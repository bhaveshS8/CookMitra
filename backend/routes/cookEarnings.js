const express = require("express");

const router = express.Router();
const { auth, authorize } = require("../middleware/auth");
const c = require("../controllers/cookEarningsController");

router.get("/earnings", auth, authorize("cook"), c.getEarnings);
router.get("/payouts", auth, authorize("cook"), c.getPayouts);
router.get("/payouts/:id", auth, authorize("cook"), c.getPayoutById);

module.exports = router;
