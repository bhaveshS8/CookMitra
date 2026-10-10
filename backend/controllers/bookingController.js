const Booking = require("../models/Booking");
const mongoose = require("mongoose");
const Notification = require("../models/Notification");
const CookProfile = require("../models/CookProfile");
const Coupon = require("../models/Coupon");
const User = require("../models/User");
const realtime = require("../utils/realtime");
const { normalizeCode, rejectionReason, computeDiscount, findCouponByCode } = require("../utils/coupons");
const { slabPriceForDuration, splitPayout } = require("../utils/pricing");
const crypto = require("crypto");
const {
  getDayWindows,
  getDayBookings,
  computeStartOptions,
  activeSlotMatch,
  findContainingWindow,
  findOverlapBooking,
  timeToMinutes,
  minutesToTime,
  dayBounds,
  intervalsOverlap,
  resolveCookAvailability,
} = require("../utils/slots");
const { buildCustomerWhatsAppUrl, buildCookJobSheetWhatsAppUrl, buildHoursCompleteWhatsAppUrl, buildReviewWhatsAppUrl, FRONTEND_BASE_URL } = require("../utils/whatsapp");
const { notifyWhatsApp } = require("../utils/whatsappApi");
const { paginationParams, applyPagination, sendList, HARD_CAP } = require("../utils/pagination");
const { razorpay: razorpayClient, isConfigured: razorpayConfigured } = require("../config/razorpay");
const {
  assertRazorpayOrderAmount,
  assertRazorpayPaymentCaptured,
} = require("../utils/razorpayVerify");
const {
  parseTimeStrict,
  isOnGrid,
  parseDayStrict,
  istDayString,
  istNowMinutes,
  istMidnight,
  istEventInstant,
  MAX_BOOKING_HORIZON_DAYS,
  OTP_VALIDITY_AFTER_END_MS,
} = require("../utils/time");
const { recordLedger } = require("../utils/finance");

const generateServiceOtp = () =>
  String(1000 + crypto.randomInt(0, 9000));

const sessionEndDate = (booking) => {
  if (booking?.serviceEndsAt) {
    const d = new Date(booking.serviceEndsAt);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (!booking?.date || !booking?.endTime) return null;
  return istEventInstant(booking.date, booking.endTime);
};

const isNoShowPastHours = (booking, now) => {
  if (!["accepted", "confirmed", "in_progress"].includes(booking?.status)) return false;
  if (booking.cookArrived || booking.serviceStartedAt) return false;
  const end = sessionEndDate(booking);
  return Boolean(end) && now >= end.getTime();
};

const sessionStartDate = (booking) => {
  if (!booking?.date || !booking?.startTime) return null;
  return istEventInstant(booking.date, booking.startTime);
};
exports.sessionStartDate = sessionStartDate;
exports.sessionEndDate = sessionEndDate;

const CANCEL_LOCK_MS = 30 * 60 * 1000;
const cancelLocked = (booking, now = Date.now()) => {
  const start = sessionStartDate(booking);
  return Boolean(start) && now >= start.getTime() - CANCEL_LOCK_MS;
};

const RESCHEDULE_ALLOWED_STATUSES = ["requested", "accepted", "confirmed"];
const RESCHEDULE_MIN_LEAD_MS = 30 * 60 * 1000;
const MAX_CUSTOMER_RESCHEDULES = 2;
const RESCHEDULE_DAY_START_MIN = 8 * 60;
const RESCHEDULE_DAY_END_MIN = 20 * 60;
const rescheduleLocked = (booking, now = Date.now()) => cancelLocked(booking, now);
const RESCHEDULE_REASONS = [
  "Change of plans",
  "Personal reason",
  "Wrong date/time selected",
  "Cook unavailable",
  "Family/event schedule changed",
  "Other",
];
const normalizeRescheduleReason = (raw) => {
  const s = String(raw ?? "").trim().slice(0, 200);
  if (!s) return "";
  return s;
};


const {
  queueRefundForApproval,
  releaseCouponUsage,
  expireBookingIfNeeded,
  dbReady,
  REQUEST_WINDOW_MS,
  PAYMENT_WINDOW_MS,
} = require("../services/bookingTransitions");
const { fanOutBookingRequest } = require("../services/whatsappDispatch");
const dispatchJobs = require("../services/bookingDispatchJobs");
const {
  acceptBookingForCook,
  rejectBookingForCook,
} = require("../services/bookingAcceptService");

const OTP_FIELDS = ["serviceOtp", "serviceOtpGeneratedAt", "serviceOtpAttempts", "serviceOtpLockedUntil"];
const stripServiceOtp = (payload) => {
  const stripOne = (b) => {
    if (!b || typeof b !== "object") return b;
    if (typeof b.toObject === "function") {
      const o = b.toObject();
      for (const f of OTP_FIELDS) delete o[f];
      return o;
    }
    const out = { ...b };
    for (const f of OTP_FIELDS) delete out[f];
    return out;
  };
  return Array.isArray(payload) ? payload.map(stripOne) : stripOne(payload);
};

// Unpaid cancelled bookings are neither shown nor tracked: cancelling an
// unpaid booking permanently deletes it (see cancelBooking / markNoShow).
const isUnpaidBooking = (b) => b?.payment?.status !== "paid";
// Mongo exclusion clause for legacy rows: hide status=cancelled unless paid.
const NOT_UNPAID_CANCELLED_CLAUSE = {
  $or: [{ status: { $ne: "cancelled" } }, { status: "cancelled", "payment.status": "paid" }],
};
const excludeUnpaidCancelled = (filter = {}) => ({
  ...filter,
  $and: [...(Array.isArray(filter.$and) ? filter.$and : []), NOT_UNPAID_CANCELLED_CLAUSE],
});
// Permanently remove an unpaid booking: coupon usage released, its
// notifications removed, doc deleted. No audit/CancellationAudit is written.
const destroyUnpaidBooking = async (booking) => {
  const id = booking?._id;
  try {
    await releaseCouponUsage(booking);
  } catch {
  }
  if (id && dbReady()) {
    try {
      await Notification.deleteMany({ booking: id });
    } catch {
    }
    try {
      await Booking.deleteOne({ _id: id });
    } catch {
    }
  }
  return id;
};

const attachCookPhotoUrls = async (objs) => {  try {
    const list = Array.isArray(objs) ? objs : [objs];
    const ids = [
      ...new Set(
        list
          .map((o) => o?.cook?._id || o?.cook)
          .filter(Boolean)
          .map(String)
      ),
    ];
    if (!ids.length) return;
    const profiles = await CookProfile.find({ user: { $in: ids } })
      .select("user photoUrl")
      .lean();
    const byUser = new Map((profiles || []).map((p) => [String(p.user), p.photoUrl || ""]));
    list.forEach((o) => {
      if (o?.cook && typeof o.cook === "object" && !Array.isArray(o.cook)) {
        o.cook.photoUrl = byUser.get(String(o.cook._id)) || "";
      }
    });
  } catch {
  }
};

const ensureServiceOtp = (booking) => {
  if (booking?.serviceOtp) return false;
  booking.serviceOtp = generateServiceOtp();
  booking.serviceOtpGeneratedAt = new Date();
  return true;
};

const signaturesEqual = (a, b) => {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};


const notifyServiceCompleted = async (booking) => {
  let cookName = "your cook";
  try {
    const cookUser = await User.findById(booking.cook).select("name");
    if (cookUser?.name) cookName = cookUser.name;
  } catch {
  }
  try {
    await Notification.create({
      user: booking.customer,
      type: "booking_completed",
      booking: booking._id,
      message: `Service complete! ${cookName} finished your session — please rate your cook.`,
    });
  } catch {
  }
  try {
    await Notification.create({
      user: booking.cook,
      type: "booking_completed",
      booking: booking._id,
      message: "Service marked complete — the customer has been asked to rate the session.",
    });
  } catch {
  }
  notifyWhatsApp("completed", booking);
};

const markHoursCompleteIfNeeded = async (booking) => {
  let changed = false;
  if (
    booking.status === "unattended" &&
    booking.payment?.status === "paid" &&
    (!booking.payment?.refundStatus || booking.payment.refundStatus === "none")
  ) {
      try {
        const queued = queueRefundForApproval(booking, "booking_unattended");
        if (queued > 0) {
          if (dbReady() && booking._id) {
            try {
              await Booking.updateOne(
                { _id: booking._id, "payment.refundStatus": "none" },
                {
                  $set: { "payment.refundStatus": "pending", "payment.refundAmount": queued },
                  $push: {
                    statusHistory: {
                      status: booking.status,
                      note: `Refund of ₹${queued} queued for admin approval (booking_unattended)`,
                    },
                  },
                }
              );
            } catch {
            }
          } else {
            await booking.save();
          }
          changed = true;
        try {
          await Notification.create({
            user: booking.customer,
            type: "refund_pending",
            booking: booking._id,
            message: `Your refund of ₹${queued} is under admin review.`,
          });
        } catch {
        }
      }
    } catch {
    }
  }
  if (!booking.hoursCompleted) {
    if (!["accepted", "confirmed", "in_progress"].includes(booking.status)) return false;
    if (!booking.serviceStartedAt && booking.serviceOtp) return false;
    const end = sessionEndDate(booking);
    if (!end || Date.now() < end.getTime()) return false;
    if (dbReady() && booking._id) {
      let flagClaimed = false;
      try {
        const claim = await Booking.updateOne(
          { _id: booking._id, hoursCompleted: { $ne: true } },
          { $set: { hoursCompleted: true, hoursCompletedAt: new Date() } }
        );
        flagClaimed = (claim.modifiedCount ?? claim.nModified ?? 0) === 1;
      } catch {
        flagClaimed = false;
      }
      if (!flagClaimed) {
        booking.hoursCompleted = true;
        return changed;
      }
      booking.hoursCompleted = true;
      booking.hoursCompletedAt = booking.hoursCompletedAt || new Date();
    } else {
      booking.hoursCompleted = true;
      booking.hoursCompletedAt = new Date();
      changed = true;
      await booking.save();
    }
    changed = true;
    await Notification.create({
      user: booking.customer,
      type: "cooking_hours_completed",
      booking: booking._id,
      message: "Your cooking hours are complete! Please review your session.",
    });
    await Notification.create({
      user: booking.cook,
      type: "cooking_hours_completed",
      booking: booking._id,
      message: "Cooking hours complete for this booking! Please wrap up your session.",
    });
    notifyWhatsApp("hours_complete", booking);
  }
  if (booking.status === "in_progress" && booking.serviceStartedAt) {
    const end = sessionEndDate(booking);
    if (end && Date.now() >= end.getTime()) {
      if (dbReady() && booking._id) {
        let autoClaimed = false;
        try {
          const claim = await Booking.updateOne(
            { _id: booking._id, status: "in_progress" },
            {
              $set: { status: "completed" },
              $push: { statusHistory: { status: "completed", note: "Service hours completed — auto-completed" } },
            }
          );
          autoClaimed = (claim.modifiedCount ?? claim.nModified ?? 0) === 1;
        } catch {
          autoClaimed = false;
        }
        if (!autoClaimed) {
          try {
            const latest = await Booking.findById(booking._id);
            if (latest) booking.status = latest.status;
          } catch {
          }
          return changed;
        }
        booking.status = "completed";
        booking.statusHistory.push({
          status: "completed",
          note: "Service hours completed — auto-completed",
        });
        changed = true;
        await notifyServiceCompleted(booking);
      } else {
        booking.status = "completed";
        booking.statusHistory.push({
          status: "completed",
          note: "Service hours completed — auto-completed",
        });
        changed = true;
        await booking.save();
        await notifyServiceCompleted(booking);
      }
    }
  }
  if (
    !booking.serviceStartedAt &&
    ["accepted", "confirmed", "in_progress"].includes(booking.status) &&
    booking.payment?.status === "paid"
  ) {
    const end = sessionEndDate(booking);
    if (end && Date.now() >= end.getTime() + 24 * 60 * 60 * 1000) {
      if (dbReady() && booking._id) {
        let legacyClaimed = false;
        try {
          const claim = await Booking.updateOne(
            { _id: booking._id, status: { $in: ["accepted", "confirmed", "in_progress"] } },
            {
              $set: { hoursCompleted: true, hoursCompletedAt: new Date(), status: "completed" },
              $push: { statusHistory: { status: "completed", note: "Auto-completed: legacy booking past its scheduled end" } },
            }
          );
          legacyClaimed = (claim.modifiedCount ?? claim.nModified ?? 0) === 1;
        } catch {
          legacyClaimed = false;
        }
        if (!legacyClaimed) {          try {
            const latest = await Booking.findById(booking._id);
            if (latest) booking.status = latest.status;
          } catch {
          }
          return changed;
        }
        booking.hoursCompleted = true;
        booking.hoursCompletedAt = booking.hoursCompletedAt || new Date();
        booking.status = "completed";
        booking.statusHistory.push({
          status: "completed",
          note: "Auto-completed: legacy booking past its scheduled end",
        });
        changed = true;
        await notifyServiceCompleted(booking);
      } else {
        booking.hoursCompleted = true;
        booking.hoursCompletedAt = booking.hoursCompletedAt || new Date();
        booking.status = "completed";
        booking.statusHistory.push({
          status: "completed",
          note: "Auto-completed: legacy booking past its scheduled end",
        });
        changed = true;
        await booking.save();
        await notifyServiceCompleted(booking);
      }
    }
  }
  if (
    !booking.cookArrived &&
    !booking.serviceStartedAt &&
    ["accepted", "confirmed", "in_progress"].includes(booking.status)
  ) {
    const end = sessionEndDate(booking);
    if (end && Date.now() >= end.getTime()) {
      if (dbReady() && booking._id) {
        let unattendedClaimed = false;
        try {
          const claim = await Booking.updateOne(
            {
              _id: booking._id,
              status: { $in: ["accepted", "confirmed", "in_progress"] },
              cookArrived: { $ne: true },
              serviceStartedAt: null,
            },
            {
              $set: { status: "unattended" },
              $push: {
                statusHistory: {
                  status: "unattended",
                  note: "Cooking hours passed — cook did not attend the booking",
                },
              },
            }
          );
          unattendedClaimed = (claim.modifiedCount ?? claim.nModified ?? 0) === 1;
        } catch {
          unattendedClaimed = false;
        }
        if (!unattendedClaimed) {
          try {
            const latest = await Booking.findById(booking._id);
            if (latest) booking.status = latest.status;
          } catch {
          }
          return changed;
        }
        booking.status = "unattended";
        booking.statusHistory.push({
          status: "unattended",
          note: "Cooking hours passed — cook did not attend the booking",
        });
      } else {
        booking.status = "unattended";
        booking.statusHistory.push({
          status: "unattended",
          note: "Cooking hours passed — cook did not attend the booking",
        });
      }
      let unattendedRefund = 0;
      try {
        unattendedRefund = queueRefundForApproval(booking, "booking_unattended") || 0;
        if (unattendedRefund > 0) {
          if (dbReady() && booking._id) {
            try {
              await Booking.updateOne(
                { _id: booking._id, "payment.refundStatus": "none" },
                {
                  $set: { "payment.refundStatus": "pending", "payment.refundAmount": unattendedRefund },
                  $push: {
                    statusHistory: {
                      status: booking.status,
                      note: `Refund of ₹${unattendedRefund} queued for admin approval (booking_unattended)`,
                    },
                  },
                }
              );
            } catch {
            }
          } else {
            try {
              await booking.save();
            } catch {
            }
          }
        }
      } catch {
      }
      try {
        await releaseCouponUsage(booking);
      } catch {
      }
      changed = true;
      try {
        await Notification.create({
          user: booking.customer,
          type: "booking_unattended",
          booking: booking._id,
          message: `Your cook did not attend the session.${unattendedRefund > 0 ? ` A refund of ₹${unattendedRefund} has been requested — our team will review it shortly.` : " Please contact support if you were charged."}`,
        });
      } catch {
      }
      try {
        await Notification.create({
          user: booking.cook,
          type: "booking_unattended",
          booking: booking._id,
          message: "You missed a booked session — it was marked unattended. Please contact support if this is a mistake.",
        });
      } catch {
      }
      if (unattendedRefund > 0) {
        try {
          await Notification.create({
            user: booking.customer,
            type: "refund_pending",
            booking: booking._id,
            message: `Your refund of ₹${unattendedRefund} is under admin review.`,
          });
        } catch {
        }
      }
    }
  }
  return changed;
};

const markArrivedIfNeeded = async (booking) => {
  if (booking.cookArrived) return false;
  booking.cookArrived = true;
  booking.cookArrivedAt = new Date();
  const paid = booking.payment?.status === "paid";
  if (paid && ["accepted", "confirmed"].includes(booking.status)) {
    booking.status = "in_progress";
    booking.statusHistory.push({ status: "in_progress", note: "Cook arrived (manual)" });
  } else {
    booking.statusHistory.push({ status: booking.status, note: "Cook arrived (manual)" });
  }
  await booking.save();
  await Notification.create({
    user: booking.customer,
    type: "cook_arrived",
    booking: booking._id,
    message: "Your cook has arrived and the service clock has started (OTP verified)!",
  });
  return true;
};

const BOOKING_CUSTOMER_FIELDS = [
  "serviceType",
  "selectedItems",
  "startTime",
  "endTime",
  "address",
  "addressDetails",
  "location",
  "guests",
  "durationHours",
  "notes",
];
const pickBookingCustomerFields = (obj) => {
  const out = {};
  for (const key of BOOKING_CUSTOMER_FIELDS) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  // Coordinates must be a complete, finite, in-range pair or absent —
  // partial pairs (lat without lng), NaN/Infinity, out-of-range values, and
  // non-numeric strings never persist (a typed address still books fine).
  const loc = out.location;
  if (loc !== undefined) {
    const lat = typeof loc?.lat === "string" && loc.lat.trim() !== "" ? Number(loc.lat) : loc?.lat;
    const lng = typeof loc?.lng === "string" && loc.lng.trim() !== "" ? Number(loc.lng) : loc?.lng;
    const ok =
      Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
      Number.isFinite(lng) && lng >= -180 && lng <= 180;
    if (ok) out.location = { lat, lng };
    else delete out.location;
  }
  return out;
};

// When `diagnostics` is true, returns { eligible, examined, excluded }
// where `excluded` counts cooks dropped at each filter stage (no personal
// data — counts only). Default return is the plain eligible array, so all
// existing callers are unaffected.
const findEligibleCooks = async ({ date, startTime, endTime, serviceType, excludeCookIds = [], diagnostics = false }) => {
  const excluded = new Set((excludeCookIds || []).map((id) => String(id)));
  const diag = {
    examined: 0,
    excludedByRequester: 0,
    wrongService: 0,
    missingAccount: 0,
    suspended: 0,
    unavailable: 0,
    noWindow: 0,
    overlap: 0,
  };
  const done = (eligible) =>
    diagnostics
      ? {
          eligible,
          examined: diag.examined,
          excluded: {
            excludedByRequester: diag.excludedByRequester,
            wrongService: diag.wrongService,
            missingAccount: diag.missingAccount,
            suspended: diag.suspended,
            unavailable: diag.unavailable,
            noWindow: diag.noWindow,
            overlap: diag.overlap,
          },
        }
      : eligible;
  let profiles = [];
  try {
    profiles = await CookProfile.find({ approvalStatus: "approved" })
      .populate("user", "name status")
      .lean();
  } catch {
    return done([]);
  }
  diag.examined = (profiles || []).length;
  const live = [];
  for (const p of profiles || []) {
    const userId = p?.user?._id || p?.user;
    if (!userId) {
      diag.missingAccount += 1;
      continue;
    }
    if (excluded.has(String(userId))) {
      diag.excludedByRequester += 1;
      continue;
    }
    if (
      Array.isArray(p.serviceTypes) &&
      p.serviceTypes.length > 0 &&
      serviceType &&
      !p.serviceTypes.includes(serviceType)
    ) {
      diag.wrongService += 1;
      continue;
    }
    if (!p.user || p.user.status === "suspended") {
      diag[!p.user ? "missingAccount" : "suspended"] += 1;
      continue;
    }
    let available = false;
    try {
      available = await resolveCookAvailability(p);
    } catch {
      available = false;
    }
    if (!available) {
      diag.unavailable += 1;
      continue;
    }
    live.push({ profile: p, userId: String(userId) });
  }
  if (!live.length) return done([]);
  let byCook = new Map();
  try {
    const { start: dayStart, end: dayEnd } = dayBounds(date);
    const allBookings = await Booking.find({
      cook: { $in: live.map((c) => c.userId) },
      date: { $gte: dayStart, $lte: dayEnd },
      $or: activeSlotMatch(),
    })
      .select("cook startTime endTime status")
      .lean();
    for (const b of allBookings || []) {
      const key = String(b.cook);
      if (!byCook.has(key)) byCook.set(key, []);
      byCook.get(key).push(b);
    }
  } catch {
    byCook = new Map();
  }
  const eligible = [];
  for (const { profile, userId } of live) {
    let windows = [];
    try {
      windows = await getDayWindows(userId, date);
    } catch {
      windows = [];
    }
    if (!findContainingWindow(windows, startTime, endTime)) {
      diag.noWindow += 1;
      continue;
    }
    if (findOverlapBooking(byCook.get(userId) || [], startTime, endTime)) {
      diag.overlap += 1;
      continue;
    }
    eligible.push({ profile, userId });
  }
  return done(eligible);
};
exports.findEligibleCooks = findEligibleCooks;

// Admin diagnostics for the durable WhatsApp dispatch outbox.
// GET /api/bookings/dispatch-jobs?status=failed&bookingId=<id>&limit=20&skip=0
// Sanitized: job ids, booking ids, counters, timestamps, reason codes only.
exports.getDispatchJobs = async (req, res, next) => {
  try {
    const { jobs, total } = await dispatchJobs.listJobs({
      status: req.query.status,
      bookingId: req.query.bookingId,
      limit: req.query.limit,
      skip: req.query.skip,
    });
    return res.json({ success: true, jobs, total });
  } catch (error) {
    next(error);
  }
};

exports.getEligibleCooksForBooking = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const eligible = await findEligibleCooks({
      date: booking.date,
      startTime: booking.startTime,
      endTime: booking.endTime,
      serviceType: booking.serviceType,
      excludeCookIds: booking.ignoredBy || [],
    });
    const cookUserIds = eligible.map((e) => e.userId);
    const profiles = await CookProfile.find({ user: { $in: cookUserIds } })
      .populate("user", "name email phone status")
      .lean();
    return res.json({ success: true, cooks: profiles });
  } catch (error) {
    next(error);
  }
};

