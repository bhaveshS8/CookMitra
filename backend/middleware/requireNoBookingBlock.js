// Shared authoritative booking-restriction gate.
//
// Apply BEFORE any booking-creation side effect (coupon redemption,
// booking insert, notifications, dispatch jobs, payment linkage).
//
//  - active restriction -> 403 + BOOKING_TEMPORARILY_BLOCKED + blockedUntil
//  - store unreachable    -> 503 + BOOKING_VERIFICATION_UNAVAILABLE (fail
//    closed: no booking is created, and no false one-hour block is claimed)
const {
  getRestrictionState,
  remainingSeconds,
  BLOCKED_CODE,
  VERIFICATION_UNAVAILABLE_CODE,
} = require("../utils/bookingRestrictions");

const requireNoBookingBlock = async (req, res, next) => {
  try {
    const customerId = req.user?.id;
    if (!customerId) {
      return res.status(401).json({ message: "Authentication required to make a booking" });
    }
    const state = await getRestrictionState(customerId);
    if (state.blocked) {
      return res.status(403).json({
        message:
          "Booking temporarily unavailable. A woman must be present at home throughout the cooking service. Your booking access has been temporarily paused for 1 hour.",
        code: BLOCKED_CODE,
        blockedUntil: state.blockedUntil,
        remainingSeconds: remainingSeconds(state.blockedUntil),
      });
    }
    return next();
  } catch (err) {
    if (err?.code === VERIFICATION_UNAVAILABLE_CODE) {
      return res.status(503).json({
        message: "Booking verification is temporarily unavailable. Please try again in a moment.",
        code: VERIFICATION_UNAVAILABLE_CODE,
      });
    }
    return next(err);
  }
};

module.exports = { requireNoBookingBlock };
