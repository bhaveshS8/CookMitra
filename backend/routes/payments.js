const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const { createOrder, verifyPayment, handleWebhook } = require("../controllers/paymentController");

router.post(
  "/order",
  auth,
  authorize("customer"),
  [
    body("cook").isMongoId().withMessage("Valid cook id is required"),
    body("date").isISO8601().withMessage("Valid date is required"),
    body("startTime").notEmpty().withMessage("Start time is required"),
    body("endTime").notEmpty().withMessage("End time is required"),
    body("durationHours")
      .optional()
      // Same contract as booking creation — whole-hour 1–4 sessions.
      // (createOrder recomputes hours from start/end anyway and rejects
      // mismatches, so a looser validator here only invites confusion.)
      .isInt({ min: 1, max: 4 })
      .withMessage("Sessions run 1–4 hours"),
    body("bookingId")
      .optional()
      .isMongoId()
      .withMessage("Valid booking id is required"),
  ],
  validate,
  createOrder
);

router.post(
  "/verify",
  auth,
  authorize("customer"),
  [
    body("razorpay_order_id").notEmpty().withMessage("Order id is required"),
    body("razorpay_payment_id").notEmpty().withMessage("Payment id is required"),
    body("razorpay_signature").notEmpty().withMessage("Signature is required"),
    body("bookingId").isMongoId().withMessage("Valid booking id is required"),
  ],
  validate,
  verifyPayment
);

// Razorpay event webhook — deliberately NO auth/validation middleware:
// Razorpay signs the RAW body (server.js mounts express.raw() for this path
// before express.json()) and the handler verifies the HMAC itself.
router.post("/webhook", handleWebhook);

module.exports = router;
