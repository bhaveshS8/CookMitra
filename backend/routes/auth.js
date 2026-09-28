const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const {
  register,
  login,
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

router.post(
  "/register",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("email").isEmail().withMessage("Valid email is required"),
    // Spec §17 calls it `mobile`; legacy clients send `phone` — accept either.
    body("phone").optional().trim(),
    body("mobile").optional().trim(),
    body().custom((_, { req }) => {
      if (!req.body.phone && !req.body.mobile) throw new Error("Phone/mobile is required");
      return true;
    }),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
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
    body("email").isEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
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
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
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
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
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
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
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
