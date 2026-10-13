const express = require("express");
const router = express.Router();
const { param } = require("express-validator");
const validate = require("../middleware/validate");
const { auth } = require("../middleware/auth");
const {
  getNotifications,
  markAsRead,
  markAllAsRead,
} = require("../controllers/notificationController");

router.get("/", auth, getNotifications);
router.patch(
  "/:id/read",
  auth,
  param("id").isMongoId().withMessage("Invalid notification id"),
  validate,
  markAsRead
);
router.patch("/read-all", auth, markAllAsRead);

module.exports = router;
