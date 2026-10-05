
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
  getEligibleCooksForBooking,
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
  getCancellationPreview,
  markNoShow,
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
    body("cook").optional().isMongoId().withMessage("Valid cook id is required"),
    body("cookId").optional().isMongoId().withMessage("Valid cook id is required"),
    body("serviceType")
      .isIn(["cook_for_me", "cook_with_me", "teach_me", "preparation_help"])
      .withMessage("Valid service type is required"),
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
  ],
  validate,
  createBooking
);

router.get("/my", auth, authorize("customer"), getMyBookings);
router.get("/my/locations", auth, authorize("customer"), getMyLocations);
router.get("/cook", auth, authorize("cook"), getCookBookings);
router.get("/cook/requests", auth, authorize("cook"), getCookRequests);
router.get("/cook/schedule", auth, authorize("cook"), getCookSchedule);
router.get("/:id/eligible-cooks", auth, authorize("admin", "cook"), getEligibleCooksForBooking);
router.get("/:id", auth, getBookingById);
router.get("/", auth, authorize("admin"), getAdminBookings);
router.patch("/:id/accept", auth, authorize("cook", "admin"), acceptBooking);
router.patch("/:id/pay", auth, authorize("customer"), payBooking);
router.patch("/:id/reject", auth, authorize("cook", "admin"), rejectBooking);
router.patch("/:id/complete", auth, authorize("cook", "admin"), completeBooking);
router.patch("/:id/arrived", auth, authorize("cook", "admin"), markCookArrived);
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
router.get("/:id/cancellation-preview", auth, getCancellationPreview);
router.post(
  "/:id/no-show",
  auth,
  authorize("cook", "admin"),
  [body("reason").trim().notEmpty().withMessage("Please describe what happened at the venue.")],
  validate,
  markNoShow
);
router.delete("/:id", auth, authorize("customer"), deleteBooking);
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
