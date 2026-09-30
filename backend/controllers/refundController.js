// Customer post-service refund requests (no-show / not completed).
//
// Flow (never automatic): scheduled end + 1h passes with the booking still
// not completed → the customer becomes eligible → they file a request with a
// reason → the request queues as payment.refundStatus "pending" (visible in
// the existing admin refund queue, GET /payouts/refunds) → an admin approves
// (full or partial) or rejects via the existing payoutController paths,
// which move the money, audit the ledger and notify.
//
// The customer never chooses an amount: refundAmount is always computed
// server-side via finance.maxRefundable (captured minus already returned).

const Booking = require("../models/Booking");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { sessionEndDate } = require("./bookingController");
const { maxRefundable, recordLedger } = require("../utils/finance");

// Server-side eligibility gate: exact timestamp comparison on the booking's
// own service clock (OTP clock when the service started, else the static IST
// schedule — sessionEndDate, the same helper completion/no-show logic uses).
// The frontend never decides eligibility and no client timestamp is trusted.
const REFUND_GRACE_MS = 60 * 60 * 1000;
const REFUND_TERMINAL_STATUSES = ["completed", "cancelled", "rejected", "expired"];

const REFUND_REASONS = [
  "Service was not provided",
  "Cook did not arrive",
  "Service was partially completed",
  "Service was not completed",
  "Other",
];

const refundEligibility = (booking, now = Date.now()) => {
  const fail = (reasonCode, extra = {}) => ({ eligible: false, reasonCode, ...extra });
  if (!booking) return fail("not_found");
  const end = sessionEndDate(booking);
  const scheduledEnd = end && !Number.isNaN(end.getTime()) ? end : null;
  if (!scheduledEnd) return fail("no_schedule");
  if (REFUND_TERMINAL_STATUSES.includes(booking.status)) return fail("bad_status");
  const pay = booking.payment || {};
  if (pay.status !== "paid" || pay.testMode) return fail("no_payment");
  const refundable = maxRefundable(booking);
  if (!(refundable > 0)) return fail("no_payment");
  if ((pay.refundStatus || "none") !== "none") return fail("already_requested");
  if (now < scheduledEnd.getTime() + REFUND_GRACE_MS) return fail("too_early");
  return {
    eligible: true,
    reasonCode: "eligible",
    scheduledEnd,
    refundableAmount: refundable,
  };
};

// Public eligibility payload for the Booking Details page (drives the
// Request Refund button + status copy; never trusted for decisions — the
// POST below recomputes everything).
const eligibilityPayload = (booking, now = Date.now()) => {
  const e = refundEligibility(booking, now);
  const pay = booking?.payment || {};
  return {
    eligible: e.eligible,
    reasonCode: e.reasonCode,
    scheduledEnd: e.scheduledEnd ? e.scheduledEnd.toISOString() : null,
    refundableAmount: e.refundableAmount || 0,
    paidAmount: Math.round(Number(pay.paidAmount || booking?.amount || 0)),
    refundStatus: pay.refundStatus || "none",
    refundAmount: Math.round(Number(pay.refundAmount || 0)),
    refundReason: pay.refundReason || "",
    refundRequestedAt: pay.refundRequestedAt || null,
    refundAdminNote: pay.refundAdminNote || "",
  };
};

exports.REFUND_REASONS = REFUND_REASONS;
exports.REFUND_GRACE_MS = REFUND_GRACE_MS;
exports.refundEligibility = refundEligibility;

// GET /bookings/:id/refund-eligibility — own customer or admin.
exports.getRefundEligibility = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const isCustomer = String(booking.customer) === String(req.user.id);
    const isAdmin = String(req.user.role).toUpperCase() === "ADMIN";
    if (!isCustomer && !isAdmin) {
      return res.status(403).json({ message: "Not authorized" });
    }
    res.json(eligibilityPayload(booking, Date.now()));
  } catch (error) {
    next(error);
  }
};

