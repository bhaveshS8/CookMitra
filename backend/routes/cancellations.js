const express = require("express");

const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const c = require("../controllers/cancellationController");

router.get("/", auth, authorize("admin"), c.listCancellations);
router.get("/:id", auth, authorize("admin"), c.getCancellationDetail);
router.post(
  "/:id/review",
  auth,
  authorize("admin"),
  [body("reason").optional().isString()],
  validate,
  c.reviewCancellation
);
router.post(
  "/:id/hold",
  auth,
  authorize("admin"),
  [body("reason").trim().notEmpty().withMessage("A hold reason is required")],
  validate,
  c.holdCancellation
);
router.post(
  "/:id/note",
  auth,
  authorize("admin"),
  [body("note").trim().notEmpty().withMessage("A note is required")],
  validate,
  c.addCancellationNote
);

module.exports = router;
