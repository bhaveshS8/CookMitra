const Booking = require("../models/Booking");
const mongoose = require("mongoose");
const Notification = require("../models/Notification");
const CookProfile = require("../models/CookProfile");
const Coupon = require("../models/Coupon");
const User = require("../models/User");
const { normalizeCode, rejectionReason, computeDiscount } = require("../utils/coupons");
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

// OTP for starting a service: 4 digits, first digit non-zero so it always
// renders as 4 digits (no leading-zero display issues).
const generateServiceOtp = () =>
  String(1000 + crypto.randomInt(0, 9000));

// End of the service clock. Prefers the live clock (serviceEndsAt, set when
// the cook enters the OTP) over the static schedule (date + endTime) so the
// hours-complete alarm counts from the actual start, not the booking slot.
// Static schedule resolves via istEventInstant (F-08): IST wall time → UTC
// instant, identical on every host timezone.
const sessionEndDate = (booking) => {
  if (booking?.serviceEndsAt) {
    const d = new Date(booking.serviceEndsAt);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (!booking?.date || !booking?.endTime) return null;
  return istEventInstant(booking.date, booking.endTime);
};

// No-show bookings: scheduled (accepted/confirmed/in_progress) but the cook
// never started the OTP-verified service and the service hours already
// passed. After the hours pass, these are transitioned to
// "unattended" and surfaced in the cook's login with a red card. Customers
// and admins still see them (history, refunds, complaints). Bookings without
// a computable session end are never treated as no-shows — when in doubt, show.
const isNoShowPastHours = (booking, now) => {
  if (!["accepted", "confirmed", "in_progress"].includes(booking?.status)) return false;
  if (booking.cookArrived || booking.serviceStartedAt) return false;
  const end = sessionEndDate(booking);
  return Boolean(end) && now >= end.getTime();
};

// Scheduled service-start datetime (static date + startTime). Unlike
// sessionEndDate this never uses the live OTP clock: the 30-minute
// cancel cutoff is anchored to the agreed slot, not to when the
// cook actually started. Resolves via istEventInstant (F-08).
const sessionStartDate = (booking) => {
  if (!booking?.date || !booking?.startTime) return null;
  return istEventInstant(booking.date, booking.startTime);
};
exports.sessionStartDate = sessionStartDate;
exports.sessionEndDate = sessionEndDate;

// Customers and cooks may cancel only until 30 minutes before
// the scheduled service start — inside that window the cook is already on
// the way. Admins are exempt (support override). Unknown start ⇒ unlocked
// (fail-open; the OTP-started guard still applies).
const CANCEL_LOCK_MS = 30 * 60 * 1000;
const cancelLocked = (booking, now = Date.now()) => {
  const start = sessionStartDate(booking);
  return Boolean(start) && now >= start.getTime() - CANCEL_LOCK_MS;
};

// ── Reschedule policy (v1: customer + admin, instant move) ─────────────────
// Only upcoming, not-yet-started bookings may move. The CURRENT slot must be
// outside the same 30-minute cutoff as cancellation (a move is at least as
// disruptive as a cancel) and the NEW slot must start at least 30 minutes from
// now — without that lead a move could dodge the cutoff by jumping into a slot
// that is already minutes away. Customers get a small cap; admins are exempt
// from both the lock and the cap (support override).
const RESCHEDULE_ALLOWED_STATUSES = ["requested", "accepted", "confirmed"];
const RESCHEDULE_MIN_LEAD_MS = 30 * 60 * 1000;
const MAX_CUSTOMER_RESCHEDULES = 2;
// Service day 08:00–20:00 — mirror of the constants in utils/slots.js (not
// exported there) so a move can never land outside the bookable day.
const RESCHEDULE_DAY_START_MIN = 8 * 60;
const RESCHEDULE_DAY_END_MIN = 20 * 60;
// Same 30-minute rule as cancel — a reschedule is not a lesser change of
// commitment. Exported for the reschedule unit tests.
const rescheduleLocked = (booking, now = Date.now()) => cancelLocked(booking, now);
// Optional customer reason for a move (v2) — stored on the reschedules[]
// audit entry, never mandatory, never sensitive PII, max 200 chars.
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


// Refund policy: money is NEVER moved automatically. A cancel, reject or
// expiry of a paid booking only queues a refund request (refundStatus
// "pending") for an admin to approve or reject in the Payouts tab.
// Test payments carry no real money, so they queue nothing. Returns the
// queued amount (0 when there is nothing refundable).
const queueRefundForApproval = (booking, reason) => {
  const pay = booking.payment || {};
  if (pay.status !== "paid" || pay.testMode) return 0;
  // Idempotent: a queued/processed/failed/manual/rejected refund is never
  // re-queued by a retry or a second terminal transition.
  if (pay.refundStatus && pay.refundStatus !== "none") return 0;
  const amount = Math.round(Number(pay.paidAmount || booking.amount || 0));
  if (!(amount > 0)) return 0;
  booking.payment.refundStatus = "pending";
  booking.payment.refundAmount = amount;
  booking.statusHistory.push({
    status: booking.status,
    note: `Refund of ₹${amount} queued for admin approval (${reason})`,
  });
  return amount;
};

// True when a live MongoDB connection exists. Unit tests run disconnected,
// so DB-dependent safety re-checks (not core logic) skip instead of hanging
// on buffered operations.
const dbReady = () => {
  try {
    return mongoose.connection && mongoose.connection.readyState === 1;
  } catch {
    return false;
  }
};

// Strip the service OTP from a booking payload before it reaches the cook:
// the cook must ask the customer for the code in person. Applies to a
// Mongoose doc, a lean object, or an array of either. All four OTP fields
// go — attempt counts and lockout timestamps would otherwise give the cook
// an oracle for an ongoing brute-force attack.
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

// Cook profile photos live on CookProfile, but booking payloads populate only
// the cook's User (name/email/phone) — so every avatar across the site would
// fall back to initials. Batch-attach `cook.photoUrl` (one query per call,
// never throws: avatars degrade to initials when the lookup fails).
const attachCookPhotoUrls = async (objs) => {
  try {
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
    // non-fatal: avatars fall back to initials
  }
};

// Ensure a booking has a service-start OTP (generated once at creation; back
// filled for older bookings). Returns true when a new OTP was assigned.
// The doc must be saved by the caller afterwards.
const ensureServiceOtp = (booking) => {
  if (booking?.serviceOtp) return false;
  booking.serviceOtp = generateServiceOtp();
  booking.serviceOtpGeneratedAt = new Date();
  return true;
};

// Constant-time HMAC comparison (plain !== leaks via timing).
const signaturesEqual = (a, b) => {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

// Bind a Razorpay payment to the expected fee: the HMAC alone only proves the
// (orderId, paymentId) pair is genuine — NOT that the order charged this
// booking's amount. Without this check a cheap order's valid triple could be
// replayed to "pay" an expensive booking. Shared implementation lives in
// utils/razorpayVerify (order amount + capture status); this alias keeps
// existing imports working.

// Notifies the customer that the service completed and prompts a rating.
// Shared by manual, live-clock auto and legacy auto completions.
const notifyServiceCompleted = async (booking) => {
  let cookName = "your cook";
  try {
    const cookUser = await User.findById(booking.cook).select("name");
    if (cookUser?.name) cookName = cookUser.name;
  } catch {
    // non-fatal
  }
  try {
    await Notification.create({
      user: booking.customer,
      type: "booking_completed",
      booking: booking._id,
      message: `Service complete! ${cookName} finished your session — please rate your cook.`,
    });
  } catch {
    // non-fatal
  }
  // The cook hears about it too (mirrors the manual-complete notice) —
  // completion closes their job and unlocks the payout queue.
  try {
    await Notification.create({
      user: booking.cook,
      type: "booking_completed",
      booking: booking._id,
      message: "Service marked complete — the customer has been asked to rate the session.",
    });
  } catch {
    // non-fatal
  }
  // WhatsApp push to BOTH sides, including the rate-your-cook prompt
  // (fire-and-forget).
  notifyWhatsApp("completed", booking);
};

// Flag cooking-hours completion. The session clock only runs after the cook
// verifies the service-start OTP (serviceStartedAt → serviceEndsAt); the
// static schedule is only a fallback for bookings started before this
// feature. Creates the alarm notification for BOTH customer and cook.
// Returns true when newly flagged.
// Auto-complete: a service that ran on the live OTP clock and is still
// `in_progress` past its end flips to `completed` by itself (with the same
// rate-prompt as a manual complete). OTP verification proves the cook and
// customer met, so payment state deliberately does NOT gate this — money
// stays visible separately as paid/due.
const markHoursCompleteIfNeeded = async (booking) => {
  let changed = false;
  // F-09 healing: paid bookings flipped to "unattended" before the refund
  // queue existed strand customer money. Queue on next read (idempotent —
  // queueRefundForApproval no-ops once a refund exists).
  if (
    booking.status === "unattended" &&
    booking.payment?.status === "paid" &&
    (!booking.payment?.refundStatus || booking.payment.refundStatus === "none")
  ) {
      try {
        const queued = queueRefundForApproval(booking, "booking_unattended");
        if (queued > 0) {
          // Targeted write: a full-doc save() here could clobber a
          // concurrent cancel/complete transition on this paid no-show.
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
              // non-fatal: retried on the next read
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
          // non-fatal
        }
      }
    } catch {
      // non-fatal: retried on the next read
    }
  }
  if (!booking.hoursCompleted) {
    if (!["accepted", "confirmed", "in_progress"].includes(booking.status)) return false;
    // Legacy bookings (no OTP flow yet) still complete on the static schedule;
    // OTP-started bookings complete on the live service clock.
    if (!booking.serviceStartedAt && booking.serviceOtp) return false;
    const end = sessionEndDate(booking);
    if (!end || Date.now() < end.getTime()) return false;
    // Atomic flag claim (production DB path): concurrent readers must not
    // all fire the hours-complete notifications — exactly one winner
    // notifies. Skipped without a DB connection (legacy flow).
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
    // WhatsApp alarm to BOTH sides (fire-and-forget).
    notifyWhatsApp("hours_complete", booking);
  }
  if (booking.status === "in_progress" && booking.serviceStartedAt) {
    const end = sessionEndDate(booking);
    if (end && Date.now() >= end.getTime()) {
      // Atomic auto-complete claim: a concurrent cancel must win or lose
      // cleanly — never be overwritten back by a stale-doc save.
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
            // non-fatal
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
  // Backfill for old bookings (no OTP clock ever started): PAID services stuck
  // in a live status long after their scheduled end are closed automatically.
  // 24h grace past the scheduled end so a service running today without OTP
  // is never cut off mid-day. F-11: arrival alone no longer completes — an
  // unpaid session is not a rendered service, so unpaid rows (even with
  // cookArrived) are left for a human to cancel, never auto-completed.
  if (
    !booking.serviceStartedAt &&
    ["accepted", "confirmed", "in_progress"].includes(booking.status) &&
    booking.payment?.status === "paid"
  ) {
    const end = sessionEndDate(booking);
    if (end && Date.now() >= end.getTime() + 24 * 60 * 60 * 1000) {
      // Atomic legacy auto-complete claim (same race contract as above).
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
            // non-fatal
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
  // Cook never attended and service hours have passed → mark as "unattended".
  // This surfaces the booking in the cook's login with a red card so they
  // can see what they missed, instead of silently hiding it.
  if (
    !booking.cookArrived &&
    !booking.serviceStartedAt &&
    ["accepted", "confirmed", "in_progress"].includes(booking.status)
  ) {
    const end = sessionEndDate(booking);
    if (end && Date.now() >= end.getTime()) {
      // Atomic unattended claim: a concurrent cancel must win or lose
      // cleanly — never be resurrected by a stale-doc save.
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
            // non-fatal
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
      // F-09: a paid no-show must never strand customer money. Queue a refund
      // for admin approval and free the coupon, exactly like a cancel does —
      // queueRefundForApproval is a no-op unless paid with no refund yet, and
      // releaseCouponUsage claims atomically, so repeats are safe.
      let unattendedRefund = 0;
      try {
        unattendedRefund = queueRefundForApproval(booking, "booking_unattended") || 0;
        if (unattendedRefund > 0) {
          // Targeted write: never a full-doc save() after the atomic flip.
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
              // non-fatal: the status flip above is what matters
            }
          } else {
            try {
              await booking.save();
            } catch {
              // non-fatal: the status flip above is what matters
            }
          }
        }
      } catch {
        // non-fatal: the status flip above is what matters
      }
      try {
        await releaseCouponUsage(booking);
      } catch {
        // non-fatal: best-effort
      }
      changed = true;
      // Both sides hear about the no-show (best-effort — the flip above is
      // what matters). The customer also learns a refund was queued.
      try {
        await Notification.create({
          user: booking.customer,
          type: "booking_unattended",
          booking: booking._id,
          message: `Your cook did not attend the session.${unattendedRefund > 0 ? ` A refund of ₹${unattendedRefund} has been requested — our team will review it shortly.` : " Please contact support if you were charged."}`,
        });
      } catch {
        // non-fatal
      }
      try {
        await Notification.create({
          user: booking.cook,
          type: "booking_unattended",
          booking: booking._id,
          message: "You missed a booked session — it was marked unattended. Please contact support if this is a mistake.",
        });
      } catch {
        // non-fatal
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
          // non-fatal
        }
      }
    }
  }
  return changed;
};

// OTP-verified arrival: records presence ONLY as a side effect of the
// customer handing over the start code (start-service calls this after the
// OTP check, so the code IS the proof the cook is on site). Arrival on an
// UNPAID hold records the flag but never promotes the status: promoting
// accepted-unpaid to in_progress would let an unpaid session be completed
// (and would block legitimate customer cancellation). Promotion requires a
// captured payment.
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

// Fields a customer may set when creating a booking. Everything else
// (customer, status, payment, amount, cookArrived, hoursCompleted, dates)
// is derived server-side. Without this whitelist a customer could POST
// `{ customer: <someoneElseId>, cookArrived: true, hoursCompleted: true }` —
// the old `Booking.create({ customer: req.user.id, ...req.body, ... })`
// spread put the body AFTER customer, so a body `customer` field silently
// OVERRODE the authenticated user and injected lifecycle flags.
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
  return out;
};

// ── Find-Cook broadcast: eligible-cook resolution ─────────────────────────
// A cook is eligible for a broadcast request only if EVERY check passes:
// approved profile, live (non-suspended) account, currently available
// toggle, service-type membership (when the profile declares one), the
// requested window fits inside the cook's open windows, and no conflicting
// live booking/hold overlaps the slot. Optionally excludes cooks who
// already ignored this request. Batched: one profile query + one bookings
// $in query, then in-memory math per cook (same pattern as the
// availability search). Snapshot only — acceptance re-checks everything.
const findEligibleCooks = async ({ date, startTime, endTime, serviceType, excludeCookIds = [] }) => {
  const excluded = new Set((excludeCookIds || []).map((id) => String(id)));
  let profiles = [];
  try {
    profiles = await CookProfile.find({ approvalStatus: "approved" })
      .populate("user", "name status")
      .lean();
  } catch {
    return [];
  }
  const live = [];
  for (const p of profiles || []) {
    const userId = p?.user?._id || p?.user;
    if (!userId) continue;
    if (excluded.has(String(userId))) continue;
    // Service-type membership — only when the profile declares a list
    // (legacy profiles with an empty list can perform any service).
    if (
      Array.isArray(p.serviceTypes) &&
      p.serviceTypes.length > 0 &&
      serviceType &&
      !p.serviceTypes.includes(serviceType)
    ) {
      continue;
    }
    if (!p.user || p.user.status === "suspended") continue;
    let available = false;
    try {
      available = await resolveCookAvailability(p);
    } catch {
      available = false;
    }
    if (!available) continue;
    live.push({ profile: p, userId: String(userId) });
  }
  if (!live.length) return [];
  // One bookings lookup for every candidate on that day, then in-memory
  // window + overlap math per cook.
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
    if (!findContainingWindow(windows, startTime, endTime)) continue;
    if (findOverlapBooking(byCook.get(userId) || [], startTime, endTime)) continue;
    eligible.push({ profile, userId });
  }
  return eligible;
};
exports.findEligibleCooks = findEligibleCooks;