// Admin recovery: re-send the WhatsApp booking request to every currently
// eligible cook (e.g. the first fan-out failed while Meta was down).
// Per-cook `sent` entries make this idempotent — cooks already notified
// are skipped, `failed` ones are retried.
exports.retryCookWhatsApp = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (booking.status !== "requested") {
      return res.status(409).json({
        message: `Only pending requests can be re-notified (current status: ${booking.status}).`,
      });
    }
    if (booking.requestExpiresAt && booking.requestExpiresAt <= new Date()) {
      return res.status(410).json({ message: "This cook request has expired." });
    }
    // Woman-presence gate: unconfirmed bookings are never re-dispatched.
    // Legacy bookings created before the verification rollout are exempt.
    {
      const vr = require("../utils/bookingRestrictions");
      const confirmed = booking.womanPresenceConfirmed === true;
      let legacy = false;
      try {
        legacy = new Date(booking.createdAt).getTime() < vr.WOMAN_PRESENCE_LAUNCH_MS;
      } catch {
        legacy = false;
      }
      if (!confirmed && !legacy) {
        return res.status(403).json({
          message: "This booking cannot be dispatched without a persisted woman-presence confirmation.",
          code: "BOOKING_MISSING_CONFIRMATION",
        });
      }
    }
    const eligible = await findEligibleCooks({
      date: booking.date,
      startTime: booking.startTime,
      endTime: booking.endTime,
      serviceType: booking.serviceType,
      excludeCookIds: booking.ignoredBy || [],
    });
    const targets = booking.cook
      ? [{ userId: String(booking.cook) }]
      : eligible;
    let customerName = "";
    try {
      const customer = await User.findById(booking.customer).select("name").lean();
      if (customer?.name) customerName = customer.name;
    } catch {
    }
    const result = await fanOutBookingRequest(booking, targets, { customerName });
    // Keep the durable job record in sync with manual re-notifies so the
    // admin dispatch-jobs view reflects the latest outcome. Best-effort:
    // never changes the response contract below.
    try {
      await dispatchJobs.recordManualAttempt(booking._id, result);
    } catch {
    }
    const fresh = (await Booking.findById(req.params.id)) || booking;
    const dispatch = Array.isArray(fresh.whatsappDispatch)
      ? fresh.whatsappDispatch.map((e) => ({
          cook: String(e.cook),
          kind: e.kind,
          status: e.status,
          attempts: e.attempts,
          error: e.error || undefined,
          deliveryStatus: e.deliveryStatus || undefined,
          deliveryUpdatedAt: e.deliveryUpdatedAt || undefined,
        }))
      : [];
    return res.json({ success: true, ok: result?.ok === true, results: result?.results || [], dispatch });
  } catch (error) {
    next(error);
  }
};

exports.createBooking = async (req, res, next) => {
  try {
    // ---- Woman-presence gate (authoritative, fail-closed) ----
    // Order matters: restriction + confirmation are verified BEFORE any
    // side effect (idempotency replay, coupon redemption, booking insert,
    // notifications, dispatch jobs, payment linkage), so a blocked or
    // unconfirmed attempt creates nothing and consumes nothing.
    try {
      const { getRestrictionState, isValidAffirmation } = require("../utils/bookingRestrictions");
      const state = await getRestrictionState(req.user.id);
      if (state.blocked) {
        const { remainingSeconds, BLOCKED_CODE } = require("../utils/bookingRestrictions");
        return res.status(403).json({
          message:
            "Booking temporarily unavailable. A woman must be present at home throughout the cooking service. Your booking access has been temporarily paused for 1 hour.",
          code: BLOCKED_CODE,
          blockedUntil: state.blockedUntil,
          remainingSeconds: remainingSeconds(state.blockedUntil),
        });
      }
      // Strict check on the BODY field only: never query params, URL params,
      // profile settings, prior bookings, or truthiness. Older clients that
      // omit the field are rejected with a clear message (no silent bypass).
      if (!isValidAffirmation(req.body?.womanPresenceConfirmed)) {
        const { CONFIRMATION_REQUIRED_CODE } = require("../utils/bookingRestrictions");
        return res.status(400).json({
          message: "Please confirm that a woman will be present at home throughout the cooking service.",
          code: CONFIRMATION_REQUIRED_CODE,
        });
      }
    } catch (gateErr) {
      if (
        gateErr?.code === "BOOKING_VERIFICATION_UNAVAILABLE" ||
        /restriction store unavailable|database not ready/i.test(String(gateErr?.message || gateErr?.cause?.message || ""))
      ) {
        return res.status(503).json({
          message: "Booking verification is temporarily unavailable. Please try again in a moment.",
          code: "BOOKING_VERIFICATION_UNAVAILABLE",
        });
      }
      throw gateErr;
    }

    const { date, startTime, endTime } = req.body;

    const strictStart = parseTimeStrict(startTime);
    const strictEnd = parseTimeStrict(endTime);
    if (strictStart == null || strictEnd == null || strictEnd <= strictStart) {
      return res.status(400).json({ message: "Invalid time slot" });
    }
    if (!isOnGrid(strictStart) || !isOnGrid(strictEnd)) {
      return res.status(400).json({ message: "Start and end times must be on 30-minute intervals" });
    }
    const strictDay = parseDayStrict(date);
    if (!strictDay) {
      return res.status(400).json({ message: "Valid date (YYYY-MM-DD) is required" });
    }
    const todayStr = istDayString();
    const dayStr = istDayString(strictDay);
    if (dayStr < todayStr) {
      return res.status(400).json({ message: "That date already passed — please pick today or a future date." });
    }
    const horizonLimit = Date.now() + MAX_BOOKING_HORIZON_DAYS * 24 * 60 * 60 * 1000;
    if (strictDay.getTime() > horizonLimit) {
      return res.status(400).json({ message: "That date is too far ahead — please pick a nearer date." });
    }
    if (dayStr === todayStr) {
      const nowMin = istNowMinutes();
      if (strictStart < nowMin) {
        return res.status(400).json({ message: "That time already passed today — please pick a later start time." });
      }
    }

    const clientKey = String(req.body.clientKey || req.body.idempotencyKey || "").trim().slice(0, 120);
    if (clientKey && dbReady()) {
      try {
        const existing = await Booking.findOne({ clientKey, customer: req.user.id });
        if (existing) {
          const existingObj = existing.toObject ? existing.toObject() : existing;
          return res.status(200).json({ ...existingObj, alreadyExists: true });
        }
      } catch {
      }
    }

    let eligibleCooks = [];
    try {
      eligibleCooks = await findEligibleCooks({
        date,
        startTime,
        endTime,
        serviceType: req.body.serviceType,
      });
    } catch {
      eligibleCooks = [];
    }
    if (!eligibleCooks.length) {
      return res.status(409).json({ message: "No cooks are free for that slot right now — please try another time." });
    }
    try {
      if (dbReady()) {
        const { start: custDayStart, end: custDayEnd } = dayBounds(date);
        const ownLive = await Booking.find({
          customer: req.user.id,
          date: { $gte: custDayStart, $lte: custDayEnd },
          $or: activeSlotMatch(),
        }).select("startTime endTime status");
        const mine = timeToMinutes(startTime);
        const mineEnd = timeToMinutes(endTime);
        const selfClash = (ownLive || []).find((r) => {
          const rs = timeToMinutes(r.startTime);
          const re = timeToMinutes(r.endTime);
          return rs != null && re != null && intervalsOverlap(mine, mineEnd, rs, re);
        });
        if (selfClash) {
          if (clientKey) {
            try {
              const existing = await Booking.findOne({ clientKey, customer: req.user.id });
              if (existing) {
                const existingObj = existing.toObject ? existing.toObject() : existing;
                return res.status(200).json({ ...existingObj, alreadyExists: true });
              }
            } catch {
            }
          }
          return res.status(409).json({
            message: "You already have a booking for that time.",
            code: "BOOKING_SELF_CLASH",
            bookingId: String(selfClash._id),
            bookingStatus: selfClash.status,
          });
        }
      }
    } catch {
    }

    const payment = req.body.payment || {};
    const razorpayOrderId = payment.razorpayOrderId || req.body.razorpayOrderId;
    const razorpayPaymentId = payment.razorpayPaymentId || req.body.razorpayPaymentId;
    const razorpaySignature = payment.razorpaySignature || req.body.razorpaySignature;
    const hasPayment = Boolean(razorpayOrderId && razorpayPaymentId && razorpaySignature);
    if (!hasPayment && (razorpayOrderId || razorpayPaymentId || razorpaySignature)) {
      return res.status(400).json({ message: "Incomplete payment details. Please start a fresh payment." });
    }
    if (hasPayment) {
      if (!process.env.RAZORPAY_KEY_SECRET) {
        return res.status(503).json({ message: "Payments cannot be verified right now. Try again later." });
      }
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest("hex");
      if (!signaturesEqual(expectedSignature, razorpaySignature)) {
        return res.status(402).json({ message: "Payment verification failed. Please try paying again." });
      }
    }
    const startMin = strictStart;
    const endMin = strictEnd;
    const billedHours = (endMin - startMin) / 60;
    if (![1, 2, 3, 4].includes(billedHours)) {
      return res.status(400).json({ message: "Sessions run 1–4 hours" });
    }
    if (req.body.durationHours != null && req.body.durationHours !== "") {
      const stated = Number(req.body.durationHours);
      if (!Number.isFinite(stated) || Math.abs(stated - billedHours) > 0.001) {
        return res.status(400).json({ message: "Duration does not match the selected time slot" });
      }
    }
    const slabPrice = slabPriceForDuration(billedHours);
    if (slabPrice == null) {
      return res.status(400).json({ message: "Sessions run 1–4 hours" });
    }
    let couponCode = "";
    let discount = 0;
    const rawCode = normalizeCode(req.body.couponCode);
    if (rawCode) {
      const coupon = await findCouponByCode(rawCode);
      const isFirstBooking =
        (await Booking.countDocuments({ customer: req.user.id })) === 0;
      const reason = rejectionReason(coupon, {
        amount: slabPrice,
        userId: req.user.id,
        serviceType: req.body.serviceType,
        isFirstBooking,
      });
      if (reason) {
        return res.status(400).json({ message: reason });
      }
      discount = computeDiscount(coupon, slabPrice);
      if (discount <= 0) {
        return res.status(400).json({ message: "This coupon gives no discount on this order." });
      }
      const userIdStr = String(req.user.id);
      const redeemed = await Coupon.findOneAndUpdate(
        {
          _id: coupon._id,
          $expr: {
            $and: [
              { $ne: ["$active", false] },
              ...(coupon.usageLimit != null
                ? [{ $lt: [{ $ifNull: ["$usedCount", 0] }, Number(coupon.usageLimit)] }]
                : []),
              ...(coupon.perUserLimit != null
                ? [
                    {
                      $lt: [
                        {
                          $size: {
                            $filter: {
                              input: { $ifNull: ["$usedBy", []] },
                              cond: { $eq: [{ $toString: "$$this" }, userIdStr] },
                            },
                          },
                        },
                        Number(coupon.perUserLimit),
                      ],
                    },
                  ]
                : []),
              ...(coupon.firstBookingOnly
                ? [{ $eq: [{ $literal: isFirstBooking }, true] }]
                : []),
            ],
          },
        },
        { $inc: { usedCount: 1 }, $push: { usedBy: req.user.id } },
        { new: true }
      );
      if (!redeemed) {
        return res.status(409).json({
          message: "This coupon was just fully redeemed. Please try another code.",
        });
      }
      couponCode = redeemed.code;
    }
    const { finalAmount, commission, cookPayout } = splitPayout(slabPrice - discount);
    const expectedAmount = finalAmount;
    const redeemedRef = { couponCode, customer: req.user.id };
    if (hasPayment) {
      const paidAmount = Number(req.body.amount ?? payment.paidAmount);
      if (!Number.isFinite(paidAmount) || Math.round(paidAmount) !== expectedAmount) {
        await releaseCouponUsage(redeemedRef);
        return res.status(400).json({
          message: `Paid amount does not match the payable fee of ₹${expectedAmount}. Please create a fresh payment.`,
        });
      }
      const orderErr = await assertRazorpayOrderAmount(razorpayOrderId, expectedAmount * 100);
      if (orderErr) {
        await releaseCouponUsage(redeemedRef);
        return res.status(402).json({ message: orderErr });
      }
      const captureErr = await assertRazorpayPaymentCaptured(
        razorpayOrderId,
        razorpayPaymentId,
        expectedAmount * 100
      );
      if (captureErr) {
        await releaseCouponUsage(redeemedRef);
        return res.status(402).json({ message: captureErr });
      }
    }

    let booking;
    try {
      booking = await Booking.create({
        customer: req.user.id,
        cook: null,
        ignoredBy: [],
        ...pickBookingCustomerFields(req.body),
        durationHours: billedHours,
        date: istMidnight(date),
        ...(clientKey ? { clientKey } : {}),
        amount: expectedAmount,
        slabPrice,
        couponCode,
        discount,
        commission,
        cookPayout,
        // Persisted atomically with the booking: the explicit YES that
        // authorized THIS request (verified strictly above).
        womanPresenceConfirmed: true,
        womanPresenceConfirmedAt: new Date(),
        payoutInfo: (() => {
          try {
            const { buildPayoutSnapshot } = require("../utils/cookEarnings");
            return buildPayoutSnapshot({
              regularPrice: slabPrice,
              discountAmount: discount,
              finalCustomerPrice: expectedAmount,
            });
          } catch {
            return undefined;
          }
        })(),
        payment: hasPayment
          ? {
              razorpayOrderId,
              razorpayPaymentId,
              razorpaySignature,
              status: "paid",
              paidAmount: expectedAmount,
              paidAt: new Date(),
            }
          : {
              status: "pending",
              paidAmount: 0,
            },
        status: "requested",
        requestExpiresAt: new Date(Date.now() + REQUEST_WINDOW_MS),
        statusHistory: [{ status: "requested" }],
        serviceOtp: generateServiceOtp(),
        serviceOtpGeneratedAt: new Date(),
      });
    } catch (createErr) {
      if (couponCode) {
        try {
          await releaseCouponUsage(redeemedRef);
        } catch {
        }
      }
      if (createErr?.code === 11000 && createErr?.keyPattern?.["payment.razorpayPaymentId"] != null) {
        return res.status(409).json({
          message: "This payment has already been recorded for another booking.",
        });
      }
      if (createErr?.code === 11000 && createErr?.keyPattern?.clientKey != null && clientKey) {
        try {
          const original = await Booking.findOne({ clientKey, customer: req.user.id });
          if (original) {
            const originalObj = original.toObject ? original.toObject() : original;
            return res.status(200).json({ ...originalObj, alreadyExists: true });
          }
        } catch {
        }
      }
      throw createErr;
    }

    try {
      const { start: raceDayStart, end: raceDayEnd } = dayBounds(booking.date);
      const rivals = await Booking.find({
        customer: req.user.id,
        _id: { $ne: booking._id },
        date: { $gte: raceDayStart, $lte: raceDayEnd },
        $or: activeSlotMatch(),
      }).select("startTime endTime status");
      const raceStart = timeToMinutes(booking.startTime);
      const raceEnd = timeToMinutes(booking.endTime);
      const beaten = (rivals || []).some((r) => {
        const rs = timeToMinutes(r.startTime);
        const re = timeToMinutes(r.endTime);
        return (
          rs != null &&
          re != null &&
          intervalsOverlap(raceStart, raceEnd, rs, re) &&
          String(r._id) < String(booking._id)
        );
      });
      if (beaten) {
        if (clientKey && dbReady()) {
          try {
            const mine = await Booking.findOne({ clientKey, customer: req.user.id });
            if (mine && String(mine._id) !== String(booking._id)) {
              try {
                await releaseCouponUsage(booking);
              } catch {
              }
              await Booking.findByIdAndDelete(booking._id);
              const mineObj = mine.toObject ? mine.toObject() : mine;
              return res.status(200).json({ ...mineObj, alreadyExists: true });
            }
          } catch {
          }
        }
        try {
          await releaseCouponUsage(booking);
        } catch {
        }
        try {
          if (booking.payment?.status === "paid" && !booking.payment?.testMode) {
            queueRefundForApproval(booking, "race_slot_lost");
            try {
              await booking.save();
            } catch {
            }
          }
        } catch {
        }
        await Booking.findByIdAndDelete(booking._id);
        return res.status(409).json({
          message: "This slot was just claimed by another booking request. Please pick a different start time.",
        });
      }
    } catch {
    }

    if (couponCode) {
      try {
        const fetched = await Coupon.findOne({ code: couponCode });
        if (fetched?.firstBookingOnly && dbReady()) {
          const mine = await Booking.countDocuments({ customer: req.user.id });
          if (mine > 1) {
            try {
              await releaseCouponUsage({ couponCode, customer: req.user.id, _id: booking._id });
            } catch {
            }
            try {
              if (booking.payment?.status === "paid" && !booking.payment?.testMode) {
                queueRefundForApproval(booking, "coupon_first_booking_race");
                try {
                  await booking.save();
                } catch {
                }
              }
            } catch {
            }
            await Booking.findByIdAndDelete(booking._id);
            return res.status(409).json({
              message: "This coupon is only for your first booking.",
            });
          }
        }
      } catch {
      }
    }


    // Eligible cooks for the WhatsApp request fan-out. Assigned outside
    // the notification try-block so delivery bookkeeping never affects
    // the booking response.
    let whatsappCandidates = [];
    try {
      let notifyCooks = eligibleCooks;
      try {
        const fresh = await findEligibleCooks({
          date,
          startTime,
          endTime,
          serviceType: req.body.serviceType,
        });
        if (fresh.length) notifyCooks = fresh;
      } catch {
      }
      try {
        whatsappCandidates = notifyCooks || [];
      } catch {
      }
      const notifDocs = (notifyCooks || []).map((c) => ({
        user: c.userId,
        type: "booking_request",
        booking: booking._id,
        message: `New booking request from ${req.user.name || "a customer"}`,
      }));

      try {
        const admins = await User.find({ role: "ADMIN", status: { $ne: "suspended" } }).select("_id").lean();
        for (const adminUser of admins || []) {
          notifDocs.push({
            user: adminUser._id,
            type: "booking_request",
            booking: booking._id,
            message: `New booking request from ${req.user.name || "a customer"}`,
          });
        }
      } catch {
      }

      for (const doc of notifDocs) {
        try {
          await Notification.create(doc);
        } catch {
        }
      }

      const targetUserIds = notifDocs.map((d) => String(d.user));
      realtime.emit(
        "booking_request",
        { booking: booking.toObject ? booking.toObject() : booking },
        { targetUserIds }
      );
    } catch {
    }

    notifyWhatsApp("request", booking, { customerName: req.user.name });
    // Durable cook fan-out: persist a dispatch job BEFORE responding so a
    // restart can never silently lose the WhatsApp work (the old unawaited
    // fan-out had no durable trace). The worker picks the job up within
    // seconds; a Meta failure still never fails the booking itself.
    try {
      await dispatchJobs.enqueueBookingRequestJob(booking._id);
      dispatchJobs.kickWorker();
    } catch {
    }

    const bookingObj = booking.toObject ? booking.toObject() : booking;
    res.status(201).json({ ...bookingObj, whatsappUrl: null, customerWhatsappUrl: null, cookPhone: null });
  } catch (error) {
    next(error);
  }
};

