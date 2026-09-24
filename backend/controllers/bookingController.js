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
// Mongoose doc, a lean object, or an array of either.
const stripServiceOtp = (payload) => {
  const stripOne = (b) => {
    if (!b || typeof b !== "object") return b;
    if (typeof b.toObject === "function") {
      const o = b.toObject();
      delete o.serviceOtp;
      return o;
    }
    const { serviceOtp: _omit, ...rest } = b;
    return rest;
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
  await Notification.create({
    user: booking.customer,
    type: "booking_completed",
    booking: booking._id,
    message: `Service complete! ${cookName} finished your session — please rate your cook.`,
  });
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
      if (queueRefundForApproval(booking, "booking_unattended") > 0) {
        await booking.save();
        changed = true;
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
    booking.hoursCompleted = true;
    booking.hoursCompletedAt = new Date();
    changed = true;
    await booking.save();
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
  }
  if (booking.status === "in_progress" && booking.serviceStartedAt) {
    const end = sessionEndDate(booking);
    if (end && Date.now() >= end.getTime()) {
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
      booking.status = "unattended";
      booking.statusHistory.push({
        status: "unattended",
        note: "Cooking hours passed — cook did not attend the booking",
      });
      // F-09: a paid no-show must never strand customer money. Queue a refund
      // for admin approval and free the coupon, exactly like a cancel does —
      // queueRefundForApproval is a no-op unless paid with no refund yet, and
      // releaseCouponUsage claims atomically, so repeats are safe.
      try {
        queueRefundForApproval(booking, "booking_unattended");
      } catch {
        // non-fatal: the status flip below is what matters
      }
      try {
        await releaseCouponUsage(booking);
      } catch {
        // non-fatal: best-effort
      }
      changed = true;
      await booking.save();
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

exports.createBooking = async (req, res, next) => {
  try {
    const { cook, date, startTime, endTime } = req.body;

    const cookProfile = await CookProfile.findOne({
      user: cook,
      approvalStatus: "approved",
    });
    if (!cookProfile) {
      return res.status(400).json({ message: "Cook not found or not approved" });
    }

    // A suspended account can't take new bookings even while the profile
    // still reads approved (discovery filters hide it; direct POSTs must
    // not bypass that). Skipped without a DB connection (unit-test path).
    if (dbReady()) {
      try {
        const cookAccount = await User.findById(cook).select("status");
        if (!cookAccount || cookAccount.status === "suspended") {
          return res.status(400).json({ message: "Cook not found or not approved" });
        }
      } catch {
        return res.status(400).json({ message: "Cook not found or not approved" });
      }
    }

    // The cook's own unavailable toggle is the only opt-out from the
    // default all-hours availability (auto-resets the next day).
    if (!(await resolveCookAvailability(cookProfile))) {
      return res.status(400).json({ message: "Cook is currently unavailable — please try another cook or date" });
    }

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

    // The requested window must fit inside one of the cook's open windows.
    // Overlap is checked against every booking currently occupying the
    // calendar: accepted/confirmed/in_progress (permanent) AND pending
    // "requested" ones inside their 5-minute hold (see getDayBookings), so a
    // held slot is invisible and unbookable for all other customers.
    const windows = await getDayWindows(cook, date);
    const containing = findContainingWindow(windows, startTime, endTime);
    if (!containing) {
      return res.status(400).json({ message: "Cook is not available for the selected time" });
    }
    const activeBookings = await getDayBookings(cook, date);
    const clash = findOverlapBooking(activeBookings, startTime, endTime);
    if (clash) {
      // Same-key retry racing its own winner: the clash may be with the hold
      // this very request created a millisecond ago (true-concurrent double
      // submit). Return the original instead of a confusing 409 — idempotency
      // must hold under concurrency, not just sequentially.
      if (clientKey && dbReady()) {
        try {
          const mine = await Booking.findOne({ clientKey, customer: req.user.id });
          if (mine) {
            const mineObj = mine.toObject ? mine.toObject() : mine;
            return res.status(200).json({ ...mineObj, alreadyExists: true });
          }
        } catch {
          // non-fatal: fall through to the 409 below
        }
      }
      return res.status(409).json({ message: "This slot is no longer available — it's booked or on hold for another request. Please pick a different start time." });
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
        cook,
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

    // Close the two-user race: two customers can pass the pre-create overlap
    // check at the same moment. Re-check AFTER inserting — if an older rival
    // (smaller _id = created earlier) occupies an overlapping interval, this
    // request loses: delete it and tell this customer the slot went elsewhere.
    // The older request never deletes itself, so at most one of two racing
    // requests survives and the slot can never end up double-booked.
    try {
      const { start: raceDayStart, end: raceDayEnd } = dayBounds(booking.date);
      const rivals = await Booking.find({
        cook,
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

    // Non-fatal: the booking already exists — a notification outage must not
    // 500 the request (the client would retry and double-book).
    try {
      await Notification.create({
        user: cook,
        type: "booking_request",
        booking: booking._id,
        message: `New booking request from ${req.user.name || "a customer"}`,
      });
    } catch {
      // non-fatal: booking creation already succeeded
    }

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
      booking.status = "expired";
      booking.statusHistory.push({
        status: "expired",
        note: "Cook did not respond within 5 minutes",
      });
      await booking.save();
      await releaseCouponUsage(booking);
      // A prepaid-at-creation hold (API path) must not keep captured money:
      // queue a refund for admin approval, otherwise the booking is stuck
      // expired+paid with no recovery path.
      let expiredRefundNote = "";
      try {
        const queued = queueRefundForApproval(booking, "request_expired");
        if (queued > 0) {
          await booking.save();
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
      return booking;
    }
    if (
      booking.status === "accepted" &&
      booking.payment?.status !== "paid" &&
      booking.paymentExpiresAt &&
      booking.paymentExpiresAt < now
    ) {
      booking.status = "cancelled";
      booking.statusHistory.push({
        status: "cancelled",
        note: "Payment not completed within 5 minutes — slot released",
      });
      await booking.save();
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
      return booking;
    }
  } catch {
    // non-fatal; retried on the next read
  }
  return null;
};
// Shared with paymentController.createOrder (payment-window check).
exports.expireBookingIfNeeded = expireBookingIfNeeded;
// Exported for unit tests of the cook-login no-show rule.
exports.isNoShowPastHours = isNoShowPastHours;
// Exported for unit tests of the 30-minute cancel cutoff.
exports.cancelLocked = cancelLocked;

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
      const obj = b.toObject ? b.toObject() : b;
      const end = sessionEndDate(b);
      // Cook never sees the OTP — they ask the customer for it in person.
      delete obj.serviceOtp;
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

exports.acceptBooking = async (req, res, next) => {
  try {
    // Cooks act only on their own bookings; admins may moderate any booking.
    const filter = { _id: req.params.id };
    if (String(req.user.role).toUpperCase() !== "ADMIN") filter.cook = req.user.id;
    let booking = await Booking.findOne(filter);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (booking.status !== "requested") {
      return res.status(400).json({ message: "Only pending requests can be accepted" });
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

    // First accept wins: refuse if the slot has been booked since the request.
    const cookIdForCheck = String(req.user.role).toUpperCase() === "ADMIN" ? booking.cook : req.user.id;
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

    // F-14: atomic accept claim (production DB path). The read-then-save below
    // lets two concurrent accepts both succeed; the conditional update admits
    // exactly one winner (status must still be "requested"). The loser
    // re-reads and gets a truthful 404/400/409. Skipped without a DB
    // connection (unit-test path keeps the legacy flow).
    const acceptNote =
      String(req.user.role).toUpperCase() === "ADMIN" ? "Accepted by admin on behalf of the cook" : undefined;
    let acceptClaimed = false;
    if (dbReady()) {
      try {
        const claimFilter = { _id: booking._id, status: "requested" };
        if (String(req.user.role).toUpperCase() !== "ADMIN") claimFilter.cook = req.user.id;
        const claimUpdate = {
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
        const claim = await Booking.updateOne(claimFilter, claimUpdate);
        if ((claim.modifiedCount ?? claim.nModified ?? 0) === 1) {
          acceptClaimed = true;
        }
      } catch {
        acceptClaimed = false;
      }
      if (acceptClaimed) {
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
          });
        }
        return res.status(409).json({
          message: "Another accept is being processed for this request. Please try again.",
        });
      }
    }
    if (!acceptClaimed) {
      booking.status = "accepted";
      // Audit trail: mark admin-assisted accepts so the booking history shows
      // that an admin pressed the button on the cook's behalf.
      booking.statusHistory.push({
        status: "accepted",
        ...(acceptNote ? { note: acceptNote } : {}),
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
        });
      }
      latest.status = "requested";
      latest.paymentExpiresAt = null;
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
    res.json({ ...obj, customerWhatsappUrl, cookPhone: cookPhoneForCustomer });
  } catch (error) {
    next(error);
  }
};

exports.rejectBooking = async (req, res, next) => {
  try {
    // Cooks act only on their own bookings; admins may moderate any booking.
    // Only pending "requested" bookings can be declined (ignore/cancel path).
    const filter = { _id: req.params.id };
    if (String(req.user.role).toUpperCase() !== "ADMIN") filter.cook = req.user.id;
    const booking = await Booking.findOne(filter);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    // Expire first: a hold past its window is `expired`, not `rejected` —
    // the label, history, and customer message all differ.
    await expireBookingIfNeeded(booking);
    if (booking.status !== "requested") {
      return res.status(400).json({ message: "Only pending requests can be declined" });
    }

    booking.status = "rejected";
    booking.statusHistory.push({
      status: "rejected",
      ...(String(req.user.role).toUpperCase() === "ADMIN" ? { note: "Declined by admin on behalf of the cook" } : {}),
    });

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

    // Tell the cook when an admin declined on their behalf so they know the
    // request was handled and the slot stayed open.
    if (String(req.user.role).toUpperCase() === "ADMIN") {
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
    const booking = await Booking.findOne(filter);
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

    booking.status = "completed";
    booking.statusHistory.push({ status: "completed" });
    await booking.save();

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
    // gone so a vanishing row isn't a mystery.
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
    const isCook = booking.cook.toString() === req.user.id;
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

    res.json(stripServiceOtp(booking));
  } catch (error) {
    next(error);
  }
};

// Self-serve reschedule removed: bookings can no longer be moved to a new
// date/time via the API. Kept as a stub so old clients get an explicit
// message instead of a generic 404.
exports.rescheduleBooking = async (req, res) => {
  return res.status(410).json({
    message: "Rescheduling is no longer available — please cancel this booking and create a new one for the new time.",
  });
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
    const booking = await Booking.findOne(filter);
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
      booking.serviceOtpAttempts = Number(booking.serviceOtpAttempts || 0) + 1;
      if (booking.serviceOtpAttempts >= 10) {
        booking.serviceOtpLockedUntil = new Date(Date.now() + 15 * 60 * 1000);
      }
      try {
        await booking.save();
      } catch {
        // non-fatal: the 400 below is what matters
      }
      if (booking.serviceOtpAttempts >= 10) {
        return res.status(429).json({
          message: "Too many incorrect attempts — please wait 15 minutes and ask the customer for the code again.",
        });
      }
      return res.status(400).json({ message: "Incorrect OTP — please ask the customer for the 4-digit code shown on their booking" });
    }
    // Success resets the guard.
    booking.serviceOtpAttempts = 0;
    booking.serviceOtpLockedUntil = undefined;
    const durMin = Math.round(Number(booking.durationHours || 0) * 60);
    if (!Number.isInteger(Number(booking.durationHours)) || durMin < 60 || durMin > 4 * 60) {
      return res.status(400).json({ message: "This booking has no usable duration — please contact support" });
    }
    const startedAt = new Date();
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
    booking.serviceStartedAt = startedAt;
    booking.serviceEndsAt = new Date(startedAt.getTime() + durMin * 60 * 1000);
    // Redefine the service window from the actual start: the scheduled
    // start/end shift to (actual start → actual start + duration) so the
    // stored endTime always reflects real cooking time, not the slot guess.
    // Wall-clock strings are IST (business timezone), never server-local.
    const fmtClock = (d) => {
      const mins = istNowMinutes(d);
      return minutesToTime(mins);
    };
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
    if (!isCustomer && !isCook && !isAdmin) {
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
    try {
      const profile = await CookProfile.findOne({ user: booking.cook._id }).select(
        "rate serviceArea"
      );
      if (profile?.rate != null) cookRate = profile.rate;
      if (profile?.serviceArea) cookServiceArea = profile.serviceArea;
    } catch {
      // non-fatal
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
        });
      }
    }
    // Dev-only test checkout (no real money): allowed solely when the server
    // explicitly opts in via ALLOW_TEST_PAYMENTS=true AND is not running in
    // production. This double-guard means a forgotten env var can never
    // enable fake payments on the live site.
    const allowTest =
      req.body?.testMode === true &&
      process.env.ALLOW_TEST_PAYMENTS === "true" &&
      process.env.NODE_ENV !== "production";
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
    // of a cheaper order's payment onto this booking). Enforced whenever a
    // real triple is presented — including test mode — so testMode can never
    // launder a cheap genuine payment onto an expensive booking. The payment
    // itself must also be captured for the full fee (not merely authorized).
    if (hasPayment) {
      const orderErr = await assertRazorpayOrderAmount(razorpayOrderId, Number(booking.amount || 0) * 100);
      if (orderErr) {
        return res.status(402).json({ message: orderErr });
      }
      const captureErr = await assertRazorpayPaymentCaptured(
        razorpayOrderId,
        razorpayPaymentId,
        Number(booking.amount || 0) * 100
      );
      if (captureErr) {
        return res.status(402).json({ message: captureErr });
      }
    }
    if (!hasPayment && !allowTest && !zeroAmount) {
      return res.status(400).json({
        message:
          "Online payment is required — please complete the UPI/card payment to confirm this booking.",
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
          testMode: allowTest,
          ...(allowTest
            ? {
                razorpayOrderId: `order_test_${booking._id.toString().slice(-10)}`,
                razorpayPaymentId: `pay_test_${booking._id.toString().slice(-10)}_${now.getTime()}`,
                razorpaySignature: "test_mode_no_signature",
              }
            : { razorpayOrderId, razorpayPaymentId, razorpaySignature }),
        };
    const confirmEntry = zeroAmount
      ? { status: "confirmed", note: "100% discount — no payment required" }
      : {
          status: "confirmed",
          note: allowTest
            ? `Test payment (no real money) via ${method}`
            : `Payment received via ${method}`,
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
      return res.status(409).json({ message: "Payment is already being processed — please check your bookings." });
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
      reason: zeroAmount ? "100% discount — no charge" : allowTest ? "Test payment (no real money)" : "Razorpay payment confirmed",
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
        const obj = b.toObject ? b.toObject() : b;
        // Admin list never carries customer OTPs (bulk leak surface).
        delete obj.serviceOtp;
        return { ...obj, review: reviewByBookingId[b._id.toString()] || null };
      }),
      pg,
      () => Booking.countDocuments()
    );
  } catch (error) {
    next(error);
  }
};
