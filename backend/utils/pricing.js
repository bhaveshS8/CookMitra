
const LAUNCH_SLABS = {
  1: 199,
  2: 349,
  3: 499,
  4: 649,
};

const COMMISSION_RATE = 0.15;

const isSlabDuration = (hours) =>
  Number.isInteger(Number(hours)) && LAUNCH_SLABS[Number(hours)] != null;

const slabPriceForDuration = (hours) => {
  const h = Number(hours);
  if (!isSlabDuration(h)) return null;
  return LAUNCH_SLABS[h];
};

const splitPayout = (payable) => {
  const finalAmount = Math.max(0, Math.round(Number(payable) || 0));
  const commission = Math.round(finalAmount * COMMISSION_RATE);
  return { finalAmount, commission, cookPayout: finalAmount - commission };
};

module.exports = {
  LAUNCH_SLABS,
  COMMISSION_RATE,
  isSlabDuration,
  slabPriceForDuration,
  splitPayout,
};