exports.expireBookingIfNeeded = expireBookingIfNeeded;
exports.queueRefundForApproval = queueRefundForApproval;
exports.releaseCouponUsage = releaseCouponUsage;
exports.REQUEST_WINDOW_MS = REQUEST_WINDOW_MS;
exports.PAYMENT_WINDOW_MS = PAYMENT_WINDOW_MS;
exports.isNoShowPastHours = isNoShowPastHours;
exports.markHoursCompleteIfNeeded = markHoursCompleteIfNeeded;
exports.cancelLocked = cancelLocked;
exports.rescheduleLocked = rescheduleLocked;
exports.RESCHEDULE_REASONS = RESCHEDULE_REASONS;
exports.normalizeRescheduleReason = normalizeRescheduleReason;

exports.getMyBookings = async (req, res, next) => {  try {
    const EXPIRY_GRACE_MS = 10 * 60 * 1000;
    const graceCutoff = new Date(Date.now() - EXPIRY_GRACE_MS);
    const filter = excludeUnpaidCancelled({
      customer: req.user.id,
      $or: [
        { status: { $ne: "expired" } },
        { status: "expired", requestExpiresAt: { $gt: graceCutoff } },
      ],
    });
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      Booking.find(filter).populate("cook", "name email phone").sort({ createdAt: -1 }).limit(HARD_CAP),
      pg
    );
    let reviewByBookingId = {};
    try {
      const Review = require("../models/Review");
      const reviews = await Review.find({
        booking: { $in: bookings.map((b) => b._id) },
      }).select("booking rating comment createdAt");
      reviewByBookingId = Object.fromEntries(
        reviews.map((r) => [r.booking.toString(), r.toObject ? r.toObject() : r])
      );
    } catch {
      reviewByBookingId = {};
    }
    const out = bookings.map((b) => {
      const obj = b.toObject ? b.toObject() : b;
      return {
        ...obj,
        review: reviewByBookingId[b._id.toString()] || null,
      };
    });
    await attachCookPhotoUrls(out);
    for (const b of bookings) {
      try {
        await markHoursCompleteIfNeeded(b);
        await expireBookingIfNeeded(b);
      } catch {
      }
    }
    const flagged = new Set(bookings.filter((b) => b.hoursCompleted).map((b) => b._id.toString()));
    let selfPhone = null;
    try {
      const self = await User.findById(req.user.id).select("phone name");
      selfPhone = self?.phone || null;
    } catch {
      selfPhone = null;
    }
    const finalOut = out.map((o) => {
      const match = bookings.find((b) => b._id.toString() === o._id.toString());
      if (match && flagged.has(o._id.toString())) {
        o.hoursCompleted = match.hoursCompleted;
        o.hoursCompletedAt = match.hoursCompletedAt;
      }
      if (match) {
        o.status = match.status;
        o.statusHistory = match.statusHistory;
        o.requestExpiresAt = match.requestExpiresAt;
        o.paymentExpiresAt = match.paymentExpiresAt;
      }
      const end = sessionEndDate(match || o);
      o.sessionEnd = end ? end.toISOString() : null;
      o.hoursCompleteWhatsappUrl = o.hoursCompleted
        ? buildHoursCompleteWhatsAppUrl({
            toPhone: selfPhone,
            booking: { ...o, hoursCompletedAt: o.hoursCompletedAt },
            cookName: o.cook?.name,
            cookPhone: o.cook?.phone,
            customerName: null,
          })
        : null;
      if (o.status === "completed") {
        const reviewUrl = `${FRONTEND_BASE_URL}/bookings/${o._id}`;
        o.reviewUrl = reviewUrl;
        o.reviewWhatsappUrl = buildReviewWhatsAppUrl({
          customerPhone: selfPhone,
          cookName: o.cook?.name,
          booking: o,
          reviewUrl,
        });
      } else {
        o.reviewUrl = null;
        o.reviewWhatsappUrl = null;
      }
      if (o.cook && typeof o.cook === "object" && !Array.isArray(o.cook)) {
        delete o.cook.email;
        if (o.status === "requested") delete o.cook.phone;
      }
      return o;
    });
    const visibleOut = finalOut.filter((o) => {
      if (isUnpaidBooking(o) && o.status === "cancelled") return false;
      if (o.status !== "expired") return true;
      const expiryRef = o.requestExpiresAt || o.updatedAt || o.createdAt;
      return expiryRef && new Date(expiryRef).getTime() > Date.now() - EXPIRY_GRACE_MS;
    });
    return sendList(res, visibleOut, pg, () => Booking.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

exports.getCookBookings = async (req, res, next) => {
  try {
    const filter = excludeUnpaidCancelled({ cook: req.user.id, status: { $ne: "expired" } });
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      Booking.find(filter).populate("customer", "name email phone").sort({ createdAt: -1 }).limit(HARD_CAP),
      pg
    );
    for (const b of bookings) {
      try {
        await markHoursCompleteIfNeeded(b);
        await expireBookingIfNeeded(b);
      } catch {
      }
    }
    const out = bookings.map((b) => {
      const obj = stripServiceOtp(b.toObject ? b.toObject() : b);
      const end = sessionEndDate(b);
      return { ...obj, sessionEnd: end ? end.toISOString() : null };
    });
    await attachCookPhotoUrls(out);
    let cookReviewByBookingId = {};
    try {
      const Review = require("../models/Review");
      const reviews = await Review.find({
        booking: { $in: bookings.map((b) => b._id) },
      })
        .populate("customer", "name")
        .select("booking customer rating comment createdAt");
      cookReviewByBookingId = Object.fromEntries(
        reviews.map((r) => [
          r.booking.toString(),
          { ...(r.toObject ? r.toObject() : r) },
        ])
      );
    } catch {
      cookReviewByBookingId = {};
    }
    let cookSelfPhone = null;
    try {
      const self = await User.findById(req.user.id).select("phone");
      cookSelfPhone = self?.phone || null;
    } catch {
      cookSelfPhone = null;
    }
    const finalCookOut = out.map((o) => {
      if (o.customer && typeof o.customer === "object" && !Array.isArray(o.customer)) {
        delete o.customer.email;
        if (o.status === "requested" || o.status === "expired") delete o.customer.phone;
      }
      return {
        ...o,
        review: cookReviewByBookingId[o._id.toString()] || null,
        hoursCompleteWhatsappUrl: o.hoursCompleted
          ? buildHoursCompleteWhatsAppUrl({
              toPhone: cookSelfPhone,
              booking: { ...o, hoursCompletedAt: o.hoursCompletedAt },
              cookName: null,
              cookPhone: cookSelfPhone,
              customerName: o.customer?.name,
            })
          : null,
      };
    });
    const now = Date.now();
    const visibleCookOut = finalCookOut.filter(
      (o) => o.status !== "expired" && !isNoShowPastHours(o, now) && !(o.status === "cancelled" && isUnpaidBooking(o))
    );
    return sendList(res, visibleCookOut, pg, () => Booking.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

exports.getCookRequests = async (req, res, next) => {
  try {
    const me = String(req.user.id);
    const now = new Date();
    const candidates = await Booking.find({
      status: "requested",
      $and: [{ cook: null }, { requestExpiresAt: { $gt: now } }],
      ignoredBy: { $ne: req.user.id },
    })
      .populate("customer", "name")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    let profile = null;
    try {
      profile = await CookProfile.findOne({ user: req.user.id }).lean();
    } catch {
      profile = null;
    }
    const eligibleNow = async (b) => {
      if (!profile || profile.approvalStatus !== "approved") return false;
      if (dbReady()) {
        try {
          const account = await User.findById(req.user.id).select("status").lean();
          if (!account || account.status === "suspended") return false;
        } catch {
          return false;
        }
      }
      try {
        if (!(await resolveCookAvailability(profile))) return false;
      } catch {
        return false;
      }
      if (
        Array.isArray(profile.serviceTypes) &&
        profile.serviceTypes.length > 0 &&
        b.serviceType &&
        !profile.serviceTypes.includes(b.serviceType)
      ) {
        return false;
      }
      const dayStr = istDayString(b.date);
      let windows = [];
      try {
        windows = await getDayWindows(req.user.id, dayStr);
      } catch {
        return false;
      }
      if (!findContainingWindow(windows, b.startTime, b.endTime)) return false;
      try {
        const rivals = await getDayBookings(req.user.id, dayStr);
        if (findOverlapBooking(rivals.filter((r) => String(r._id) !== String(b._id)), b.startTime, b.endTime)) return false;
      } catch {
        return false;
      }
      return true;
    };
    const out = [];
    for (const b of candidates || []) {
      if (Array.isArray(b.ignoredBy) && b.ignoredBy.map((id) => String(id)).includes(me)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        if (!(await eligibleNow(b))) continue;
      } catch {
        continue;
      }
      const obj = { ...b };
      if (obj.customer && typeof obj.customer === "object") {
        delete obj.customer.email;
        delete obj.customer.phone;
      }
      out.push(stripServiceOtp(obj));
    }
    res.json(out);
  } catch (error) {
    next(error);
  }
};

const SCHEDULE_ELIGIBLE_STATUSES = ["accepted", "confirmed", "in_progress", "completed"];
exports.SCHEDULE_ELIGIBLE_STATUSES = SCHEDULE_ELIGIBLE_STATUSES;

exports.getCookSchedule = async (req, res, next) => {
  try {
    const rawDay = String(req.query?.day || "today").trim().toLowerCase();
    let dayStr;
    if (rawDay === "today") {
      dayStr = istDayString(new Date());
    } else if (rawDay === "tomorrow") {
      const t = new Date(Date.now() + 24 * 60 * 60 * 1000);
      dayStr = istDayString(t);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDay) && parseDayStrict(rawDay)) {
      dayStr = rawDay;
    } else {
      return res.status(400).json({ message: "day must be today, tomorrow, or YYYY-MM-DD" });
    }
    const { start: dayStart, end: dayEnd } = dayBounds(dayStr);
    const filter = {
      cook: req.user.id,
      date: { $gte: dayStart, $lte: dayEnd },
      status: { $in: SCHEDULE_ELIGIBLE_STATUSES },
      "payment.status": "paid",
    };
    const bookings = await Booking.find(filter)
      .populate("customer", "name phone")
      .sort({ startTime: 1 })
      .limit(HARD_CAP)
      .lean();
    for (const b of bookings || []) {
      try {
        await markHoursCompleteIfNeeded(b);
      } catch {
      }
    }
    const out = [];
    for (const b of bookings || []) {
      if (!SCHEDULE_ELIGIBLE_STATUSES.includes(b.status)) continue;
      if (!b.payment || b.payment.status !== "paid") continue;
      const obj = stripServiceOtp(b);
      const end = sessionEndDate(b);
      if (obj.customer && typeof obj.customer === "object" && !Array.isArray(obj.customer)) {
        delete obj.customer.email;
      }
      out.push({ ...obj, sessionEnd: end ? end.toISOString() : null });
    }
    await attachCookPhotoUrls(out);
    res.json(out);
  } catch (error) {
    next(error);
  }
};

exports.acceptBooking = async (req, res, next) => {
  try {
    const isAdmin = String(req.user.role).toUpperCase() === "ADMIN";
    if (!isAdmin) {
      // Website cooks share one acceptance service with the WhatsApp
      // channel — same validations, same atomic claim, same side effects.
      try {
        const { booking, alreadyAccepted } = await acceptBookingForCook({
          bookingId: req.params.id,
          cookId: req.user.id,
          source: "website",
        });
        let customerWhatsappUrl = null;
        let cookPhoneForCustomer = null;
        try {
          const cookUser = await User.findById(req.user.id).select("name phone");
          const customer = await User.findById(booking.customer).select("phone");
          cookPhoneForCustomer = cookUser?.phone || null;
          customerWhatsappUrl = buildCustomerWhatsAppUrl({
            customerPhone: customer?.phone,
            cookName: cookUser?.name,
            cookPhone: cookUser?.phone,
            booking,
          });
        } catch {
          customerWhatsappUrl = null;
        }
        const obj = stripServiceOtp(booking);
        if (alreadyAccepted) {
          return res.json({ success: true, ...obj, alreadyAccepted: true });
        }
        return res.json({ success: true, ...obj, customerWhatsappUrl, cookPhone: cookPhoneForCustomer });
      } catch (err) {
        if (err && err.statusCode) {
          if (err.code) {
            return res.status(err.statusCode).json({ success: false, code: err.code, message: err.message });
          }
          return res.status(err.statusCode).json({ message: err.message });
        }
        throw err;
      }
    }
    let booking = await Booking.findOne({ _id: req.params.id });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const assignedCookId = booking.cook ? String(booking.cook) : null;
    if (!isAdmin) {
      if (assignedCookId && assignedCookId !== String(req.user.id)) {
        if (booking.status === "accepted") {
          return res.status(409).json({
            success: false,
            code: "BOOKING_ALREADY_ASSIGNED",
            message: "This booking has already been accepted by another cook.",
          });
        }
        return res.status(404).json({ message: "Booking not found" });
      }
    }
    const actingCookId = isAdmin
      ? assignedCookId || String(req.body?.cookId || req.body?.cook || "")
      : String(req.user.id);
    if (isAdmin && !assignedCookId && !actingCookId) {
      return res.status(400).json({ message: "Choose the cook to assign this request to." });
    }
    if (booking.status !== "requested") {
      const wonByMe =
        booking.status === "accepted" &&
        assignedCookId &&
        (isAdmin || assignedCookId === String(req.user.id));
      if (wonByMe) {
        if (isAdmin) {
          const requestedCook = String(req.body?.cookId || req.body?.cook || "");
          if (requestedCook && requestedCook !== String(assignedCookId)) {
            return res.status(409).json({
              success: false,
              code: "BOOKING_ALREADY_ASSIGNED",
              message: "This booking has already been accepted by another cook.",
            });
          }
        }
        const obj = stripServiceOtp(booking.toObject ? booking.toObject() : booking);
        return res.json({ success: true, ...obj, alreadyAccepted: true });
      }
      return res.status(400).json({ message: "Only pending requests can be accepted" });
    }
    if (
      !isAdmin &&
      !assignedCookId &&
      Array.isArray(booking.ignoredBy) &&
      booking.ignoredBy.map((id) => String(id)).includes(String(req.user.id))
    ) {
      return res.status(409).json({
        success: false,
        code: "BOOKING_IGNORED_BY_YOU",
        message: "You already ignored this request.",
      });
    }

    if (booking.requestExpiresAt && booking.requestExpiresAt < new Date()) {
      booking.status = "expired";
      booking.statusHistory.push({
        status: "expired",
        note: "Cook did not respond within 5 minutes",
      });
      await booking.save();
      await releaseCouponUsage(booking);
      await Notification.create({
        user: booking.customer,
        type: "booking_expired",
        booking: booking._id,
        message:
          "Your booking request expired — the cook didn't respond within 5 minutes. Please find another cook.",
      });
      try {
        realtime.emit("booking_expired", {
          bookingId: String(booking._id),
          customerId: String(booking.customer),
        });
      } catch {
      }
      return res.status(410).json({
        message:
          "This request expired after 5 minutes. The customer has been notified to choose another cook.",
      });
    }

    const cookIdForCheck = isAdmin ? actingCookId : req.user.id;
    if (!isAdmin && !assignedCookId) {
      try {
        const profile = await CookProfile.findOne({ user: req.user.id });
        if (!profile || profile.approvalStatus !== "approved") {
          return res.status(409).json({
            success: false,
            code: "COOK_NOT_ELIGIBLE",
            message: "Your cook profile is not approved for new requests right now.",
          });
        }
        if (dbReady()) {
          try {
            const account = await User.findById(req.user.id).select("status");
            if (!account || account.status === "suspended") {
              return res.status(409).json({
                success: false,
                code: "COOK_NOT_ELIGIBLE",
                message: "Your account cannot accept requests right now.",
              });
            }
          } catch {
            return res.status(500).json({ message: "Could not verify your account right now. Please try again." });
          }
        }
        if (!(await resolveCookAvailability(profile))) {
          return res.status(409).json({
            success: false,
            code: "COOK_NOT_ELIGIBLE",
            message: "You are marked unavailable — flip back to Available to accept requests.",
          });
        }
        if (
          Array.isArray(profile.serviceTypes) &&
          profile.serviceTypes.length > 0 &&
          booking.serviceType &&
          !profile.serviceTypes.includes(booking.serviceType)
        ) {
          return res.status(409).json({
            success: false,
            code: "COOK_NOT_ELIGIBLE",
            message: "This request is for a service you don't offer.",
          });
        }
        const dayStrForWindows = istDayString(booking.date);
        let windows = [];
        try {
          windows = await getDayWindows(req.user.id, dayStrForWindows);
        } catch {
          windows = [];
        }
        if (!findContainingWindow(windows, booking.startTime, booking.endTime)) {
          return res.status(409).json({
            success: false,
            code: "COOK_NOT_ELIGIBLE",
            message: "You are not available for that time anymore.",
          });
        }
      } catch (e) {
        if (e?.statusCode) throw e;
        return res.status(500).json({ message: "Could not verify eligibility right now. Please try again." });
      }
    }
    if (isAdmin && !assignedCookId && actingCookId) {
      try {
        const profile = await CookProfile.findOne({ user: actingCookId });
        if (!profile || profile.approvalStatus !== "approved") {
          return res.status(409).json({
            success: false,
            code: "COOK_NOT_ELIGIBLE",
            message: "That cook is not approved for new requests.",
          });
        }
        if (dbReady()) {
          try {
            const account = await User.findById(actingCookId).select("status");
            if (!account || account.status === "suspended") {
              return res.status(409).json({
                success: false,
                code: "COOK_NOT_ELIGIBLE",
                message: "That cook's account cannot take requests right now.",
              });
            }
          } catch {
            return res.status(500).json({ message: "Could not verify that cook right now. Please try again." });
          }
        }
        try {
          if (!(await resolveCookAvailability(profile))) {
            return res.status(409).json({
              success: false,
              code: "COOK_NOT_ELIGIBLE",
              message: "That cook is marked unavailable right now.",
            });
          }
        } catch {
          return res.status(500).json({ message: "Could not verify that cook right now. Please try again." });
        }
        if (
          Array.isArray(profile.serviceTypes) &&
          profile.serviceTypes.length > 0 &&
          booking.serviceType &&
          !profile.serviceTypes.includes(booking.serviceType)
        ) {
          return res.status(409).json({
            success: false,
            code: "COOK_NOT_ELIGIBLE",
            message: "That cook doesn't offer the requested service.",
          });
        }
        try {
          const dayStrForAdminPick = istDayString(booking.date);
          let adminWindows = [];
          try {
            adminWindows = await getDayWindows(actingCookId, dayStrForAdminPick);
          } catch {
            adminWindows = [];
          }
          if (!findContainingWindow(adminWindows, booking.startTime, booking.endTime)) {
            return res.status(409).json({
              success: false,
              code: "COOK_NOT_ELIGIBLE",
              message: "That cook is not available for that time anymore.",
            });
          }
        } catch {
          return res.status(500).json({ message: "Could not verify that cook right now. Please try again." });
        }
      } catch (e) {
        if (e?.statusCode) throw e;
        return res.status(500).json({ message: "Could not verify that cook right now. Please try again." });
      }
    }
    try {
      const { start: dayStart, end: dayEnd } = dayBounds(booking.date);
      const rivals = await Booking.find({
        cook: cookIdForCheck,
        _id: { $ne: booking._id },
        date: { $gte: dayStart, $lte: dayEnd },
        status: { $in: ["accepted", "confirmed", "in_progress"] },
      }).select("startTime endTime status");
      const s = timeToMinutes(booking.startTime);
      const e = timeToMinutes(booking.endTime);
      const overlaps = (rivals || []).some((r) => {
        const rs = timeToMinutes(r.startTime);
        const re = timeToMinutes(r.endTime);
        return rs != null && re != null && intervalsOverlap(s, e, rs, re);
      });
      if (overlaps) {
        return res.status(409).json({
          success: false,
          code: "SLOT_UNAVAILABLE",
          message: "This slot has already been booked (another request was accepted). Please decline this request.",
        });
      }
    } catch {
      return res.status(500).json({
        message: "Could not verify slot availability right now. Please try again.",
      });
    }

    const acceptNote =
      isAdmin ? "Accepted by admin on behalf of the cook" : undefined;
    let acceptClaimed = false;
    if (dbReady()) {
      try {
        const nowForClaim = new Date();
        const claimFilter = { _id: booking._id, status: "requested", requestExpiresAt: { $gt: nowForClaim } };
        let claimUpdate;
        if (!isAdmin && !assignedCookId) {
          claimFilter.cook = null;
          claimUpdate = {
            $set: {
              cook: req.user.id,
              status: "accepted",
              paymentExpiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS),
            },
            $push: { statusHistory: { status: "accepted", note: `Accepted by cook ${req.user.id}` } },
          };
        } else if (isAdmin && !assignedCookId) {
          claimFilter.cook = null;
          claimUpdate = {
            $set: {
              cook: actingCookId,
              status: "accepted",
              paymentExpiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS),
            },
            $push: { statusHistory: { status: "accepted", note: acceptNote } },
          };
        } else {
          if (!isAdmin) claimFilter.cook = req.user.id;
          else if (assignedCookId) claimFilter.cook = booking.cook;
          claimUpdate = {
            $set: {
              status: "accepted",
              paymentExpiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS),
            },
          };
          if (acceptNote) {
            claimUpdate.$push = { statusHistory: { status: "accepted", note: acceptNote } };
          } else {
            claimUpdate.$push = { statusHistory: { status: "accepted" } };
          }
        }
        const claim = await Booking.updateOne(claimFilter, claimUpdate);
        if ((claim.modifiedCount ?? claim.nModified ?? 0) === 1) {
          acceptClaimed = true;
        }
      } catch {
        acceptClaimed = false;
      }
      if (acceptClaimed) {
        try {
          const fresh = await Booking.findById(booking._id);
          if (fresh) booking = fresh;
        } catch {
        }
      } else {
        let latest = null;
        try {
          latest = await Booking.findById(booking._id);
        } catch {
          latest = null;
        }
        if (!latest) {
          return res.status(404).json({ message: "Booking not found" });
        }
        if (latest.status !== "requested") {
          const alreadyWon = latest.cook && latest.status === "accepted";
          return res.status(409).json({
            success: false,
            code: alreadyWon ? "BOOKING_ALREADY_ASSIGNED" : "BOOKING_INVALID_STATE",
            message: alreadyWon
              ? "This booking has already been accepted by another cook."
              : "This request was just handled — please refresh to see its current status.",
          });
        }
        if (latest.requestExpiresAt && latest.requestExpiresAt <= new Date()) {
          return res.status(410).json({
            success: false,
            code: "BOOKING_REQUEST_EXPIRED",
            message: "This cook request has expired.",
          });
        }
        if (latest.cook && String(latest.cook) !== String(cookIdForCheck)) {
          return res.status(409).json({
            success: false,
            code: "BOOKING_ALREADY_ASSIGNED",
            message: "This booking has already been accepted by another cook.",
          });
        }
        return res.status(409).json({
          success: false,
          code: "BOOKING_INVALID_STATE",
          message: "Another accept is being processed for this request. Please try again.",
        });
      }
    }
    if (!acceptClaimed) {
      if (!assignedCookId) booking.cook = cookIdForCheck;
      booking.status = "accepted";
      booking.statusHistory.push({
        status: "accepted",
        ...(acceptNote ? { note: acceptNote } : !assignedCookId ? { note: `Accepted by cook ${cookIdForCheck}` } : {}),
      });
      booking.paymentExpiresAt = new Date(Date.now() + PAYMENT_WINDOW_MS);
      await booking.save();
    }

    let acceptClash = false;
    try {
      const { start: vStart, end: vEnd } = dayBounds(booking.date);
      const postRivals = await Booking.find({
        cook: booking.cook,
        _id: { $ne: booking._id },
        date: { $gte: vStart, $lte: vEnd },
        status: { $in: ["accepted", "confirmed", "in_progress"] },
      }).select("startTime endTime status");
      const myStart = timeToMinutes(booking.startTime);
      const myEnd = timeToMinutes(booking.endTime);
      acceptClash = (postRivals || []).some((r) => {
        const rs = timeToMinutes(r.startTime);
        const re = timeToMinutes(r.endTime);
        return rs != null && re != null && intervalsOverlap(myStart, myEnd, rs, re);
      });
    } catch {
      acceptClash = false; // verification unavailable — keep today's behavior
    }
    if (acceptClash) {
      let latest = null;
      if (dbReady()) {
        try {
          latest = await Booking.findById(booking._id);
        } catch {
          latest = null;
        }
      }
      if (!latest || latest.status !== "accepted" || latest.payment?.status === "paid") {
        const kept = latest || booking;
        const keptObj = stripServiceOtp(kept);
        return res.status(409).json({
          ...keptObj,
          message: "This slot was just confirmed for another request. Your booking was kept as-is — please contact support if you were charged.",
          code: "SLOT_UNAVAILABLE",
        });
      }
      latest.status = "requested";
      latest.paymentExpiresAt = null;
      if (!assignedCookId) latest.cook = null;
      latest.requestExpiresAt = new Date(Date.now() + REQUEST_WINDOW_MS);
      latest.statusHistory.push({
        status: "requested",
        note: "Accept rolled back — the slot was just confirmed for another request",
      });
      try {
        await latest.save();
      } catch {
      }
      return res.status(409).json({
        message: "This slot was just confirmed for another request. Please decline this one.",
        code: "SLOT_UNAVAILABLE",
      });
    }

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
    notifyWhatsApp("accepted", booking, {
      notifyCook: String(req.user.role).toUpperCase() === "ADMIN",
    });

    if (String(req.user.role).toUpperCase() === "ADMIN") {
      try {
        const customerUser = await User.findById(booking.customer).select("name");
        const dateLabel = new Date(booking.date).toLocaleDateString("en-IN", {
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric",
        });
        await Notification.create({
          user: booking.cook,
          type: "booking_accepted",
          booking: booking._id,
          message: `An admin accepted a service request on your behalf for ${
            customerUser?.name || "a customer"
          } — ${dateLabel}, ${booking.startTime}–${booking.endTime}. The slot is booked; the customer has 5 minutes to complete payment.`,
        });
      } catch {
      }
    }

    let customerWhatsappUrl = null;
    let cookPhoneForCustomer = null;
    const cookId = String(req.user.role).toUpperCase() === "ADMIN" ? booking.cook : req.user.id;
    try {
      const cookUser = await User.findById(cookId).select("name phone");
      const customer = await User.findById(booking.customer).select("phone");
      cookPhoneForCustomer = cookUser?.phone || null;
      customerWhatsappUrl = buildCustomerWhatsAppUrl({
        customerPhone: customer?.phone,
        cookName: cookUser?.name,
        cookPhone: cookUser?.phone,
        booking,
      });
    } catch {
      customerWhatsappUrl = null;
    }

    try {
      realtime.emit("booking_assigned", {
        bookingId: String(booking._id),
        assignedCookId: String(booking.cook),
        customerId: String(booking.customer),
      });
    } catch {
    }

    const obj = stripServiceOtp(booking);
    res.json({ success: true, ...obj, customerWhatsappUrl, cookPhone: cookPhoneForCustomer });
  } catch (error) {
    next(error);
  }
};

