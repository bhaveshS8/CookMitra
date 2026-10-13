const express = require("express");

const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const c = require("../controllers/adminCookEarningsController");

// Weekly payout cycles only. Lead, incentive, and referral programs were
// removed in full (models, handlers, and UI deleted); the old
// /api/admin/cook-incentives mount is gone — everything lives here.
router.get("/payouts", auth, authorize("admin"), c.listCookPayouts);
router.post("/payouts/build", auth, authorize("admin"), c.buildCookPayout);
router.post("/payouts/:id/approve", auth, authorize("admin"), c.approveCookPayout);
router.post(
  "/payouts/:id/pay",
  auth,
  authorize("admin"),
  [body("reference").optional().isString()],
  validate,
  c.payCookPayout
);
router.post("/payouts/:id/hold", auth, authorize("admin"), c.holdCookPayout);
router.post(
  "/payouts/:id/reference",
  auth,
  authorize("admin"),
  [body("reference").optional().isString(), body("paymentReference").optional().isString()],
  validate,
  c.recordPayoutReference
);
router.post("/payouts/:id/sync-bookings", auth, authorize("admin"), c.syncCycleBookings);

module.exports = router;
