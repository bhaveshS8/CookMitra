const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const {
  register,
  login,
  logout,
  googleAuth,
  forgotPassword,
  resetPassword,
  getMe,
  updateProfile,
  getAllUsers,
  adminSetUserStatus,
  adminDeleteUser,
  adminAddCook,
  adminAddAdmin,
} = require("../controllers/authController");

// Shared validators so login + register enforce the same authentication rules.
const emailRule = body("email")
  .trim()
  .notEmpty()
  .withMessage("Email is required")
  .isEmail()
  .withMessage("Enter a valid email address")
  .normalizeEmail({ gmail_remove_dots: false });
const passwordRule = (field = "password") =>
  body(field)
    .notEmpty()
    .withMessage("Password is required")
    .isLength({ min: 8, max: 128 })
    .withMessage("Password must be 8–128 characters");
const phoneOrMobileRule = [
  body("phone").optional().trim(),
  body("mobile").optional().trim(),
  // Registration mobiles must be exactly 10 digits (Indian mobile starting
  // 6-9). An optional +91 / 91 / 0 prefix is tolerated and stripped to the
  // 10-digit core so "+91 98765 43210" still passes.
  body("phone")
    .optional()
    .custom((v) => {
      if (!v) return true;
      let digits = String(v).replace(/\D/g, "");
      if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
      else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
      if (digits.length !== 10) throw new Error("Mobile number must be exactly 10 digits");
      if (!/^[6-9]\d{9}$/.test(digits))
        throw new Error("Enter a valid 10-digit mobile number");
      return true;
    }),
  body("mobile")
    .optional()
    .custom((v) => {
      if (!v) return true;
      let digits = String(v).replace(/\D/g, "");
      if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
      else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
      if (digits.length !== 10) throw new Error("Mobile number must be exactly 10 digits");
      if (!/^[6-9]\d{9}$/.test(digits))
        throw new Error("Enter a valid 10-digit mobile number");
      return true;
    }),
  body().custom((_, { req }) => {
    if (!req.body.phone && !req.body.mobile) throw new Error("Phone/mobile is required");
    return true;
  }),
];

router.post(
  "/register",
  [
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Full name is required")
      .isLength({ min: 2, max: 80 })
      .withMessage("Name must be 2–80 characters"),
    emailRule,
    // Spec §17 calls it `mobile`; legacy clients send `phone` — accept either.
    ...phoneOrMobileRule,
    passwordRule("password"),
    body("role")
      .optional()
      .customSanitizer((v) => String(v).toUpperCase())
      .isIn(["CUSTOMER", "COOK"])
      .withMessage("Role must be CUSTOMER or COOK"),
  ],
  validate,
  register
);

router.post(
  "/login",
  [
    emailRule,
    body("password").notEmpty().withMessage("Password is required"),
    // rememberMe only controls token lifetime, never auth logic.
    body("rememberMe")
      .optional()
      .custom((v) => typeof v === "boolean" || v === "true" || v === "false")
      .withMessage("rememberMe must be true or false"),
  ],
  validate,
  login
);

// Password reset (public, throttled + enumeration-safe in-controller).
router.post(
  "/forgot-password",
  [body("email").isEmail().withMessage("Valid email is required")],
  validate,
  forgotPassword
);
router.post(
  "/reset-password",
  [
    body("token").trim().notEmpty().withMessage("Reset token is required"),
    body("password")
      .isLength({ min: 8, max: 128 })
      .withMessage("Password must be 8–128 characters"),
  ],
  validate,
  resetPassword
);

router.post(
  "/google",
  [
    body("idToken").notEmpty().withMessage("Google ID token is required"),
    body("role")
      .optional()
      .customSanitizer((v) => String(v).toUpperCase())
      .isIn(["CUSTOMER", "COOK"])
      .withMessage("Role must be CUSTOMER or COOK"),
  ],
  validate,
  googleAuth
);

router.get("/me", auth, getMe);
router.post("/logout", logout);
router.put(
  "/me",
  auth,
  [
    body("name")
      .optional()
      .trim()
      .isLength({ min: 2, max: 80 })
      .withMessage("Name must be between 2 and 80 characters"),
    body("phone")
      .optional()
      .trim()
      .notEmpty()
      .withMessage("Phone is required"),
    body("mobile")
      .optional()
      .trim()
      .notEmpty()
      .withMessage("Mobile is required"),
    body("address").optional().trim().isLength({ max: 500 }).withMessage("Address is too long"),
  ],
  validate,
  updateProfile
);
router.get("/users", auth, authorize("admin"), getAllUsers);

// Admin: create a cook account (+ approved profile) directly.
router.post(
  "/cooks",
  auth,
  authorize("admin"),
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().withMessage("Valid email is required"),
    body("phone").optional().trim(),
    body("mobile").optional().trim(),
    body().custom((_, { req }) => {
      if (!req.body.phone && !req.body.mobile) throw new Error("Phone/mobile is required");
      return true;
    }),
    body("password")
      .isLength({ min: 8, max: 128 })
      .withMessage("Password must be 8–128 characters"),
    body("rate").optional().isNumeric().withMessage("Rate must be a number"),
    body("serviceTypes").optional().isArray().withMessage("serviceTypes must be an array"),
  ],
  validate,
  adminAddCook
);

// Admin: register a new admin account (admin-gated — the public /register
// route only accepts customer/cook, so this is the sole way to add admins).
router.post(
  "/admins",
  auth,
  authorize("admin"),
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().withMessage("Valid email is required"),
    body("phone").optional().trim(),
    body("mobile").optional().trim(),
    body().custom((_, { req }) => {
      if (!req.body.phone && !req.body.mobile) throw new Error("Phone/mobile is required");
      return true;
    }),
    body("password")
      .isLength({ min: 8, max: 128 })
      .withMessage("Password must be 8–128 characters"),
  ],
  validate,
  adminAddAdmin
);

// Admin account management: block/unblock and delete customer/cook accounts.
router.patch(
  "/users/:id/status",
  auth,
  authorize("admin"),
  [
    body("status")
      .isIn(["active", "suspended"])
      .withMessage("Status must be either active or suspended"),
  ],
  validate,
  adminSetUserStatus
);
router.delete("/users/:id", auth, authorize("admin"), adminDeleteUser);

module.exports = router;