exports.createBooking = async (req, res, next) => {
  try {
    // Find-Cook flow: the client NEVER chooses the cook. Any `cook` /
    // `cookId` in the body is untrusted input and is ignored — the booking
    // is created unassigned (cook = null) and the first atomic accept wins.
    const { date, startTime, endTime } = req.body;

    // Strict date/time validation (server-side, IST): full HH:MM shape,
    // real calendar day, 30-minute grid, whole-hour 1–4h sessions. Frontend
    // defaults and stale tabs can never bypass this.
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
    // Stale-request guard: past dates and start times that already passed
    // today are refused (a forgotten open tab must not create a booking for
    // a lapsed slot). Business clock is Asia/Kolkata regardless of host TZ.
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

    // Idempotency: a client-generated key per booking attempt. Retries
    // (double-click, network retry, back button) with the same key return
    // the original hold instead of minting a duplicate.
    const clientKey = String(req.body.clientKey || req.body.idempotencyKey || "").trim().slice(0, 120);
    if (clientKey && dbReady()) {
      try {
        const existing = await Booking.findOne({ clientKey, customer: req.user.id });
        if (existing) {
          const existingObj = existing.toObject ? existing.toObject() : existing;
          return res.status(200).json({ ...existingObj, alreadyExists: true });
        }
      } catch {
        // non-fatal: fall through and create
      }
    }

    // The requested window must be servable by at least one eligible cook
    // right now (approved + live + available + window fits + no overlap).
    // Eligibility is a snapshot — acceptance re-checks everything — but a
    // request nobody can serve must fail fast instead of stranding the
    // customer on the waiting screen.
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
    // The customer cannot hold two overlapping live bookings for the same
    // window (double-booking themselves).
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
        const selfClash = (ownLive || []).some((r) => {
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
              // non-fatal: fall through to the 409 below
            }
          }
          return res.status(409).json({ message: "You already have a booking for that time." });
        }
      }
    } catch {
      // non-fatal: the per-cook eligibility above already gated the request
    }

    // Payment is optional (online pay-before-booking removed): when Razorpay
    // details are supplied they are verified as before, otherwise the booking
    // is created with payment.status "pending".
    const payment = req.body.payment || {};
    const razorpayOrderId = payment.razorpayOrderId || req.body.razorpayOrderId;
    const razorpayPaymentId = payment.razorpayPaymentId || req.body.razorpayPaymentId;
    const razorpaySignature = payment.razorpaySignature || req.body.razorpaySignature;
    const hasPayment = Boolean(razorpayOrderId && razorpayPaymentId && razorpaySignature);
    // A partial triple proves nothing and must never be silently dropped: an
    // unverified payment id with no booking link is orphaned money with no
    // recovery path. Fail closed. (Runs before coupon redemption, so nothing
    // needs releasing here.)
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
    // Launch price list covers whole-hour 1–4h sessions only.
    if (![1, 2, 3, 4].includes(billedHours)) {
      return res.status(400).json({ message: "Sessions run 1–4 hours" });
    }
    // The stated duration must match the selected window (windows are sized
    // from the input service hours).
    if (req.body.durationHours != null && req.body.durationHours !== "") {
      const stated = Number(req.body.durationHours);
      if (!Number.isFinite(stated) || Math.abs(stated - billedHours) > 0.001) {
        return res.status(400).json({ message: "Duration does not match the selected time slot" });
      }
    }
    // Launch slab pricing — the fee comes from the price list, never from
    // the client and no longer from the cook's rack rate.
    const slabPrice = slabPriceForDuration(billedHours);
    if (slabPrice == null) {
      return res.status(400).json({ message: "Sessions run 1–4 hours" });
    }
    // Optional coupon: re-validated fresh here (eligibility, min order,
    // service, first-booking) and redeemed on success. The /validate
    // endpoint only previews — it never mutates usage.
    let couponCode = "";
    let discount = 0;
    const rawCode = normalizeCode(req.body.couponCode);
    if (rawCode) {
      const coupon = await Coupon.findOne({ code: rawCode });
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
      // Atomic redemption: the eligibility check above is a read, so two
      // concurrent requests could both pass it (double-spend of a single-use
      // code). Re-enforce the count limits INSIDE a conditional update — only
      // one racer's filter matches, the loser gets null and a 409.
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
              // Re-assert first-booking eligibility atomically with the
              // redemption (the earlier count was a plain read). Keeps the
              // firstBookingOnly guard from being raced by two concurrent
              // first bookings issuing from the same pre-registered count.
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
    // 25% platform commission; the cook earns 75% of the final amount.
    const { finalAmount, commission, cookPayout } = splitPayout(slabPrice - discount);
    const expectedAmount = finalAmount;
    // The coupon was already redeemed above — every path that fails AFTER the
    // redemption must free it, or a single-use code is burned with no booking.
    const redeemedRef = { couponCode, customer: req.user.id };
    if (hasPayment) {
      const paidAmount = Number(req.body.amount ?? payment.paidAmount);
      if (!Number.isFinite(paidAmount) || Math.round(paidAmount) !== expectedAmount) {
        await releaseCouponUsage(redeemedRef);
        return res.status(400).json({
          message: `Paid amount does not match the payable fee of ₹${expectedAmount}. Please create a fresh payment.`,
        });
      }
      // The HMAC above proves the triple is genuine; this proves the order
      // actually charged THIS booking's fee (blocks cheap-order replay),
      // and that the payment was captured (not merely authorized/failed).
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
        // Find-Cook: always unassigned at creation — never from the client.
        cook: null,
        ignoredBy: [],
        ...pickBookingCustomerFields(req.body),
        // billedHours is validated above to match any stated duration, so it is
        // the authoritative duration — persisting it keeps the start/pay flows
        // working even when the client omits the optional durationHours field.
        durationHours: billedHours,
        // Stored as the UTC instant of IST midnight (F-08) — every reader
        // resolves the business day from IST parts, so the stored day is
        // correct on any host timezone. Identical instant to the old
        // local-midnight value on IST-pinned hosts.
        date: istMidnight(date),
        ...(clientKey ? { clientKey } : {}),
        amount: expectedAmount,
        slabPrice,
        couponCode,
        discount,
        commission,
        cookPayout,
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
        // Every order gets its own 4-digit service-start OTP. Generated once
        // at creation (never regenerated later), shown only to the customer.
        serviceOtp: generateServiceOtp(),
        serviceOtpGeneratedAt: new Date(),
      });
    } catch (createErr) {
      // A booking that failed to persist must not burn a redeemed coupon.
      if (couponCode) {
        try {
          await releaseCouponUsage(redeemedRef);
        } catch {
          // non-fatal: the error below is what matters
        }
      }
      // The unique payment-id index rejects a replayed payment triple.
      if (createErr?.code === 11000 && createErr?.keyPattern?.["payment.razorpayPaymentId"] != null) {
        return res.status(409).json({
          message: "This payment has already been recorded for another booking.",
        });
      }
      // Idempotency-key collision: a retried request lost the pre-check race
      // with itself — return the original hold instead of a 500.
      if (createErr?.code === 11000 && createErr?.keyPattern?.clientKey != null && clientKey) {
        try {
          const original = await Booking.findOne({ clientKey, customer: req.user.id });
          if (original) {
            const originalObj = original.toObject ? original.toObject() : original;
            return res.status(200).json({ ...originalObj, alreadyExists: true });
          }
        } catch {
          // non-fatal: fall through to the generic error
        }
      }
      throw createErr;
    }

    // Close the two-customer race: two customers can pass the eligibility
    // snapshot at the same moment. Re-check AFTER inserting — if this
    // customer's own older overlapping live booking (smaller _id = created
    // earlier) occupies the interval, this request loses: delete it and
    // return the surviving original. (Per-cook double-booking is closed at
    // accept time by the atomic claim + overlap re-check there.)
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
      // Oldest overlapping rival wins: ANY older rival (not just the first
      // one returned — Mongo order is unspecified) defeats this request, so
      // three-way races cannot leave two overlapping holds behind.
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
        // Same-key retry racing its own winner: the "rival" that beat us may
        // be our own twin request. Return the surviving original instead of a
        // 409 (idempotency under concurrency).
        if (clientKey && dbReady()) {
          try {
            const mine = await Booking.findOne({ clientKey, customer: req.user.id });
            if (mine && String(mine._id) !== String(booking._id)) {
              try {
                await releaseCouponUsage(booking);
              } catch {
                // non-fatal
              }
              await Booking.findByIdAndDelete(booking._id);
              const mineObj = mine.toObject ? mine.toObject() : mine;
              return res.status(200).json({ ...mineObj, alreadyExists: true });
            }
          } catch {
            // non-fatal: fall through to the generic loser path below
          }
        }
        // Losing the race must not burn a redeemed coupon with no booking.
        try {
          await releaseCouponUsage(booking);
        } catch {
          // non-fatal: the 409 below is what matters
        }
        // A prepaid race loser already has captured money: queue it for an
        // admin refund BEFORE deleting, otherwise the payment is orphaned
        // with no booking to attach to.
        try {
          if (booking.payment?.status === "paid" && !booking.payment?.testMode) {
            queueRefundForApproval(booking, "race_slot_lost");
            try {
              await booking.save();
            } catch {
              // non-fatal: the refund fields may be lost with the delete,
              // the 409 below still tells the customer to contact support
            }
          }
        } catch {
          // non-fatal: the 409 below is what matters
        }
        await Booking.findByIdAndDelete(booking._id);
        return res.status(409).json({
          message: "This slot was just claimed by another booking request. Please pick a different start time.",
        });
      }
    } catch {
      // non-fatal: the pre-create check already covers the common cases
    }

    // First-booking coupon post-create guard: two concurrent FIRST bookings
    // both pass the pre-create countDocuments check (both see 0). After
    // insert, a firstBookingOnly coupon with 2+ bookings for this customer
    // means this request raced — release, delete, and fail closed.
    if (couponCode) {
      try {
        const fetched = await Coupon.findOne({ code: couponCode });
        if (fetched?.firstBookingOnly && dbReady()) {
          const mine = await Booking.countDocuments({ customer: req.user.id });
          if (mine > 1) {
            try {
              await releaseCouponUsage({ couponCode, customer: req.user.id, _id: booking._id });
            } catch {
              // non-fatal
            }
            try {
              if (booking.payment?.status === "paid" && !booking.payment?.testMode) {
                queueRefundForApproval(booking, "coupon_first_booking_race");
                try {
                  await booking.save();
                } catch {
                  // non-fatal
                }
              }
            } catch {
              // non-fatal
            }
            await Booking.findByIdAndDelete(booking._id);
            return res.status(409).json({
              message: "This coupon is only for your first booking.",
            });
          }
        }
      } catch {
        // non-fatal: pre-create validation already passed
      }
    }

    // Build WhatsApp URLs for cook notification

    // Broadcast the request to every eligible cook (same bookingId). The
    // booking already exists — a notification outage must not 500 the
    // request (the client would retry and double-book). Eligibility is
    // re-resolved here so the notify set matches the final persisted slot.
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
        // fall back to the pre-create snapshot
      }
      const notifDocs = (notifyCooks || []).map((c) => ({
        user: c.userId,
        type: "booking_request",
        booking: booking._id,
        message: `New booking request from ${req.user.name || "a customer"}`,
      }));
      // Insert one row per cook; duplicates impossible (fresh booking id).
      for (const doc of notifDocs) {
        try {
          await Notification.create(doc);
        } catch {
          // per-cook best effort — one failure must not block the rest
        }
      }
    } catch {
      // non-fatal: booking creation already succeeded
    }

    // Automatic WhatsApp push to BOTH sides (Meta Cloud API; no-op when
    // unconfigured). Never awaited — a notification outage must not 500
    // the request (the client would retry and double-book).
    notifyWhatsApp("request", booking, { customerName: req.user.name });

    // Contact privacy: the cook's phone number is shared only AFTER they
    // accept (see acceptBooking). A fresh "requested" booking therefore
    // exposes no contact details — coordination runs through in-app
    // notifications. Keys stay present (null) so client contracts don't break.
    const bookingObj = booking.toObject ? booking.toObject() : booking;
    res.status(201).json({ ...bookingObj, whatsappUrl: null, customerWhatsappUrl: null, cookPhone: null });
  } catch (error) {
    next(error);
  }
};

