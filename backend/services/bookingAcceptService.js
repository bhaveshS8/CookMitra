// Shared booking acceptance service — the single source of truth for
// cook accept / reject(ignore) business rules.
//
// Website (`POST /bookings/:id/accept`, `:id/reject`) and WhatsApp
// (interactive Accept / Decline buttons) BOTH call:
//
//   acceptBookingForCook({ bookingId, cookId, source: "website" | "whatsapp" })
//   rejectBookingForCook({ bookingId, cookId, source: "website" | "whatsapp" })
//
// The WhatsApp sender identity (verified phone number -> cook account)
// determines `cookId`. Booking/cook ids from the button payload are never
// trusted for authorization.
//
// All validations mirror the website flow: booking exists, status is
// `requested`, request not expired, cook eligible + authorized, cook has
// not ignored it, slot still available, availability window still valid,
// no conflicting booking, and the final claim is a single atomic
// `updateOne({_id, status:"requested", requestExpiresAt:{$gt:now}, ...})`
// so exactly one cook wins a website-vs-WhatsApp race.

const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const User = require("../models/User");
const Notification = require("../models/Notification");
const realtime = require("../utils/realtime");
const slots = require("../utils/slots");
const { istDayString } = require("../utils/time");
const { notifyWhatsApp } = require("../utils/whatsappApi");
const {
  dbReady,
  queueRefundForApproval,
  releaseCouponUsage,
  expireBookingIfNeeded,
  REQUEST_WINDOW_MS,
  PAYMENT_WINDOW_MS,
} = require("./bookingTransitions");

// Model calls fail fast instead of hanging on mongoose operation
// buffering when no live DB is reachable (degraded envs / unit tests
// with partially mocked models). A timeout never mutates state.
const OP_TIMEOUT_MS = 1500;
const timed = async (promise) => {
  try {
    const winner = await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), OP_TIMEOUT_MS)),
    ]);
    return winner;
  } catch {
    return { modifiedCount: 0 };
  }
};
const isTimeout = (r) => Boolean(r && r.__timeout);

const fail = (statusCode, message, extra = {}) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  throw err;
};

// Website reads via findOne (controller parity); the WhatsApp webhook
// reads via findById. Each side mocks/stubs its own accessor, so the
// lookup order is source-aware. Every attempt is timeout-guarded.
const loadBooking = async (bookingId, source) => {
  const byId = async () => {
    try {
      const r = await timed(Booking.findById(bookingId));
      return isTimeout(r) ? null : r;
    } catch {
      return null;
    }
  };
  const byOne = async () => {
    try {
      const r = await timed(Booking.findOne({ _id: bookingId }));
      return isTimeout(r) ? null : r;
    } catch {
      return null;
    }
  };
  if (source === "whatsapp") {
    return (await byId()) || (await byOne());
  }
  return (await byOne()) || (await byId());
};

// The website keeps its historical in-memory fallback when the DB is
// unreachable; the WhatsApp channel always attempts the atomic claim
// (spec section 5) and refuses to mutate on an unverifiable outcome.
const shouldAttemptAtomic = (source) => source === "whatsapp" || dbReady();

const attemptUpdateOne = async (filter, update) => {
  const r = await timed(Booking.updateOne(filter, update));
  if (!r || isTimeout(r)) return { claimed: false, timedOut: true };
  return { claimed: (r.modifiedCount ?? r.nModified ?? 0) === 1, timedOut: false };
};

