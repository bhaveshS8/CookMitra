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

router.post("/webhook", handleWebhook);

module.exports = router;
