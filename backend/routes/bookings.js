
const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const rateLimit = require("express-rate-limit");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const {
  createBooking,
  getMyBookings,
  getMyLocations,
  getCookBookings,
  getAdminBookings,
  getBookingById,
  acceptBooking,
  rejectBooking,
  completeBooking,
  cancelBooking,
  deleteBooking,
  rescheduleBooking,
  startService,
  payBooking,
  markCookArrived,
} = require("../controllers/bookingController");

router.post(
  "/",
  auth,
  authorize("customer"),
  [
    body("cook").isMongoId().withMessage("Valid cook id is required"),
    body("serviceType")
      .isIn(["cook_for_me", "cook_with_me", "teach_me", "preparation_help"])
      .withMessage("Valid service type is required"),
    // Date-only (YYYY-MM-DD): full datetimes are refused outright so a
    // silently-dropped time/timezone component can never shift the day.
    body("date").matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("Valid date (YYYY-MM-DD) is required"),
    body("startTime").notEmpty().withMessage("Start time is required"),
    body("endTime").notEmpty().withMessage("End time is required"),
    body("address").trim().notEmpty().withMessage("Address is required"),
    body("guests")
      .optional()
      .isInt({ min: 1, max: 500 })
      .withMessage("Guests must be between 1 and 500"),
    body("durationHours")
      .optional()
      .isInt({ min: 1, max: 4 })
      .withMessage("Sessions run 1–4 hours"),
    body("couponCode")
      .optional()
      .isString()
      .withMessage("Coupon code must be text"),
    body("clientKey")
      .optional()
      .isString()
      .isLength({ max: 120 })
      .withMessage("Client key must be text"),
    body("location.lat")
      .optional()
      .isFloat({ min: -90, max: 90 })
      .withMessage("Invalid latitude"),
    body("location.lng")
      .optional()
      .isFloat({ min: -180, max: 180 })
      .withMessage("Invalid longitude"),
    body("amount")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Amount must be a non-negative number"),
    // Payment details are optional now (pay-on-booking removed): when absent
    // the booking is created with payment.status "pending".
  ],
  validate,
  createBooking
);

router.get("/my", auth, authorize("customer"), getMyBookings);
router.get("/my/locations", auth, authorize("customer"), getMyLocations);
router.get("/cook", auth, authorize("cook"), getCookBookings);
router.get("/:id", auth, getBookingById);
router.get("/", auth, authorize("admin"), getAdminBookings);
router.patch("/:id/accept", auth, authorize("cook", "admin"), acceptBooking);
// Customer confirms payment within the 5-minute post-acceptance window.
router.patch("/:id/pay", auth, authorize("customer"), payBooking);
router.patch("/:id/reject", auth, authorize("cook", "admin"), rejectBooking);
router.patch("/:id/complete", auth, authorize("cook", "admin"), completeBooking);
router.patch("/:id/arrived", auth, authorize("cook", "admin"), markCookArrived);
// OTP start is brute-force sensitive (4 digits + 10-try lockout): own
// tighter bucket on top of the general limiter.
const otpLimiter = rateLimit({
  standardHeaders: false,
  legacyHeaders: false,
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_OTP || 30),
  message: { message: "Too many attempts — please try again later." },
});
router.patch(
  "/:id/start-service",
  auth,
  authorize("cook", "admin"),
  otpLimiter,
  [body("otp").trim().notEmpty().withMessage("OTP is required")],
  validate,
  startService
);
router.patch("/:id/cancel", auth, cancelBooking);
// Customers may permanently remove bookings the cook never accepted
// (requested / rejected / expired) or ones they already cancelled.
router.delete("/:id", auth, authorize("customer"), deleteBooking);
// Self-serve reschedule removed — route kept so old clients get an explicit
// 410 (see rescheduleBooking stub) instead of a generic 404.
router.patch(
  "/:id/reschedule",
  auth,
  authorize("customer", "cook", "admin"),
  rescheduleBooking
);

module.exports = router;