// ── 5-minute confirmation windows ──────────────────────────────────────────
// REQUEST_WINDOW_MS: the cook must accept within 5 minutes of the request.
// PAYMENT_WINDOW_MS: once accepted, the customer must pay within 5 minutes,
// otherwise the booking auto-cancels and the slot is freed.
const REQUEST_WINDOW_MS = 5 * 60 * 1000;
const PAYMENT_WINDOW_MS = 5 * 60 * 1000;

// Release a previously consumed coupon (reject/cancel/payment-expiry paths).
// Idempotent per booking via couponReleased: concurrent cancel/expire paths
// cannot double-decrement usedCount. Best-effort and must never throw.
const releaseCouponUsage = async (booking) => {
  try {
    if (!booking?.couponCode || !booking?.customer) return;
    if (booking.couponReleased === true) return;
    // F-13: atomic release claim (production DB path). Cancel and lazy-expiry
    // can run concurrently on two processes that BOTH read couponReleased=false;
    // the conditional update admits exactly one releaser — the loser returns
    // without touching usedCount. Plain { couponCode, customer } refs (no _id)
    // and the disconnected unit-test path keep the in-memory check above.
    if (booking._id && dbReady()) {
      try {
        const claimed = await Booking.updateOne(
          { _id: booking._id, couponReleased: { $ne: true } },
          { $set: { couponReleased: true } }
        );
        if ((claimed.modifiedCount ?? claimed.nModified ?? 0) !== 1) return;
      } catch {
        // Claim unavailable — fall through to the legacy path below.
      }
    }
    const Coupon = require("../models/Coupon");
    await Coupon.updateOne(
      { code: String(booking.couponCode).toUpperCase() },
      { $inc: { usedCount: -1 }, $pull: { usedBy: booking.customer } }
    );
    // Guard against negative counters from double-release.
    await Coupon.updateOne(
      { code: String(booking.couponCode).toUpperCase(), usedCount: { $lt: 0 } },
      { $set: { usedCount: 0 } }
    );
    // Mark released so a concurrent second path becomes a no-op. Plain
    // { couponCode, customer } refs (no _id) simply skip the flag. Persist
    // directly so callers that save before releasing still keep it.
    if (booking && typeof booking.save === "function" && booking.couponReleased !== undefined) {
      try {
        booking.couponReleased = true;
      } catch {
        // non-fatal
      }
    }
    try {
      if (booking?._id) {
        await Booking.updateOne({ _id: booking._id }, { $set: { couponReleased: true } });
      }
    } catch {
      // non-fatal
    }
  } catch {
    // non-fatal
  }
};

