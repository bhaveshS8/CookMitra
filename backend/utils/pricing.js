// Launch pricing — single source of truth for what a session costs.
// Festive-launch slabs (whole hours only): every cook, every service, one
// flat price. Both booking flows must offer exactly these durations; the
// server recomputes the fee from duration and never trusts client amounts.
//
// Platform commission 25%: the customer pays `payable`, the cook earns
// 75% (`cookPayout`), Cook Mitra keeps 25% (`commission`).

const LAUNCH_SLABS = {
  1: 199,
  2: 349,
  3: 499,
  4: 649,
};

const COMMISSION_RATE = 0.25;

// Whole-hour durations the launch price list covers.
const isSlabDuration = (hours) =>
  Number.isInteger(Number(hours)) && LAUNCH_SLABS[Number(hours)] != null;

// Pre-discount session price, or null when the duration has no slab.
const slabPriceForDuration = (hours) => {
  const h = Number(hours);
  if (!isSlabDuration(h)) return null;
  return LAUNCH_SLABS[h];
};

// Split a final (post-discount) amount into platform/cook shares.
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
