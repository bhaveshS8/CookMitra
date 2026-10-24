// Regression: admin Cook Payouts tab must really pay.
//
// Defect (reproduced 2026-10-13): bookings finished by the platform's own
// legacy auto-complete path (completed + paid + hours complete, but no OTP
// trail) sat in GET /payouts/queue permanently unpayable — "Mark paid"
// disabled and PATCH /:id/settle hard-400 PAYOUT_NOT_ELIGIBLE. The money was
// owed but the tab could never release it.
//
// Fix: an audited admin override for rows blocked ONLY by attendance-proof
// gaps. Money blockers (unpaid/test/refund/settled/amounts) stay hard-blocked.
// Isolated: real route stack over HTTP, in-memory MongoDB.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = "test";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const express = require("express");
const jwt = require("jsonwebtoken");

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes++;
  else failures++;
};

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(await mongod.getUri());

  const User = require("./models/User");
  const Booking = require("./models/Booking");
  const CookProfile = require("./models/CookProfile");
  const LedgerEntry = require("./models/LedgerEntry");
  const Notification = require("./models/Notification");
  await Promise.all([User.init(), Booking.init(), CookProfile.init(), LedgerEntry.init(), Notification.init()]);

  const mkUser = async (role) => User.create({
    name: `${role} User`,
    email: `${role}-${Math.random().toString(36).slice(2, 10)}@test.local`,
    phone: `9${String(Math.floor(100000000 + Math.random() * 899999999))}`,
    password: "password123",
    role,
  });
  const cook = await mkUser("cook");
  const cust = await mkUser("customer");
  const admin = await mkUser("admin");
  await CookProfile.create({ user: cook._id });
  const tok = (u) => jwt.sign({ id: u._id.toString() }, process.env.JWT_SECRET);

  const base = {
    customer: cust._id, cook: cook._id, serviceType: "cook_for_me",
    date: new Date(), startTime: "10:00", endTime: "12:00", address: "V",
    durationHours: 2, amount: 349, commission: 52.35, cookPayout: 296.65,
    status: "completed", hoursCompleted: true,
    payment: { status: "paid", paidAmount: 349, refundStatus: "none" },
  };
  // Fully OTP-verified service.
  const otpBooking = await Booking.create({
    ...base, cookArrived: true, serviceStartedAt: new Date(),
  });
  // Legacy auto-complete shape: owed, but no attendance proof.
  const legacyBooking = await Booking.create({ ...base });
  // Money-blocked: customer refund in flight (otherwise fully verified,
  // so the refund is the SOLE blocker).
  const refundBooking = await Booking.create({
    ...base, cookArrived: true, serviceStartedAt: new Date(),
    payment: { status: "paid", paidAmount: 349, refundStatus: "pending", refundAmount: 349 },
  });

  const app = express();
  app.use(express.json());
  app.use("/api/payouts", require("./routes/payouts"));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err?.statusCode || 500).json({ message: err?.message || "error" }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, token, body) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  };

  // ── 1. Queue surfaces all three rows with the right flags ──────
  const q = await api("GET", "/api/payouts/queue?page=1&limit=25", tok(admin));
  const rows = Array.isArray(q.data) ? q.data : q.data?.data || [];
  const row = (id) => rows.find((r) => String(r._id) === String(id));
  check("queue 200 with all rows", q.status === 200 && row(otpBooking._id) && row(legacyBooking._id) && row(refundBooking._id), `s=${q.status} n=${rows.length}`);
  check("otp row eligible, no override needed", row(otpBooking._id)?.payoutEligible === true && !row(otpBooking._id)?.payoutOverrideAllowed);
  check("legacy row blocked but override-allowed", row(legacyBooking._id)?.payoutEligible === false && row(legacyBooking._id)?.payoutOverrideAllowed === true, JSON.stringify(row(legacyBooking._id)?.payoutBlockers));
  check("refund row blocked, override NOT allowed", row(refundBooking._id)?.payoutEligible === false && !row(refundBooking._id)?.payoutOverrideAllowed, JSON.stringify(row(refundBooking._id)?.payoutBlockers));

  // ── 2. Happy path still settles ─────────────────────────────────
  {
    const s = await api("PATCH", `/api/payouts/${otpBooking._id}/settle`, tok(admin), { reference: "UPI-OTP-001" });
    check("otp booking settles -> 200 settled", s.status === 200 && s.data?.payout?.status === "settled", `s=${s.status}`);
    const fresh = await Booking.findById(otpBooking._id).lean();
    check("settled amount + ref persisted", fresh.payout?.amount === 296.65 && fresh.payout?.reference === "UPI-OTP-001");
    check("ledger written once", (await LedgerEntry.countDocuments({ booking: otpBooking._id, type: "payout.settled" })) === 1);
    check("cook notified", (await Notification.countDocuments({ user: cook._id, type: "payout_settled", booking: otpBooking._id })) === 1);
    const retry = await api("PATCH", `/api/payouts/${otpBooking._id}/settle`, tok(admin), { reference: "UPI-OTP-001" });
    check("re-settle idempotent (no double pay)", retry.status === 200 && (await LedgerEntry.countDocuments({ booking: otpBooking._id, type: "payout.settled" })) === 1, `s=${retry.status}`);
  }

  // ── 3. Legacy row: blocked without override, payable with it ───
  {
    const plain = await api("PATCH", `/api/payouts/${legacyBooking._id}/settle`, tok(admin), { reference: "UPI-LEG-001" });
    check("legacy settle without override still 400", plain.status === 400 && plain.data?.code === "PAYOUT_NOT_ELIGIBLE", `s=${plain.status}`);
    const short = await api("PATCH", `/api/payouts/${legacyBooking._id}/settle`, tok(admin), { reference: "UPI-LEG-001", verificationOverride: true, overrideReason: "ok" });
    check("override with short reason -> 400", short.status === 400 && short.data?.code === "OVERRIDE_REASON_REQUIRED", `s=${short.status}`);
    const reason = "Called customer on phone; service confirmed delivered on date";
    const ov = await api("PATCH", `/api/payouts/${legacyBooking._id}/settle`, tok(admin), { reference: "UPI-LEG-001", verificationOverride: true, overrideReason: reason });
    check("legacy settle with override -> 200 settled", ov.status === 200 && ov.data?.payout?.status === "settled", `s=${ov.status}`);
    const fresh = await Booking.findById(legacyBooking._id).lean();
    const hist = (fresh.statusHistory || []).map((h) => h.note || "").join(" | ");
    check("override reason in status history", hist.includes(reason), hist.slice(-120));
    const led = await LedgerEntry.findOne({ booking: legacyBooking._id, type: "payout.settled" }).lean();
    check("override reason in ledger", (led?.reason || "").includes(reason));
  }

  // ── 4. Money blockers can never be overridden ───────────────────
  {
    const ov = await api("PATCH", `/api/payouts/${refundBooking._id}/settle`, tok(admin), {
      reference: "UPI-REF-001", verificationOverride: true,
      overrideReason: "Trying to force through a refund-blocked payout",
    });
    check("refund-blocked settle with override still 400", ov.status === 400 && /refund/i.test(ov.data?.message || ""), `s=${ov.status} ${ov.data?.message}`);
    check("refund-blocked booking untouched", (await Booking.findById(refundBooking._id).lean()).payout?.status !== "settled");
  }

  // ── 5. Reference uniqueness + auth guards ───────────────────────
  {
    const other = await Booking.create({ ...base, cookArrived: true, serviceStartedAt: new Date() });
    const dup = await api("PATCH", `/api/payouts/${other._id}/settle`, tok(admin), { reference: "UPI-OTP-001" });
    check("duplicate reference across bookings -> 409", dup.status === 409, `s=${dup.status}`);
    const anon = await api("PATCH", `/api/payouts/${other._id}/settle`, null, { reference: "UPI-NEW-1" });
    check("no token -> 401", anon.status === 401, `s=${anon.status}`);
    const cookTry = await api("PATCH", `/api/payouts/${other._id}/settle`, tok(cook), { reference: "UPI-NEW-1" });
    check("cook cannot settle -> 403", cookTry.status === 403, `s=${cookTry.status}`);
  }

  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
