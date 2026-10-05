const express = require("express");

const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const {
  getPayoutQueue,
  getPayoutHistory,
  settlePayout,
  rejectPayout,
  getPayoutStatement,
  markRefundSettled,
  approveRefund,
  rejectRefund,
  getRefundQueue,
  getLedgerSummary,
  reconcileMissingPayoutLedger,
  reconcileRefund,
} = require("../controllers/payoutController");

router.get("/statement/me", auth, authorize("cook"), getPayoutStatement);
router.get("/statement/:cookId", auth, authorize("admin"), getPayoutStatement);

router.get("/queue", auth, authorize("admin"), getPayoutQueue);
router.get("/history", auth, authorize("admin"), getPayoutHistory);
router.get("/refunds", auth, authorize("admin"), getRefundQueue);
router.get("/ledger/summary", auth, authorize("admin"), getLedgerSummary);
router.post("/ledger/reconcile", auth, authorize("admin"), reconcileMissingPayoutLedger);
router.post("/refunds/:id/reconcile", auth, authorize("admin"), reconcileRefund);
router.patch(
  "/:id/settle",
  auth,
  authorize("admin"),
  [body("reference").trim().notEmpty().withMessage("A payment reference is required")],
  validate,
  settlePayout
);
router.patch(
  "/refunds/:id/settle",
  auth,
  authorize("admin"),
  [body("reference").trim().notEmpty().withMessage("A transfer reference is required")],
  validate,
  markRefundSettled
);
router.patch("/refunds/:id/approve", auth, authorize("admin"), approveRefund);
router.patch(
  "/refunds/:id/reject",
  auth,
  authorize("admin"),
  [body("reason").optional().isString().withMessage("Reason must be text")],
  validate,
  rejectRefund
);
router.patch(
  "/:id/reject",
  auth,
  authorize("admin"),
  [body("reason").optional().isString().withMessage("Reason must be text")],
  validate,
  rejectPayout
);

module.exports = router;
