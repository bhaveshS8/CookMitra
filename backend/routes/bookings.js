
const express = require("express");
const router = express.Router();
const { body, query } = require("express-validator");
const rateLimit = require("express-rate-limit");
const { rateLimitStore } = require("../utils/rateLimitStore");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const {
  createBooking,
  getMyBookings,
  getMyLocations,
  getCookBookings,
  getCookRequests,
  getCookSchedule,
  getAdminBookings,
  getBookingById,
  acceptBooking,
  rejectBooking,
  completeBooking,
  cancelBooking,
  deleteBooking,
  rescheduleBooking,
  getRescheduleOptions,
  startService,
  payBooking,
  markCookArrived,
} = require("../controllers/bookingController");
const {
  getRefundEligibility,
  requestRefund,
} = require("../controllers/refundController");

router.post(
  "/",
  auth,
  authorize("customer"),
  [
    // Find-Cook flow: the customer never sends a cook. A `cook`/`cookId`
    // in the body is accepted by the validator but IGNORED by the
    // controller (the booking is always created with cook = null).
    body("cook").optional().isMongoId().withMessage("Valid cook id is required"),
    body("cookId").optional().isMongoId().withMessage("Valid cook id is required"),
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
// Broadcast request feed (must sit before /:id so "requests" isn't a param).
router.get("/cook/requests", auth, authorize("cook"), getCookRequests);
// Payment-gated schedule for the cook's Today/Tomorrow tabs (paid only).
router.get("/cook/schedule", auth, authorize("cook"), getCookSchedule);
router.get("/:id", auth, getBookingById);
router.get("/", auth, authorize("admin"), getAdminBookings);
router.patch("/:id/accept", auth, authorize("cook", "admin"), acceptBooking);
// Customer confirms payment within the 5-minute post-acceptance window.
router.patch("/:id/pay", auth, authorize("customer"), payBooking);
router.patch("/:id/reject", auth, authorize("cook", "admin"), rejectBooking);
router.patch("/:id/complete", auth, authorize("cook", "admin"), completeBooking);
router.patch("/:id/arrived", auth, authorize("cook", "admin"), markCookArrived);
// OTP start is brute-force sensitive (4 digits + 10-try lockout): own
// tighter bucket on top of the general limiter. Shared (MongoDB-backed) so
// the budget holds across replicas — see utils/rateLimitStore.js.
const otpLimiter = rateLimit({
  store: rateLimitStore("otp"),
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
// Reschedule (+ v2 cook reassignment): free slots for the picker + the move
// itself. v1 policy is customer + admin (cooks don't move bookings); the
// controller enforces ownership, the 30-minute cutoff/lead, the reschedule
// cap, cook eligibility, and the no-money-moves rule. Price, payment status
// and rescheduleCount can never be set from the request — they are absent
// from the validators below by design.
router.get(
  "/:id/reschedule-options",
  auth,
  authorize("customer", "admin"),
  [
    query("date").matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("Valid date (YYYY-MM-DD) is required"),
    query("startTime").optional().matches(/^\d{1,2}:\d{2}$/).withMessage("Valid start time (HH:MM) is required"),
  ],
  validate,
  getRescheduleOptions
);
router.patch(
  "/:id/reschedule",
  auth,
  authorize("customer", "admin"),
  [
    body("date").matches(/^\d{4}-\d{2}-\d{2}$/).withMessage("Valid date (YYYY-MM-DD) is required"),
    body("startTime").matches(/^\d{1,2}:\d{2}$/).withMessage("Valid start time (HH:MM) is required"),
    body("reason").optional().isString().withMessage("Reason must be text").isLength({ max: 200 }).withMessage("Reason must be under 200 characters"),
    body("cookId").optional().isMongoId().withMessage("Selected cook is not available for the selected time"),
  ],
  validate,
  rescheduleBooking
);
// Post-service refund requests: eligibility is computed server-side from the
// booking's own service clock — the frontend never decides, and amount /
// status / eligibility keys are never read from the request by design.
router.get("/:id/refund-eligibility", auth, getRefundEligibility);
router.post(
  "/:id/refund-request",
  auth,
  authorize("customer"),
  [
    body("reason").isString().withMessage("Please choose a refund reason").isLength({ min: 1, max: 120 }).withMessage("Please choose a refund reason"),
    body("note").optional().isString().withMessage("Note must be text").isLength({ max: 500 }).withMessage("Note must be under 500 characters"),
  ],
  validate,
  requestRefund
);

module.exports = router;
