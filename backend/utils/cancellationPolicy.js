// Centralized customer cancellation & refund policy engine (§2).
// THE single source of truth for cancellation eligibility, refund percentage
// and refund amounts. Controllers must call this — never re-implement the
// slabs. The frontend never computes refunds; it only displays these values.
//
// Boundary rule (documented, deterministic — §7):
//   msUntilStart > 24h            → MORE_THAN_24_HOURS  (90%)
//   24h >= msUntilStart > 6h      → WITHIN_24_HOURS     (75%)
//   msUntilStart <= 6h            → WITHIN_6_HOURS      (50%)
// i.e. exactly 24h resolves to WITHIN_24_HOURS, exactly 6h to WITHIN_6_HOURS.
//
// Money rule (§10/§31): paise-integer arithmetic throughout (no float drift —
// ₹449 × 75% = ₹336.75 exactly), rounded to 2 decimals. The refund base is
// ALWAYS the eligible customer/service amount actually paid
// (payment.paidAmount, falling back to booking.amount — the coupon-adjusted
// final price). Never cook payout, commission, or pre-coupon price.

const { istEventInstant } = require("./time");
const policyConfig = require("../config/cancellationPolicy");

const MS_24H = 24 * 60 * 60 * 1000;
const MS_6H = 6 * 60 * 60 * 1000;

const TERMINAL_STATUSES = ["cancelled", "completed", "rejected", "expired", "unattended"];

const CUSTOMER_CANCELLATION_REASONS = [
  "CHANGE_OF_PLANS",
  "WRONG_BOOKING_DETAILS",
  "WRONG_ADDRESS",
  "SERVICE_NO_LONGER_REQUIRED",
  "OTHER",
];

// Complaint reasons a customer may file from "Report a Problem" (§19).
const CUSTOMER_COMPLAINT_REASONS = [
  "COOK_DID_NOT_ARRIVE",
  "MAJOR_SERVICE_DEVIATION",
  "SERVICE_QUALITY_ISSUE",
  "UNPROFESSIONAL_BEHAVIOR",
  "OTHER",
];

// Cases that must NEVER auto-refund — admin verification required (§21).
const NOT_AUTO_REFUNDABLE = [
  "CHANGE_OF_PLANS",
  "CUSTOMER_UNAVAILABLE",
  "WRONG_ADDRESS_BY_CUSTOMER",
  "OUT_OF_SCOPE_REQUEST",
  "PREFERENCE_AFTER_DELIVERY",
  "UNSUPPORTED_COMPLAINT",
  "AFTER_CANCELLATION_WINDOW",
];

const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
const fromPaise = (paise) => Math.round(Number(paise || 0)) / 100;

// Paise-safe: base × percent → 2-decimal rupees. 449 × 75 = 336.75 exactly.
const computeRefund = (baseAmount, refundPercent) => {
  const basePaise = toPaise(baseAmount);
  if (!(basePaise > 0)) return 0;
  const pct = Math.min(100, Math.max(0, Number(refundPercent) || 0));
  return fromPaise(Math.round((basePaise * pct) / 100));
};

// Scheduled service-start instant (IST wall time → UTC instant, host-TZ safe).
// Mirrors bookingController.sessionStartDate without the require cycle.
const serviceStartInstant = (booking) => {
  try {
    if (!booking?.date || !booking?.startTime) return null;
    return istEventInstant(booking.date, booking.startTime);
  } catch {
    return null;
  }
};

// Whether a real gateway charge may be deducted (§11): only when configured
// (>0), and only against a real captured gateway payment. Never invented,
// never applied to test/unpaid money.
const gatewayDeductionFor = (booking) => {
  const fee = Number(policyConfig.gatewayFixedFee) || 0;
  if (!(fee > 0)) return 0;
  const pay = booking?.payment || {};
  if (pay.status !== "paid" || pay.testMode) return 0;
  if (!pay.razorpayPaymentId) return 0;
  return Math.round(fee * 100) / 100;
};

const slabFor = (category) =>
  policyConfig.slabs[category] || { cancellationChargePercent: 0, refundPercent: 0 };

// Derive the cancellation category from server-side booking truth (§3).
// opts: { actorRole: customer|cook|admin, noShow?: boolean, cookFailed?: boolean }
const deriveCategory = (booking, nowMs, opts = {}) => {
  const role = String(opts.actorRole || "customer").toLowerCase();
  if (opts.noShow) return "CUSTOMER_NO_SHOW";
  if (opts.cookFailed) return "COOK_FAILED_SERVICE";
  if (role === "cook") return "COOK_CANCELLED";
  // Customer path below.
  if (!booking?.cook) return "BEFORE_ASSIGNMENT";
  if (booking?.cookArrived || booking?.serviceStartedAt) return "COOK_ARRIVED";
  const start = serviceStartInstant(booking);
  if (!start) return "MORE_THAN_24_HOURS"; // unknown start ⇒ fail-open (matches cancel cutoff)
  const ms = start.getTime() - nowMs;
  if (ms > MS_24H) return "MORE_THAN_24_HOURS";
  if (ms > MS_6H) return "WITHIN_24_HOURS";
  return "WITHIN_6_HOURS";
};