// Eligibility for broadcast (cook == null) requests. Direct-assigned
// requests skip this — the assignment itself is the authorization.
const assertBroadcastEligible = async (booking, cookId) => {
  let profile = null;
  try {
    const r = await timed(CookProfile.findOne({ user: cookId }));
    profile = isTimeout(r) ? null : r;
  } catch {
    return fail(500, "Could not verify eligibility right now. Please try again.");
  }
  if (!profile || profile.approvalStatus !== "approved") {
    return fail(409, "Your cook profile is not approved for new requests right now.", {
      code: "COOK_NOT_ELIGIBLE",
    });
  }
  if (dbReady()) {
    try {
      const account = await User.findById(cookId).select("status");
      if (!account || account.status === "suspended") {
        return fail(409, "Your account cannot accept requests right now.", {
          code: "COOK_NOT_ELIGIBLE",
        });
      }
    } catch (e) {
      if (e?.statusCode) throw e;
      return fail(500, "Could not verify your account right now. Please try again.");
    }
  }
  let available = false;
  try {
    available = await slots.resolveCookAvailability(profile);
  } catch {
    return fail(500, "Could not verify eligibility right now. Please try again.");
  }
  if (!available) {
    return fail(409, "You are marked unavailable — flip back to Available to accept requests.", {
      code: "COOK_NOT_ELIGIBLE",
    });
  }
  if (
    Array.isArray(profile.serviceTypes) &&
    profile.serviceTypes.length > 0 &&
    booking.serviceType &&
    !profile.serviceTypes.includes(booking.serviceType)
  ) {
    return fail(409, "This request is for a service you don't offer.", {
      code: "COOK_NOT_ELIGIBLE",
    });
  }
  const dayStrForWindows = istDayString(booking.date);
  let windows = [];
  try {
    windows = await slots.getDayWindows(cookId, dayStrForWindows);
  } catch {
    windows = [];
  }
  if (!slots.findContainingWindow(windows, booking.startTime, booking.endTime)) {
    return fail(409, "You are not available for that time anymore.", {
      code: "COOK_NOT_ELIGIBLE",
    });
  }
};

const findRivals = async (booking, cookId) => {
  try {
    const { start: dayStart, end: dayEnd } = slots.dayBounds(booking.date);
    const r = await timed(
      Booking.find({
        cook: cookId,
        _id: { $ne: booking._id },
        date: { $gte: dayStart, $lte: dayEnd },
        status: { $in: ["accepted", "confirmed", "in_progress"] },
      }).select("startTime endTime status")
    );
    if (isTimeout(r)) return fail(500, "Could not verify slot availability right now. Please try again.");
    return r || [];
  } catch (e) {
    if (e?.statusCode) throw e;
    return fail(500, "Could not verify slot availability right now. Please try again.");
  }
};

const assertSlotFree = async (booking, cookId) => {
  const rivals = await findRivals(booking, cookId);
  const s = slots.timeToMinutes(booking.startTime);
  const e = slots.timeToMinutes(booking.endTime);
  const overlaps = (rivals || []).some((r) => {
    const rs = slots.timeToMinutes(r.startTime);
    const re = slots.timeToMinutes(r.endTime);
    return rs != null && re != null && slots.intervalsOverlap(s, e, rs, re);
  });
  if (overlaps) {
    return fail(
      409,
      "This slot has already been booked (another request was accepted). Please decline this request.",
      { code: "SLOT_UNAVAILABLE" }
    );
  }
};

const acceptClaimNote = (source, cookId, isBroadcast) => {
  if (!isBroadcast) return undefined; // direct assignment: no note (website parity)
  return source === "whatsapp"
    ? `Accepted by cook ${cookId} via WhatsApp`
    : `Accepted by cook ${cookId}`;
};