// Lazy expiry pass, run whenever a booking is read. Returns the booking when
// a transition happened so callers can re-read fresh fields.
// - "requested" older than 5 minutes → "expired" (customer's waiting screen
//   shows the sorry state and redirects them to Find Cooks).
// - "accepted" but unpaid after 5 minutes → "cancelled" (slot released).
const expireBookingIfNeeded = async (booking) => {
  try {
    const now = new Date();
    if (
      booking.status === "requested" &&
      booking.requestExpiresAt &&
      booking.requestExpiresAt < now
    ) {
      // Atomic expiry claim (production DB path): a concurrent accept must
      // win over this lazy expiry — exactly one transition commits and the
      // loser syncs to the truth. Skipped without a DB connection
      // (unit-test path keeps the legacy flow).
      if (dbReady() && booking._id) {
        let expiredClaimed = false;
        try {
          const claim = await Booking.updateOne(
            { _id: booking._id, status: "requested", requestExpiresAt: { $lt: now } },
            {
              $set: { status: "expired" },
              $push: { statusHistory: { status: "expired", note: "Cook did not respond within 5 minutes" } },
            }
          );
          expiredClaimed = (claim.modifiedCount ?? claim.nModified ?? 0) === 1;
        } catch {
          expiredClaimed = false;
        }
        if (!expiredClaimed) {
          // Lost the race (accept/reject/cancel won, or the window moved) —
          // sync to the truth and stop without side effects.
          try {
            const latest = await Booking.findById(booking._id);
            if (latest && latest.status !== "requested") {
              booking.status = latest.status;
              return booking;
            }
          } catch {
            // non-fatal
          }
          return null;
        }
        booking.status = "expired";
        booking.statusHistory.push({
          status: "expired",
          note: "Cook did not respond within 5 minutes",
        });
      } else {
        booking.status = "expired";
        booking.statusHistory.push({
          status: "expired",
          note: "Cook did not respond within 5 minutes",
        });
        await booking.save();
      }
      await releaseCouponUsage(booking);
      // A prepaid-at-creation hold (API path) must not keep captured money:
      // queue a refund for admin approval, otherwise the booking is stuck
      // expired+paid with no recovery path.
      let expiredRefundNote = "";
      try {
        const queued = queueRefundForApproval(booking, "request_expired");
        if (queued > 0) {
          // Targeted refund-queue write (production DB path): a full-doc
          // save() here could clobber a concurrent accept's payment window.
          if (dbReady() && booking._id) {
            try {
              await Booking.updateOne(
                { _id: booking._id, "payment.refundStatus": "none" },
                {
                  $set: { "payment.refundStatus": "pending", "payment.refundAmount": queued },
                  $push: {
                    statusHistory: {
                      status: booking.status,
                      note: `Refund of ₹${queued} queued for admin approval (request_expired)`,
                    },
                  },
                }
              );
            } catch {
              // non-fatal: expiry itself must always succeed
            }
          } else {
            await booking.save();
          }
          expiredRefundNote = ` A refund of ₹${queued} has been requested — our team will review it shortly.`;
        } else if (booking.payment?.testMode && booking.payment?.status === "paid") {
          expiredRefundNote = " (Test payment — no real money moved.)";
        }
      } catch {
        // non-fatal: expiry itself must always succeed
      }
      try {
        await Notification.create({
          user: booking.customer,
          type: "booking_expired",
          booking: booking._id,
          message: `Your booking request expired — the cook didn't respond within 5 minutes. Please find another cook.${expiredRefundNote}`,
        });
      } catch {
        // non-fatal: expiry itself must always succeed
      }
      // The cook's calendar just freed up — tell them the request lapsed.
      try {
        await Notification.create({
          user: booking.cook,
          type: "booking_expired",
          booking: booking._id,
          message: "A booking request expired without a response — the slot is open again.",
        });
      } catch {
        // non-fatal: expiry itself must always succeed
      }
      // WhatsApp push to BOTH sides (fire-and-forget).
      notifyWhatsApp("expired", booking);
      return booking;
    }
    if (
      booking.status === "accepted" &&
      booking.payment?.status !== "paid" &&
      booking.paymentExpiresAt &&
      booking.paymentExpiresAt < now
    ) {
      // Atomic payment-window claim (production DB path): a concurrent pay
      // confirm must win over this lazy release — exactly one commits.
      if (dbReady() && booking._id) {
        let releasedClaimed = false;
        try {
          const claim = await Booking.updateOne(
            {
              _id: booking._id,
              status: "accepted",
              "payment.status": { $ne: "paid" },
              paymentExpiresAt: { $lt: now },
            },
            {
              $set: { status: "cancelled" },
              $push: {
                statusHistory: {
                  status: "cancelled",
                  note: "Payment not completed within 5 minutes — slot released",
                },
              },
            }
          );
          releasedClaimed = (claim.modifiedCount ?? claim.nModified ?? 0) === 1;
        } catch {
          releasedClaimed = false;
        }
        if (!releasedClaimed) {
          // Lost the race (payment confirmed concurrently) — sync and stop.
          try {
            const latest = await Booking.findById(booking._id);
            if (latest && (latest.status !== "accepted" || latest.payment?.status === "paid")) {
              booking.status = latest.status;
              return booking;
            }
          } catch {
            // non-fatal
          }
          return null;
        }
        booking.status = "cancelled";
        booking.statusHistory.push({
          status: "cancelled",
          note: "Payment not completed within 5 minutes — slot released",
        });
      } else {
        booking.status = "cancelled";
        booking.statusHistory.push({
          status: "cancelled",
          note: "Payment not completed within 5 minutes — slot released",
        });
        await booking.save();
      }
      await releaseCouponUsage(booking);
      try {
        await Notification.create({
          user: booking.customer,
          type: "booking_cancelled",
          booking: booking._id,
          message: "Payment was not completed within 5 minutes — the slot was released. Please book again.",
        });
      } catch {
        // non-fatal: expiry itself must always succeed
      }
      // The held slot just freed up — tell the cook it is bookable again.
      try {
        await Notification.create({
          user: booking.cook,
          type: "booking_cancelled",
          booking: booking._id,
          message: "A held slot was released (the customer didn't pay in time) — it is bookable again.",
        });
      } catch {
        // non-fatal: expiry itself must always succeed
      }
      // WhatsApp push to BOTH sides (fire-and-forget).
      notifyWhatsApp("cancelled", booking, {
        refundNote: "The slot was released because payment was not completed in time. Please book again.",
      });
      return booking;
    }
  } catch {
    // non-fatal; retried on the next read
  }
  return null;
};
// Shared with paymentController.createOrder (payment-window check).
exports.expireBookingIfNeeded = expireBookingIfNeeded;
// Shared with the WhatsApp inbound controller (cook accept/decline taps):
// refund queueing, coupon release and overlap helpers stay single-sourced.
exports.queueRefundForApproval = queueRefundForApproval;
exports.releaseCouponUsage = releaseCouponUsage;
exports.REQUEST_WINDOW_MS = REQUEST_WINDOW_MS;
exports.PAYMENT_WINDOW_MS = PAYMENT_WINDOW_MS;
// Exported for unit tests of the cook-login no-show rule.
exports.isNoShowPastHours = isNoShowPastHours;
// Exported for unit tests of the auto-complete notification path.
exports.markHoursCompleteIfNeeded = markHoursCompleteIfNeeded;
// Exported for unit tests of the 30-minute cancel cutoff.
exports.cancelLocked = cancelLocked;
// Exported for unit tests of the 30-minute reschedule cutoff.
exports.rescheduleLocked = rescheduleLocked;
// Exported for the cook-reassignment reschedule tests + options feed.
exports.RESCHEDULE_REASONS = RESCHEDULE_REASONS;
exports.normalizeRescheduleReason = normalizeRescheduleReason;

