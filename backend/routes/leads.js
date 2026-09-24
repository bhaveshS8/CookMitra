const express = require("express");
const router = express.Router();
const { body } = require("express-validator");
const rateLimit = require("express-rate-limit");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const {
  createLead,
  getLeads,
  updateLeadStatus,
  deleteLead,
} = require("../controllers/leadController");

// Public PII intake (S-09): own tight bucket so one IP cannot spam the lead
// store with rotating numbers. Genuine users submit once; 20/15min is ample.
const leadLimiter = rateLimit({
  standardHeaders: false,
  legacyHeaders: false,
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_LEADS || 20),
  message: { message: "Too many requests — please try again later." },
});

router.post(
  "/",
  leadLimiter,
  [
    body("name")
      .trim()
      .notEmpty()
      .withMessage("Name is required")
      .isLength({ min: 2, max: 80 })
      .withMessage("Name must be between 2 and 80 characters")
      .matches(/^[a-zA-Z\s.'-]+$/)
      .withMessage("Name can only contain letters, spaces and . ' -"),
    body("whatsapp").trim().notEmpty().withMessage("WhatsApp number is required"),
    body("location")
      .trim()
      .notEmpty()
      .withMessage("Location is required")
      .isLength({ min: 2, max: 120 })
      .withMessage("Location must be between 2 and 120 characters"),
    body("coords.lat")
      .optional()
      .isFloat({ min: -90, max: 90 })
      .withMessage("Invalid latitude"),
    body("coords.lng")
      .optional()
      .isFloat({ min: -180, max: 180 })
      .withMessage("Invalid longitude"),
  ],
  validate,
  createLead
);

router.get("/", auth, authorize("admin"), getLeads);
router.patch(
  "/:id",
  auth,
  authorize("admin"),
  [body("status").isIn(["new", "contacted", "converted", "closed"])],
  validate,
  updateLeadStatus
);
router.delete("/:id", auth, authorize("admin"), deleteLead);

module.exports = router;
