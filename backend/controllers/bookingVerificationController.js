// Woman-presence verification endpoints.
//
// POST /verification/decline  — record an explicit NO (starts/keeps the
//                                one-hour lockout; never creates a booking)
// GET  /verification/status   — current lockout state (drives the frontend
//                                countdown; expiry is always server-side)
//
// Identity comes exclusively from the verified auth context (req.user.id).
// Any client-supplied customer id in the body is ignored.

const {
  recordDecline,
  getRestrictionState,
  remainingSeconds,
  LOCKOUT_SECONDS,
  VERIFICATION_UNAVAILABLE_CODE,
} = require("../utils/bookingRestrictions");

exports.declineVerification = async (req, res, next) => {
  try {
    const customerId = req.user?.id;
    if (!customerId) {
      return res.status(401).json({ message: "Authentication required" });
    }
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
      // Body is accepted but carries no authority: an explicit decline needs
      // no fields, and unexpected types are rejected rather than trusted.
      for (const [k, v] of Object.entries(req.body)) {
        if (typeof v === "object" && v !== null) {
          return res.status(400).json({ message: "Invalid request. Please try again." });
        }
        if (String(k).length > 64 || String(v).length > 256) {
          return res.status(400).json({ message: "Invalid request. Please try again." });
        }
      }
    }
    const { created, blockedUntil } = await recordDecline(customerId);
    return res.status(created ? 201 : 200).json({
      blocked: true,
      created,
      blockedUntil,
      lockoutSeconds: LOCKOUT_SECONDS,
      remainingSeconds: remainingSeconds(blockedUntil),
      message:
        "Booking temporarily unavailable. Your booking access has been temporarily paused for 1 hour.",
      code: "BOOKING_TEMPORARILY_BLOCKED",
    });
  } catch (err) {
    if (err?.code === "RESTRICTION_WRITE_FAILED") {
      return res.status(503).json({
        message: "Could not record the restriction right now. Please try again — no booking was created.",
        code: "RESTRICTION_WRITE_FAILED",
      });
    }
    return next(err);
  }
};

exports.verificationStatus = async (req, res, next) => {
  try {
    const customerId = req.user?.id;
    if (!customerId) {
      return res.status(401).json({ message: "Authentication required" });
    }
    const state = await getRestrictionState(customerId);
    if (state.blocked) {
      return res.json({
        blocked: true,
        blockedUntil: state.blockedUntil,
        lockoutSeconds: LOCKOUT_SECONDS,
        remainingSeconds: remainingSeconds(state.blockedUntil),
        code: "BOOKING_TEMPORARILY_BLOCKED",
      });
    }
    return res.json({ blocked: false, blockedUntil: null, remainingSeconds: 0 });
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
