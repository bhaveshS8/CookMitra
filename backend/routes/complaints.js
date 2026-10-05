const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const {
  createComplaint,
  getMyComplaints,
  getAllComplaints,
  updateComplaintStatus,
} = require("../controllers/complaintController");

router.post(
  "/",
  auth,
  authorize("cook", "customer"),
  [
    body("message")
      .trim()
      .isLength({ min: 10, max: 2000 })
      .withMessage("Please describe the issue (10–2000 characters)"),
    body("category")
      .optional()
      .isIn(["behaviour", "payment", "address", "no_show", "safety", "quality", "hygiene", "other"])
      .withMessage("Invalid category"),
  ],
  validate,
  createComplaint
);

router.get("/my", auth, authorize("cook", "customer"), getMyComplaints);

router.get("/", auth, authorize("admin"), getAllComplaints);

router.patch(
  "/:id/status",
  auth,
  authorize("admin"),
  [
    body("status")
      .optional()
      .isIn(["open", "in_review", "resolved", "rejected"])
      .withMessage("Invalid status"),
    body("adminNote")
      .optional()
      .isString()
      .isLength({ max: 2000 })
      .withMessage("Note must be under 2000 characters"),
  ],
  validate,
  updateComplaintStatus
);

module.exports = router;