exports.getMyBookings = async (req, res, next) => {  try {
    // A request that expired (cook didn't respond in 5 minutes) stays in the
    // customer's login for 10 minutes so the booking flow isn't lost — the
    // user can spot the failed request, open it, and retry the search for
    // another cook on the same slot. Older expired rows carry no action and
    // drop off the list. The pagination count below reuses this filter so
    // pages stay consistent.
    const EXPIRY_GRACE_MS = 10 * 60 * 1000;
    const graceCutoff = new Date(Date.now() - EXPIRY_GRACE_MS);
    const filter = {
      customer: req.user.id,
      $or: [
        { status: { $ne: "expired" } },
        { status: "expired", requestExpiresAt: { $gt: graceCutoff } },
      ],
    };
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      Booking.find(filter).populate("cook", "name email phone").sort({ createdAt: -1 }).limit(HARD_CAP),
      pg
    );
    // Submitted reviews keyed by booking id (one review per booking max).
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
        // Submitted review for completed services (one per booking).
        review: reviewByBookingId[b._id.toString()] || null,
      };
    });
    // Cook avatars across the site need the profile photo (not on the User).
    await attachCookPhotoUrls(out);
    // Time-based alarm: flag any active booking whose session end passed, and
    // lazily expire requests / unpaid acceptances whose window elapsed.
    for (const b of bookings) {
      try {
        await markHoursCompleteIfNeeded(b);
        await expireBookingIfNeeded(b);
      } catch {
        // non-fatal; alarm retries on next fetch
      }
    }
    // Re-read flagged fields so the response includes fresh hoursCompleted.
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
        // Reflect lazy expiry transitions (requested→expired, accepted
        // unpaid→cancelled) that happened during the pass above.
        o.status = match.status;
        o.statusHistory = match.statusHistory;
        o.requestExpiresAt = match.requestExpiresAt;
        o.paymentExpiresAt = match.paymentExpiresAt;
      }
      const end = sessionEndDate(match || o);
      o.sessionEnd = end ? end.toISOString() : null;
      // Hours-complete WhatsApp alarm addressed to the customer (self).
      o.hoursCompleteWhatsappUrl = o.hoursCompleted
        ? buildHoursCompleteWhatsAppUrl({
            toPhone: selfPhone,
            booking: { ...o, hoursCompletedAt: o.hoursCompletedAt },
            cookName: o.cook?.name,
            cookPhone: o.cook?.phone,
            customerName: null,
          })
        : null;
      // Completed: rating reminder with a link to the booking review page.
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
      // Contact privacy: the customer never needs the cook's email, and the
      // cook's phone is shared only after they accept the request.
      if (o.cook && typeof o.cook === "object" && !Array.isArray(o.cook)) {
        delete o.cook.email;
        if (o.status === "requested") delete o.cook.phone;
      }
      return o;
    });
    // Holds that flipped to expired during the lazy pass above were still
    // "requested" at query time — keep them for the 10-minute grace (the
    // waiting screen and the dashboard retry both read the same single
    // booking), then drop them once the expiry moment falls out of it.
    const visibleOut = finalOut.filter((o) => {
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
    // Expired 5-minute holds are hidden from the cook's login — a dead hold
    // carries no action and no history value. Cancelled bookings ARE shown
    // with their cancelled tag (the cook keeps the history: what was called
    // off, when, and by whom). The same filter drives the pagination count
    // below, keeping pages consistent.
    const filter = { cook: req.user.id, status: { $ne: "expired" } };
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
        // non-fatal
      }
    }
    const out = bookings.map((b) => {
      const obj = stripServiceOtp(b.toObject ? b.toObject() : b);
      const end = sessionEndDate(b);
      // Cook never sees the OTP or its metadata — they ask the customer for
      // the code in person.
      return { ...obj, sessionEnd: end ? end.toISOString() : null };
    });
    // Cook avatars across the site need the profile photo (not on the User).
    await attachCookPhotoUrls(out);
    // Submitted customer ratings keyed by booking id (one per booking max),
    // so the cook can view the rating for each completed service.
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
    // Hours-complete WhatsApp alarm addressed to the cook (self).
    let cookSelfPhone = null;
    try {
      const self = await User.findById(req.user.id).select("phone");
      cookSelfPhone = self?.phone || null;
    } catch {
      cookSelfPhone = null;
    }
    const finalCookOut = out.map((o) => {
      // Contact privacy (mirror of the customer side): the cook never needs
      // the customer's email, and the customer's phone is shared only after
      // the cook accepts the request.
      if (o.customer && typeof o.customer === "object" && !Array.isArray(o.customer)) {
        delete o.customer.email;
        // The customer's phone is shared only after the cook accepts — and
        // never for dead holds: an `expired` request exposes it otherwise,
        // since the lazy pass flips the status after the strip ran.
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
    // No-shows the cook never attended whose service hours already passed
    // are now marked "unattended" and shown in the cook's login with a
    // red card so they can see what they missed. Customers and admins
    // still see them for history, refunds and complaints.
    const now = Date.now();
    const visibleCookOut = finalCookOut.filter(
      (o) => o.status !== "expired" && !isNoShowPastHours(o, now)
    );
    return sendList(res, visibleCookOut, pg, () => Booking.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

// Broadcast request feed for cooks: unassigned REQUESTED bookings inside
// their 5-minute window that THIS cook is currently eligible for
// (approved + live + available + window fits + no overlap + not ignored).
// Snapshot only — the atomic accept claim decides the winner. Cooks poll
// this alongside /bookings/cook; each request pops the Accept/Ignore dialog.
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
    // Eligibility snapshot for THIS cook (same rules as acceptance).
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
      // Belt-and-braces with the ignoredBy:$ne query above: a request this
      // cook already ignored must never re-surface here.
      if (Array.isArray(b.ignoredBy) && b.ignoredBy.map((id) => String(id)).includes(me)) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        if (!(await eligibleNow(b))) continue;
      } catch {
        continue;
      }
      const obj = { ...b };
      // Privacy: broadcast readers see the customer name + venue, never the
      // phone/email. The full contact arrives only after this cook accepts.
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

// ── Payment-gated cook schedule ──────────────────────────────────────────
// ASSIGNED ≠ SCHEDULED: a booking appears in the cook's Today/Tomorrow only
// after backend-verified payment. Enforced HERE at the query layer — the
// frontend only displays what this returns, so forged client state, stale
// tabs, refreshes or direct API calls can never surface an unpaid booking
// as scheduled.
//
// Eligible = cook is me AND date in the requested IST day AND
// payment.status is "paid" AND status is schedule-eligible. ACCEPTED+UNPAID
// (waiting for the customer) is therefore invisible here by construction;
// it stays reachable via /bookings/cook (Upcoming) and /bookings/:id.
const SCHEDULE_ELIGIBLE_STATUSES = ["accepted", "confirmed", "in_progress", "completed"];
exports.SCHEDULE_ELIGIBLE_STATUSES = SCHEDULE_ELIGIBLE_STATUSES;

// GET /api/bookings/cook/schedule?day=today|tomorrow|YYYY-MM-DD
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
    // Lazy hours-complete flagging (same as the main cook list); re-check
    // eligibility afterwards so a transition mid-read can't leak a dead row.
    for (const b of bookings || []) {
      try {
        await markHoursCompleteIfNeeded(b);
      } catch {
        // non-fatal
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
    // Fetch by id only first: broadcast requests (cook == null) are
    // claimable by any eligible cook; assigned bookings stay scoped to
    // their own cook (admins may moderate any booking).
    let booking = await Booking.findOne({ _id: req.params.id });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const assignedCookId = booking.cook ? String(booking.cook) : null;
    if (!isAdmin) {
      if (assignedCookId && assignedCookId !== String(req.user.id)) {
        // Someone already won this request: say so truthfully (409) so the
        // losing cook's popup closes with "accepted by another cook" instead
        // of a mystery 404. A still-pending request owned by another cook
        // stays invisible (404) — same as before Find-Cook.
        if (booking.status === "accepted") {
          return res.status(409).json({
            success: false,
            code: "BOOKING_ALREADY_ASSIGNED",
            message: "This booking has already been accepted by another cook.",
          });
        }
        return res.status(404).json({ message: "Booking not found" });
      }
      // Broadcast (unassigned): any authenticated cook may attempt — the
      // atomic claim + eligibility re-check below decide the winner.
    }
    // Never accept on someone else's identity: the cook always comes from
    // the authenticated session, never from the request body.
    const actingCookId = isAdmin
      ? assignedCookId || String(req.body?.cookId || req.body?.cook || "")
      : String(req.user.id);
    if (isAdmin && !assignedCookId && !actingCookId) {
      return res.status(400).json({ message: "Choose the cook to assign this request to." });
    }
    if (booking.status !== "requested") {
      // Idempotent winner re-accept: the assigned cook double-tapping Accept
      // (or retrying after a timeout) gets success, not an error — no state
      // changes, no duplicate history, no second payment window.
      const wonByMe =
        booking.status === "accepted" &&
        assignedCookId &&
        (isAdmin || assignedCookId === String(req.user.id));
      if (wonByMe) {
        const obj = stripServiceOtp(booking.toObject ? booking.toObject() : booking);
        return res.json({ success: true, ...obj, alreadyAccepted: true });
      }
      return res.status(400).json({ message: "Only pending requests can be accepted" });
    }
    // A cook who already ignored this broadcast request cannot accept it.
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

    // 5-minute window: a late accept is refused so the customer never waits
    // on a request that already timed out on their waiting screen.
    if (booking.requestExpiresAt && booking.requestExpiresAt < new Date()) {
      booking.status = "expired";
      booking.statusHistory.push({
        status: "expired",
        note: "Cook did not respond within 5 minutes",
      });
      await booking.save();
      // A late accept must not burn a redeemed coupon with no booking —
      // same release the lazy-expiry path performs.
      await releaseCouponUsage(booking);
      await Notification.create({
        user: booking.customer,
        type: "booking_expired",
        booking: booking._id,
        message:
          "Your booking request expired — the cook didn't respond within 5 minutes. Please find another cook.",
      });
      return res.status(410).json({
        message:
          "This request expired after 5 minutes. The customer has been notified to choose another cook.",
      });
    }

    // Acceptance-time eligibility re-check (broadcast requests): the cook
    // who was eligible at notify time may no longer be — approval, live
    // account, availability toggle, service-type membership, open window
    // and slot overlap are ALL re-verified here. First accept wins: refuse
    // if the acting cook's slot has been booked since the request.
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
    // Admin assigning a broadcast request to an explicit cook: verify that
    // cook the same way (never assign a suspended/unapproved cook).
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
      // Fail closed: the overlap guard is a safety check — if it cannot run,
      // accepting could double-book the cook. The cook can retry.
      return res.status(500).json({
        message: "Could not verify slot availability right now. Please try again.",
      });
    }

    // Atomic accept claim (production DB path). The conditional update admits
    // exactly one winner:
    //   broadcast cook claim:  status still "requested" AND cook still null
    //                          AND request not expired  →  sets the cook.
    //   assigned cook claim:   status still "requested" AND cook still mine.
    // The loser re-reads and gets a truthful 404/409/410. Skipped without a
    // DB connection (unit-test path keeps the legacy flow).
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
          // non-fatal: continue with the in-memory doc
        }
      } else {
        // Lost the race (or the state moved) — report the current truth.
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
      // Unit-test / no-DB path: claim the booking in memory.
      if (!assignedCookId) booking.cook = cookIdForCheck;
      booking.status = "accepted";
      // Audit trail: mark admin-assisted accepts so the booking history shows
      // that an admin pressed the button on the cook's behalf; broadcast
      // cook accepts record the winning cook id (single authoritative entry).
      booking.statusHistory.push({
        status: "accepted",
        ...(acceptNote ? { note: acceptNote } : !assignedCookId ? { note: `Accepted by cook ${cookIdForCheck}` } : {}),
      });
      // Customer now has 5 minutes to pay before the slot is released.
      booking.paymentExpiresAt = new Date(Date.now() + PAYMENT_WINDOW_MS);
      await booking.save();
    }

    // Post-accept race verification (TOCTOU close): two overlapping
    // "requested" holds can both pass the pre-check above at the same moment
    // and both flip to "accepted". Re-read rivals AFTER persisting — if an
    // overlapping rival is already accepted/confirmed/in_progress, this
    // accept loses deterministically and rolls back to "requested" with a
    // 409. Every concurrent accepter runs the same rule after its own flip,
    // so no interleaving can leave two overlapping accepted bookings behind
    // (worst case both roll back and both customers retry — safe).
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
      // Re-read before rolling back: `booking` is a stale in-memory doc and
      // the customer may have paid in the meantime — a full-doc save() here
      // would clobber the paid/confirmed state (money captured, booking shown
      // as requested). A paid booking stands; only an unpaid one rolls back.
      // Skipped without a DB connection (unit-test path).
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
      // Broadcast claims must also release the cook — otherwise the losing
      // winner's id stays on a REQUESTED row and no other cook can claim it.
      if (!assignedCookId) latest.cook = null;
      // Renew the hold from now — rolling back onto the old (possibly
      // already-expired) requestExpiresAt would revive a dead hold.
      latest.requestExpiresAt = new Date(Date.now() + REQUEST_WINDOW_MS);
      latest.statusHistory.push({
        status: "requested",
        note: "Accept rolled back — the slot was just confirmed for another request",
      });
      try {
        await latest.save();
      } catch {
        // non-fatal: the 409 below is what matters
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
      // non-fatal: the accept itself already succeeded
    }
    // WhatsApp push to the customer (cook acted in-app so only needs one
    // when an admin accepted on their behalf — see notifyCook below).
    notifyWhatsApp("accepted", booking, {
      notifyCook: String(req.user.role).toUpperCase() === "ADMIN",
    });

    // When an admin accepted on the cook's behalf, alert the cook — their
    // calendar just gained a booked slot and they would otherwise never know.
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
        // non-fatal: the accept itself already succeeded
      }
    }

    // Include a customer-targeted "BOOKED" WhatsApp confirmation (cook name +
    // cook phone) so the cook app can forward it to the user in one tap, and
    // the customer sees it under My Bookings.
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

    const obj = stripServiceOtp(booking);
    res.json({ success: true, ...obj, customerWhatsappUrl, cookPhone: cookPhoneForCustomer });
  } catch (error) {
    next(error);
  }
};

