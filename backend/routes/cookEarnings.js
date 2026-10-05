// Cook-facing earnings routes (§19). All auth + authorize("cook").
const express = require("express");

const router = express.Router();
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const c = require("../controllers/cookEarningsController");

router.get("/earnings", auth, authorize("cook"), c.getEarnings);
router.get("/payouts", auth, authorize("cook"), c.getPayouts);
router.get("/payouts/:id", auth, authorize("cook"), c.getPayoutById);
router.get("/incentives", auth, authorize("cook"), c.getIncentives);
router.get("/incentives/progress", auth, authorize("cook"), c.getIncentiveProgress);
router.post(
  "/leads",
  auth,
  authorize("cook"),
  [
    body("customerName").optional().trim(),
    body("name").optional().trim(),
    body("location").optional().trim(),
  ],
  validate,
  c.createLead
);
router.get("/leads", auth, authorize("cook"), c.listLeads);
router.get("/leads/:id", auth, authorize("cook"), c.getLead);
router.get("/referral", auth, authorize("cook"), c.getReferralInfo);
router.get("/referrals", auth, authorize("cook"), c.listReferrals);
router.post("/referral/regenerate", auth, authorize("cook"), c.regenerateReferral);

module.exports = router;
