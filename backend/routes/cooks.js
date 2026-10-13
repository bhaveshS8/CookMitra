const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize, optionalAuth } = require("../middleware/auth");
const { cookDocUpload, validateUploadedContent } = require("../middleware/upload");
const {
  getCooks,
  getCook,
  getCookAdminOverview,
  getMyProfile,
  createCookProfile,
  updateCookProfile,
  updateApprovalStatus,
  getAvailableSlots,
  uploadCookDocs,
  adminUploadCookDocs,
  toggleAvailability,
} = require("../controllers/cookController");

const uploadErrorMessage = (err) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return "File too large — each file must be 2MB or less (JPG/PNG/WEBP/PDF)";
  }
  return err?.message || "File upload failed";
};

// Mobile number accepted through the cook profile form (create + edit).
// Normalized to a 10-digit Indian mobile (allows +91 / leading 0 input).
const mobileNumberRule = (field) =>
  body(field)
    .optional()
    .trim()
    .custom((v) => {
      if (v === "" || v == null) return true; // absent/empty = no change (controller ignores)
      let digits = String(v).replace(/\D/g, "");
      if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
      else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
      if (digits.length !== 10) throw new Error("Mobile number must be exactly 10 digits");
      if (!/^[6-9]\d{9}$/.test(digits))
        throw new Error("Enter a valid 10-digit mobile number");
      return true;
    });
const cookMobileRules = [
  mobileNumberRule("mobileNumber"),
  mobileNumberRule("mobile"),
  mobileNumberRule("phone"),
];

router.get("/", optionalAuth, getCooks);
router.get("/me", auth, authorize("cook"), getMyProfile);
router.post(
  "/upload-docs",
  auth,
  authorize("cook"),
  (req, res, next) => {
    cookDocUpload.fields([
      { name: "aadhar", maxCount: 1 },
      { name: "pan", maxCount: 1 },
      { name: "photo", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: uploadErrorMessage(err) });
      }
      next();
    });
  },
  validateUploadedContent,
  uploadCookDocs
);
router.get("/admin-overview/:id", auth, authorize("admin"), getCookAdminOverview);
router.post(
  "/:id/upload-docs",
  auth,
  authorize("admin"),
  (req, res, next) => {
    cookDocUpload.fields([
      { name: "aadhar", maxCount: 1 },
      { name: "pan", maxCount: 1 },
      { name: "photo", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: uploadErrorMessage(err) });
      }
      next();
    });
  },
  validateUploadedContent,
  adminUploadCookDocs
);
router.get("/:id", getCook);

router.post(
  "/",
  auth,
  authorize("cook"),
  [
    body("bio").optional().trim(),
    body("skills").optional().trim(),
    body("rate").optional().isNumeric().withMessage("Rate must be a number"),
    body("serviceTypes")
      .isArray({ min: 1 })
      .withMessage("At least one service type is required"),
    ...cookMobileRules,
  ],
  validate,
  createCookProfile
);

router.put("/:id", auth, authorize("cook"), [...cookMobileRules], validate, updateCookProfile);
router.patch(
  "/:id/approval",
  auth,
  authorize("admin"),
  [
    body("status")
      .isIn(["approved", "rejected"])
      .withMessage("Status must be approved or rejected"),
  ],
  validate,
  updateApprovalStatus
);

router.patch(
  "/me/availability",
  auth,
  authorize("cook"),
  [
    body("status")
      .isIn(["available", "unavailable"])
      .withMessage("Status must be available or unavailable"),
  ],
  validate,
  toggleAvailability
);

router.get("/:id/availability", getAvailableSlots);

module.exports = router;
