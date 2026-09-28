const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const {
  getAvailability,
  searchAvailability,
  getMySlots,
  setAvailability,
  removeAvailability,
} = require("../controllers/availabilityController");

router.get("/my", auth, authorize("cook"), getMySlots);
// Batched search MUST sit above "/:cookId" or "search" parses as a cook id.
router.get("/search", searchAvailability);
router.get("/:cookId", getAvailability);

router.post(
  "/",
  auth,
  authorize("cook"),
  [
    body("date").isISO8601().withMessage("Valid date is required"),
    body("startTime").notEmpty().withMessage("Start time is required"),
    body("endTime").notEmpty().withMessage("End time is required"),
  ],
  validate,
  setAvailability
);

router.delete("/:id", auth, authorize("cook"), removeAvailability);

module.exports = router;