exports.rejectBooking = async (req, res, next) => {
  try {
    const isAdmin = String(req.user.role).toUpperCase() === "ADMIN";
    if (!isAdmin) {
      // Website cooks share one rejection service with the WhatsApp
      // channel — broadcast ignores keep status=requested, direct
      // declines reject the request.
      try {
        const { booking, ignored } = await rejectBookingForCook({
          bookingId: req.params.id,
          cookId: req.user.id,
          source: "website",
        });
        if (ignored) {
          const out = stripServiceOtp(booking.toObject ? booking.toObject() : booking);
          return res.json({
            success: true,
            ...out,
            status: "requested",
            ignored: true,
            code: "BOOKING_STILL_REQUESTED",
            message: "Request ignored — the customer is still waiting for another cook.",
          });
        }
        return res.json(stripServiceOtp(booking));
      } catch (err) {
        if (err && err.statusCode) {
          if (err.code) {
            return res.status(err.statusCode).json({ success: false, code: err.code, message: err.message });
          }
          return res.status(err.statusCode).json({ message: err.message });
        }
        throw err;
      }
    }
    let booking = await Booking.findOne({ _id: req.params.id });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const assignedCookId = booking.cook ? String(booking.cook) : null;
    const filter = { _id: req.params.id };
    if (!isAdmin && assignedCookId) {
      if (assignedCookId !== String(req.user.id)) {
        return res.status(404).json({ message: "Booking not found" });
      }
      filter.cook = req.user.id;
    }
    await expireBookingIfNeeded(booking);
    if (booking.status !== "requested") {
      return res.status(400).json({ message: "Only pending requests can be declined" });
    }

    if (!assignedCookId && !isAdmin) {
      const me = String(req.user.id);
      try {
        if (dbReady()) {
          await Booking.updateOne(
            { _id: booking._id, status: "requested" },
            { $addToSet: { ignoredBy: req.user.id } }
          );
          const fresh = await Booking.findById(booking._id);
          if (fresh) booking = fresh;
          if (booking.status !== "requested") {
            return res.status(409).json({
              success: false,
              code: "BOOKING_INVALID_STATE",
              message: "This request was just handled — please refresh to see its current status.",
            });
          }
        } else {
          booking.ignoredBy = booking.ignoredBy || [];
          if (!booking.ignoredBy.map((id) => String(id)).includes(me)) {
            booking.ignoredBy.push(req.user.id);
          }
          if (typeof booking.save === "function") await booking.save();
        }
      } catch {
      }
      try {
        realtime.emit("booking_ignored", {
          bookingId: String(booking._id),
          cookId: String(req.user.id),
        });
      } catch {
      }

      const out = stripServiceOtp(booking.toObject ? booking.toObject() : booking);
      return res.json({
        success: true,
        ...out,
        status: "requested",
        ignored: true,
        code: "BOOKING_STILL_REQUESTED",
        message: "Request ignored — the customer is still waiting for another cook.",
      });
    }

    const rejectNote =
      String(req.user.role).toUpperCase() === "ADMIN" ? { note: "Declined by admin on behalf of the cook" } : {};
    let rejectClaimed = false;
    if (dbReady()) {
      try {
        const claimFilter = { _id: booking._id, status: "requested" };
        if (filter.cook) claimFilter.cook = filter.cook;
        const claim = await Booking.updateOne(claimFilter, {
          $set: { status: "rejected" },
          $push: { statusHistory: { status: "rejected", ...rejectNote } },
        });
        if ((claim.modifiedCount ?? claim.nModified ?? 0) === 1) {
          rejectClaimed = true;
        }
      } catch {
        rejectClaimed = false;
      }
      if (rejectClaimed) {
        try {
          const fresh = await Booking.findOne(filter);
          if (fresh) booking = fresh;
        } catch {
        }
      } else {
        let latest = null;
        try {
          latest = await Booking.findOne(filter);
        } catch {
          latest = null;
        }
        if (!latest) {
          return res.status(404).json({ message: "Booking not found" });
        }
        if (latest.status !== "requested") {
          return res.status(409).json({
            message: "This request was just handled — please refresh to see its current status.",
            code: "BOOKING_INVALID_STATE",
          });
        }
        return res.status(409).json({
          message: "Another action is being processed for this request. Please try again.",
          code: "BOOKING_INVALID_STATE",
        });
      }
    }
    if (!rejectClaimed) {
      booking.status = "rejected";
      booking.statusHistory.push({ status: "rejected", ...rejectNote });
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
    await booking.save();
    await releaseCouponUsage(booking);


    try {
      await Notification.create({
        user: booking.customer,
        type: "booking_rejected",
        booking: booking._id,
        message: `Your booking request has been rejected.${rejectRefundNote}`,
      });
    } catch {
    }
    notifyWhatsApp("rejected", booking, {
      refundNote: rejectRefundNote || undefined,
    });

    if (String(req.user.role).toUpperCase() === "ADMIN" && booking.cook) {
      try {
        await Notification.create({
          user: booking.cook,
          type: "booking_rejected",
          booking: booking._id,
          message: "An admin declined a service request on your behalf — the slot remains open.",
        });
      } catch {
      }
    }

    res.json(stripServiceOtp(booking));
  } catch (error) {
    next(error);
  }
};

exports.completeBooking = async (req, res, next) => {
  try {
    const filter = { _id: req.params.id };
    if (String(req.user.role).toUpperCase() !== "ADMIN") filter.cook = req.user.id;
    let booking = await Booking.findOne(filter);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (booking.status === "completed") {
      const completedObj = stripServiceOtp(booking);
      return res.json({ ...completedObj, alreadyCompleted: true });
    }
    if (!["confirmed", "in_progress"].includes(booking.status)) {
      return res.status(400).json({ message: "Only paid, live (confirmed) bookings can be marked completed" });
    }
    if (booking.payment?.status !== "paid") {
      return res.status(400).json({ message: "Only paid bookings can be marked completed" });
    }
    if (String(req.user.role).toUpperCase() !== "ADMIN" && !booking.serviceStartedAt) {
      const end = sessionEndDate(booking);
      const legacyOk =
        booking.hoursCompleted === true &&
        end &&
        Date.now() >= end.getTime() + 24 * 60 * 60 * 1000;
      if (!legacyOk) {
        return res.status(400).json({ message: "Service has not started yet — completion is available after the OTP-verified start" });
      }
    }

    if (dbReady()) {
      let claimOk = false;
      try {
        const claimFilter = {
          _id: booking._id,
          status: { $in: ["confirmed", "in_progress"] },
          "payment.status": "paid",
        };
        if (String(req.user.role).toUpperCase() !== "ADMIN") claimFilter.cook = req.user.id;
        const claim = await Booking.updateOne(claimFilter, {
          $set: { status: "completed" },
          $push: { statusHistory: { status: "completed" } },
        });
        claimOk = (claim.modifiedCount ?? claim.nModified ?? 0) === 1;
      } catch {
        claimOk = false;
      }
      if (!claimOk) {
        let latest = null;
        try {
          latest = await Booking.findOne(filter);
        } catch {
          latest = null;
        }
        if (!latest) {
          return res.status(404).json({ message: "Booking not found" });
        }
        if (latest.status === "completed") {
          const completedObj = stripServiceOtp(latest);
          return res.json({ ...completedObj, alreadyCompleted: true });
        }
        return res.status(409).json({
          message: "This booking was just updated — please refresh to see its current status.",
          code: "BOOKING_INVALID_STATE",
        });
      }
      try {
        const fresh = await Booking.findOne(filter);
        if (fresh) booking = fresh;
      } catch {
      }
    } else {
      booking.status = "completed";
      booking.statusHistory.push({ status: "completed" });
      await booking.save();
    }

    let cookNameForMsg = "your cook";
    try {
      const cookUser = await User.findById(booking.cook).select("name");
      if (cookUser?.name) cookNameForMsg = cookUser.name;
    } catch {
    }
    try {
      await Notification.create({
        user: booking.customer,
        type: "booking_completed",
        booking: booking._id,
        message: `Service complete! ${cookNameForMsg} finished your session — please rate your cook.`,
      });
    } catch {
    }
    try {
      await Notification.create({
        user: booking.cook,
        type: "booking_completed",
        booking: booking._id,
        message: "Service marked complete — the customer has been asked to rate the session.",
      });
    } catch {
    }

    let reviewWhatsappUrl = null;
    let reviewUrl = `${FRONTEND_BASE_URL}/bookings/${booking._id}`;
    try {
      const customer = await User.findById(booking.customer).select("phone");
      reviewWhatsappUrl = buildReviewWhatsAppUrl({
        customerPhone: customer?.phone,
        cookName: cookNameForMsg,
        booking,
        reviewUrl,
      });
    } catch {
      reviewWhatsappUrl = null;
    }

    const completedObj = stripServiceOtp(booking);
    res.json({ ...completedObj, reviewWhatsappUrl, reviewUrl });
  } catch (error) {
    next(error);
  }
};

exports.deleteBooking = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.customer.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const DELETABLE_STATUSES = ["requested", "rejected", "expired", "cancelled"];
    if (!DELETABLE_STATUSES.includes(booking.status)) {
      return res.status(400).json({
        message: "Only bookings that were not accepted by the cook, or that you cancelled, can be deleted",
      });
    }

    if (booking.payment?.status === "paid") {
      return res.status(400).json({
        message: "This booking has a payment history and cannot be deleted. Please contact support.",
      });
    }

    await Booking.findByIdAndDelete(booking._id);
    if (booking.status === "requested") {
      await releaseCouponUsage(booking);
    }
    if (booking.cook) {
      try {
        await Notification.create({
          user: booking.cook,
          type: "booking_cancelled",
          booking: booking._id,
          message: "The customer withdrew their pending booking request — the slot is free again.",
        });
      } catch {
      }
    }
    res.json({ message: "Booking deleted", id: req.params.id });
  } catch (error) {
    next(error);
  }
};