exports.rejectBooking = async (req, res, next) => {
  try {
    const isAdmin = String(req.user.role).toUpperCase() === "ADMIN";
    // Fetch by id first: broadcast requests (cook == null) are visible to
    // every eligible cook for Ignore; assigned bookings stay scoped.
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
    // Expire first: a hold past its window is `expired`, not `rejected` —
    // the label, history, and customer message all differ.
    await expireBookingIfNeeded(booking);
    if (booking.status !== "requested") {
      return res.status(400).json({ message: "Only pending requests can be declined" });
    }

    // ── Broadcast Ignore: one cook passing does NOT reject the customer's
    // booking. Record the cook in ignoredBy (idempotent) and keep the
    // booking REQUESTED for everyone else. No customer notification, no
    // coupon release, no WhatsApp — the request is still live.
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
        // non-fatal: the ignore is best-effort below
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

    // Atomic reject claim (production DB path): a concurrent accept (also
    // atomic) vs this reject must have exactly one winner — a stale-doc
    // save() here could otherwise overwrite an accept back to "rejected".
    // Skipped without a DB connection (unit-test path keeps the legacy flow).
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
          // non-fatal: continue with the in-memory doc
        }
      } else {
        // Lost the race (or the state moved) — report the current truth.
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

    // A pay-first booking (paid at creation) is queued for an admin refund
    // decision — the cook declined, so the captured money has no service to
    // attach to. A queued refund never blocks the reject itself.
    let rejectRefundNote = "";
    try {
      const queued = queueRefundForApproval(booking, "booking_rejected");
      if (queued > 0) {
        rejectRefundNote = ` A refund of ₹${queued} has been requested — our team will review it shortly.`;
      } else if (booking.payment?.testMode && booking.payment?.status === "paid") {
        rejectRefundNote = " (Test payment — no real money moved.)";
      }
    } catch {
      // non-fatal: the reject itself must always succeed
    }
    await booking.save();
    await releaseCouponUsage(booking);

    // No availability flip-back needed: bookings only carve out part of an
    // open window, which stays bookable for its remaining free time.

    try {
      await Notification.create({
        user: booking.customer,
        type: "booking_rejected",
        booking: booking._id,
        message: `Your booking request has been rejected.${rejectRefundNote}`,
      });
    } catch {
      // non-fatal: the reject itself already succeeded
    }
    // WhatsApp push to the customer (fire-and-forget).
    notifyWhatsApp("rejected", booking, {
      refundNote: rejectRefundNote || undefined,
    });

    // Tell the cook when an admin declined on their behalf so they know the
    // request was handled and the slot stayed open. Broadcast requests have
    // no single cook — every notified cook already holds a request card.
    if (String(req.user.role).toUpperCase() === "ADMIN" && booking.cook) {
      try {
        await Notification.create({
          user: booking.cook,
          type: "booking_rejected",
          booking: booking._id,
          message: "An admin declined a service request on your behalf — the slot remains open.",
        });
      } catch {
        // non-fatal: the reject itself already succeeded
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
    // Idempotent: completing an already-completed service returns it.
    if (booking.status === "completed") {
      const completedObj = stripServiceOtp(booking);
      return res.json({ ...completedObj, alreadyCompleted: true });
    }
    // Completion requires a paid, live booking — an unpaid `accepted`
    // request must never jump straight to `completed` without payment,
    // service start, or hours running. Status alone is not proof: the
    // captured payment is required (defense in depth — confirmed implies
    // paid, but a direct DB edit or legacy row must not slip through).
    if (!["confirmed", "in_progress"].includes(booking.status)) {
      return res.status(400).json({ message: "Only paid, live (confirmed) bookings can be marked completed" });
    }
    if (booking.payment?.status !== "paid") {
      return res.status(400).json({ message: "Only paid bookings can be marked completed" });
    }
    // Service evidence: the OTP clock must have started, or (legacy /
    // support path) the hours flag plus 24h past the scheduled end. This
    // blocks completing a session immediately after payment that never ran.
    // Admins may complete on support evidence (explicit override).
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

    // Atomic complete claim (production DB path): a concurrent cancel must
    // not be silently overwritten back to "completed" by a stale-doc save —
    // exactly one terminal transition wins and the loser reports the truth.
    // Skipped without a DB connection (unit-test path keeps the legacy flow).
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
        // non-fatal: continue with the in-memory doc
      }
    } else {
      booking.status = "completed";
      booking.statusHistory.push({ status: "completed" });
      await booking.save();
    }

    // Website (in-app) notification prompting the customer to rate the cook.
    let cookNameForMsg = "your cook";
    try {
      const cookUser = await User.findById(booking.cook).select("name");
      if (cookUser?.name) cookNameForMsg = cookUser.name;
    } catch {
      // non-fatal
    }
    try {
      await Notification.create({
        user: booking.customer,
        type: "booking_completed",
        booking: booking._id,
        message: `Service complete! ${cookNameForMsg} finished your session — please rate your cook.`,
      });
    } catch {
      // non-fatal: completion already succeeded
    }
    // The cook hears about it too (every other terminal transition notifies
    // both sides) — completion affects their record and payout queue.
    try {
      await Notification.create({
        user: booking.cook,
        type: "booking_completed",
        booking: booking._id,
        message: "Service marked complete — the customer has been asked to rate the session.",
      });
    } catch {
      // non-fatal: completion already succeeded
    }

    // WhatsApp rating reminder to the customer's own number, with a link to
    // the booking page where the review form lives.
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

// Permanently remove a booking from the customer's history. Only the booking's
// own customer may delete, and only records that never became a real
// engagement: the cook never accepted (requested / rejected / expired) or the
// customer already cancelled it. Anything with captured money is kept for the
// financial trail — support can help with those.
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
    // Release the held coupon only for a live `requested` hold — terminal
    // records (rejected/expired/cancelled) already released theirs on that
    // transition; releasing again would drift usedCount and over-redeem
    // usage-capped codes.
    if (booking.status === "requested") {
      await releaseCouponUsage(booking);
    }
    // The cook was notified of the request at creation — tell them it's
    // gone so a vanishing row isn't a mystery (broadcast requests have no
    // single cook; those cards go stale via status polling).
    if (booking.cook) {
      try {
        await Notification.create({
          user: booking.cook,
          type: "booking_cancelled",
          booking: booking._id,
          message: "The customer withdrew their pending booking request — the slot is free again.",
        });
      } catch {
        // non-fatal: the delete itself already succeeded
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

    // Expire first: a hold past its window is already dead — it can no
    // longer be cancelled (use delete to clear it from history).
    await expireBookingIfNeeded(booking);
    // Idempotent: cancelling an already-cancelled booking returns it without
    // re-queueing refunds, re-releasing coupons, or re-notifying.
    if (booking.status === "cancelled") {
      return res.json({ ...(stripServiceOtp(booking).toObject ? stripServiceOtp(booking) : stripServiceOtp(booking)), alreadyCancelled: true });
    }
    // Terminal states can never re-enter the flow — including "unattended"
    // (a closed no-show; paid no-shows carry a queued refund instead).
    if (["completed", "rejected", "expired", "unattended"].includes(booking.status)) {
      return res.status(400).json({ message: "Booking cannot be cancelled" });
    }

    // OTP-verified start is the proof of presence: it sets cookArrived via
    // markArrivedIfNeeded, so the self-serve cancel path closes from here on.
    // (Manual arrival taps are disabled — see markCookArrived.)
    if (booking.serviceStartedAt) {
      return res.status(400).json({ message: "Service has already started — this booking can no longer be cancelled. Please contact support." });
    }
    // F-10: "started" also covers a live in_progress session (cook arrived /
    // OTP clock running) even if the started-at stamp is somehow absent —
    // cancelling mid-service by self-serve is never allowed. Admins (support
    // override) remain exempt.
    if (!isAdmin && booking.status === "in_progress") {
      return res.status(400).json({ message: "Service is already in progress — this booking can no longer be cancelled online. Please contact support." });
    }
    // 30-minute cutoff: customers and cooks may cancel only until 30
    // minutes before the scheduled service start. Admins are exempt.
    if (!isAdmin && cancelLocked(booking)) {
      return res.status(400).json({ message: "Bookings can only be cancelled until 30 minutes before the service start time. Please contact support for help." });
    }

    // Atomic cancel claim (production DB path): two concurrent cancels (or a
    // cancel racing an OTP start / payment confirm) must not both run the
    // refund/coupon/notify sequence. The conditional update admits exactly one
    // winner while the booking is still live and unstarted; the loser re-reads
    // and gets the truthful terminal code. Skipped without a DB connection
    // (unit-test path keeps the legacy flow).
    const cancelledByValue = isAdmin ? "admin" : isCook ? "cook" : "customer";
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
          // non-fatal: continue with the in-memory doc
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

    // Paid bookings queue a refund for admin approval on cancel — captured
    // money for a cancelled session is never kept or moved automatically.
    // A queued refund never blocks the cancellation itself.
    let refundNote = "";
    try {
      const queued = queueRefundForApproval(booking, "booking_cancelled");
      if (queued > 0) {
        refundNote = ` A refund of ₹${queued} has been requested — our team will review it shortly.`;
      } else if (booking.payment?.testMode && booking.payment?.status === "paid") {
        refundNote = " (Test payment — no real money moved.)";
      }
    } catch {
      // non-fatal: cancellation itself must always succeed
    }
    await booking.save();
    // Cook reliability signal: a cook cancelling after accepting is tracked
    // atomically ($inc — safe under retries since cancel is idempotent above
    // and this only runs on the live transition).
    if (!isAdmin && isCook) {
      try {
        await CookProfile.updateOne({ user: booking.cook }, { $inc: { cancelledByCookCount: 1 } });
      } catch {
        // non-fatal: cancellation itself already succeeded
      }
    }
    // The held coupon (if any) is freed — a cancelled booking must not burn
    // a single-use code like WELCOME50.
    await releaseCouponUsage(booking);

    // No availability flip-back needed (see rejectBooking).

    // Both parties always hear about the cancellation: each side's
    // dashboard/details row flips to "cancelled", and EACH side gets a
    // notification naming who cancelled. (Previously the canceller heard
    // nothing on unpaid bookings, and the other side got a vague message.)
    const customerMsg = isCustomer
      ? `Your booking has been cancelled.${refundNote}`
      : `Cook cancelled your booking.${refundNote}`;
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
      // non-fatal
    }
    // Broadcast requests have no single cook — the request cards on every
    // eligible cook's dashboard go stale via status polling.
    if (booking.cook) {
      try {
        await Notification.create({
          user: booking.cook,
          type: "booking_cancelled",
          booking: booking._id,
          message: cookMsg,
        });
      } catch {
        // non-fatal
      }
    }
    // WhatsApp push to BOTH sides (fire-and-forget).
    notifyWhatsApp("cancelled", booking, {
      cancelledBy: cancelledByValue,
      refundNote: refundNote || undefined,
    });

    res.json(stripServiceOtp(booking));
  } catch (error) {
    next(error);
  }
};

// Free slots for moving a booking to a new day — the reschedule picker's
// feed. Auth: the booking's own customer or an admin (cooks cannot reschedule
// in v1). The booking being moved is excluded from the occupancy check so its
// own current hold never hides the calendar around it. Shape mirrors
// GET /availability so the client can reuse its slot picker.
//
// Slot+cook mode: with ?date=&startTime= the response also answers whether
// the CURRENT cook covers that exact slot and, when not, lists verified
// replacement cooks — public cards only, never PII.
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

    // Broadcast (Find-Cook) requests have no assigned cook: offer the full
    // service day minus the customer's own live holds. The move itself
    // re-validates real cook eligibility, so an optimistic slot here can
    // never book an unservable time.
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
    // Same 30-minute lead rule the move itself enforces; admins see all slots
    // (support can move a booking into the next slot if needed).
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

    // Date-only mode (calendar feed) — unchanged v1 behaviour.
    const rawStart = req.query.startTime;
    if (rawStart == null || String(rawStart).trim() === "") {
      return res.json(base);
    }

    // Slot+cook mode — is the current cook free at exactly this start?
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