// POST /bookings/:id/refund-request — own customer only (route authorizes
// "customer"; ownership is re-checked here so one customer can never file on
// another's booking). Body: { reason, note? } — amount/status/eligibility
// keys are never read from the request.
exports.requestRefund = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (String(booking.customer) !== String(req.user.id)) {
      return res.status(403).json({ message: "You are not authorized to request a refund for this booking." });
    }

    const reason = String(req.body?.reason || "").trim();
    if (!REFUND_REASONS.includes(reason)) {
      return res.status(400).json({ message: "Please choose a valid refund reason." });
    }
    const rawNote = String(req.body?.note ?? "");
    if (rawNote.length > 500) {
      return res.status(400).json({ message: "Note must be under 500 characters." });
    }
    const note = rawNote.trim().slice(0, 500);

    // Revalidate EVERYTHING server-side (never the frontend's word).
    const now = Date.now();
    const check = refundEligibility(booking, now);
    if (!check.eligible) {
      const messages = {
        bad_status:
          booking.status === "completed"
            ? "This booking has already been completed and is not eligible for this refund request."
            : "This booking is no longer eligible for a refund request.",
        no_payment: "This booking does not have a refundable payment.",
        already_requested: "A refund request already exists for this booking.",
        too_early:
          "Refund requests become available 1 hour after the scheduled service end time if the service has not been completed.",
        no_schedule: "This booking has no usable service schedule — please contact support.",
      };
      const status = check.reasonCode === "already_requested" ? 409 : 400;
      return res.status(status).json({ message: messages[check.reasonCode] || "This booking is not eligible for a refund request." });
    }

    const amount = Math.round(Number(check.refundableAmount));
    // Atomic claim: refundStatus none→pending plus the full guard set, so two
    // tabs (or a completion racing us) admit exactly one winner. A lost race
    // re-reads below instead of double-filing.
    let claimed = null;
    try {
      claimed = await Booking.findOneAndUpdate(
        {
          _id: booking._id,
          customer: req.user.id,
          status: { $nin: REFUND_TERMINAL_STATUSES },
          "payment.status": "paid",
          "payment.refundStatus": "none",
        },
        {
          $set: {
            "payment.refundStatus": "pending",
            "payment.refundAmount": amount,
            "payment.refundReason": reason,
            "payment.refundCustomerNote": note,
            "payment.refundRequestedAt": new Date(),
            "payment.refundRequestedBy": "customer",
            "payment.refundAdminNote": "",
          },
          $push: {
            statusHistory: {
              status: booking.status,
              note: `Refund requested by customer: ${reason}`,
            },
          },
        },
        { new: true }
      );
    } catch (e) {
      // Duplicate-key style collision on a unique guard → treat as a lost race.
      claimed = null;
    }
    if (!claimed) {
      let latest = null;
      try {
        latest = await Booking.findById(booking._id);
      } catch {
        latest = null;
      }
      if (!latest) {
        return res.status(404).json({ message: "Booking not found" });
      }
      if ((latest.payment?.refundStatus || "none") !== "none") {
        return res.status(409).json({ message: "A refund request already exists for this booking.", code: "REFUND_ALREADY_PROCESSED" });
      }
      if (latest.status === "completed") {
        return res.status(400).json({ message: "This booking has already been completed and is not eligible for this refund request.", code: "REFUND_NOT_ELIGIBLE" });
      }
      return res.status(409).json({ message: "This booking was just updated — please refresh to see its current state.", code: "BOOKING_INVALID_STATE" });
    }

    await recordLedger({
      idempotencyKey: `refund-request:${claimed._id}`,
      booking: claimed._id,
      type: "refund.requested",
      amount,
      prevState: "refund:none",
      newState: "refund:pending",
      actor: `customer:${req.user.id}`,
      source: "system",
      reason,
    });

    // Notify the customer (confirmation) + every admin (review queue).
    // Best-effort: the request itself already succeeded.
    try {
      await Notification.create({
        user: claimed.customer,
        type: "refund_processed",
        booking: claimed._id,
        message: `Your refund request for ₹${amount} has been submitted and is under admin review.`,
      });
    } catch {
      // non-fatal
    }
    try {
      const admins = await User.find({ role: "ADMIN" }).select("_id").limit(50).lean();
      const endLabel = check.scheduledEnd
        ? check.scheduledEnd.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
        : "";
      await Promise.all(
        (admins || []).map((a) =>
          Notification.create({
            user: a._id,
            type: "refund_processed",
            booking: claimed._id,
            message: `New refund request for booking #${String(claimed._id).slice(-6).toUpperCase()} — ₹${amount} (${reason}${endLabel ? `, scheduled ${endLabel}` : ""}).`,
          }).catch(() => null)
        )
      );
    } catch {
      // non-fatal
    }

    res.status(201).json(eligibilityPayload(claimed, Date.now()));
  } catch (error) {
    next(error);
  }
};