exports.cancelBooking = async (req, res, next) => {
  try {
    let booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const isCustomer = booking.customer.toString() === req.user.id;
    const isCook = booking.cook != null && booking.cook.toString() === req.user.id;
    const isAdmin = String(req.user.role).toUpperCase() === "ADMIN";
    if (!isCustomer && !isCook && !isAdmin) {
      return res.status(403).json({ message: "Not authorized" });
    }

    await expireBookingIfNeeded(booking);
    if (booking.status === "cancelled") {
      if (isUnpaidBooking(booking)) {
        const id = await destroyUnpaidBooking(booking);
        return res.json({ deleted: true, id, message: "Booking cancelled and removed (no payment was made)." });
      }
      return res.json({ ...(stripServiceOtp(booking).toObject ? stripServiceOtp(booking) : stripServiceOtp(booking)), alreadyCancelled: true });
    }
    if (["completed", "rejected", "expired", "unattended"].includes(booking.status)) {
      return res.status(400).json({ message: "Booking cannot be cancelled" });
    }

    const cancelledByValue = isAdmin ? "admin" : isCook ? "cook" : "customer";
    // "Finding a cook" page: a customer withdrawing a still-unassigned
    // (`requested`) booking cancels in one tap — no reason prompt, no
    // 30-minute cutoff. Nothing is paid and no cook is engaged yet, so
    // there is nothing to refund or penalize. evaluateCancellation() below
    // still runs as a safety net (BEFORE_ASSIGNMENT, allowed).
    const isRequestWithdrawal = booking.status === "requested" && cancelledByValue === "customer";
    const { CUSTOMER_CANCELLATION_REASONS } = require("../utils/cancellationPolicy");
    let cancelReason = "";
    let cancelReasonNote = "";
    if (isRequestWithdrawal) {
      cancelReason = "OTHER";
      cancelReasonNote = "";
    } else if (!isAdmin) {
      cancelReason = String(req.body?.reason || "").trim().toUpperCase().slice(0, 60);
      if (cancelledByValue === "customer") {
        if (cancelReason && !CUSTOMER_CANCELLATION_REASONS.includes(cancelReason)) {
          return res.status(400).json({ message: "Please choose a valid cancellation reason." });
        }
        cancelReason = cancelReason || "OTHER";
        if (cancelReason === "OTHER") {
          cancelReasonNote = String(req.body?.reasonNote || req.body?.note || "").trim().slice(0, 500);
          if (!cancelReasonNote) {
            return res.status(400).json({ message: "Please describe your reason for cancelling." });
          }
        } else {
          cancelReasonNote = String(req.body?.reasonNote || req.body?.note || "").trim().slice(0, 500);
        }
      } else if (cancelReason) {
        cancelReasonNote = String(req.body?.reasonNote || req.body?.note || "").trim().slice(0, 500);
      }
    } else {
      cancelReason = String(req.body?.reason || "").trim().toUpperCase().slice(0, 60) || "ADMIN_CANCELLED";
      cancelReasonNote = String(req.body?.reasonNote || req.body?.note || "").trim().slice(0, 500);
    }

    if (booking.serviceStartedAt) {
      return res.status(400).json({ message: "Service has already started — this booking can no longer be cancelled. Please contact support." });
    }
    if (!isAdmin && booking.status === "in_progress") {
      return res.status(400).json({ message: "Service is already in progress — this booking can no longer be cancelled online. Please contact support." });
    }
    if (!isAdmin && !isRequestWithdrawal && cancelLocked(booking)) {
      return res.status(400).json({ message: "Bookings can only be cancelled until 30 minutes before the service start time. Please contact support for help." });
    }

    const { evaluateCancellation } = require("../utils/cancellationPolicy");
    const policy = evaluateCancellation({
      booking,
      currentTime: Date.now(),
      actorRole: cancelledByValue,
    });
    if (!policy.allowed) {
      return res.status(400).json({ message: policy.message || "This booking cannot be cancelled." });
    }
    let cancelClaimed = false;
    if (dbReady()) {
      try {
        const claim = await Booking.updateOne(
          {
            _id: booking._id,
            status: { $in: ["requested", "accepted", "confirmed", "in_progress"] },
            $or: [{ serviceStartedAt: { $exists: false } }, { serviceStartedAt: null }],
          },
          {
            $set: { status: "cancelled", cancelledBy: cancelledByValue },
            $push: { statusHistory: { status: "cancelled" } },
          }
        );
        if ((claim.modifiedCount ?? claim.nModified ?? 0) === 1) {
          cancelClaimed = true;
        }
      } catch {
        cancelClaimed = false;
      }
      if (cancelClaimed) {
        try {
          const fresh = await Booking.findById(req.params.id);
          if (fresh) booking = fresh;
        } catch {
        }
        booking.cancelledBy = cancelledByValue;
      } else {
        let latest = null;
        try {
          latest = await Booking.findById(req.params.id);
        } catch {
          latest = null;
        }
        if (!latest) {
          return res.status(404).json({ message: "Booking not found" });
        }
        if (latest.status === "cancelled") {
          if (isUnpaidBooking(latest)) {
            const id = await destroyUnpaidBooking(latest);
            return res.json({ deleted: true, id, message: "Booking cancelled and removed (no payment was made)." });
          }
          return res.json({ ...(stripServiceOtp(latest).toObject ? stripServiceOtp(latest) : stripServiceOtp(latest)), alreadyCancelled: true });
        }
        if (["completed", "rejected", "expired", "unattended"].includes(latest.status)) {
          return res.status(400).json({ message: "Booking cannot be cancelled" });
        }
        if (latest.serviceStartedAt || latest.status === "in_progress") {
          return res.status(400).json({ message: "Service has already started — this booking can no longer be cancelled. Please contact support." });
        }
        return res.status(409).json({
          message: "This booking was just updated — please refresh to see its current status.",
        });
      }
    }
    if (!cancelClaimed) {
      booking.status = "cancelled";
      booking.cancelledBy = cancelledByValue;
      booking.statusHistory.push({ status: "cancelled" });
    }

    // Unpaid cancelled bookings are neither shown nor tracked: remove the
    // record instead of keeping a cancelled stub (no refund/audit/notify).
    if (isUnpaidBooking(booking)) {
      const id = await destroyUnpaidBooking(booking);
      return res.json({ deleted: true, id, message: "Booking cancelled and removed (no payment was made)." });
    }

    const snap = {
      cancelledBy: cancelledByValue,
      cancelledAt: new Date(),
      cancellationReason: cancelReason || (cancelledByValue === "cook" ? "COOK_CANCELLED" : "OTHER"),
      cancellationReasonNote: cancelReasonNote || "",
      cancellationCategory: policy.cancellationCategory,
      policyVersion: policy.policyVersion,
      bookingAmount: policy.bookingAmount,
      refundPercentage: policy.refundPercent,
      cancellationChargePercentage: policy.cancellationChargePercent,
      grossRefundAmount: policy.grossRefund,
      nonRefundableCharges: policy.nonRefundableCharges,
      finalRefundAmount: policy.finalRefund,
      refundStatus: policy.finalRefund > 0 ? "PENDING" : "NOT_APPLICABLE",
      refundRequestedAt: policy.finalRefund > 0 ? new Date() : undefined,
    };
    booking.cancellationInfo = { ...(booking.cancellationInfo || {}), ...snap };
    booking.statusHistory.push({
      status: "cancelled",
      note: `Cancelled by ${cancelledByValue} (${snap.cancellationCategory}, policy ${snap.policyVersion}): charge ${snap.cancellationChargePercentage}%, refund ${snap.refundPercentage}% → ₹${snap.finalRefundAmount}${snap.nonRefundableCharges ? ` (incl. ₹${snap.nonRefundableCharges} non-refundable charges)` : ""}${cancelReasonNote ? ` — ${cancelReasonNote}` : ""}`,
    });
    let refundNote = "";
    try {
      const queued = queueRefundForApproval(booking, `booking_cancelled:${snap.cancellationCategory}`, snap.finalRefundAmount);
      if (queued > 0) {
        refundNote = ` A refund of ₹${queued} (${snap.refundPercentage}% of ₹${snap.bookingAmount}) has been requested — our team will review it shortly.`;
      } else if (snap.finalRefundAmount === 0 && booking.payment?.status === "paid" && !booking.payment?.testMode) {
        refundNote = ` No refund is applicable for this cancellation (${snap.cancellationCategory}).`;
      } else if (booking.payment?.testMode && booking.payment?.status === "paid") {
        refundNote = " (Test payment — no real money moved.)";
      }
    } catch {
    }
    try {
      const CancellationAudit = require("../models/CancellationAudit");
      await CancellationAudit.create([
        {
          actor: req.user.id,
          actorRole: String(req.user.role || "").toUpperCase(),
          bookingId: booking._id,
          event: "CANCELLATION_REQUESTED",
          previousStatus: booking.status === "cancelled" ? "" : booking.status,
          newStatus: "cancelled",
          amount: snap.bookingAmount,
          reason: `${cancelReason}${cancelReasonNote ? `: ${cancelReasonNote}` : ""}`,
          metadata: { category: snap.cancellationCategory, policyVersion: snap.policyVersion },
        },
        {
          actor: req.user.id,
          actorRole: String(req.user.role || "").toUpperCase(),
          bookingId: booking._id,
          event: "REFUND_CALCULATED",
          previousStatus: "",
          newStatus: snap.refundStatus,
          amount: snap.finalRefundAmount,
          reason: `${snap.refundPercentage}% of ₹${snap.bookingAmount} → gross ₹${snap.grossRefundAmount}, charges ₹${snap.nonRefundableCharges}`,
          metadata: { category: snap.cancellationCategory, policyVersion: snap.policyVersion },
        },
      ]);
    } catch {
    }
    if (!isAdmin && isCook) {
      try {
        const CancellationAudit = require("../models/CancellationAudit");
        await CancellationAudit.create({
          actor: req.user.id,
          actorRole: "COOK",
          bookingId: booking._id,
          event: "COOK_CANCELLED",
          previousStatus: "",
          newStatus: "cancelled",
          amount: snap.finalRefundAmount,
          reason: "Cook cancelled — alternative cook to be attempted; 100% refund queued if no replacement",
          metadata: { category: snap.cancellationCategory },
        });
      } catch {
      }
    }
    await booking.save();
    if (!isAdmin && isCook) {
      try {
        await CookProfile.updateOne({ user: booking.cook }, { $inc: { cancelledByCookCount: 1 } });
      } catch {
      }
    }
    await releaseCouponUsage(booking);


    const customerMsg = isCustomer
      ? `Your booking has been cancelled.${refundNote}`
      : isCook
        ? `Your cook had to cancel this booking — we are trying to find you an alternative cook.${refundNote}`
        : `Your booking was cancelled by our team.${refundNote}`;
    const cookMsg = isCustomer
      ? "Customer cancelled a booking."
      : "You cancelled a booking.";
    try {
      await Notification.create({
        user: booking.customer,
        type: "booking_cancelled",
        booking: booking._id,
        message: customerMsg,
      });
    } catch {
    }
    if (booking.cook) {
      try {
        await Notification.create({
          user: booking.cook,
          type: "booking_cancelled",
          booking: booking._id,
          message: cookMsg,
        });
      } catch {
      }
    }
    notifyWhatsApp("cancelled", booking, {
      cancelledBy: cancelledByValue,
      refundNote: refundNote || undefined,
    });

    res.json(stripServiceOtp(booking));
  } catch (error) {
    next(error);
  }
};

