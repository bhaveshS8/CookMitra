
const sanitizePercent = (raw, fallback, name) => {
  const n = Number(raw);
  // Guard against unset / non-numeric / out-of-range env configuration.
  // An invalid percentage must never silently poison every payout with NaN.
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    if (raw !== undefined && String(raw).trim() !== "") {
      try {
        console.warn(
          `CONFIG WARNING: ${name}=${JSON.stringify(raw)} is invalid — falling back to ${fallback}. Set a number 0–100.`
        );
      } catch {
      }
    }
    return fallback;
  }
  return n;
};

const payoutPercentage = sanitizePercent(process.env.COOK_PAYOUT_PERCENT, 85, "COOK_PAYOUT_PERCENT");
const deductionPercentage = sanitizePercent(process.env.COOK_DEDUCTION_PERCENT, 15, "COOK_DEDUCTION_PERCENT");

module.exports = {
  payoutPercentage,
  deductionPercentage,
};
