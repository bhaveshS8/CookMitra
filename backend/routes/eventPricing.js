const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize, optionalAuth } = require("../middleware/auth");
const {
  getPricing,
  calculateQuote,
  updatePricing,
} = require("../controllers/eventPricingController");

// Public price table (booking flow preview — server recomputes on booking).
router.get("/", optionalAuth, getPricing);
router.post(
  "/calculate",
  optionalAuth,
  [
    body("serviceType")
      .isIn(["cooking_only", "preparation_cooking", "cooking_serving"])
      .withMessage("Valid service type is required"),
    body("duration")
      .isFloat({ min: 1, max: 8 })
      .withMessage("Duration must be between 1 and 8 hours"),
  ],
  validate,
  calculateQuote
);
// Admin pricing management (§16).
router.put("/", auth, authorize("admin"), updatePricing);

module.exports = router;