exports.getCancellationPreview = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const isCustomer = booking.customer.toString() === req.user.id;
    const isAdmin = String(req.user.role).toUpperCase() === "ADMIN";
    if (!isCustomer && !isAdmin) {
      return res.status(403).json({ message: "Not authorized" });
    }
    const { evaluateCancellation, isWithin30MinCutoff } = require("../utils/cancellationPolicy");
    const policy = evaluateCancellation({
      booking,
      currentTime: Date.now(),
      actorRole: isAdmin ? "admin" : "customer",
    });
    if (!policy.allowed) {
      return res.json({ canCancel: false, reason: policy.reasonCode || "NOT_CANCELLABLE", message: policy.message });
    }
    if (!isAdmin && isWithin30MinCutoff(booking)) {
      return res.json({
        canCancel: false,
        reason: "INSIDE_CUTOFF",
        message: "Bookings can only be cancelled until 30 minutes before the service start time. Please contact support for help.",
      });
    }
    res.json({
      canCancel: true,
      category: policy.cancellationCategory,
      cancellationChargePercent: policy.cancellationChargePercent,
      refundPercent: policy.refundPercent,
      bookingAmount: policy.bookingAmount,
      grossRefund: policy.grossRefund,
      nonRefundableCharges: policy.nonRefundableCharges,
      finalRefund: policy.finalRefund,
      message: policy.message,
    });
  } catch (error) {
    next(error);
  }
};

exports.markNoShow = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const isAdmin = String(req.user.role).toUpperCase() === "ADMIN";
    const isOwnCook =
      booking.cook != null && String(booking.cook) === String(req.user.id) &&
      String(req.user.role).toUpperCase() === "COOK";
    if (!isAdmin && !isOwnCook) {
      return res.status(403).json({ message: "Not authorized" });
    }
    if (["cancelled", "completed", "rejected", "expired", "unattended"].includes(booking.status)) {
      return res.status(400).json({ message: "Booking cannot be marked as no-show" });
    }
    if (!booking.cook) {
      return res.status(400).json({ message: "No cook is assigned to this booking" });
    }
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    if (!reason) {
      return res.status(400).json({ message: "Please describe what happened at the venue." });
    }
    const { evaluateCancellation } = require("../utils/cancellationPolicy");
    const policy = evaluateCancellation({
      booking,
      currentTime: Date.now(),
      actorRole: isAdmin ? "admin" : "cook",
      noShow: true,
    });
    let claimed = false;
    try {
      if (dbReady()) {
        const claim = await Booking.updateOne(
          {
            _id: booking._id,
            status: { $in: ["requested", "accepted", "confirmed", "in_progress"] },
          },
          {
            $set: {
              status: "cancelled",
              cancelledBy: "customer",
              "noShow.marked": true,
              "noShow.markedBy": req.user.id,
              "noShow.markedByRole": isAdmin ? "ADMIN" : "COOK",
              "noShow.markedAt": new Date(),
              "noShow.reason": reason,
            },
          }
        );
        claimed = (claim.modifiedCount ?? claim.nModified ?? 0) === 1;
      } else {
        claimed = true;
      }
    } catch {
      claimed = false;
    }
    if (!claimed) {
      return res.status(409).json({ message: "This booking was just updated — please refresh to see its current status." });
    }
    const fresh = (await Booking.findById(req.params.id)) || booking;
    fresh.cancellationInfo = {
      ...(fresh.cancellationInfo || {}),
      cancelledBy: "customer",
      cancelledAt: new Date(),
      cancellationReason: "CUSTOMER_NO_SHOW",
      cancellationReasonNote: reason,
      cancellationCategory: "CUSTOMER_NO_SHOW",
      policyVersion: policy.policyVersion,
      bookingAmount: policy.bookingAmount,
      refundPercentage: 0,
      cancellationChargePercentage: 100,
      grossRefundAmount: 0,
      nonRefundableCharges: 0,
      finalRefundAmount: 0,
      refundStatus: "NOT_APPLICABLE",
    };
    fresh.statusHistory.push({ status: "cancelled", note: `Customer no-show recorded (${reason}) — 0% refund` });
    // Unpaid cancelled bookings are neither shown nor tracked.
    if (isUnpaidBooking(fresh)) {
      const id = await destroyUnpaidBooking(fresh);
      return res.json({ deleted: true, id, message: "No-show recorded — unpaid booking removed." });
    }
    await fresh.save();
    try {
      const CancellationAudit = require("../models/CancellationAudit");
      await CancellationAudit.create({
        actor: req.user.id,
        actorRole: isAdmin ? "ADMIN" : "COOK",
        bookingId: fresh._id,
        event: "NO_SHOW_MARKED",
        previousStatus: booking.status,
        newStatus: "cancelled",
        amount: 0,
        reason,
        metadata: { category: "CUSTOMER_NO_SHOW" },
      });
    } catch {
    }
    try {
      await Notification.create({
        user: fresh.customer,
        type: "booking_cancelled",
        booking: fresh._id,
        message: "Your booking was marked as a no-show — the cook reached the venue but could not reach you. No refund is applicable. Please contact support if this is a mistake.",
      });
    } catch {
    }
    if (fresh.cook) {
      try {
        await Notification.create({
          user: fresh.cook,
          type: "no_show_marked",
          booking: fresh._id,
          message: "Customer no-show recorded for this booking.",
        });
      } catch {
      }
    }
    notifyWhatsApp("cancelled", fresh, { cancelledBy: "no_show" });
    res.json(stripServiceOtp(fresh));
  } catch (error) {
    next(error);
  }
};

exports.getRescheduleOptions = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const isCustomer = booking.customer.toString() === req.user.id;
    const isAdmin = String(req.user.role).toUpperCase() === "ADMIN";
    if (!isCustomer && !isAdmin) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const strictDay = parseDayStrict(req.query.date);
    if (!strictDay) {
      return res.status(400).json({ message: "Valid date (YYYY-MM-DD) is required" });
    }
    const dayStr = istDayString(strictDay);
    if (dayStr < istDayString()) {
      return res.status(400).json({ message: "That date already passed — please pick today or a future date." });
    }
    if (strictDay.getTime() > Date.now() + MAX_BOOKING_HORIZON_DAYS * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ message: "That date is too far ahead — please pick a nearer date." });
    }

    const durHours = Number(booking.durationHours);
    if (!Number.isFinite(durHours) || durHours * 60 < 30 || durHours > 4) {
      return res.status(400).json({ message: "This booking has no usable duration — please contact support" });
    }

    const isBroadcastOptions = !booking.cook;
    const windows = isBroadcastOptions
      ? [{ startTime: "08:00", endTime: "20:00" }]
      : await getDayWindows(booking.cook, dayStr);
    const allRivals = isBroadcastOptions
      ? await Booking.find({
          customer: booking.customer,
          _id: { $ne: booking._id },
          date: { $gte: dayBounds(dayStr).start, $lte: dayBounds(dayStr).end },
          $or: activeSlotMatch(),
        }).select("startTime endTime status")
      : (await getDayBookings(booking.cook, dayStr)).filter(
          (b) => String(b._id) !== String(booking._id)
        );
    const rivals = allRivals;
    const slots = computeStartOptions(windows, rivals, durHours).filter((s) => {
      if (isAdmin) return true;
      const instant = istEventInstant(dayStr, s.startTime);
      return Boolean(instant) && instant.getTime() - Date.now() >= RESCHEDULE_MIN_LEAD_MS;
    });

    const base = {
      date: dayStr,
      durationHours: durHours,
      currentSlot: {
        date: istDayString(booking.date),
        startTime: booking.startTime,
        endTime: booking.endTime,
      },
      slots: slots.map((s) => ({ ...s, derived: true })),
    };

    const rawStart = req.query.startTime;
    if (rawStart == null || String(rawStart).trim() === "") {
      return res.json(base);
    }

    const slotStart = parseTimeStrict(String(rawStart).trim());
    if (slotStart == null || !isOnGrid(slotStart)) {
      return res.status(400).json({ message: "Valid start time (HH:MM) is required" });
    }
    const durMin = Math.round(Number(booking.durationHours || 0) * 60);
    const slotEnd = slotStart + durMin;
    const slotStartTime = minutesToTime(slotStart);
    const slotEndTime = minutesToTime(slotEnd);
    if (slotStart < RESCHEDULE_DAY_START_MIN || slotEnd > RESCHEDULE_DAY_END_MIN) {
      return res.status(400).json({
        message: "Sessions must run between 8:00 AM and 8:00 PM",
        currentCookAvailable: false,
        currentCookUnavailableReason: "outside_working_hours",
        slot: { date: dayStr, startTime: slotStartTime, endTime: slotEndTime },
        availableCooks: [],
      });
    }
    if (!isAdmin) {
      const instant = istEventInstant(dayStr, slotStartTime);
      if (!instant || instant.getTime() - Date.now() < RESCHEDULE_MIN_LEAD_MS) {
        return res.status(400).json({ message: "The new time must be at least 30 minutes from now — please pick a later slot." });
      }
    }
    const check = await checkCookForSlot(booking.cook, booking, dayStr, slotStartTime, slotEndTime);
    if (check.ok) {
      return res.json({
        ...base,
        slot: { date: dayStr, startTime: slotStartTime, endTime: slotEndTime },
        currentCookAvailable: true,
        availableCooks: [],
      });
    }
    const availableCooks = await findReplacementCooks(
      booking, dayStr, slotStartTime, slotEndTime, booking.cook
    );
    return res.json({
      ...base,
      slot: { date: dayStr, startTime: slotStartTime, endTime: slotEndTime },
      currentCookAvailable: false,
      currentCookUnavailableReason: check.conflict ? "already_booked" : "cook_unavailable",
      currentCookMessage: "Your current cook is unavailable for this time.",
      availableCooks,
    });
  } catch (error) {
    next(error);
  }
};

