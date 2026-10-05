// Admin console routes for cook incentives / leads / referrals / payouts.
const express = require("express");

const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const c = require("../controllers/adminCookEarningsController");

router.get("/leads", auth, authorize("admin"), c.listAllLeads);
router.post("/leads/:id/verify", auth, authorize("admin"), c.verifyLead);
router.post(
  "/leads/:id/reject",
  auth,
  authorize("admin"),
  [body("reason").optional().isString()],
  validate,
  c.rejectLead
);
router.post("/leads/:id/duplicate", auth, authorize("admin"), c.markLeadDuplicate);

router.get("/incentives", auth, authorize("admin"), c.listIncentives);
router.post("/incentives/:id/approve", auth, authorize("admin"), c.approveIncentive);
router.post(
  "/incentives/:id/reject",
  auth,
  authorize("admin"),
  [body("reason").optional().isString()],
  validate,
  c.rejectIncentive
);
router.post("/incentives/:id/hold", auth, authorize("admin"), c.holdIncentive);

router.get("/referrals", auth, authorize("admin"), c.listReferrals);
router.post("/referrals/:id/approve", auth, authorize("admin"), c.approveReferral);

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

module.exports = router;
