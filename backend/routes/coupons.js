const express = require("express");
const router = express.Router();
const { body, param } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const {
  validateCoupon,
  listActiveCoupons,
  listCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
} = require("../controllers/couponController");

// Phase 11: coupon routes previously had zero route-level validation —
// malformed admin bodies reached Mongoose as 500s and typeless preview input
// flowed into discount math. Schemas below mirror the Coupon model.
const SERVICE_TYPES = ["cook_for_me", "cook_with_me", "teach_me", "preparation_help"];
const codeRule = (field = "code", optional = false) => {
  let r = body(field);
  r = optional ? r.optional() : r;
  return r
    .isString()
    .withMessage("Coupon code must be text")
    .trim()
    .isLength({ min: 3, max: 24 })
    .withMessage("Coupon code must be 3–24 characters")
    .matches(/^[A-Za-z0-9]+$/)
    .withMessage("Coupon code may only contain letters and numbers");
};
// NOTE: .optional() must lead each chain — trailed after validators it does
// NOT skip missing fields (every absent optional field 400s). Verified live.
// All body fields are optional-style (only `code` is required on create):
// flat vs percent coupons need different subsets, enforced by
// createTypeCheck below — not by marking every field required.
const couponBodyRules = () => {
  const O = (field) => body(field).optional();
  return [
    O("description")
      .isString()
      .withMessage("Description must be text")
      .trim()
      .isLength({ max: 500 })
      .withMessage("Description must be under 500 characters"),
    O("discountType").isIn(["flat", "percent"]).withMessage("discountType must be flat or percent"),
    O("percent").isInt({ min: 1, max: 100 }).withMessage("percent must be 1–100"),
    O("flatAmount").isFloat({ min: 1 }).withMessage("flatAmount must be at least ₹1"),
    O("maxDiscount").isFloat({ min: 1 }).withMessage("maxDiscount must be at least ₹1"),
    O("minOrder").isFloat({ min: 0 }).withMessage("minOrder cannot be negative"),
    O("usageLimit").isInt({ min: 1 }).withMessage("usageLimit must be at least 1"),
    O("perUserLimit").isInt({ min: 1 }).withMessage("perUserLimit must be at least 1"),
    O("firstBookingOnly").isBoolean().withMessage("firstBookingOnly must be true or false"),
    O("active").isBoolean().withMessage("active must be true or false"),
    O("applicableServices")
      .isArray()
      .withMessage("applicableServices must be an array")
      .custom((arr) => (arr || []).every((s) => SERVICE_TYPES.includes(String(s))))
      .withMessage("applicableServices holds unknown service types"),
    O("validFrom").isISO8601().withMessage("validFrom must be a date"),
    O("validTo").isISO8601().withMessage("validTo must be a date"),
  ];
};
const idRule = param("id").isMongoId().withMessage("Invalid id");
// Create-time cross-field rule: flat coupons need flatAmount, percent
// coupons (the default) need percent. Type-level checks above still apply.
const createTypeCheck = body().custom((_, { req }) => {
  const t = req.body?.discountType || "percent";
  if (t === "flat" && req.body?.flatAmount == null) {
    throw new Error("flatAmount is required for flat coupons");
  }
  if (t === "percent" && req.body?.percent == null) {
    throw new Error("percent is required for percent coupons");
  }
  return true;
});

// Public — promo codes are meant to be shared. The homepage billboard renders
// whatever comes back here, so admin-created offers go live immediately.
router.get("/active", listActiveCoupons);

// Customer — preview a coupon against a live order amount (never mutates usage).
router.post(
  "/validate",
  auth,
  authorize("customer"),
  [
    codeRule("code"),
    body("amount").isFloat({ min: 0 }).withMessage("amount must be a non-negative number"),
    body("serviceType").optional().isIn(SERVICE_TYPES).withMessage("Unknown service type"),
  ],
  validate,
  validateCoupon
);

// Admin — full management (list / create / edit / delete).
router.get("/", auth, authorize("admin"), listCoupons);
router.post("/", auth, authorize("admin"), [codeRule("code"), ...couponBodyRules(), createTypeCheck], validate, createCoupon);
router.patch("/:id", auth, authorize("admin"), [idRule, codeRule("code", true), ...couponBodyRules()], validate, updateCoupon);
router.delete("/:id", auth, authorize("admin"), idRule, validate, deleteCoupon);

module.exports = router;