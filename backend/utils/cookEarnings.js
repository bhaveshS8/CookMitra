// Cook Partner earnings engine — pure functions (no DB), unit-testable.
// Financial rules (§22) enforced here so controllers stay thin:
//  1. cook payout = 85% of FINAL customer price (never regular price).
//  2. Two-decimal precision (₹381.65, not rounded-to-rupee legacy split).
//  3. Historical snapshots immutable — compute once, store, never recompute.
//  4. Never trust frontend values — every function takes server-side inputs.

const cfg = require("../config/cookEarnings");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Precise 85/15 split from the FINAL customer price (§1, §22).
// Returns { finalCustomerPrice, platformDeductionAmount, cookPayoutAmount }
// with platformDeductionPercent from config. cookPayout + deduction === final.
const computeCookPayout = (finalCustomerPrice) => {
  const final = round2(finalCustomerPrice);
  if (!Number.isFinite(final) || final <= 0) {
    return {
      finalCustomerPrice: 0,
      platformDeductionPercent: cfg.deductionPercentage,
      platformDeductionAmount: 0,
      cookPayoutAmount: 0,
    };
  }
  const deduction = round2((final * cfg.deductionPercentage) / 100);
  const payout = round2(final - deduction);
  return {
    finalCustomerPrice: final,
    platformDeductionPercent: cfg.deductionPercentage,
    platformDeductionAmount: deduction,
    cookPayoutAmount: payout,
  };
};

// Build the immutable payout snapshot stored on the booking (§2).
// regularPrice = pre-discount slab; discountAmount = coupon saving.
const buildPayoutSnapshot = ({ regularPrice, discountAmount, finalCustomerPrice }) => {
  const regular = round2(regularPrice);
  const discount = round2(discountAmount);
  const final = round2(
    finalCustomerPrice != null ? finalCustomerPrice : regular - discount
  );
  const split = computeCookPayout(final);
  return {
    regularPrice: regular,
    discountAmount: discount,
    finalCustomerPrice: split.finalCustomerPrice,
    platformDeductionPercent: split.platformDeductionPercent,
    platformDeductionAmount: split.platformDeductionAmount,
    cookPayoutAmount: split.cookPayoutAmount,
    payoutStatus: "eligible",
    payoutEligibleAt: new Date(),
    payoutProcessedAt: null,
    payoutHoldReason: "",
  };
};

// Weekly-cycle eligibility (§3): completed + paid + verified, never
// cancelled/refunded/disputed/incomplete/under-verification.
const payoutEligibleForCycle = (booking) => {
  const reasons = [];
  if (!booking) return { eligible: false, reasons: ["Booking not found"] };
  const pay = booking.payment || {};
  if (booking.status !== "completed") reasons.push(`Booking is ${booking.status || "unknown"}, not completed`);
  if (pay.status !== "paid") reasons.push("Payment is not captured");
  if (pay.testMode) reasons.push("Test payments carry no real money");
  const rs = pay.refundStatus || "none";
  if (!["none", "rejected"].includes(rs)) reasons.push(`Customer refund is ${rs} — held for a later cycle`);
  // Dispute / verification hold flags (stored on payoutInfo when present).
  const info = booking.payoutInfo || {};
  if (info.disputed) reasons.push("Booking is disputed — held");
  if (info.underVerification) reasons.push("Booking is under verification — held");
  if (info.payoutStatus === "paid" || booking?.payout?.status === "settled")
    reasons.push("Payout already paid");
  if (!(Number(booking.amount ?? info.finalCustomerPrice) > 0))
    reasons.push("Booking amount is not positive");
  return { eligible: reasons.length === 0, reasons };
};

// Normalize an Indian mobile to its 10-digit core before duplicate checks.
// "+91 98765 43210", "919876543210", "09876543210" → "9876543210".
// Returns "" when the input cannot be a valid mobile.
const normalizePhone = (raw) => {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return "";
  return digits;
};

// Referral code: CM-<NAME>-<4 hex> e.g. CM-BHAVESH-8F42 (§12).
const generateReferralCode = (name) => {
  const crypto = require("crypto");
  const base = String(name || "COOK")
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 12) || "COOK";
  const suffix = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `CM-${base}-${suffix}`;
};

const referralLinkFor = (code) => `/register?ref=${encodeURIComponent(code)}`;

// Incentive progress for one slab (§8/§9): server-computed from verified
// lead count + enrollment window. Frontend counters are display-only.
const incentiveProgress = ({ incentive, verifiedLeadCount, now = new Date() }) => {
  const count = Math.max(0, Number(verifiedLeadCount) || 0);
  const target = Number(incentive.target ?? incentive.targetLeads);
  const end = new Date(incentive.endDate);
  const expired = now > end;
  const eligible = count >= target && !expired;
  return {
    target,
    verifiedLeadCount: count,
    remaining: Math.max(0, target - count),
    startDate: incentive.startDate,
    endDate: incentive.endDate,
    expired,
    eligible,
    status: incentive.status,
    reward: incentive.reward,
  };
};

// Referral qualification (§11): 10 verified bookings by the referred cook.
const referralQualified = (verifiedBookingCount) =>
  Number(verifiedBookingCount) >= Number(cfg.referralBookingTarget);

module.exports = {
  round2,
  computeCookPayout,
  buildPayoutSnapshot,
  payoutEligibleForCycle,
  normalizePhone,
  generateReferralCode,
  referralLinkFor,
  incentiveProgress,
  referralQualified,
};