// Main entry: evaluateCancellation({ booking, currentTime, actorRole, noShow, cookFailed }).
const evaluateCancellation = ({ booking, currentTime, actorRole = "customer", noShow = false, cookFailed = false } = {}) => {
  const nowMs = Number(currentTime) || Date.now();
  const role = String(actorRole || "customer").toLowerCase();
  const fail = (reasonCode, message, extra = {}) => ({
    allowed: false,
    reasonCode,
    message,
    cancellationCategory: extra.cancellationCategory || null,
    cancellationChargePercent: 0,
    refundPercent: 0,
    bookingAmount: 0,
    grossRefund: 0,
    nonRefundableCharges: 0,
    finalRefund: 0,
    policyVersion: policyConfig.version,
    ...extra,
  });
  if (!booking) return fail("BOOKING_NOT_FOUND", "Booking not found.");
  if (TERMINAL_STATUSES.includes(booking.status)) {
    return fail("BOOKING_NOT_CANCELLABLE", "This booking can no longer be cancelled.");
  }
  // Started service can never be self-serve cancelled (race guard pairs with
  // the atomic claim in cancelBooking — §17). Admins may still record it.
  if ((booking.serviceStartedAt || booking.status === "in_progress") && role !== "admin") {
    return fail(
      "SERVICE_ALREADY_STARTED",
      "The service has already started — this booking can no longer be cancelled online. Please contact support.",
      { cancellationCategory: booking.cookArrived ? "COOK_ARRIVED" : null }
    );
  }
  // Cook arrival locks customer self-serve cancellation (§8): no bypass via
  // a frontend cancel after the cook reaches the venue. Admins record 0%.
  if (booking.cookArrived && role === "customer" && !noShow) {
    const slab = slabFor("COOK_ARRIVED");
    const base = refundBaseOf(booking);
    return fail("COOK_ARRIVED", "The cook has already reached the venue — this booking can no longer be cancelled online. Please contact support.", {
      cancellationCategory: "COOK_ARRIVED",
      cancellationChargePercent: slab.cancellationChargePercent,
      refundPercent: slab.refundPercent,
      bookingAmount: base,
      grossRefund: 0,
      nonRefundableCharges: 0,
      finalRefund: 0,
    });
  }

  const category = deriveCategory(booking, nowMs, { actorRole: role, noShow, cookFailed });
  const slab = slabFor(category);
  const base = refundBaseOf(booking);
  const paid = booking?.payment?.status === "paid" && !booking?.payment?.testMode && base > 0;
  const grossRefund = paid ? computeRefund(base, slab.refundPercent) : 0;
  const fee = paid && grossRefund > 0 ? gatewayDeductionFor(booking) : 0;
  const finalRefund = paid ? Math.max(0, Math.round((grossRefund - fee) * 100) / 100) : 0;
  return {
    allowed: true,
    cancellationCategory: category,
    cancellationChargePercent: slab.cancellationChargePercent,
    refundPercent: slab.refundPercent,
    bookingAmount: base,
    grossRefund,
    nonRefundableCharges: fee,
    finalRefund,
    policyVersion: policyConfig.version,
    withinCutoff30Min: isWithin30MinCutoff(booking, nowMs),
    message: messageFor(category, slab),
  };
};

// Eligible refund base (§31): actual customer-paid service amount.
const refundBaseOf = (booking) => {
  const paid = Number(booking?.payment?.paidAmount);
  if (Number.isFinite(paid) && paid > 0) return Math.round(paid * 100) / 100;
  const amt = Number(booking?.amount);
  if (Number.isFinite(amt) && amt > 0) return Math.round(amt * 100) / 100;
  return 0;
};

// Existing 30-minute self-serve cutoff (kept — §1 flow must not break).
const isWithin30MinCutoff = (booking, nowMs = Date.now()) => {
  const start = serviceStartInstant(booking);
  if (!start) return false;
  return nowMs >= start.getTime() - 30 * 60 * 1000;
};

const messageFor = (category, slab) => {
  const map = {
    BEFORE_ASSIGNMENT: "100% refund is applicable — no cook was assigned yet.",
    MORE_THAN_24_HOURS: "90% refund is applicable (10% cancellation charge).",
    WITHIN_24_HOURS: "75% refund is applicable (25% cancellation charge).",
    WITHIN_6_HOURS: "50% refund is applicable (50% cancellation charge).",
    COOK_ARRIVED: "No refund is applicable — the cook has reached the venue.",
    CUSTOMER_NO_SHOW: "No refund is applicable for a customer no-show.",
    COOK_CANCELLED: "100% refund is applicable — the cook cancelled. We will try an alternative cook first.",
    COOK_FAILED_SERVICE: "100% refund is applicable — the confirmed service was not provided.",
  };
  return map[category] || `${slab.refundPercent}% refund is applicable.`;
};

module.exports = {
  MS_24H,
  MS_6H,
  TERMINAL_STATUSES,
  CUSTOMER_CANCELLATION_REASONS,
  CUSTOMER_COMPLAINT_REASONS,
  NOT_AUTO_REFUNDABLE,
  computeRefund,
  toPaise,
  fromPaise,
  serviceStartInstant,
  gatewayDeductionFor,
  deriveCategory,
  evaluateCancellation,
  refundBaseOf,
  isWithin30MinCutoff,
  policyVersion: policyConfig.version,
};