const acceptBookingForCook = async ({ bookingId, cookId, source = "website" } = {}) => {
  if (!bookingId || !cookId) {
    return fail(400, "Booking and cook are required.");
  }
  let booking = await loadBooking(bookingId, source);
  if (!booking) {
    return fail(404, "Booking not found");
  }
  const assignedCookId = booking.cook ? String(booking.cook) : null;
  const me = String(cookId);
  if (assignedCookId && assignedCookId !== me) {
    if (booking.status === "accepted") {
      return fail(409, "This booking has already been accepted by another cook.", {
        code: "BOOKING_ALREADY_ASSIGNED",
      });
    }
    return fail(404, "Booking not found");
  }
  const isBroadcast = !assignedCookId;

  if (booking.status !== "requested") {
    const wonByMe = booking.status === "accepted" && assignedCookId && assignedCookId === me;
    if (wonByMe) {
      return { booking, alreadyAccepted: true };
    }
    return fail(400, "Only pending requests can be accepted");
  }
  if (
    isBroadcast &&
    Array.isArray(booking.ignoredBy) &&
    booking.ignoredBy.map((id) => String(id)).includes(me)
  ) {
    return fail(409, "You already ignored this request.", {
      code: "BOOKING_IGNORED_BY_YOU",
    });
  }

  if (booking.requestExpiresAt && booking.requestExpiresAt < new Date()) {
    booking.status = "expired";
    booking.statusHistory.push({
      status: "expired",
      note: "Cook did not respond within 5 minutes",
    });
    try {
      await booking.save();
    } catch {
    }
    await releaseCouponUsage(booking);
    try {
      await Notification.create({
        user: booking.customer,
        type: "booking_expired",
        booking: booking._id,
        message:
          "Your booking request expired — the cook didn't respond within 5 minutes. Please find another cook.",
      });
    } catch {
    }
    try {
      realtime.emit("booking_expired", {
        bookingId: String(booking._id),
        customerId: String(booking.customer),
      });
    } catch {
    }
    return fail(410, "This request expired after 5 minutes. The customer has been notified to choose another cook.");
  }

  if (isBroadcast) {
    await assertBroadcastEligible(booking, cookId);
  }
  await assertSlotFree(booking, cookId);

  const note = acceptClaimNote(source, me, isBroadcast);
  let acceptClaimed = false;
  if (shouldAttemptAtomic(source)) {
    const nowForClaim = new Date();
    const claimFilter = { _id: booking._id, status: "requested", requestExpiresAt: { $gt: nowForClaim } };
    let claimUpdate;
    if (isBroadcast) {
      claimFilter.cook = null;
      claimUpdate = {
        $set: {
          cook: cookId,
          status: "accepted",
          paymentExpiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS),
        },
        $push: { statusHistory: { status: "accepted", ...(note ? { note } : {}) } },
      };
    } else {
      claimFilter.cook = cookId;
      claimUpdate = {
        $set: {
          status: "accepted",
          paymentExpiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS),
        },
        $push: { statusHistory: { status: "accepted", ...(note ? { note } : {}) } },
      };
    }
    const { claimed, timedOut } = await attemptUpdateOne(claimFilter, claimUpdate);
    if (claimed) {
      acceptClaimed = true;
      try {
        const fresh = await loadBooking(booking._id, source);
        if (fresh) booking = fresh;
      } catch {
      }
    } else if (timedOut && dbReady()) {
      return fail(503, "Could not confirm this request right now. Please try again.");
    } else if (!timedOut || dbReady()) {
      const latest = await loadBooking(booking._id, source);
      if (!latest) {
        if (!dbReady() && source === "website") {
          acceptClaimed = false; // fall through to the in-memory path below
        } else if (!dbReady()) {
          return fail(503, "Could not confirm this request right now. Please try again.");
        } else {
          return fail(404, "Booking not found");
        }
      } else {
        if (latest.status !== "requested") {
          const alreadyWon = latest.cook && latest.status === "accepted";
          return fail(
            409,
            alreadyWon
              ? "This booking has already been accepted by another cook."
              : "This request was just handled — please refresh to see its current status.",
            { code: alreadyWon ? "BOOKING_ALREADY_ASSIGNED" : "BOOKING_INVALID_STATE" }
          );
        }
        if (latest.requestExpiresAt && latest.requestExpiresAt <= new Date()) {
          return fail(410, "This cook request has expired.", {
            code: "BOOKING_REQUEST_EXPIRED",
          });
        }
        if (latest.cook && String(latest.cook) !== me) {
          return fail(409, "This booking has already been accepted by another cook.", {
            code: "BOOKING_ALREADY_ASSIGNED",
          });
        }
        if (source === "website" && !dbReady()) {
          acceptClaimed = false; // fall through to the in-memory path below
        } else {
          return fail(409, "Another accept is being processed for this request. Please try again.", {
            code: "BOOKING_INVALID_STATE",
          });
        }
      }
    } else {
      return fail(503, "Could not confirm this request right now. Please try again.");
    }
  }
  if (!acceptClaimed) {
    if (isBroadcast) booking.cook = cookId;
    booking.status = "accepted";
    booking.statusHistory.push({ status: "accepted", ...(note ? { note } : {}) });
    booking.paymentExpiresAt = new Date(Date.now() + PAYMENT_WINDOW_MS);
    try {
      await booking.save();
    } catch {
    }
  }

  // Post-claim overlap verification: another confirm may have landed first.
  let acceptClash = false;
  try {
    const postRivals = await findRivals({ ...booking, _id: booking._id }, booking.cook);
    const myStart = slots.timeToMinutes(booking.startTime);
    const myEnd = slots.timeToMinutes(booking.endTime);
    acceptClash = (postRivals || []).some((r) => {
      const rs = slots.timeToMinutes(r.startTime);
      const re = slots.timeToMinutes(r.endTime);
      return rs != null && re != null && slots.intervalsOverlap(myStart, myEnd, rs, re);
    });
  } catch (e) {
    if (e?.statusCode) throw e;
    acceptClash = false;
  }
  if (acceptClash) {
    let latest = null;
    if (dbReady()) {
      try {
        latest = await loadBooking(booking._id, source);
      } catch {
        latest = null;
      }
    }
    if (!latest || latest.status !== "accepted" || latest.payment?.status === "paid") {
      return fail(
        409,
        "This slot was just confirmed for another request. Your booking was kept as-is — please contact support if you were charged.",
        { code: "SLOT_UNAVAILABLE", booking: latest || booking }
      );
    }
    latest.status = "requested";
    latest.paymentExpiresAt = null;
    if (isBroadcast) latest.cook = null;
    latest.requestExpiresAt = new Date(Date.now() + REQUEST_WINDOW_MS);
    latest.statusHistory.push({
      status: "requested",
      note: "Accept rolled back — the slot was just confirmed for another request",
    });
    try {
      await latest.save();
    } catch {
    }
    return fail(409, "This slot was just confirmed for another request. Please decline this one.", {
      code: "SLOT_UNAVAILABLE",
    });
  }

  // Side effects — identical for website and WhatsApp accepts.
  try {
    await Notification.create({
      user: booking.customer,
      type: "booking_accepted",
      booking: booking._id,
      message:
        "Your booking request has been accepted! Complete payment within 5 minutes to confirm your slot.",
    });
  } catch {
  }
  try {
    notifyWhatsApp("accepted", booking);
  } catch {
  }
  if (source === "website") {
    // The cook is not looking at WhatsApp — push the Marathi
    // scheduled-booking job sheet proactively (idempotent per cook).
    try {
      const { notifyWhatsAppEvent } = require("./whatsappDispatch");
      notifyWhatsAppEvent("booking.accepted", booking);
    } catch {
    }
  }
  try {
    realtime.emit("booking_assigned", {
      bookingId: String(booking._id),
      assignedCookId: String(booking.cook),
      customerId: String(booking.customer),
    });
  } catch {
  }
  return { booking, alreadyAccepted: false };
};

