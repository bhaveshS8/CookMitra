
// Forgiving normalization: uppercase + drop spaces, hyphens, underscores
// and invisible copy-paste junk (zero-width spaces, BOM). Every lookup and
// every stored code goes through this, so "welcome-50", "WELCOME 50" and
// "WELCOME50" are one coupon.
const normalizeCode = (code) =>
  String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "");

const rejectionReason = (
  coupon,
  { amount, userId, serviceType, isFirstBooking, now = new Date() } = {}
) => {
  if (!coupon) return "This coupon is not valid for this booking.";
  if (coupon.active === false) return "This coupon is no longer active.";
  if (coupon.validFrom && new Date(coupon.validFrom) > now)
    return "This coupon is not valid yet.";
  if (coupon.validTo && new Date(coupon.validTo) < now)
    return "This coupon has expired.";
  const fullFee = Number(amount);
  if (!Number.isFinite(fullFee) || fullFee <= 0)
    return "Invalid order amount for this coupon.";
  if (Number(coupon.minOrder) > 0 && fullFee < Number(coupon.minOrder))
    return `This coupon needs a minimum order of ₹${coupon.minOrder}.`;
  if (
    coupon.usageLimit != null &&
    Number(coupon.usedCount || 0) >= Number(coupon.usageLimit)
  )
    return "This coupon has reached its usage limit.";
  if (userId && coupon.perUserLimit != null) {
    const uses = (coupon.usedBy || []).filter(
      (id) => String(id) === String(userId)
    ).length;
    if (uses >= Number(coupon.perUserLimit))
      return "You have already used this coupon.";
  }
  if (coupon.firstBookingOnly && isFirstBooking === false)
    return "This coupon is only for your first booking.";
  if (
    serviceType &&
    Array.isArray(coupon.applicableServices) &&
    coupon.applicableServices.length > 0 &&
    !coupon.applicableServices.includes(serviceType)
  )
    return "This coupon is not valid for the selected service.";
  return null;
};

const computeDiscount = (coupon, amount) => {
  const fullFee = Math.round(Number(amount));
  let raw = 0;
  if (coupon.discountType === "flat") {
    raw = Math.round(Number(coupon.flatAmount) || 0);
  } else {
    raw = Math.round((fullFee * Number(coupon.percent)) / 100) || 0;
  }
  const capped =
    coupon.maxDiscount != null
      ? Math.min(raw, Math.round(Number(coupon.maxDiscount)))
      : raw;
  return Math.max(0, Math.min(capped, fullFee));
};

// Resolve a coupon by user-entered code: exact normalized match first,
// then a legacy fallback comparing normalized forms (codes stored before
// separator-stripping, e.g. "FIRST FREE", still resolve). The collection
// is admin-managed and tiny, so the scan is cheap and runs only on miss.
const findCouponByCode = async (code) => {
  const wanted = normalizeCode(code);
  if (!wanted) return null;
  let Coupon;
  try {
    Coupon = require("../models/Coupon");
  } catch {
    return null;
  }
  try {
    const exact = await Coupon.findOne({ code: wanted });
    if (exact) return exact;
  } catch {
    return null;
  }
  try {
    const all = await Coupon.find({});
    return (all || []).find((c) => normalizeCode(c?.code) === wanted) || null;
  } catch {
    return null;
  }
};

module.exports = { normalizeCode, rejectionReason, computeDiscount, findCouponByCode };
