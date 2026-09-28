// Shared coupon pricing — pure functions over a coupon record so both the
// validate endpoint and the payment flow compute identical discounts.
// Nothing here touches the DB, which keeps it unit-testable.

const normalizeCode = (code) => String(code || "").trim().toUpperCase();

// Returns null when usable, otherwise a human-readable rejection reason.
// Options: amount (pre-discount fee), userId, serviceType, isFirstBooking
// (whether the customer has no prior bookings), now.
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

// Rupee discount for a usable coupon (caller must check rejectionReason).
// Flat coupons take flatAmount; percent coupons take percent capped by
// maxDiscount. Never exceeds the order value.
const computeDiscount = (coupon, amount) => {
  const fullFee = Math.round(Number(amount));
  let raw = 0;
  if (coupon.discountType === "flat") {
    raw = Math.round(Number(coupon.flatAmount) || 0);
  } else {
    // Guard corrupt data (missing percent → NaN → falsy checks pass and the
    // booking settles ₹0): treat unparseable percent as no discount.
    raw = Math.round((fullFee * Number(coupon.percent)) / 100) || 0;
  }
  const capped =
    coupon.maxDiscount != null
      ? Math.min(raw, Math.round(Number(coupon.maxDiscount)))
      : raw;
  return Math.max(0, Math.min(capped, fullFee));
};

module.exports = { normalizeCode, rejectionReason, computeDiscount };
