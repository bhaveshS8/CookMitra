// finance-audit.test.js — financial integrity regression suite (no DB).
// Run:  node backend/finance-audit.test.js  — exits non-zero on failure.
//
// Covers the money-movement hardening: centralized payout eligibility,
// refund/payout double-spend gates, atomic refund claims, payout reference
// uniqueness + format, recipient snapshots, payout-details validation,
// order reuse, webhook event dedup, ledger idempotency. Follows the repo's
// stubbed-controller convention (cf. payment-adversarial.test.js).

// Gateway env BEFORE requires (config snapshots at load).
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.RAZORPAY_KEY_ID = "rk_test_abcdef123456";
process.env.RAZORPAY_KEY_SECRET = "s3cr3tK3yV4lu3AbCdEfGh";
process.env.RAZORPAY_CURRENCY = "INR";
process.env.RAZORPAY_WEBHOOK_SECRET = "wh_test_secret_abc123";

const crypto = require("crypto");
const Booking = require("./models/Booking");
const CookProfile = require("./models/CookProfile");
const User = require("./models/User");
const Notification = require("./models/Notification");
const LedgerEntry = require("./models/LedgerEntry");
const payoutCtrl = require("./controllers/payoutController");
const paymentCtrl = require("./controllers/paymentController");
const cookCtrl = require("./controllers/cookController");
const rzCfg = require("./config/razorpay");
const {
  payoutEligibility,
  refundApprovalCheck,
  maxRefundable,
  refundedTotal,
  isValidPayoutReference,
  validatePayoutDetails,
  recordLedger,
} = require("./utils/finance");

