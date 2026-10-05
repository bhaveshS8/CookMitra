
const payoutPercentage = Number(process.env.COOK_PAYOUT_PERCENT || 85);
const deductionPercentage = Number(process.env.COOK_DEDUCTION_PERCENT || 15);

const INCENTIVES = [
  { code: "JOINING", targetLeads: 10, days: 7, reward: 500 },
  { code: "PERFORMANCE", targetLeads: 20, days: 10, reward: 1000 },
  { code: "ACHIEVEMENT", targetLeads: 30, days: 15, reward: 1500 },
  { code: "CHAMPION", targetLeads: 50, days: 30, reward: 2500 },
];

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
