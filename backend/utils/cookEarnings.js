
const cfg = require("../config/cookEarnings");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Integer-paise helpers: category totals (pending/paid/lifetime, cycle
// gross/deductions/earnings) are accumulated in paise so the reconciliation
// invariant lifetime_paise === pending_paise + paid_paise holds by
// construction instead of depending on binary floating-point summation
// order. Per-booking stored values keep their existing round2 shape.
const toPaise = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100);
};
const fromPaise = (p) => Math.round(Number(p) || 0) / 100;

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

const payoutEligibleForCycle = (booking) => {
  const reasons = [];
  if (!booking) return { eligible: false, reasons: ["Booking not found"] };
  const pay = booking.payment || {};
  if (booking.status !== "completed") reasons.push(`Booking is ${booking.status || "unknown"}, not completed`);
  if (pay.status !== "paid") reasons.push("Payment is not captured");
  if (pay.testMode) reasons.push("Test payments carry no real money");
  const rs = pay.refundStatus || "none";
  if (!["none", "rejected"].includes(rs)) reasons.push(`Customer refund is ${rs} — held for a later cycle`);
  const info = booking.payoutInfo || {};
  if (info.disputed) reasons.push("Booking is disputed — held");
  if (info.underVerification) reasons.push("Booking is under verification — held");
  if (info.payoutStatus === "paid" || booking?.payout?.status === "settled")
    reasons.push("Payout already paid");
  if (!(Number(booking.amount ?? info.finalCustomerPrice) > 0))
    reasons.push("Booking amount is not positive");
  return { eligible: reasons.length === 0, reasons };
};

module.exports = {
  round2,
  toPaise,
  fromPaise,
  computeCookPayout,
  buildPayoutSnapshot,
  payoutEligibleForCycle,
};