let failures = 0, passes = 0;
const check = (n, ok, d) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`);
  ok ? passes++ : failures++;
};
const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
};
const next = (err) => { if (err) throw err || new Error("next()"); };

// ── shared fakes ────────────────────────────────────────────────────────────
let notifLog = [];
Notification.create = async (d) => { notifLog.push(d); return d; };
User.findById = () => ({ select: async () => ({ name: "T", phone: "9000000001" }) });

const eligibleBooking = (over = {}) => ({
  _id: "b1",
  customer: "cust1",
  cook: "cook1",
  status: "completed",
  hoursCompleted: true,
  serviceStartedAt: new Date(Date.now() - 3 * 3600 * 1000),
  cookArrived: true,
  cookArrivedAt: new Date(Date.now() - 3 * 3600 * 1000),
  amount: 349,
  cookPayout: 262,
  commission: 87,
  payment: { status: "paid", paidAmount: 349, testMode: false, refundStatus: "none" },
  payout: { status: "pending" },
  statusHistory: [],
  ...over,
  save: async function () { return this; },
  toObject: function () { const { save, toObject, ...rest } = this; return { ...rest }; },
});

(async () => {
  console.log("═══ payout eligibility ═══");
  {
    const { eligible } = payoutEligibility(eligibleBooking());
    check("fully rendered service eligible", eligible === true);
    const cases = [
      ["unpaid", { payment: { status: "pending" } }],
      ["test mode", { payment: { status: "paid", testMode: true, refundStatus: "none" } }],
      ["zero amount", { amount: 0, cookPayout: 0 }],
      ["cancelled", { status: "cancelled" }],
      ["unstarted service", { serviceStartedAt: null }],
      ["no arrival", { cookArrived: false }],
      ["already settled", { payout: { status: "settled" } }],
      ["live refund", { payment: { status: "paid", refundStatus: "pending" } }],
      ["hours incomplete", { hoursCompleted: false }],
    ];
    for (const [label, over] of cases) {
      const r = payoutEligibility(eligibleBooking(over));
      check(`ineligible: ${label}`, r.eligible === false && r.reasons.length > 0, r.reasons[0] || "");
    }
    const r = payoutEligibility(eligibleBooking({ payment: { status: "paid", refundStatus: "rejected" } }));
    check("rejected refund does not block", r.eligible === true);
  }

  console.log("\n═══ refund approval gate ═══");
  {
    const q = (over = {}) => eligibleBooking({
      status: "cancelled",
      hoursCompleted: false,
      serviceStartedAt: null,
      cookArrived: false,
      payment: { status: "paid", paidAmount: 349, refundStatus: "pending", refundAmount: 349 },
      payout: { status: "pending" },
      ...over,
    });
    const ok = refundApprovalCheck(q());
    check("queued refund approvable at capped amount", ok.ok === true && ok.amount === 349, JSON.stringify(ok));
    // Settled payout without clawback → blocked (same money twice).
    const settled = q({ payout: { status: "settled" } });
    const blocked = refundApprovalCheck(settled);
    check("settled payout blocks refund w/o clawback", blocked.ok === false, blocked.reasons[0] || "");
    const forced = refundApprovalCheck(settled, { clawback: true });
    check("explicit clawback re-opens with note path", forced.ok === true, JSON.stringify(forced));
    // Cap: requested above captured → blocked.
    const over = q({ payment: { status: "paid", paidAmount: 349, refundStatus: "pending", refundAmount: 999 } });
    check("refund above captured capped/blocked", refundApprovalCheck(over).ok === false, "");
    check("refundedTotal counts processed only",
      refundedTotal({ payment: { refundStatus: "processed", refundAmount: 349 } }) === 349 &&
      refundedTotal({ payment: { refundStatus: "pending", refundAmount: 349 } }) === 0);
    check("maxRefundable subtracts prior returns",
      maxRefundable({ payment: { paidAmount: 349 }, amount: 349 }) === 349);
  }

  console.log("\n═══ payout references ═══");
  {
    check("valid UPI txn id accepted", isValidPayoutReference("919876543210") === true);
    check("valid bank ref accepted", isValidPayoutReference("UTR/2026/AB12-99") === true);
    check("short/blank rejected", isValidPayoutReference("ab") === false && isValidPayoutReference("   ") === false);
  }

  console.log("\n═══ payout-details validation ═══");
  {
    const upi = validatePayoutDetails({ method: "upi", upiId: "cook@okhdfc" });
    check("valid UPI passes", upi.ok === true, JSON.stringify(upi.reasons));
    check("bad UPI rejected", validatePayoutDetails({ method: "upi", upiId: "not-an-id" }).ok === false);
    const bank = validatePayoutDetails({ method: "bank", holderName: "Ravi", bankName: "HDFC", accountLast4: "1234", ifsc: "hdfc0001234" });
    check("valid bank passes + IFSC normalized", bank.ok === true && bank.normalized.ifsc === "HDFC0001234", bank.normalized.ifsc);
    check("bad IFSC rejected", validatePayoutDetails({ method: "bank", holderName: "R", bankName: "B", accountLast4: "1234", ifsc: "NOPE" }).ok === false);
    check("unknown keys stripped", !("evil" in validatePayoutDetails({ method: "upi", upiId: "a@b", evil: 1 }).normalized));
  }

  console.log("\n═══ settlePayout guards ═══");
  {
    const savedFindById = Booking.findById;
    const savedFindOne = Booking.findOne;
    const savedClaim = Booking.findOneAndUpdate;
    const savedLedger = LedgerEntry.create;
    const ledgerRows = [];
    LedgerEntry.create = async (e) => { ledgerRows.push(e); return e; };
    try {
      // Duplicate reference → 409, no state change.
      const doc = eligibleBooking();
      Booking.findById = async () => doc;
      Booking.findOne = () => ({ select: async () => ({ _id: "other" }) });
      let r = makeRes();
      await payoutCtrl.settlePayout({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "DUPREF123456" } }, r, next);
      check("duplicate reference → 409", r.statusCode === 409 && doc.payout.status === "pending", `s=${r.statusCode}`);
      // Live refund → 400 with reasons.
      const doc2 = eligibleBooking({ payment: { status: "paid", refundStatus: "pending" } });
      Booking.findById = async () => doc2;
      Booking.findOne = () => ({ select: async () => null });
      r = makeRes();
      await payoutCtrl.settlePayout({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "UNIQUE987654" } }, r, next);
      check("refund-pending blocks settlement", r.statusCode === 400 && /refund/i.test(r.body?.message || ""), `s=${r.statusCode}`);
      // Bad reference format → 400.
      Booking.findById = async () => eligibleBooking();
      r = makeRes();
      await payoutCtrl.settlePayout({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "x" } }, r, next);
      check("malformed reference → 400", r.statusCode === 400, `s=${r.statusCode}`);
      // Happy path: atomic claim + snapshot + settler + ledger.
      const doc3 = eligibleBooking();
      const CookProfile = require("./models/CookProfile");
      const savedProfile = CookProfile.findOne;
      CookProfile.findOne = () => ({ select: () => ({ lean: async () => ({ payoutDetails: { method: "upi", upiId: "cook@okhdfc", holderName: "C", bankName: "", accountLast4: "", ifsc: "" } }) }) });
      Booking.findById = async () => doc3;
      Booking.findOne = () => ({ select: async () => null });
      Booking.findOneAndUpdate = async (filter, update) => {
        if (filter._id !== doc3._id || doc3.payout.status !== "pending") return null;
        Object.assign(doc3.payout, update.$set["payout.status"] !== undefined ? {
          status: update.$set["payout.status"],
          settledAt: update.$set["payout.settledAt"],
          reference: update.$set["payout.reference"],
          amount: update.$set["payout.amount"],
          recipient: update.$set["payout.recipient"],
          settledBy: update.$set["payout.settledBy"],
        } : {});
        doc3.statusHistory.push(update.$push.statusHistory);
        return doc3;
      };
      r = makeRes();
      await payoutCtrl.settlePayout({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "UTR2026000111" } }, r, next);
      check("eligible settle → 200 settled", r.statusCode === 200 && doc3.payout.status === "settled", `s=${r.statusCode}`);
      check("recipient snapshot frozen", doc3.payout.recipient?.upiId === "cook@okhdfc", JSON.stringify(doc3.payout.recipient));
      check("settler recorded", String(doc3.payout.settledBy) === "admin1", String(doc3.payout.settledBy));
      check("ledger row recorded", ledgerRows.some((l) => l.type === "payout.settled" && l.idempotencyKey === "payout:b1"), `${ledgerRows.length} rows`);
      CookProfile.findOne = savedProfile;
    } finally {
      Booking.findById = savedFindById;
      Booking.findOne = savedFindOne;
      Booking.findOneAndUpdate = savedClaim;
      LedgerEntry.create = savedLedger;
    }
  }

  console.log("\n═══ approveRefund atomicity ═══");
  {
    const savedFindById = Booking.findById;
    const savedClaim = Booking.findOneAndUpdate;
    const savedUpdate = Booking.updateOne;
    const savedLedger = LedgerEntry.create;
    const ledgerRows = [];
    LedgerEntry.create = async (e) => { ledgerRows.push(e); return e; };
    const qdoc = () => {
      const d = eligibleBooking({
        status: "cancelled", hoursCompleted: false, serviceStartedAt: null, cookArrived: false,
        payment: { status: "paid", paidAmount: 349, refundStatus: "pending", refundAmount: 349 },
        payout: { status: "pending" },
      });
      return d;
    };
    try {
      const doc = qdoc();
      Booking.findById = async () => doc;
      // Synchronous CAS: exactly one concurrent approver wins the claim.
      Booking.findOneAndUpdate = async (filter, update) => {
        if (doc.payment.refundStatus !== "pending") return null;
        doc.payment.refundStatus = update.$set["payment.refundStatus"];
        return doc;
      };
      Booking.updateOne = async () => ({});
      notifLog.length = 0;
      const mkReq = () => ({ params: { id: "b1" }, user: { id: "admin1" }, body: {} });
      const [r1, r2] = await Promise.all([
        (async () => { const r = makeRes(); await payoutCtrl.approveRefund(mkReq(), r, next); return r; })(),
        (async () => { const r = makeRes(); await payoutCtrl.approveRefund(mkReq(), r, next); return r; })(),
      ]);
      const wins = [r1, r2].filter((r) => r.statusCode === 200).length;
      const conflicts = [r1, r2].filter((r) => r.statusCode === 400).length;
      check("concurrent approves: one wins, one 400", wins === 1 && conflicts === 1, `${r1.statusCode}/${r2.statusCode}`);
      check("refund ends manual (gateway unconfigured) or processed", ["manual", "processed", "failed"].includes(doc.payment.refundStatus), doc.payment.refundStatus);
      check("approve ledger row recorded", ledgerRows.some((l) => l.type === "refund.approved"), `${ledgerRows.length} rows`);
      // Settled payout without clawback → blocked and lock handed back.
      const doc2 = qdoc();
      doc2.payout = { status: "settled" };
      Booking.findById = async () => doc2;
      const r = makeRes();
      await payoutCtrl.approveRefund(mkReq(), r, next);
      check("settled payout blocks approve w/o clawback", r.statusCode === 400 && doc2.payment.refundStatus === "pending", `s=${r.statusCode}/${doc2.payment.refundStatus}`);
    } finally {
      Booking.findById = savedFindById;
      Booking.findOneAndUpdate = savedClaim;
      Booking.updateOne = savedUpdate;
      LedgerEntry.create = savedLedger;
    }
  }

  console.log("\n═══ markRefundSettled caps ═══");
  {
    const savedFindById = Booking.findById;
    const savedLedger = LedgerEntry.create;
    LedgerEntry.create = async (e) => e;
    try {
      const doc = eligibleBooking({
        status: "cancelled",
        payment: { status: "paid", paidAmount: 349, refundStatus: "manual", refundAmount: 349 },
      });
      Booking.findById = async () => doc;
      let r = makeRes();
      await payoutCtrl.markRefundSettled({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "R", amount: 999 } }, r, next);
      check("over-approved manual amount refused", r.statusCode === 400, `s=${r.statusCode}`);
      r = makeRes();
      await payoutCtrl.markRefundSettled({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "R", amount: 349 } }, r, next);
      check("exact manual amount settles", r.statusCode === 200 && doc.payment.refundStatus === "processed", `s=${r.statusCode}`);
    } finally {
      Booking.findById = savedFindById;
      LedgerEntry.create = savedLedger;
    }
  }

  console.log("\n═══ order reuse ═══");
  {
    const CookProfile = require("./models/CookProfile");
    const savedProfile = CookProfile.findOne;
    const savedFind = Booking.find;
    const savedFindById = Booking.findById;
    const savedUpdate = Booking.updateOne;
    const savedUser = User.findById;
    // Gateway configured in-process (env preset above); mock fetch/create.
    rzCfg.razorpay.orders.fetch = async (id) => {
      if (id === "order_live_1") return { id, amount: 34900, currency: "INR" };
      if (id === "order_stale_1") return { id, amount: 19900, currency: "INR" };
      const e = new Error("no such order"); e.statusCode = 404; throw e;
    };
    let created = 0;
    rzCfg.razorpay.orders.create = async (o) => { created += 1; return { id: "order_new_1", currency: o.currency }; };
    CookProfile.findOne = async () => ({ approvalStatus: "approved" });
    User.findById = () => ({ select: async () => ({ status: "active" }) });
    const mkOrderBooking = () => ({
      _id: "b1", customer: "cust1", cook: "cook1", date: new Date(Date.now() + 7 * 864e5),
      startTime: "10:00", endTime: "12:00", status: "accepted",
      amount: 349,
      payment: { status: "pending", razorpayOrderId: "order_live_1", razorpayOrderIds: ["order_live_1"] },
      paymentExpiresAt: new Date(Date.now() + 300e3),
      requestExpiresAt: new Date(Date.now() + 300e3),
      save: async function () { return this; },
    });
    // Availability + profile lookups inside createOrder go through real utils;
    // stubbed at the model layer: Booking.find yields no rivals, and the
    // plain CookProfile stub throws inside getDayWindows, which falls back
    // to the full service day.
    Booking.find = () => ({ select: async () => [] });
    let updateCalls = 0;
    Booking.updateOne = async () => { updateCalls += 1; return {}; };
    const body = { cook: "cook1", date: "2099-02-02", startTime: "10:00", endTime: "12:00", durationHours: 2, bookingId: "b1" };
    // NOTE: createOrder derives windows from CookProfile.schedule via
    // getDayWindows (real util → stubbed CookProfile.findOne without .select
    // chain support here is plain-async → TypeError → caught → full-day).
    // Availability toggle: resolveCookAvailability is NOT called in
    // createOrder (only windows + overlap), so the plain stub suffices.
    const orderBooking = mkOrderBooking();
    Booking.findById = () => ({ select: async () => orderBooking });
    let r = makeRes();
    await paymentCtrl.createOrder(
      { body, user: { id: "cust1", role: "CUSTOMER" } }, r, next
    );
    check("live stored order reused (no new mint)", r.statusCode === 200 && r.body?.reused === true && created === 0, `s=${r.statusCode} created=${created}`);
    Booking.findById = savedFindById;
    User.findById = savedUser;
    CookProfile.findOne = savedProfile;
    Booking.find = savedFind;
    Booking.updateOne = savedUpdate;
  }

  console.log("\n═══ webhook dedup ═══");
  {
    const WebhookEvent = require("./models/WebhookEvent");
    const savedCreate = WebhookEvent.create;
    const savedFindOne = Booking.findOne;
    const seen = new Set();
    WebhookEvent.create = async (e) => {
      if (seen.has(e.key)) { const err = new Error("dup"); err.code = 11000; throw err; }
      seen.add(e.key);
      return e;
    };
    WebhookEvent.updateOne = async () => ({});
    const savedLedger = LedgerEntry.create;
    LedgerEntry.create = async (e) => e;
    try {
      let saves = 0;
      const doc = mkBookingDoc();
      function mkBookingDoc() {
        return {
          _id: "bW", customer: "cust1", cook: "cook1", status: "accepted", amount: 349,
          date: new Date(Date.now() + 864e5), startTime: "10:00", endTime: "12:00",
          payment: { status: "pending", razorpayOrderId: "order_w1" },
          statusHistory: [],
          save: async function () { saves += 1; return this; },
          toObject: function () { const { save, toObject, ...rest } = this; return { ...rest }; },
        };
      }
      Booking.findOne = async () => doc;
      const raw = Buffer.from(JSON.stringify({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_w1", order_id: "order_w1", amount: 34900, currency: "INR", status: "captured" } } },
      }));
      const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");
      const req = () => ({ body: raw, headers: { "x-razorpay-signature": sig } });
      const mkRes = () => {
        let s = 200, p = null;
        const res = { status: (c) => { s = c; return res; }, json: (x) => { p = x; return res; } };
        return { res, out: () => ({ s, p }) };
      };
      const a = mkRes(); await paymentCtrl.handleWebhook(req(), a.res);
      const b = mkRes(); await paymentCtrl.handleWebhook(req(), b.res);
      check("first delivery confirms", a.out().p?.handled === true && doc.status === "confirmed", JSON.stringify(a.out().p));
      check("duplicate delivery acked w/o reprocessing", b.out().p?.handled === "duplicate" && saves === 1, `saves=${saves}`);
    } finally {
      WebhookEvent.create = savedCreate;
      Booking.findOne = savedFindOne;
      LedgerEntry.create = savedLedger;
    }
  }

  console.log("\n═══ ledger idempotency ═══");
  {
    const savedLedger = LedgerEntry.create;
    try {
      let calls = 0;
      LedgerEntry.create = async (e) => {
        calls += 1;
        if (calls > 1) { const err = new Error("dup"); err.code = 11000; throw err; }
        return e;
      };
      const entry = { idempotencyKey: "k1", booking: "b1", type: "payout.settled", amount: 100 };
      const r1 = await recordLedger(entry);
      const r2 = await recordLedger(entry);
      check("duplicate key recorded once", r1.recorded === true && r2.duplicate === true, JSON.stringify([r1, r2]));
      LedgerEntry.create = async () => { throw new Error("db down"); };
      const r3 = await recordLedger(entry);
      check("ledger failure never throws", r3.failed === true, JSON.stringify(r3));
    } finally {
      LedgerEntry.create = savedLedger;
    }
  }

  console.log("\n═══ cook payout-details update ═══");
  {
    const CookProfile = require("./models/CookProfile");
    const savedFind = CookProfile.findOneAndUpdate;
    const savedUpdate = CookProfile.updateOne;
    try {
      let historyPushed = false;
      CookProfile.findOneAndUpdate = async (f, b) => ({ user: "cook1", payoutDetails: b.payoutDetails });
      CookProfile.updateOne = async () => { historyPushed = true; return {}; };
      let r = makeRes();
      await cookCtrl.updateCookProfile({ user: { id: "cook1" }, body: { payoutDetails: { method: "upi", upiId: "bad" } } }, r, next);
      check("bad UPI rejected", r.statusCode === 400, `s=${r.statusCode}`);
      r = makeRes();
      await cookCtrl.updateCookProfile({ user: { id: "cook1" }, body: { payoutDetails: { method: "upi", upiId: "cook@okhdfc" } } }, r, next);
      check("valid UPI saved + history trailed", r.statusCode === 200 && historyPushed === true, `s=${r.statusCode}`);
    } finally {
      CookProfile.findOneAndUpdate = savedFind;
      CookProfile.updateOne = savedUpdate;
    }
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
