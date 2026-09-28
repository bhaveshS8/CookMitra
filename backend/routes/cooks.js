const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize, optionalAuth } = require("../middleware/auth");
const { cookDocUpload } = require("../middleware/upload");
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

router.get("/", optionalAuth, getCooks);
router.get("/me", auth, authorize("cook"), getMyProfile);
// Cook ID verification file uploads (Aadhaar / PAN / photo).
// Must be declared before "/:id" routes so "upload-docs" isn't treated as an id.
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
        return res.status(400).json({ message: err.message || "File upload failed" });
      }
      next();
    });
  },
  uploadCookDocs
);
router.get("/admin-overview/:id", auth, authorize("admin"), getCookAdminOverview);
// Admin uploads verification docs on behalf of a cook (e.g. files received
// over email/WhatsApp). Declared above "/:id" like the self-upload route.
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
        return res.status(400).json({ message: err.message || "File upload failed" });
      }
      next();
    });
  },
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
  ],
  validate,
  createCookProfile
);

router.put("/:id", auth, authorize("cook"), updateCookProfile);
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

// Cook on/off switch — toggle between available / unavailable.
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