const rejectBookingForCook = async ({ bookingId, cookId, source = "website" } = {}) => {
  if (!bookingId || !cookId) {
    return fail(400, "Booking and cook are required.");
  }
  let booking = await loadBooking(bookingId, source);
  if (!booking) {
    return fail(404, "Booking not found");
  }
  const assignedCookId = booking.cook ? String(booking.cook) : null;
  const me = String(cookId);
  if (assignedCookId && assignedCookId !== me) {
    return fail(404, "Booking not found");
  }
  await expireBookingIfNeeded(booking);
  if (booking.status !== "requested") {
    return fail(400, "Only pending requests can be declined");
  }

  // Broadcast: ignore keeps status=requested so other cooks can accept.
  if (!assignedCookId) {
    try {
      if (shouldAttemptAtomic(source)) {
        const { timedOut } = await attemptUpdateOne(
          { _id: booking._id, status: "requested" },
          { $addToSet: { ignoredBy: cookId } }
        );
        if (!timedOut) {
          try {
            const fresh = await loadBooking(booking._id, source);
            if (fresh) booking = fresh;
          } catch {
          }
        }
        if (booking.status !== "requested") {
          return fail(409, "This request was just handled — please refresh to see its current status.", {
            code: "BOOKING_INVALID_STATE",
          });
        }
      } else {
        booking.ignoredBy = booking.ignoredBy || [];
        if (!booking.ignoredBy.map((id) => String(id)).includes(me)) {
          booking.ignoredBy.push(cookId);
        }
        if (typeof booking.save === "function") {
          try {
            await booking.save();
          } catch {
          }
        }
      }
    } catch (e) {
      if (e?.statusCode) throw e;
    }
    try {
      realtime.emit("booking_ignored", {
        bookingId: String(booking._id),
        cookId: me,
      });
    } catch {
    }
    return { booking, ignored: true };
  }

  // Directly assigned cook: decline rejects the request.
  let rejectClaimed = false;
  if (shouldAttemptAtomic(source)) {
    const { claimed, timedOut } = await attemptUpdateOne(
      { _id: booking._id, status: "requested", cook: cookId },
      {
        $set: { status: "rejected" },
        $push: {
          statusHistory: {
            status: "rejected",
            ...(source === "whatsapp" ? { note: "Declined by cook via WhatsApp" } : {}),
          },
        },
      }
    );
    if (claimed) {
      rejectClaimed = true;
      try {
        const fresh = await loadBooking(bookingId, source);
        if (fresh) booking = fresh;
      } catch {
      }
    } else if (!timedOut) {
      let latest = null;
      try {
        const r = await timed(Booking.findOne({ _id: booking._id, cook: cookId }));
        latest = isTimeout(r) ? null : r;
      } catch {
        latest = null;
      }
      if (!latest) {
        if (!dbReady() && source === "website") {
          rejectClaimed = false; // fall through to the in-memory path below
        } else if (!dbReady()) {
          return fail(503, "Could not decline this request right now. Please try again.");
        } else {
          return fail(404, "Booking not found");
        }
      } else {
        if (latest.status !== "requested") {
          return fail(409, "This request was just handled — please refresh to see its current status.", {
            code: "BOOKING_INVALID_STATE",
          });
        }
        if (source === "website" && !dbReady()) {
          rejectClaimed = false; // fall through to the in-memory path below
        } else {
          return fail(409, "Another action is being processed for this request. Please try again.", {
            code: "BOOKING_INVALID_STATE",
          });
        }
      }
    } else if (dbReady()) {
      return fail(409, "Another action is being processed for this request. Please try again.", {
        code: "BOOKING_INVALID_STATE",
      });
    }
  }
  if (!rejectClaimed) {
    if (!dbReady() && source === "whatsapp") {
      return fail(503, "Could not decline this request right now. Please try again.");
    }
    booking.status = "rejected";
    booking.statusHistory.push({
      status: "rejected",
      ...(source === "whatsapp" ? { note: "Declined by cook via WhatsApp" } : {}),
    });
  }

  let rejectRefundNote = "";
  try {
    const queued = queueRefundForApproval(booking, "booking_rejected");
    if (queued > 0) {
      rejectRefundNote = ` A refund of ₹${queued} has been requested — our team will review it shortly.`;
    } else if (booking.payment?.testMode && booking.payment?.status === "paid") {
      rejectRefundNote = " (Test payment — no real money moved.)";
    }
  } catch {
  }
  try {
    if (typeof booking.save === "function") await booking.save();
  } catch {
  }
  try {
    await releaseCouponUsage(booking);
  } catch {
  }
  try {
    await Notification.create({
      user: booking.customer,
      type: "booking_rejected",
      booking: booking._id,
      message: `Your booking request has been rejected.${rejectRefundNote}`,
    });
  } catch {
  }
  try {
    notifyWhatsApp("rejected", booking, { refundNote: rejectRefundNote || undefined });
  } catch {
  }
  return { booking, ignored: false, refundNote: rejectRefundNote };
};

module.exports = {
  acceptBookingForCook,
  rejectBookingForCook,
};