const publicRescheduleCookCard = (profile, userDoc) => ({
  cookId: String(userDoc?._id || profile?.user?._id || profile?.user || ""),
  name: String(userDoc?.name || "Verified cook"),
  photoUrl: String(profile?.photoUrl || ""),
  rating: Number(profile?.rating?.average || 0),
  ratingCount: Number(profile?.rating?.count || 0),
  experienceYears: Number(profile?.experienceYears || 0),
  serviceArea: String(profile?.serviceArea || ""),
  specialties: Array.isArray(profile?.specialties) ? profile.specialties.slice(0, 6) : [],
});
const checkCookForSlot = async (cookUserId, booking, dayStr, startTime, endTime) => {
  const unavailable = (message, conflict = false) => ({ ok: false, message, conflict });
  let profile = null;
  try {
    profile = await CookProfile.findOne({ user: cookUserId });
  } catch {
    return unavailable("Cook not found or not approved");
  }
  if (!profile || profile.approvalStatus !== "approved") {
    return unavailable("Cook not found or not approved");
  }
  if (dbReady()) {
    try {
      const account = await User.findById(cookUserId).select("status name");
      if (!account || account.status === "suspended") {
        return unavailable("This cook is no longer available for the selected time. Please choose another cook.");
      }
    } catch {
      return unavailable("Cook not found or not approved");
    }
  }
  if (!(await resolveCookAvailability(profile))) {
    return unavailable("This cook is no longer available for the selected time. Please choose another cook.");
  }
  if (
    Array.isArray(profile.serviceTypes) &&
    profile.serviceTypes.length > 0 &&
    booking?.serviceType &&
    !profile.serviceTypes.includes(booking.serviceType)
  ) {
    return unavailable("This cook does not offer the requested service for the selected time. Please choose another cook.");
  }
  let windows = [];
  try {
    windows = await getDayWindows(cookUserId, dayStr);
  } catch {
    windows = [];
  }
  if (!findContainingWindow(windows, startTime, endTime)) {
    return unavailable("This cook is no longer available for the selected time. Please choose another cook.");
  }
  let rivals = [];
  try {
    rivals = await getDayBookings(cookUserId, dayStr);
  } catch {
    rivals = [];
  }
  const clash = findOverlapBooking(rivals, startTime, endTime);
  if (clash && String(clash._id) !== String(booking?._id)) {
    return unavailable("This cook was just booked for the selected time. Please choose another cook.", true);
  }
  return { ok: true, profile };
};
const findReplacementCooks = async (booking, dayStr, startTime, endTime, excludeCookId, limit = 12) => {
  let profiles = [];
  try {
    profiles = await CookProfile.find({ approvalStatus: "approved" })
      .populate("user", "name status")
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
  } catch {
    return [];
  }
  const eligible = [];
  for (const p of profiles || []) {
    const uid = String(p?.user?._id || p?.user || "");
    if (!uid || uid === String(excludeCookId || "")) continue;
    if (!p?.user || p.user.status === "suspended") continue;
    eligible.push(p);
  }
  const flags = await Promise.all(eligible.map((p) => resolveCookAvailability(p)));
  const live = eligible.filter((_, i) => flags[i]);
  const withService = live.filter((p) => {
    if (!Array.isArray(p?.serviceTypes) || p.serviceTypes.length === 0) return true;
    return booking?.serviceType ? p.serviceTypes.includes(booking.serviceType) : true;
  });
  let bookingsByCook = new Map();
  try {
    const ids = withService.map((p) => p?.user?._id || p?.user);
    const { start, end } = dayBounds(dayStr);
    const all = await Booking.find({
      cook: { $in: ids },
      date: { $gte: start, $lte: end },
      $or: activeSlotMatch(),
    })
      .select("cook startTime endTime status")
      .lean();
    for (const b of all || []) {
      const key = String(b.cook);
      if (!bookingsByCook.has(key)) bookingsByCook.set(key, []);
      bookingsByCook.get(key).push(b);
    }
  } catch {
    bookingsByCook = new Map();
  }
  const out = [];
  for (const p of withService) {
    const uid = String(p?.user?._id || p?.user || "");
    const wins = (() => {
      try {
        const { resolveCookWindows } = require("../utils/slots");
        return resolveCookWindows(p, dayStr);
      } catch {
        return null;
      }
    })();
    if (!wins || !findContainingWindow(wins, startTime, endTime)) continue;
    if (findOverlapBooking(bookingsByCook.get(uid) || [], startTime, endTime)) continue;
    out.push(publicRescheduleCookCard(p, p.user));
    if (out.length >= limit) break;
  }
  out.sort((a, b) => b.rating - a.rating || b.ratingCount - a.ratingCount);
  return out;
};
const dateLabelFromParts = (dayStr) => {
  const m = String(dayStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(dayStr || "");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || m[2]}`;
};

exports.rescheduleBooking = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const isCustomer = booking.customer.toString() === req.user.id;
    const isAdmin = String(req.user.role).toUpperCase() === "ADMIN";
    if (!isCustomer && !isAdmin) {
      return res.status(403).json({ message: "Not authorized" });
    }

    await expireBookingIfNeeded(booking);

    const requestedDayStr = String(req.body?.date || "").trim();
    const requestedStart = parseTimeStrict(req.body?.startTime);
    const rawReason = String(req.body?.reason ?? "");
    if (rawReason.length > 200) {
      return res.status(400).json({ message: "Reschedule reason is too long — please keep it under 200 characters." });
    }
    const reason = rawReason.trim().slice(0, 200);
    const rawCookId = req.body?.cookId ?? req.body?.newCookId ?? req.body?.selectedCookId;
    let requestedCookId = null;
    if (rawCookId != null && String(rawCookId).trim() !== "") {
      requestedCookId = String(rawCookId).trim();
      if (!mongoose.Types.ObjectId.isValid(requestedCookId)) {
        return res.status(400).json({ message: "This cook is no longer available for the selected time. Please choose another cook." });
      }
    }

    const sameSlot =
      RESCHEDULE_ALLOWED_STATUSES.includes(booking.status) &&
      requestedDayStr === istDayString(booking.date) &&
      requestedStart != null &&
      requestedStart === timeToMinutes(booking.startTime);
    if (sameSlot && (requestedCookId == null || requestedCookId === String(booking.cook))) {
      return res.json({ ...stripServiceOtp(booking), unchanged: true });
    }

    if (!RESCHEDULE_ALLOWED_STATUSES.includes(booking.status)) {
      return res.status(400).json({
        message:
          booking.status === "in_progress"
            ? "This session has already started — rescheduling is no longer possible."
            : "Only upcoming bookings that have not started can be rescheduled.",
      });
    }
    if (booking.serviceStartedAt || booking.cookArrived || booking.hoursCompleted) {
      return res.status(400).json({
        message: "This session is already under way — rescheduling is no longer possible.",
      });
    }
    if (!isAdmin && rescheduleLocked(booking)) {
      return res.status(400).json({
        message: "Bookings can only be rescheduled until 30 minutes before the service start time. Please contact support for help.",
      });
    }
    if (!isAdmin && Number(booking.rescheduleCount || 0) >= MAX_CUSTOMER_RESCHEDULES) {
      return res.status(400).json({
        message: "This booking has already been rescheduled twice — please contact support if you need another change.",
      });
    }

    if (requestedStart == null) {
      return res.status(400).json({ message: "Valid start time (HH:MM) is required" });
    }
    if (!isOnGrid(requestedStart)) {
      return res.status(400).json({ message: "Start time must be on a 30-minute interval" });
    }
    const strictDay = parseDayStrict(requestedDayStr);
    if (!strictDay) {
      return res.status(400).json({ message: "Valid date (YYYY-MM-DD) is required" });
    }
    const dayStr = istDayString(strictDay);
    const todayStr = istDayString();
    if (dayStr < todayStr) {
      return res.status(400).json({ message: "That date already passed — please pick today or a future date." });
    }
    if (strictDay.getTime() > Date.now() + MAX_BOOKING_HORIZON_DAYS * 24 * 60 * 60 * 1000) {
      return res.status(400).json({ message: "That date is too far ahead — please pick a nearer date." });
    }
    if (dayStr === todayStr && requestedStart < istNowMinutes()) {
      return res.status(400).json({ message: "That time already passed today — please pick a later start time." });
    }
    if (!isAdmin) {
      const targetInstant = istEventInstant(dayStr, minutesToTime(requestedStart));
      if (!targetInstant || targetInstant.getTime() - Date.now() < RESCHEDULE_MIN_LEAD_MS) {
        return res.status(400).json({
          message: "The new time must be at least 30 minutes from now — please pick a later slot.",
        });
      }
    }

    const durMin = Math.round(Number(booking.durationHours || 0) * 60);
    if (!Number.isFinite(durMin) || durMin < 30 || durMin > 4 * 60) {
      return res.status(400).json({ message: "This booking has no usable duration — please contact support" });
    }
    const endMin = requestedStart + durMin;
    const startTime = minutesToTime(requestedStart);
    const endTime = minutesToTime(endMin);
    if (requestedStart < RESCHEDULE_DAY_START_MIN || endMin > RESCHEDULE_DAY_END_MIN) {
      return res.status(400).json({ message: "Sessions must run between 8:00 AM and 8:00 PM" });
    }

    const isBroadcastMove = !booking.cook && !requestedCookId;
    const targetCookId = requestedCookId || (booking.cook ? String(booking.cook) : null);
    const cookChanged = String(targetCookId) !== String(booking.cook);

    if (isBroadcastMove) {
      let freshEligible = [];
      try {
        freshEligible = await findEligibleCooks({
          date: dayStr,
          startTime,
          endTime,
          serviceType: booking.serviceType,
        });
      } catch {
        freshEligible = [];
      }
      if (!freshEligible.length) {
        return res.status(409).json({
          message: "No cooks are free for that new time — please pick another slot.",
        });
      }
    } else if (!cookChanged) {
      const cookProfile = await CookProfile.findOne({ user: booking.cook, approvalStatus: "approved" });
      if (!cookProfile) {
        return res.status(400).json({ message: "Cook not found or not approved" });
      }
      if (dbReady()) {
        try {
          const cookAccount = await User.findById(booking.cook).select("status");
          if (!cookAccount || cookAccount.status === "suspended") {
            return res.status(400).json({ message: "Cook not found or not approved" });
          }
        } catch {
          return res.status(400).json({ message: "Cook not found or not approved" });
        }
      }
      if (!(await resolveCookAvailability(cookProfile))) {
        return res.status(400).json({
          message: "Your current cook is unavailable for this time. Please choose another time or find another available cook.",
          currentCookAvailable: false,
        });
      }

      const windows = await getDayWindows(booking.cook, dayStr);
      if (!findContainingWindow(windows, startTime, endTime)) {
        return res.status(400).json({
          message: "Your current cook is unavailable for this time. Please choose another time or find another available cook.",
          currentCookAvailable: false,
        });
      }
      const rivals = (await getDayBookings(booking.cook, dayStr)).filter(
        (b) => String(b._id) !== String(booking._id)
      );
      if (findOverlapBooking(rivals, startTime, endTime)) {
        return res.status(409).json({
          message: "That time just got booked — please pick another start time",
          currentCookAvailable: false,
        });
      }
    } else {
      const swap = await checkCookForSlot(targetCookId, booking, dayStr, startTime, endTime);
      if (!swap.ok) {
        return res.status(swap.conflict ? 409 : 400).json({ message: swap.message });
      }
    }

    const oldDate = booking.date;
    const oldStartTime = booking.startTime;
    const oldEndTime = booking.endTime;
    const oldCook = String(booking.cook);
    const oldSlotLabel = `${dateLabelFromParts(istDayString(oldDate))} ${oldStartTime}–${oldEndTime}`.trim();
    const newSlotLabel = `${dateLabelFromParts(dayStr)} ${startTime}–${endTime}`;
    const actor = isAdmin ? "admin" : "customer";
    const expectedCount = Number(booking.rescheduleCount || 0);
    const newDay = istMidnight(dayStr);
    let oldCookName = "";
    let newCookName = "";
    try {
      if (cookChanged && dbReady()) {
        const [oldU, newU] = await Promise.all([
          User.findById(oldCook).select("name").lean(),
          User.findById(targetCookId).select("name").lean(),
        ]);
        oldCookName = String(oldU?.name || "");
        newCookName = String(newU?.name || "");
      }
    } catch {
    }
    const renewedWindow =
      booking.status === "requested"
        ? { requestExpiresAt: new Date(Date.now() + REQUEST_WINDOW_MS) }
        : booking.status === "accepted"
          ? { paymentExpiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS) }
          : {};
    const historyEntry = {
      status: booking.status,
      note:
        `Rescheduled from ${oldSlotLabel} to ${newSlotLabel} by ${actor}` +
        (cookChanged ? ` (cook reassigned${oldCookName || newCookName ? `: ${oldCookName || "previous cook"} → ${newCookName || "new cook"}` : ""})` : "") +
        (reason ? ` — reason: ${reason}` : ""),
    };
    const auditEntry = {
      fromDate: oldDate,
      fromStartTime: oldStartTime,
      fromEndTime: oldEndTime,
      toDate: newDay,
      toStartTime: startTime,
      toEndTime: endTime,
      by: actor,
      at: new Date(),
      fromCook: booking.cook,
      toCook: targetCookId,
      fromCookName: oldCookName,
      toCookName: newCookName,
      reason,
    };

    let moved = null;
    if (dbReady()) {
      const claimFilter = { _id: booking._id, status: booking.status, rescheduleCount: expectedCount };
      if (!isAdmin) claimFilter.customer = req.user.id;
      try {
        moved = await Booking.findOneAndUpdate(
          claimFilter,
          {
            $set: {
              date: newDay,
              startTime,
              endTime,
              ...(cookChanged ? { cook: targetCookId } : {}),
              ...(isBroadcastMove ? { ignoredBy: [] } : {}),
              rescheduleCount: expectedCount + 1,
              ...renewedWindow,
            },
            $push: { statusHistory: historyEntry, reschedules: auditEntry },
          },
          { new: true }
        );
      } catch {
        moved = null;
      }
      if (!moved) {
        let latest = null;
        try {
          latest = await Booking.findById(booking._id);
        } catch {
          latest = null;
        }
        if (!latest) {
          return res.status(404).json({ message: "Booking not found" });
        }
        if (
          RESCHEDULE_ALLOWED_STATUSES.includes(latest.status) &&
          dayStr === istDayString(latest.date) &&
          requestedStart === timeToMinutes(latest.startTime) &&
          String(latest.cook) === String(requestedCookId || latest.cook)
        ) {
          return res.json({ ...stripServiceOtp(latest), unchanged: true });
        }
        return res.status(409).json({
          message: "This booking was just updated elsewhere — please refresh to see its current time.",
        });
      }

      const rollbackMove = async (message) => {
        const reverted = await Booking.findOneAndUpdate(
          { _id: booking._id, status: booking.status, rescheduleCount: expectedCount + 1 },
          {
            $set: {
              date: oldDate,
              startTime: oldStartTime,
              endTime: oldEndTime,
              ...(cookChanged ? { cook: oldCook } : {}),
              rescheduleCount: expectedCount,
              ...(booking.status === "requested" ? { requestExpiresAt: booking.requestExpiresAt } : {}),
              ...(booking.status === "accepted" ? { paymentExpiresAt: booking.paymentExpiresAt } : {}),
            },
            $pop: { statusHistory: 1, reschedules: 1 },
          },
          { new: true }
        );
        if (reverted) {
          return res.status(409).json({ message });
        }
        return res.status(409).json({
          message: "That time just got booked while your move was in flight — please refresh to check your booking.",
        });
      };
      try {
        if (isBroadcastMove) {
          const { start: mvDayStart, end: mvDayEnd } = dayBounds(newDay);
          const ownLive = await Booking.find({
            customer: booking.customer,
            _id: { $ne: booking._id },
            date: { $gte: mvDayStart, $lte: mvDayEnd },
            $or: activeSlotMatch(),
          }).select("startTime endTime status");
          const mvStart = timeToMinutes(startTime);
          const mvEnd = timeToMinutes(endTime);
          const selfClash = (ownLive || []).some((r) => {
            const rs = timeToMinutes(r.startTime);
            const re = timeToMinutes(r.endTime);
            return rs != null && re != null && intervalsOverlap(mvStart, mvEnd, rs, re);
          });
          const stillEligible = await findEligibleCooks({
            date: dayStr,
            startTime,
            endTime,
            serviceType: booking.serviceType,
          });
          if (selfClash || !stillEligible.length) {
            return await rollbackMove("That time just got booked — please pick another start time");
          }
        } else {
          const after = (await getDayBookings(targetCookId, dayStr)).filter(
            (b) => String(b._id) !== String(booking._id)
          );
          const clash = findOverlapBooking(after, startTime, endTime);
          if (clash && String(clash._id) < String(booking._id)) {
            return await rollbackMove(
              cookChanged
                ? "This cook was just booked for the selected time. Please choose another cook."
                : "That time just got booked — please pick another start time"
            );
          }
        }
      } catch (e) {
        if (e?.statusCode) throw e;
      }
    } else {
      booking.date = newDay;
      booking.startTime = startTime;
      booking.endTime = endTime;
      if (cookChanged) booking.cook = targetCookId;
      if (isBroadcastMove) booking.ignoredBy = [];
      booking.rescheduleCount = expectedCount + 1;
      Object.assign(booking, renewedWindow);
      booking.statusHistory.push(historyEntry);
      if (Array.isArray(booking.reschedules)) booking.reschedules.push(auditEntry);
      await booking.save();
      moved = booking;
    }

    const notifyMoved = (user, message) =>
      Notification.create({ user, type: "booking_rescheduled", booking: booking._id, message });
    try {
      if (cookChanged) {
        await notifyMoved(
          oldCook,
          `A booking previously assigned to you is no longer yours — its schedule was changed to ${newSlotLabel}. The slot is now open.`
        );
        await notifyMoved(
          targetCookId,
          `You have been assigned a new booking — ${newSlotLabel}. Please check your schedule.`
        );
        await notifyMoved(
          booking.customer,
          isAdmin
            ? `Your booking was rescheduled to ${newSlotLabel} and a new cook has been assigned.`
            : `Your booking has been rescheduled to ${newSlotLabel} and a new cook has been assigned.`
        );
      } else if (isBroadcastMove) {
        await notifyMoved(
          booking.customer,
          isAdmin
            ? `Your cook search was moved to ${newSlotLabel} by our support team (was ${oldSlotLabel}). We're contacting free cooks again.`
            : `Your cook search has been moved to ${newSlotLabel} (was ${oldSlotLabel}). We're contacting free cooks again.`
        );
      } else if (isAdmin) {
        await notifyMoved(
          booking.cook,
          `Booking moved to ${newSlotLabel} by our support team (was ${oldSlotLabel}). Please check your schedule.`
        );
        await notifyMoved(
          booking.customer,
          `Your booking was moved to ${newSlotLabel} by our support team (was ${oldSlotLabel}).`
        );
      } else {
        await notifyMoved(
          booking.cook,
          `Booking rescheduled to ${newSlotLabel} by the customer (was ${oldSlotLabel}). Please check your schedule.`
        );
        await notifyMoved(
          booking.customer,
          `Your booking has been rescheduled to ${newSlotLabel} (was ${oldSlotLabel}).`
        );
      }
    } catch {
    }
    notifyWhatsApp("rescheduled", moved || booking, {
      oldDate: oldSlotLabel,
      oldStart: "",
      oldEnd: "",
    });

    res.json(stripServiceOtp(moved));
  } catch (error) {
    next(error);
  }
};

exports.startService = async (req, res, next) => {
  try {
    const filter = { _id: req.params.id };
    if (String(req.user.role).toUpperCase() !== "ADMIN") filter.cook = req.user.id;
    let booking = await Booking.findOne(filter);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const prepaid = booking.payment?.status === "paid";
    if (!prepaid || (!["confirmed", "in_progress"].includes(booking.status) && booking.status !== "accepted")) {
      return res.status(400).json({ message: "Only paid, confirmed bookings can start service" });
    }
    if (booking.serviceStartedAt) {
      const obj = stripServiceOtp(booking);
      return res.json({ ...obj, serviceStarted: true });
    }
    const otp = String(req.body?.otp || "").trim();
    if (!booking.serviceOtp && ensureServiceOtp(booking)) {
      try {
        await booking.save();
      } catch {
      }
    }
    if (booking.serviceOtpLockedUntil && new Date(booking.serviceOtpLockedUntil) > new Date()) {
      return res.status(429).json({
        message: "Too many incorrect attempts — please wait 15 minutes and ask the customer for the code again.",
      });
    }
    try {
      const otpEnd = sessionEndDate(booking);
      if (otpEnd && Date.now() > otpEnd.getTime() + OTP_VALIDITY_AFTER_END_MS) {
        return res.status(410).json({
          message: "This booking's start code has expired — please contact support.",
        });
      }
    } catch {
    }
    if (!booking.serviceOtp || otp !== String(booking.serviceOtp)) {
      let totalAttempts = Number(booking.serviceOtpAttempts || 0) + 1;
      if (dbReady()) {
        try {
          const bumped = await Booking.findOneAndUpdate(
            { _id: booking._id },
            { $inc: { serviceOtpAttempts: 1 } },
            { new: true }
          );
          if (bumped) totalAttempts = Number(bumped.serviceOtpAttempts || totalAttempts);
          if (totalAttempts >= 10) {
            try {
              await Booking.updateOne(
                { _id: booking._id },
                { $set: { serviceOtpLockedUntil: new Date(Date.now() + 15 * 60 * 1000) } }
              );
            } catch {
            }
          }
        } catch {
        }
      } else {
        booking.serviceOtpAttempts = totalAttempts;
        if (totalAttempts >= 10) {
          booking.serviceOtpLockedUntil = new Date(Date.now() + 15 * 60 * 1000);
        }
        try {
          await booking.save();
        } catch {
        }
      }
      if (totalAttempts >= 10) {
        return res.status(429).json({
          message: "Too many incorrect attempts — please wait 15 minutes and ask the customer for the code again.",
        });
      }
      return res.status(400).json({ message: "Incorrect OTP — please ask the customer for the 4-digit code shown on their booking" });
    }
    const durMin = Math.round(Number(booking.durationHours || 0) * 60);
    if (!Number.isInteger(Number(booking.durationHours)) || durMin < 60 || durMin > 4 * 60) {
      return res.status(400).json({ message: "This booking has no usable duration — please contact support" });
    }
    const startedAt = new Date();
    const fmtClock = (d) => {
      const mins = istNowMinutes(d);
      return minutesToTime(mins);
    };
    if (dbReady() && istDayString(booking.date) === istDayString(startedAt)) {
      try {
        const nowMin = istNowMinutes(startedAt);
        const newStart = minutesToTime(nowMin);
        const newEnd = minutesToTime(nowMin + durMin);
        const sameDay = (await getDayBookings(booking.cook, booking.date)).filter(
          (b) => String(b._id) !== String(booking._id) &&
            ["accepted", "confirmed", "in_progress"].includes(b.status)
        );
        if (findOverlapBooking(sameDay, newStart, newEnd)) {
          return res.status(409).json({
            message: "Starting now overlaps another confirmed booking for this cook — please ask support to cancel and rebook first.",
          });
        }
      } catch {
      }
    }
    const serviceNotePreview = `Service started (OTP verified)`;
    if (dbReady()) {
      const claimFilter = {
        _id: booking._id,
        serviceStartedAt: null,
        status: { $in: ["confirmed", "in_progress", "accepted"] },
        "payment.status": "paid",
      };
      if (String(req.user.role).toUpperCase() !== "ADMIN") claimFilter.cook = req.user.id;
      let claimed = null;
      try {
        claimed = await Booking.findOneAndUpdate(
          claimFilter,
          {
            $set: {
              serviceStartedAt: startedAt,
              serviceEndsAt: new Date(startedAt.getTime() + durMin * 60 * 1000),
              startTime: fmtClock(startedAt),
              endTime: fmtClock(new Date(startedAt.getTime() + durMin * 60 * 1000)),
              serviceOtpAttempts: 0,
              serviceOtpLockedUntil: null,
              status: "in_progress",
            },
            $push: {
              statusHistory: {
                status: "in_progress",
                note: `${serviceNotePreview} ${fmtClock(startedAt)}–${fmtClock(new Date(startedAt.getTime() + durMin * 60 * 1000))}`,
              },
            },
          },
          { new: true }
        );
      } catch {
        claimed = null;
      }
      if (!claimed) {
        let latest = null;
        try {
          latest = await Booking.findOne(filter);
        } catch {
          latest = null;
        }
        if (latest?.serviceStartedAt) {
          const obj = stripServiceOtp(latest);
          return res.json({ ...obj, serviceStarted: true });
        }
        return res.status(409).json({
          message: "This booking was just updated — please refresh to see its current status.",
          code: "BOOKING_INVALID_STATE",
        });
      }
      booking = claimed;
    } else {
      booking.serviceOtpAttempts = 0;
      booking.serviceOtpLockedUntil = undefined;
      booking.serviceStartedAt = startedAt;
      booking.serviceEndsAt = new Date(startedAt.getTime() + durMin * 60 * 1000);
      booking.startTime = fmtClock(startedAt);
      booking.endTime = fmtClock(booking.serviceEndsAt);
      await markArrivedIfNeeded(booking);
      const serviceNote = `Service started (OTP verified) ${booking.startTime}–${booking.endTime}`;
      if (booking.status !== "in_progress") {
        booking.status = "in_progress";
        booking.statusHistory.push({ status: "in_progress", note: serviceNote });
      } else {
        booking.statusHistory.push({ status: "in_progress", note: serviceNote });
      }
      await booking.save();
    }
    if (dbReady()) {
      try {
        await markArrivedIfNeeded(booking);
        const freshAfterArrival = await Booking.findOne(filter);
        if (freshAfterArrival) booking = freshAfterArrival;
      } catch {
      }
    }
    try {
      await Notification.create({
        user: booking.customer,
        type: "service_started",
        booking: booking._id,
        message: "Your service has started — enjoy your session! The hours are now being counted.",
      });
    } catch {
    }
    try {
      await Notification.create({
        user: booking.cook,
        type: "service_started",
        booking: booking._id,
        message: "Service started (OTP verified) — your hours are now being counted. Have a great session!",
      });
    } catch {
    }
    notifyWhatsApp("started", booking);
    const obj = stripServiceOtp(booking);
    res.json({ ...obj, serviceStarted: true });
  } catch (error) {
    next(error);
  }
};

exports.markCookArrived = async (req, res) => {
  return res.status(410).json({
    message: "Manual arrival is no longer supported — service starts with the OTP code from the customer.",
  });
};

