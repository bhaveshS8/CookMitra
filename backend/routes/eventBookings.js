const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const {
  createEventBooking,
  getMyEventBookings,
  getCookEventBookings,
  getAdminEventBookings,
  getEventBookingById,
  assignCook,
  updateEventBookingStatus,
  cancelEventBooking,
  getEventStats,
} = require("../controllers/eventBookingController");

// Customer creates a booking request (no cook selection — §20 rule 1).
router.post(
  "/",
  auth,
  authorize("customer"),
  [
    body("eventType").trim().notEmpty().withMessage("Event type is required"),
    body("eventDate").notEmpty().withMessage("Event date is required"),
    body("startTime").notEmpty().withMessage("Start time is required"),
    body("duration")
      .isFloat({ min: 1, max: 8 })
      .withMessage("Duration must be between 1 and 8 hours"),
    body("guestCount")
      .isInt({ min: 1, max: 1000 })
      .withMessage("Guest count must be between 1 and 1000"),
    body("address").trim().notEmpty().withMessage("Address is required"),
    body("menu").trim().notEmpty().withMessage("Menu requirement is required"),
    body("serviceType")
      .isIn(["cooking_only", "preparation_cooking", "cooking_serving"])
      .withMessage("Valid service type is required"),
    body("additionalCook")
      .optional()
      .isInt({ min: 0, max: 10 })
      .withMessage("Additional cooks must be between 0 and 10"),
    body("extraHours")
      .optional()
      .isFloat({ min: 0, max: 12 })
      .withMessage("Extra hours must be between 0 and 12"),
    body("distanceKm")
      .optional()
      .isFloat({ min: 0 })
      .withMessage("Distance must be a non-negative number"),
  ],
  validate,
  createEventBooking
);

router.get("/my", auth, authorize("customer"), getMyEventBookings);
router.get("/cook", auth, authorize("cook"), getCookEventBookings);
router.get("/stats", auth, authorize("admin"), getEventStats);
router.get("/", auth, authorize("admin"), getAdminEventBookings);
router.get("/:id", auth, getEventBookingById);
// Admin assigns a verified cook (§11).
router.post(
  "/:id/assign-cook",
  auth,
  authorize("admin"),
  [body("cookId").isMongoId().withMessage("Valid cook id is required")],
  validate,
  assignCook
);
// Admin moves the booking through the §15 lifecycle.
router.patch(
  "/:id/status",
  auth,
  authorize("admin"),
  [body("status")
    .isIn(["cook_assigned", "confirmed", "in_progress", "completed", "cancelled"])
    .withMessage("Valid status is required")],
  validate,
  updateEventBookingStatus
);
// Customer (own) or admin cancels.
router.post("/:id/cancel", auth, cancelEventBooking);

module.exports = router;