// Move an upcoming booking to a new date/time (same duration, same money;
// optionally a new cook when the original cannot cover the new slot — v2).
// Policy: the booking's own customer, or an admin, may move it; the
// move is instant — the other side is notified — and subject to:
//   1. requested / accepted / confirmed only (never a started or terminal row),
//   2. the CURRENT slot outside the 30-minute cutoff (admins exempt),
//   3. the NEW slot ≥30 minutes away, on the 30-minute grid, inside the cook's
//      open windows, clear of rival bookings, and inside the service day — the
//      same rules booking creation enforces,
//   4. at most MAX_CUSTOMER_RESCHEDULES moves (admins exempt).
// Money is NEVER touched: the slab fee depends only on the duration, which
// cannot change here — no refund, re-charge, coupon or ledger work happens.
// The 5-minute request/payment windows are renewed in the SAME atomic update
// so a moved hold cannot expire the moment it lands.
// A move keeps duration/money; it may also swap the cook when the original
// cook cannot cover the new slot. All cook eligibility checks mirror booking
// creation (approved profile, live account, availability toggle, open window,
// no overlap) plus the service-type membership when the profile declares one.
// Public cook card for reschedule replacement lists — discovery fields only.
// Never phones, documents, payout details, tokens or admin data.
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
// Single-cook eligibility for an exact [startTime, endTime] slot. Returns
// { ok:true, profile, userDoc } or { ok:false, message, conflict } where
// conflict=true maps to HTTP 409 (slot taken) and false maps to 400.
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
  // Live-account check (same fail-closed shape as booking creation): only
  // runs against a live DB; disconnected unit-test fakes skip it while the
  // profile/availability/window/overlap checks below still run in memory.
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
  // Service-type membership — only when the profile declares a list (legacy
  // profiles with an empty list can perform any service, as in creation).
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
  // The booking being moved never blocks itself (same-cook re-pick).
  if (clash && String(clash._id) !== String(booking?._id)) {
    return unavailable("This cook was just booked for the selected time. Please choose another cook.", true);
  }
  return { ok: true, profile };
};
// Replacement-cook search for a slot the current cook cannot cover.
// Batched: one profile query + one bookings $in query, then in-memory math
// per cook (same pattern as availability search).
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
  // Highest-rated first — the customer picks from a short, sane list.
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

    // A hold past its window is already dead — expire it first so a stale
    // request can never be moved (mirrors cancelBooking).
    await expireBookingIfNeeded(booking);

    const requestedDayStr = String(req.body?.date || "").trim();
    const requestedStart = parseTimeStrict(req.body?.startTime);
    // Optional v2 fields: reason (≤200 chars, stored on the audit entry) and
    // cookId (explicit cook swap when the original cook cannot cover the new
    // slot; aliases accepted for forward-compat clients).
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

    // Idempotency first: a retry of a move that already landed (double-click,
    // client timeout, back button) reports success instead of 400/409. Only
    // while the row is still movable — a cancelled booking must never answer
    // "moved". A cook swap is part of the identity: same slot + same cook →
    // unchanged; same slot + different cook is a real (counted) change.
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
    // 30-minute cutoff on the CURRENT slot; admins are exempt (support).
    if (!isAdmin && rescheduleLocked(booking)) {
      return res.status(400).json({
        message: "Bookings can only be rescheduled until 30 minutes before the service start time. Please contact support for help.",
      });
    }
    // Move cap: self-serve rescheduling is not unlimited shuffling.
    if (!isAdmin && Number(booking.rescheduleCount || 0) >= MAX_CUSTOMER_RESCHEDULES) {
      return res.status(400).json({
        message: "This booking has already been rescheduled twice — please contact support if you need another change.",
      });
    }

    // Strict date/time validation (server-side, IST) — the same rules booking
    // creation enforces, so a stale tab can never land an off-grid slot.
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
    // Minimum lead on the NEW slot: without it a move could dodge the cutoff
    // above by jumping into a slot that is minutes away.
    if (!isAdmin) {
      const targetInstant = istEventInstant(dayStr, minutesToTime(requestedStart));
      if (!targetInstant || targetInstant.getTime() - Date.now() < RESCHEDULE_MIN_LEAD_MS) {
        return res.status(400).json({
          message: "The new time must be at least 30 minutes from now — please pick a later slot.",
        });
      }
    }

    // Duration is fixed by the original booking — it drives the price, so it
    // must never change here.
    const durMin = Math.round(Number(booking.durationHours || 0) * 60);
    if (!Number.isFinite(durMin) || durMin < 30 || durMin > 4 * 60) {
      return res.status(400).json({ message: "This booking has no usable duration — please contact support" });
    }
    const endMin = requestedStart + durMin;
    const startTime = minutesToTime(requestedStart);
    const endTime = minutesToTime(endMin);
    // Service day 08:00–20:00 — mirror of the engine's clamp in utils/slots.js.
    if (requestedStart < RESCHEDULE_DAY_START_MIN || endMin > RESCHEDULE_DAY_END_MIN) {
      return res.status(400).json({ message: "Sessions must run between 8:00 AM and 8:00 PM" });
    }

    // Target cook: explicit swap (v2) or the currently assigned cook (v1).
    // Never trust the frontend's availability answer — every eligibility
    // check below is re-run server-side against live data.
    // Broadcast (Find-Cook) moves have no cook: the new slot just needs at
    // least one eligible cook, and stale ignores reset for the fresh search.
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
      // The cook must still be able to take work: approved profile, live
      // account, availability toggle on — the checks booking creation runs.
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

      // The new slot must sit inside one of the cook's open windows and clash
      // with nothing else (the booking being moved is excluded from its own
      // overlap check).
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
      // Cook swap: the selected cook must independently pass every
      // eligibility check for the exact new slot (approved, live, available,
      // service-type, window, overlap). Users cannot assign arbitrary,
      // suspended or unverified cooks — the checks run here, not in the UI.
      const swap = await checkCookForSlot(targetCookId, booking, dayStr, startTime, endTime);
      if (!swap.ok) {
        return res.status(swap.conflict ? 409 : 400).json({ message: swap.message });
      }
    }

    // Everything below is the move itself. Capture the old slot first: the
    // in-memory fallback mutates the document in place. Money is NEVER
    // touched here — amount, payment and coupon fields are not in the update.
    const oldDate = booking.date;
    const oldStartTime = booking.startTime;
    const oldEndTime = booking.endTime;
    const oldCook = String(booking.cook);
    const oldSlotLabel = `${dateLabelFromParts(istDayString(oldDate))} ${oldStartTime}–${oldEndTime}`.trim();
    const newSlotLabel = `${dateLabelFromParts(dayStr)} ${startTime}–${endTime}`;
    const actor = isAdmin ? "admin" : "customer";
    const expectedCount = Number(booking.rescheduleCount || 0);
    const newDay = istMidnight(dayStr);
    // Denormalized cook names for the history display (best effort).
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
      // non-fatal: ids alone still audit the swap
    }
    // 5-minute windows are renewed inside the same write (see policy above).
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
      // Optimistic claim: status + rescheduleCount pin the state that was read,
      // so a concurrent move, accept, cancel or expiry makes the filter miss —
      // exactly one racer wins. The date/time/cook swap lands in ONE atomic
      // update — never new-time + old-unavailable-cook. Losers re-read below
      // instead of silently dropping the request.
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
              // Broadcast moves re-open the search on the new slot: past
              // ignores belonged to the old slot.
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
        // Lost the race (or the state moved on): report the current truth.
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

      // Cross-document race guard: a rival booking (a new request, or another
      // move) can take this slot between the pre-check and the claim. Re-verify
      // now against the TARGET cook; on a clash the deterministic tie-break
      // gives the slot to the smaller booking id and this move is rolled back
      // (slot + cook together — never a half-applied swap). (This codebase uses no
      // Mongo transactions — accept/pay/start all re-verify overlaps too, so a
      // crash before the rollback can only surface as a refused accept.)
      // Broadcast moves have no target cook: re-verify the customer's own
      // overlap plus live eligibility instead.
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
        // Non-fatal: the pre-check covered the common case, and every
        // downstream flow (accept/pay/start) re-verifies overlaps.
      }
    } else {
      // Disconnected unit-test path (mirrors accept's legacy branch): apply the
      // same move in memory so the controller stays testable without a DB.
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

    // Both sides are always notified that the booking moved: the cook who
    // must show up, and the customer who booked it. An admin move touches
    // both parties since neither of them initiated it; a customer move
    // confirms back to the customer as well as informing the cook. Cook
    // swap: the old cook is released, the new cook is assigned — each gets
    // exactly one targeted message.
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
        // Unassigned request moved to a new slot: only the customer hears
        // about it (eligible cooks pick up the fresh slot from their feed).
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
      // non-fatal: the move itself already succeeded
    }
    // WhatsApp push to BOTH sides with old → new slot (fire-and-forget).
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

// Cook starts the service by entering the customer's 4-digit OTP (read out
// to them in person at the venue). Sets the live service clock
// (serviceStartedAt → serviceEndsAt = start + booked duration) and marks
// arrival, so the hours-complete alarm counts real cooking time. Idempotent:
// re-submitting after a start returns the current state. The OTP is never
// returned to the cook — every response here is stripped.
exports.startService = async (req, res, next) => {
  try {
    const filter = { _id: req.params.id };
    if (String(req.user.role).toUpperCase() !== "ADMIN") filter.cook = req.user.id;
    let booking = await Booking.findOne(filter);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    // The clock only runs on paid work: a paid confirmed/in_progress
    // booking, or a legacy accepted booking whose payment is already
    // recorded. Unpaid requests must never start the service clock.
    const prepaid = booking.payment?.status === "paid";
    if (!prepaid || (!["confirmed", "in_progress"].includes(booking.status) && booking.status !== "accepted")) {
      return res.status(400).json({ message: "Only paid, confirmed bookings can start service" });
    }
    if (booking.serviceStartedAt) {
      const obj = stripServiceOtp(booking);
      return res.json({ ...obj, serviceStarted: true });
    }
    const otp = String(req.body?.otp || "").trim();
    // Backfill for pre-OTP legacy bookings (creation always sets one now):
    // mint the code so the customer can read it on their booking page.
    if (!booking.serviceOtp && ensureServiceOtp(booking)) {
      try {
        await booking.save();
      } catch {
        // non-fatal: the check below still applies
      }
    }
    // Brute-force guard: 10 wrong tries lock the code for 15 minutes.
    if (booking.serviceOtpLockedUntil && new Date(booking.serviceOtpLockedUntil) > new Date()) {
      return res.status(429).json({
        message: "Too many incorrect attempts — please wait 15 minutes and ask the customer for the code again.",
      });
    }
    // OTP expiry: the code is only valid through 24h past the scheduled
    // session end. Afterwards the booking is a no-show/support case, and a
    // stale code must not start a clock weeks later.
    try {
      const otpEnd = sessionEndDate(booking);
      if (otpEnd && Date.now() > otpEnd.getTime() + OTP_VALIDITY_AFTER_END_MS) {
        return res.status(410).json({
          message: "This booking's start code has expired — please contact support.",
        });
      }
    } catch {
      // non-fatal: expiry check unavailable — fall through to OTP check
    }
    if (!booking.serviceOtp || otp !== String(booking.serviceOtp)) {
      // Atomic attempt counter (production DB path): concurrent wrong
      // guesses must all count toward the 10-try lockout — a read-increment-
      // save here would let parallel guesses undercount and bypass the lock.
      // Skipped without a DB connection (unit-test path keeps the legacy flow).
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
              // non-fatal: the 429 below is what matters
            }
          }
        } catch {
          // non-fatal: fall through with the in-memory count
        }
      } else {
        booking.serviceOtpAttempts = totalAttempts;
        if (totalAttempts >= 10) {
          booking.serviceOtpLockedUntil = new Date(Date.now() + 15 * 60 * 1000);
        }
        try {
          await booking.save();
        } catch {
          // non-fatal: the 400 below is what matters
        }
      }
      if (totalAttempts >= 10) {
        return res.status(429).json({
          message: "Too many incorrect attempts — please wait 15 minutes and ask the customer for the code again.",
        });
      }
      return res.status(400).json({ message: "Incorrect OTP — please ask the customer for the 4-digit code shown on their booking" });
    }
    // Success resets the guard.
    const durMin = Math.round(Number(booking.durationHours || 0) * 60);
    if (!Number.isInteger(Number(booking.durationHours)) || durMin < 60 || durMin > 4 * 60) {
      return res.status(400).json({ message: "This booking has no usable duration — please contact support" });
    }
    const startedAt = new Date();
    // Wall-clock strings are IST (business timezone), never server-local.
    const fmtClock = (d) => {
      const mins = istNowMinutes(d);
      return minutesToTime(mins);
    };
    // Late-start overlap guard: the rewrite below moves the window to
    // (now → now+duration). On the booking's own day that can collide with
    // another live booking for the same cook — refuse with 409 so support can
    // cancel/rebook instead of the cook being double-booked. Skipped without a
    // DB connection (unit-test path keeps the pure OTP flow).
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
        // non-fatal: verification unavailable, proceed with the start
      }
    }
    // Atomic start claim (production DB path): two concurrent correct OTPs
    // must not both set the clock and double-push history — the conditional
    // update admits exactly one starter (serviceStartedAt must still be
    // unset, booking still live+paid). The loser re-reads and receives the
    // idempotent started state. Skipped without a DB connection (unit-test
    // path keeps the legacy flow).
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
        // Lost the race (already started) or the state moved — return truth.
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
      // Redefine the service window from the actual start: the scheduled
      // start/end shift to (actual start → actual start + duration) so the
      // stored endTime always reflects real cooking time, not the slot guess.
      // Wall-clock strings are IST (business timezone), never server-local.
      booking.startTime = fmtClock(startedAt);
      booking.endTime = fmtClock(booking.serviceEndsAt);
      // OTP verified ⇒ cook is on site: record arrival (manual taps disabled).
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
    // OTP verified ⇒ cook is on site (production path arrives here with the
    // claimed doc; legacy path already arrived+saved above — the
    // cookArrived guard inside makes this second call a no-op there).
    if (dbReady()) {
      try {
        await markArrivedIfNeeded(booking);
        const freshAfterArrival = await Booking.findOne(filter);
        if (freshAfterArrival) booking = freshAfterArrival;
      } catch {
        // non-fatal: the start itself already succeeded
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
      // non-fatal
    }
    // Confirm to the cook as well — their hours are now being counted.
    try {
      await Notification.create({
        user: booking.cook,
        type: "service_started",
        booking: booking._id,
        message: "Service started (OTP verified) — your hours are now being counted. Have a great session!",
      });
    } catch {
      // non-fatal
    }
    // WhatsApp push to BOTH sides (fire-and-forget).
    notifyWhatsApp("started", booking);
    const obj = stripServiceOtp(booking);
    res.json({ ...obj, serviceStarted: true });
  } catch (error) {
    next(error);
  }
};

