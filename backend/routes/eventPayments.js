const express = require("express");
const { auth, authorize } = require("../middleware/auth");
const controller = require("../controllers/eventPaymentController");

const router = express.Router();

router.post("/:id/order", auth, authorize("customer"), controller.createEventOrder);
router.post("/:id/verify", auth, authorize("customer", "admin"), controller.verifyEventPayment);

router.get("/admin/refunds", auth, authorize("admin"), controller.getEventRefundQueue);
router.post("/admin/refunds/:id/approve", auth, authorize("admin"), controller.approveEventRefund);
router.post("/admin/refunds/:id/reconcile", auth, authorize("admin"), controller.reconcileEventRefund);
router.post("/admin/refunds/:id/reject", auth, authorize("admin"), controller.rejectEventRefund);

module.exports = router;
