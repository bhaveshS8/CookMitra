// Cross-rail payout guards: the weekly-cycle rail (CookPayout + payoutInfo)
// and the legacy per-booking rail (Booking.payout) must never pay the same
// booking twice, and refunds must not bypass clawback after a weekly pay.
//
// Hermetic: models stubbed in-memory. No DB, no network, no real sends.
// Run: node backend/payout-weekly-guards.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = "test";

const Booking = require("./models/Booking");
const CookPayout = require("./models/CookPayout");
const CookProfile = require("./models/CookProfile");
const Notification = require("./models/Notification");
const { payoutEligibility, refundApprovalCheck } = require("./utils/finance");
const payoutCtrl = require("./controllers/payoutController");

let passes = 0;
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes++;
  else failures++;
};
const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
};
const next = (err) => { if (err) throw err || new Error("next()"); };

const base = (over = {}) => ({
  _id: "b1",
  customer: "cust1",
  cook: "cook1",
  status: "completed",
  hoursCompleted: true,
  serviceStartedAt: new Date(),
  cookArrived: true,
  amount: 349,
  cookPayout: 296.65,
  commission: 52.35,
  payment: { status: "paid", paidAmount: 349, testMode: false, refundStatus: "none" },
  payout: { status: "pending" },
  statusHistory: [],
  ...over,
});

async function main() {
  // ── 1. Eligibility ──
  check("legacy booking without payoutInfo stays eligible", payoutEligibility(base()).eligible === true);
  check(
    "weekly-paid booking ineligible on legacy rail",
    (() => { const r = payoutEligibility(base({ payoutInfo: { payoutStatus: "paid", payoutCycleRef: "CP-X" } })); return r.eligible === false && /weekly payout/.test(r.reasons[0]); })()
  );
  check(
    "cycle-claimed booking ineligible on legacy rail",
    (() => { const r = payoutEligibility(base({ payoutInfo: { payoutStatus: "pending_weekly", payoutCycleRef: "CP-X" } })); return r.eligible === false && /weekly/.test(r.reasons.join(" ")); })()
  );
  check(
    "eligible payoutInfo does not block",
    payoutEligibility(base({ payoutInfo: { payoutStatus: "eligible" } })).eligible === true
  );

  // ── 2. Refund gate ──
  const refundCase = (over = {}) => base({
    status: "cancelled",
    hoursCompleted: false,
    serviceStartedAt: null,
    cookArrived: false,
    payment: { status: "paid", paidAmount: 349, testMode: false, refundStatus: "pending", refundAmount: 349 },
    ...over,
  });
  check(
    "weekly-paid refund needs clawback",
    refundApprovalCheck(refundCase({ payoutInfo: { payoutStatus: "paid", payoutCycleRef: "CP-X" } }), { clawback: false }).ok === false
  );
  check(
    "weekly-paid refund allowed with clawback",
    refundApprovalCheck(refundCase({ payoutInfo: { payoutStatus: "paid", payoutCycleRef: "CP-X" } }), { clawback: true }).ok === true
  );
  check(
    "unclaimed refund unaffected",
    refundApprovalCheck(refundCase(), { clawback: false }).ok === true
  );

  // ── 3. settlePayout endpoint guards (stubbed persistence) ──
  const store = new Map();
  const savedFindById = Booking.findById;
  const savedFindOne = Booking.findOne;
  const savedFindOneAndUpdate = Booking.findOneAndUpdate;
  const savedProfile = CookProfile.findOne;
  const savedNotif = Notification.create;
  let updateCalls = 0;
  try {
    Booking.findById = async (id) => store.get(String(id)) || null;
    Booking.findOne = () => ({ select: async () => null });
    Booking.findOneAndUpdate = async () => { updateCalls++; return null; };
    CookProfile.findOne = () => ({ select: () => ({ lean: async () => null }) });
    Notification.create = async () => ({});
    const admin = { id: "admin1" };

    store.set("paid", base({ _id: "paid", payoutInfo: { payoutStatus: "paid", payoutCycleRef: "CP-X" } }));
    let r = makeRes();
    await payoutCtrl.settlePayout({ params: { id: "paid" }, user: admin, body: { reference: "UPI-GUARD-01" } }, r, next);
    check("legacy settle of weekly-paid -> 409, no write", r.statusCode === 409 && updateCalls === 0, `s=${r.statusCode}`);

    store.set("claimed", base({ _id: "claimed", payoutInfo: { payoutStatus: "approved", payoutCycleRef: "CP-Y" } }));
    r = makeRes();
    await payoutCtrl.settlePayout({ params: { id: "claimed" }, user: admin, body: { reference: "UPI-GUARD-02" } }, r, next);
    check("legacy settle of cycle-claimed -> 409, no write", r.statusCode === 409 && updateCalls === 0, `s=${r.statusCode}`);
  } finally {
    Booking.findById = savedFindById;
    Booking.findOne = savedFindOne;
    Booking.findOneAndUpdate = savedFindOneAndUpdate;
    CookProfile.findOne = savedProfile;
    Notification.create = savedNotif;
  }

  // ── 4. Legacy paid-cycle display fallback (paid + settledAmount 0 reads fully paid) ──
  const { round2 } = require("./utils/cookEarnings");
  const serializeSettled = (c) => {
    const totalPayable = round2(c.totalPayable ?? 0);
    return round2(c.settledAmount || (c.status === "paid" ? totalPayable : 0));
  };
  check("paid cycle with settledAmount 0 reads fully paid", serializeSettled({ status: "paid", totalPayable: 593.3, settledAmount: 0 }) === 593.3);
  check("pending cycle with settledAmount 0 reads 0", serializeSettled({ status: "pending", totalPayable: 593.3, settledAmount: 0 }) === 0);

  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