exports.getBookingById = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate("cook", "name email phone")
      .populate("customer", "name email phone");
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    // Unpaid cancelled bookings are neither shown nor tracked.
    if (booking.status === "cancelled" && isUnpaidBooking(booking)) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const isCustomer = booking.customer?._id?.toString() === req.user.id;
    const isCook = booking.cook?._id?.toString() === req.user.id;
    const isAdmin = String(req.user.role).toUpperCase() === "ADMIN";
    const isBroadcastReader =
      !booking.cook &&
      booking.status === "requested" &&
      String(req.user.role).toUpperCase() === "COOK";
    if (!isCustomer && !isCook && !isAdmin && !isBroadcastReader) {
      return res.status(403).json({ message: "Not authorized" });
    }

    try {
      await markHoursCompleteIfNeeded(booking);
    } catch {
    }

    try {
      await expireBookingIfNeeded(booking);
    } catch {
    }
    let cookRate = null;
    let cookServiceArea = null;
    if (booking.cook?._id) {
      try {
        const profile = await CookProfile.findOne({ user: booking.cook._id }).select(
          "rate serviceArea"
        );
        if (profile?.rate != null) cookRate = profile.rate;
        if (profile?.serviceArea) cookServiceArea = profile.serviceArea;
      } catch {
      }
    }

    const fullObj = booking.toObject ? booking.toObject() : booking;
    const obj = isCustomer ? fullObj : stripServiceOtp(fullObj);
    if (!isAdmin) {
      if (obj.cook && typeof obj.cook === "object" && !Array.isArray(obj.cook)) {
        delete obj.cook.email;
        if (obj.status === "requested") delete obj.cook.phone;
      }
      if (isCook && obj.customer && typeof obj.customer === "object" && !Array.isArray(obj.customer)) {
        delete obj.customer.email;
        if (obj.status === "requested") delete obj.customer.phone;
      }
      if (isBroadcastReader && obj.customer && typeof obj.customer === "object" && !Array.isArray(obj.customer)) {
        delete obj.customer.email;
        delete obj.customer.phone;
      }
    }
    await attachCookPhotoUrls(obj);
    const end = sessionEndDate(booking);
    const hoursPayload = { ...obj, hoursCompletedAt: booking.hoursCompletedAt };
    let bookingReview = null;
    try {
      const Review = require("../models/Review");
      const found = await Review.findOne({ booking: booking._id })
        .populate("customer", "name")
        .select("booking customer rating comment createdAt");
      if (found) bookingReview = found.toObject ? found.toObject() : found;
    } catch {
      bookingReview = null;
    }
    res.json({
      ...obj,
      review: bookingReview,
      sessionEnd: end ? end.toISOString() : null,
      cookWhatsappUrl:
        booking.payment?.status === "paid"
          ? buildCookJobSheetWhatsAppUrl({
              cookPhone: booking.cook?.phone,
              customerName: booking.customer?.name,
              customerPhone: booking.customer?.phone,
              booking: obj,
            })
          : null,
      cookRate,
      cookServiceArea,
      hoursCompleteCustomerUrl: booking.hoursCompleted
        ? buildHoursCompleteWhatsAppUrl({
            toPhone: booking.customer?.phone,
            booking: hoursPayload,
            cookName: booking.cook?.name,
            cookPhone: booking.cook?.phone,
            customerName: booking.customer?.name,
          })
        : null,
      hoursCompleteCookUrl: booking.hoursCompleted
        ? buildHoursCompleteWhatsAppUrl({
            toPhone: booking.cook?.phone,
            booking: hoursPayload,
            cookName: booking.cook?.name,
            cookPhone: booking.cook?.phone,
            customerName: booking.customer?.name,
          })
        : null,
    });
  } catch (error) {
    next(error);
  }
};

exports.payBooking = async (req, res, next) => {
  try {
    let booking = await Booking.findOne({
      _id: req.params.id,
      customer: req.user.id,
    });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    await expireBookingIfNeeded(booking);
    if (booking.payment?.status === "paid") {
      if (booking.status === "accepted") {
        booking.status = "confirmed";
        booking.statusHistory.push({
          status: "confirmed",
          note: "Payment already recorded — confirmed on re-check.",
        });
        await booking.save();
      }
      // Webhook-confirmed stragglers reach the cook's scheduled message here.
      try {
        require("../services/whatsappDispatch").notifyWhatsAppEvent("booking.accepted", booking);
      } catch {
      }
      const paidObj = booking.toObject ? booking.toObject() : booking;
      return res.json({ ...paidObj, alreadyPaid: true });
    }
    if (booking.status === "cancelled" || booking.status === "expired") {
      return res.status(410).json({
        message:
          "Payment window expired — the slot was released. Please book the cook again.",
      });
    }
    if (booking.status !== "accepted") {
      return res.status(400).json({
        message: `This booking is not awaiting payment (status: ${booking.status}).`,
      });
    }
    if (!booking.cook) {
      return res.status(400).json({
        message: "No cook has accepted this request yet — payment unlocks after a cook accepts.",
      });
    }
    if (dbReady()) {
      try {
        const { start: payDayStart, end: payDayEnd } = dayBounds(booking.date);
        const payRivals = await Booking.find({
          cook: booking.cook,
          _id: { $ne: booking._id },
          date: { $gte: payDayStart, $lte: payDayEnd },
          status: { $in: ["accepted", "confirmed", "in_progress"] },
        }).select("startTime endTime status");
        const payStart = timeToMinutes(booking.startTime);
        const payEnd = timeToMinutes(booking.endTime);
        const payClash = (payRivals || []).some((r) => {
          const rs = timeToMinutes(r.startTime);
          const re = timeToMinutes(r.endTime);
          return rs != null && re != null && intervalsOverlap(payStart, payEnd, rs, re);
        });
        if (payClash) {
          return res.status(409).json({
            message: "This slot was just confirmed for another booking. Please pick a different time.",
          });
        }
      } catch {
        return res.status(500).json({
          message: "Could not verify slot availability right now. Please try again.",
        });
      }
    }
    const payment = req.body.payment || {};
    const razorpayOrderId = payment.razorpayOrderId || req.body.razorpayOrderId;
    const razorpayPaymentId = payment.razorpayPaymentId || req.body.razorpayPaymentId;
    const razorpaySignature = payment.razorpaySignature || req.body.razorpaySignature;
    const hasPayment = Boolean(razorpayOrderId && razorpayPaymentId && razorpaySignature);
    if (hasPayment) {
      if (!process.env.RAZORPAY_KEY_SECRET) {
        return res.status(503).json({ message: "Payments cannot be verified right now. Try again later." });
      }
      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(`${razorpayOrderId}|${razorpayPaymentId}`)
        .digest("hex");
      if (!signaturesEqual(expectedSignature, razorpaySignature)) {
        return res.status(402).json({ message: "Payment verification failed. Please try paying again." });
      }
      const storedOrderId = String(booking.payment?.razorpayOrderId || "");
      if (!storedOrderId || storedOrderId !== String(razorpayOrderId)) {
        return res.status(402).json({
          message: "This payment does not belong to this booking. Please start a fresh payment.",
          code: "PAYMENT_AMOUNT_MISMATCH",
        });
      }
    }
    const zeroAmount = hasPayment ? false : Number(booking.amount) <= 0;
    if (zeroAmount && !booking.couponCode) {
      return res.status(400).json({
        message: "This booking has no payable amount recorded. Please contact support.",
      });
    }
    if (hasPayment) {
      const orderErr = await assertRazorpayOrderAmount(razorpayOrderId, Number(booking.amount || 0) * 100);
      if (orderErr) {
        return res.status(402).json({ message: orderErr, code: "PAYMENT_AMOUNT_MISMATCH" });
      }
      const captureErr = await assertRazorpayPaymentCaptured(
        razorpayOrderId,
        razorpayPaymentId,
        Number(booking.amount || 0) * 100
      );
      if (captureErr) {
        return res.status(402).json({ message: captureErr, code: "PAYMENT_AMOUNT_MISMATCH" });
      }
    }
    if (!hasPayment && !zeroAmount) {
      return res.status(400).json({
        message:
          "Online payment is required — please complete the UPI/card payment to confirm this booking.",
        code: "PAYMENT_REQUIRED",
      });
    }
    const method = String(req.body?.method || "upi").toLowerCase();
    const now = new Date();
    const paymentDoc = zeroAmount
      ? {
          status: "paid",
          paidAmount: 0,
          paidAt: now,
          testMode: false,
          razorpayOrderId: "",
          razorpayPaymentId: `zero_free_${booking._id.toString()}`,
          razorpaySignature: "no_charge",
        }
      : {
          status: "paid",
          paidAmount: booking.amount,
          paidAt: now,
          testMode: false,
          razorpayOrderId,
          razorpayPaymentId,
          razorpaySignature,
        };
    const confirmEntry = zeroAmount
      ? { status: "confirmed", note: "100% discount — no payment required" }
      : {
          status: "confirmed",
          note: `Payment received via ${method}`,
        };
    const claimed = await Booking.findOneAndUpdate(
      { _id: booking._id, status: "accepted", "payment.status": { $ne: "paid" } },
      { $set: { payment: paymentDoc, status: "confirmed" }, $push: { statusHistory: confirmEntry } },
      { new: true }
    );
    if (!claimed) {
      const fresh = await Booking.findOne({ _id: booking._id, customer: req.user.id });
      if (fresh?.payment?.status === "paid") {
        const freshObj = fresh.toObject ? fresh.toObject() : fresh;
        return res.json({ ...freshObj, alreadyPaid: true });
      }
      return res.status(409).json({ message: "Payment is already being processed — please check your bookings.", code: "PAYMENT_ALREADY_PROCESSED" });
    }
    booking = claimed;

    await recordLedger({
      idempotencyKey: `pay:${booking._id}:${booking.payment?.razorpayPaymentId || "no-gateway"}`,
      booking: booking._id,
      type: "payment.confirmed",
      amount: Math.round(Number(booking.payment?.paidAmount || 0)),
      prevState: "payment:pending",
      newState: "payment:paid",
      actor: `customer:${booking.customer}`,
      source: "checkout",
      razorpayOrderId: booking.payment?.razorpayOrderId || "",
      razorpayPaymentId: booking.payment?.razorpayPaymentId || "",
      reason: zeroAmount ? "100% discount — no charge" : "Razorpay payment confirmed",
    });

    if (dbReady() && !zeroAmount) {
      try {
        const { start: postDayStart, end: postDayEnd } = dayBounds(booking.date);
        const postRivals = await Booking.find({
          cook: booking.cook,
          _id: { $ne: booking._id },
          date: { $gte: postDayStart, $lte: postDayEnd },
          status: { $in: ["confirmed", "in_progress"] },
        }).select("startTime endTime status");
        const myStart = timeToMinutes(booking.startTime);
        const myEnd = timeToMinutes(booking.endTime);
        const postClash = (postRivals || []).some((r) => {
          const rs = timeToMinutes(r.startTime);
          const re = timeToMinutes(r.endTime);
          return rs != null && re != null && intervalsOverlap(myStart, myEnd, rs, re);
        });
        if (postClash) {
          try {
            await Notification.create({
              user: booking.customer,
              type: "booking_confirmed",
              booking: booking._id,
              message: `Your payment was received and your booking is confirmed, but the slot overlaps another confirmed booking for this cook. Our team will contact you to reconcile (rebook or refund) — please keep payment id ${booking.payment?.razorpayPaymentId || ""}.`,
            });
          } catch {
          }
        }
      } catch {
      }
    }

    let cookUser = null;
    let customer = null;
    try {
      [cookUser, customer] = await Promise.all([
        User.findById(booking.cook).select("name phone"),
        User.findById(booking.customer).select("name phone"),
      ]);
    } catch {
      cookUser = null;
      customer = null;
    }

    try {
      const dateLabel = new Date(booking.date).toLocaleDateString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      const serviceLabel = String(booking.serviceType || "").replace(/_/g, " ");
      const venueParts = [
        booking.address || "",
        booking.addressDetails?.flatNo || "",
        booking.addressDetails?.society || "",
        booking.addressDetails?.landmark || "",
        booking.addressDetails?.city || "",
      ]
        .map((p) => String(p).trim())
        .filter(Boolean)
        .join(", ");
      const venuePin =
        booking.location?.lat != null && booking.location?.lng != null
          ? `https://www.google.com/maps?q=${booking.location.lat},${booking.location.lng}`
          : null;
      const detailLines = [
        `Payment received — booking confirmed! ${customer?.name || "A customer"} paid ${booking.payment.testMode ? "(test payment) " : ""}₹${booking.amount}.`,
        `Customer: ${customer?.name || "Customer"}${customer?.phone ? ` (${customer.phone})` : ""}`,
        `Service: ${serviceLabel}`,
        `When: ${dateLabel}, ${booking.startTime}–${booking.endTime}${booking.durationHours ? ` (${booking.durationHours} hrs)` : ""}`,
        booking.guests ? `Guests: ${booking.guests}` : null,
        venueParts ? `Venue: ${venueParts}` : null,
        venuePin ? `Venue pin: ${venuePin}` : null,
        booking.selectedItems?.length ? `Dishes: ${booking.selectedItems.join(", ")}` : null,
        booking.notes ? `Notes: ${booking.notes}` : null,
        "Please reach the venue on time.",
      ].filter(Boolean);
      await Notification.create({
        user: booking.cook,
        type: "booking_confirmed",
        booking: booking._id,
        message: detailLines.join("\n"),
      });
    } catch {
    }

    let cookWhatsappUrl = null;
    try {
      cookWhatsappUrl = buildCookJobSheetWhatsAppUrl({
        cookPhone: cookUser?.phone,
        customerName: customer?.name,
        customerPhone: customer?.phone,
        booking,
      });
    } catch {
      cookWhatsappUrl = null;
    }

    let customerWhatsappUrl = null;
    try {
      customerWhatsappUrl = buildCustomerWhatsAppUrl({
        customerPhone: customer?.phone,
        cookName: cookUser?.name,
        cookPhone: cookUser?.phone,
        booking,
      });
    } catch {
      customerWhatsappUrl = null;
    }

    try {
      const dateLabel = new Date(booking.date).toLocaleDateString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      });
      await Notification.create({
        user: booking.customer,
        type: "booking_confirmed",
        booking: booking._id,
        message: `Booking confirmed — payment received! ${
          cookUser?.name || "Your cook"
        } will arrive on ${dateLabel}, ${booking.startTime}–${booking.endTime}.${
          cookUser?.phone ? ` Contact: ${cookUser.phone}` : ""
        }`,
      });
    } catch {
    }

    // Single confirmation fan-out: cook job sheet + customer confirmation
    // with cook contact (2 Meta calls). Do NOT also emit
    // notifyWhatsAppEvent("booking.confirmed") here — it sends the customer
    // a second confirmation message for the same payment (was 3 calls).
    notifyWhatsApp("confirmed", booking, {
      cookName: cookUser?.name,
      cookPhone: cookUser?.phone,
      customerName: customer?.name,
      customerPhone: customer?.phone,
    });
    // Cook's scheduled job sheet goes out only now — after payment is done
    // (sendCookScheduledMessage skips while unpaid; already-sent is deduped).
    try {
      require("../services/whatsappDispatch").notifyWhatsAppEvent("booking.accepted", booking);
    } catch {
    }

    const obj = booking.toObject ? booking.toObject() : booking;
    res.json({ ...obj, cookWhatsappUrl, customerWhatsappUrl });
  } catch (error) {
    if (error?.code === 11000 && error?.keyPattern?.["payment.razorpayPaymentId"] != null) {
      return res.status(409).json({
        message: "This payment has already been recorded for another booking.",
      });
    }
    next(error);
  }
};

exports.getMyLocations = async (req, res, next) => {
  try {
    const bookings = await Booking.find({ customer: req.user.id })
      .select("address addressDetails location date createdAt")
      .sort({ createdAt: -1 })
      .limit(100);
    const seen = new Map();
    for (const b of bookings) {
      const address = String(b.address || "").trim();
      if (!address) continue;
      const lat = Number(b.location?.lat);
      const lng = Number(b.location?.lng);
      const hasPin = Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
        Number.isFinite(lng) && lng >= -180 && lng <= 180;
      // Dedup by address text AND pin: materially different pins for one
      // address label stay separate entries instead of collapsing.
      const key = hasPin
        ? `${address.toLowerCase()}||${lat.toFixed(4)},${lng.toFixed(4)}`
        : address.toLowerCase();
      if (!seen.has(key)) {
        seen.set(key, {
          address,
          addressDetails: b.addressDetails || {},
          location: hasPin ? { lat, lng } : null,
          lastUsed: b.createdAt,
          timesUsed: 1,
        });
      } else {
        const entry = seen.get(key);
        entry.timesUsed += 1;
        if (hasPin && !entry.location) {
          entry.location = { lat, lng };
          entry.addressDetails = b.addressDetails || entry.addressDetails;
        }
      }
      if (seen.size >= 10) break;
    }
    res.json([...seen.values()].slice(0, 10));
  } catch (error) {
    next(error);
  }
};

exports.getAdminBookings = async (req, res, next) => {
  try {
    const pg = paginationParams(req);
    const adminFilter = excludeUnpaidCancelled();
    const bookings = await applyPagination(
      Booking.find(adminFilter)
        .populate("customer", "name email phone")
        .populate("cook", "name email phone")
        .sort({ createdAt: -1 }),
      pg
    );
    for (const b of bookings) {
      try {
        await expireBookingIfNeeded(b);
        await markHoursCompleteIfNeeded(b);
      } catch {
      }
    }
    let reviewByBookingId = {};
    try {
      const Review = require("../models/Review");
      const reviews = await Review.find({
        booking: { $in: bookings.map((b) => b._id) },
      })
        .populate("customer", "name")
        .select("booking customer rating comment createdAt");
      reviewByBookingId = Object.fromEntries(
        reviews.map((r) => [r.booking.toString(), r.toObject ? r.toObject() : r])
      );
    } catch {
      reviewByBookingId = {};
    }
    return sendList(
      res,
      bookings.map((b) => {
        const obj = stripServiceOtp(b.toObject ? b.toObject() : b);
        return { ...obj, review: reviewByBookingId[b._id.toString()] || null };
      }),
      pg,
      () => Booking.countDocuments(adminFilter)
    );
  } catch (error) {
    next(error);
  }
};