// Manual arrival endpoint DISABLED (loophole closure): a self-tapped
// "I've arrived" let a cook certify presence without proof — it fed the
// paid+arrived cancel block and no-show/auto-complete evidence with zero
// verification. Arrival is now recorded ONLY via OTP-verified
// `start-service` (markArrivedIfNeeded below), where the customer handing
// over the code proves the cook is on site. This stub stays so old app
// versions get an explicit message instead of a generic 404.
exports.markCookArrived = async (req, res) => {
  return res.status(410).json({
    message: "Manual arrival is no longer supported — service starts with the OTP code from the customer.",
  });
};

// Single booking details for the details page. Visible to the customer who
// owns it, the assigned cook, or an admin. Includes session end and
// role-agnostic WhatsApp links.
exports.getBookingById = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate("cook", "name email phone")
      .populate("customer", "name email phone");
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const isCustomer = booking.customer?._id?.toString() === req.user.id;
    const isCook = booking.cook?._id?.toString() === req.user.id;
    const isAdmin = String(req.user.role).toUpperCase() === "ADMIN";
    // Broadcast requests (no cook yet) are readable by any authenticated
    // cook — they are the eligible recipients. Privacy strips below still
    // hide phones while requested.
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
      // non-fatal
    }

    // 5-minute confirmation windows — expire on read so the customer's
    // waiting and payment pages always poll back a fresh status.
    try {
      await expireBookingIfNeeded(booking);
    } catch {
      // non-fatal
    }
    // Cook public profile bits for the details page (rate/area). Live
    // location tracking was removed — no cookLiveLocation here.
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
        // non-fatal
      }
    }

    const fullObj = booking.toObject ? booking.toObject() : booking;
    // The cook must never see the service-start OTP — they ask the customer
    // for it in person. Admins don't need it either (support asks the
    // customer); only the owning customer keeps it.
    const obj = isCustomer ? fullObj : stripServiceOtp(fullObj);
    // Contact privacy: while "requested", neither side sees the other's
    // phone; post-accept each side gets the other's phone for coordination.
    // Emails are never needed client-side. Admins keep full details.
    if (!isAdmin) {
      if (obj.cook && typeof obj.cook === "object" && !Array.isArray(obj.cook)) {
        delete obj.cook.email;
        if (obj.status === "requested") delete obj.cook.phone;
      }
      if (isCook && obj.customer && typeof obj.customer === "object" && !Array.isArray(obj.customer)) {
        delete obj.customer.email;
        if (obj.status === "requested") delete obj.customer.phone;
      }
      // Broadcast readers (eligible cooks who haven't accepted) never see
      // the customer's phone or email — only the name + venue area.
      if (isBroadcastReader && obj.customer && typeof obj.customer === "object" && !Array.isArray(obj.customer)) {
        delete obj.customer.email;
        delete obj.customer.phone;
      }
    }
    // Cook avatar on the details page needs the profile photo (public like
    // the cooks list — kept even while "requested").
    await attachCookPhotoUrls(obj);
    const end = sessionEndDate(booking);
    const hoursPayload = { ...obj, hoursCompletedAt: booking.hoursCompletedAt };
    // Submitted review for this service (one per booking max) — visible to
    // the customer who wrote it, the cook who received it, or an admin.
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
      // Post-payment job sheet for the cook (customer name/number/location) —
      // lets the customer re-send their details on WhatsApp from the details
      // page if the automatic share after payment was missed.
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

// Customer confirms payment for an ACCEPTED booking within the 5-minute
// window. Demo mode: records a mock gateway id and confirms the booking
// (the Razorpay order/verify flow can be slotted in later without any
// contract change — the frontend calls PATCH /api/bookings/:id/pay either
// way, and `POST /api/payments/verify` remains available for real gateway
// integration).
exports.payBooking = async (req, res, next) => {
  try {
    let booking = await Booking.findOne({
      _id: req.params.id,
      customer: req.user.id,
    });
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    // Window elapsed while the customer was on the payment page? Cancel and
    // free the slot instead of taking money.
    await expireBookingIfNeeded(booking);
    // Idempotent first: a payment already recorded (earlier confirm call,
    // webhook reconcile, or prepaid-at-creation) reports the current truth.
    // Retries after success, client timeouts, or refund-queueing must never
    // re-process money — and must not 400/410 a booking that is paid.
    if (booking.payment?.status === "paid") {
      if (booking.status === "accepted") {
        booking.status = "confirmed";
        booking.statusHistory.push({
          status: "confirmed",
          note: "Payment already recorded — confirmed on re-check.",
        });
        await booking.save();
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
    // Find-Cook invariant (server-authoritative): only an accepted booking
    // with a server-assigned cook may confirm payment.
    if (!booking.cook) {
      return res.status(400).json({
        message: "No cook has accepted this request yet — payment unlocks after a cook accepts.",
      });
    }
    // Overlap guard: two overlapping `accepted` holds can briefly coexist
    // (concurrent accepts); paying both would capture money twice for one
    // slot. Refuse when a rival is already live — no post-pay verification
    // exists, so this pre-claim check is the only guard. Skipped without a
    // DB connection (unit-test path — same outcome as a failed lookup below).
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
        // Fail closed: no post-pay verification exists, so if the slot
        // availability check can't run we must not take money for a slot
        // that may already be double-accepted. The customer can retry.
        return res.status(500).json({
          message: "Could not verify slot availability right now. Please try again.",
        });
      }
    }
    // Real money only: a booking is confirmed exclusively on a verified
    // Razorpay payment. The old demo path (fabricated pay_demo_* ids) is gone
    // — it marked bookings "paid" without any money moving, poisoning the
    // cook's received-earnings accounting.
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
      // Bind the payment to THIS booking: the order id must be the one this
      // booking's checkout minted (createOrder persists it on the booking).
      // The HMAC only proves the (order, payment) pair is genuine — without
      // this binding a captured triple could be replayed to confirm any
      // other accepted booking of the same amount.
      const storedOrderId = String(booking.payment?.razorpayOrderId || "");
      if (!storedOrderId || storedOrderId !== String(razorpayOrderId)) {
        return res.status(402).json({
          message: "This payment does not belong to this booking. Please start a fresh payment.",
          code: "PAYMENT_AMOUNT_MISMATCH",
        });
      }
    }
    // Fully-discounted session (100% coupon): nothing is charged, so the
    // booking confirms at ₹0 without any gateway money. Same atomic claim,
    // same notifications — payment never reaches Razorpay. A zero payable
    // without any coupon is a data error, never a free booking.
    const zeroAmount = hasPayment ? false : Number(booking.amount) <= 0;
    if (zeroAmount && !booking.couponCode) {
      return res.status(400).json({
        message: "This booking has no payable amount recorded. Please contact support.",
      });
    }
    // Bind the genuine triple to this booking's stored fee (blocks replay
    // of a cheaper order's payment onto this booking). The payment itself
    // must also be captured for the full fee (not merely authorized).
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
    // Atomic claim: only one concurrent pay attempt flips accepted+unpaid to
    // confirmed. A lost race re-reads — paid elsewhere means success (the
    // idempotent path above returns it), anything else is a conflict.
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

    // Immutable money trail: one row per captured payment. The webhook path
    // uses the SAME idempotency key, so whichever path records first wins
    // and the other becomes a no-op duplicate.
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

    // Post-claim overlap verification: the pre-claim check and the atomic
    // claim can straddle a rival's confirmation (concurrent accepts/pays).
    // Money is already captured, so this never auto-cancels — it flags both
    // parties + admin via notification and returns 409 with the kept
    // confirmed state so support can reconcile (refund one side).
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
            // non-fatal
          }
        }
      } catch {
        // non-fatal: verification unavailable — the confirmed state stands
      }
    }

    // Load both parties first — the cook's confirmation notification below
    // carries the full job details (customer, service, guests, venue + pin).
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

    // Confirmation alert to the COOK's login: full booking details so the
    // cook can see the job in Notifications without opening the dashboard.
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
      // non-fatal: the confirmation itself already succeeded
    }

    // 1) Job sheet -> the COOK's WhatsApp (customer name/number/location).
    //    The customer's app opens this right after payment succeeds.
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

    // 2) Confirmation -> the USER's own WhatsApp: payment-received
    //    confirmation with the cook's name + number and booked service hours.
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

    // 3) Booking confirmation notification to the user's website account.
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
      // non-fatal: the confirmation itself already succeeded
    }

    // 4) Automatic WhatsApp push to BOTH sides (cook job sheet + customer
    //    confirmation). Fire-and-forget — never delays the pay response.
    notifyWhatsApp("confirmed", booking, {
      cookName: cookUser?.name,
      cookPhone: cookUser?.phone,
      customerName: customer?.name,
      customerPhone: customer?.phone,
    });

    const obj = booking.toObject ? booking.toObject() : booking;
    res.json({ ...obj, cookWhatsappUrl, customerWhatsappUrl });
  } catch (error) {
    // The unique payment-id index: a (genuine, verified) triple already
    // recorded on another booking can never be recorded here, even when the
    // HMAC passes — turn the storage collision into a clear 409 instead of
    // a 500. This is the last line of defense after the order-id binding.
    if (error?.code === 11000 && error?.keyPattern?.["payment.razorpayPaymentId"] != null) {
      return res.status(409).json({
        message: "This payment has already been recorded for another booking.",
      });
    }
    next(error);
  }
};

// Distinct previous service locations for the customer, most recent first.
// Powers the "use previous location" picker on booking forms.
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
      const key = address.toLowerCase();
      const hasPin = b.location?.lat != null && b.location?.lng != null;
      if (!seen.has(key)) {
        seen.set(key, {
          address,
          addressDetails: b.addressDetails || {},
          location: hasPin ? { lat: b.location.lat, lng: b.location.lng } : null,
          lastUsed: b.createdAt,
          timesUsed: 1,
        });
      } else {
        const entry = seen.get(key);
        entry.timesUsed += 1;
        // Prefer entries carrying a GPS pin.
        if (hasPin && !entry.location) {
          entry.location = { lat: b.location.lat, lng: b.location.lng };
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
    const bookings = await applyPagination(
      Booking.find()
        .populate("customer", "name email phone")
        .populate("cook", "name email phone")
        .sort({ createdAt: -1 }),
      pg
    );
    // Lazily expire stale pending requests (requested→expired, accepted
    // unpaid→cancelled) and mark hours-complete→unattended transitions
    // so admins never act on dead rows — the same pass the cook and
    // customer dashboards run before rendering.
    for (const b of bookings) {
      try {
        await expireBookingIfNeeded(b);
        await markHoursCompleteIfNeeded(b);
      } catch {
        // non-fatal
      }
    }
    // Attach each service's customer rating (one per booking max).
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
        // Admin list never carries customer OTPs (bulk leak surface).
        return { ...obj, review: reviewByBookingId[b._id.toString()] || null };
      }),
      pg,
      () => Booking.countDocuments()
    );
  } catch (error) {
    next(error);
  }
};
