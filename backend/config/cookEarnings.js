// Cook Partner Rate / Payout / Incentive / Referral configuration.
// Single source of truth — admin-configurable via env overrides, never
// hardcoded in controllers. Financial rules (§22):
//   cook payout = 85% of FINAL customer price, 15% platform deduction,
//   coupon discounts reduce the final price first.

const payoutPercentage = Number(process.env.COOK_PAYOUT_PERCENT || 85);
const deductionPercentage = Number(process.env.COOK_DEDUCTION_PERCENT || 15);

const INCENTIVES = [
  { code: "JOINING", targetLeads: 10, days: 7, reward: 500 },
  { code: "PERFORMANCE", targetLeads: 20, days: 10, reward: 1000 },
  { code: "ACHIEVEMENT", targetLeads: 30, days: 15, reward: 1500 },
  { code: "CHAMPION", targetLeads: 50, days: 30, reward: 2500 },
];

// Non-cumulative by default (§10): each slab has its own eligibility.
// Set COOK_INCENTIVES_CUMULATIVE=true to pay slabs cumulatively.
const cumulative =
  String(process.env.COOK_INCENTIVES_CUMULATIVE || "false").toLowerCase() === "true";

const referralReward = Number(process.env.COOK_REFERRAL_REWARD || 250);
const referralBookingTarget = Number(process.env.COOK_REFERRAL_BOOKING_TARGET || 10);

module.exports = {
  payoutPercentage,
  deductionPercentage,
  incentives: INCENTIVES,
  cumulative,
  referralReward,
  referralBookingTarget,
  incentiveByCode: (code) =>
    INCENTIVES.find((i) => i.code === String(code || "").toUpperCase()) || null,
};
