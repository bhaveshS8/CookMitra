const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize, optionalAuth } = require("../middleware/auth");
const {
  listEventTypes,
  createEventType,
  updateEventType,
  deleteEventType,
} = require("../controllers/eventController");

// Public catalogue for the booking flow (guests can browse events).
router.get("/", optionalAuth, listEventTypes);
router.post(
  "/",
  auth,
  authorize("admin"),
  [body("name").trim().notEmpty().withMessage("Event name is required")],
  validate,
  createEventType
);
router.put("/:id", auth, authorize("admin"), updateEventType);
router.delete("/:id", auth, authorize("admin"), deleteEventType);

module.exports = router;
