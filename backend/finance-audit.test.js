
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
  normalizePayoutReference,
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
    const settled = q({ payout: { status: "settled" } });
    const blocked = refundApprovalCheck(settled);
    check("settled payout blocks refund w/o clawback", blocked.ok === false, blocked.reasons[0] || "");
    const forced = refundApprovalCheck(settled, { clawback: true });
    check("explicit clawback re-opens with note path", forced.ok === true, JSON.stringify(forced));
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
      const doc = eligibleBooking();
      Booking.findById = async () => doc;
      Booking.findOne = () => ({ select: async () => ({ _id: "other" }) });
      let r = makeRes();
      await payoutCtrl.settlePayout({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "DUPREF123456" } }, r, next);
      check("duplicate reference → 409", r.statusCode === 409 && doc.payout.status === "pending", `s=${r.statusCode}`);
      const doc2 = eligibleBooking({ payment: { status: "paid", refundStatus: "pending" } });
      Booking.findById = async () => doc2;
      Booking.findOne = () => ({ select: async () => null });
      r = makeRes();
      await payoutCtrl.settlePayout({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "UNIQUE987654" } }, r, next);
      check("refund-pending blocks settlement", r.statusCode === 400 && /refund/i.test(r.body?.message || ""), `s=${r.statusCode}`);
      Booking.findById = async () => eligibleBooking();
      r = makeRes();
      await payoutCtrl.settlePayout({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "x" } }, r, next);
      check("malformed reference → 400", r.statusCode === 400, `s=${r.statusCode}`);
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
      Booking.findOneAndUpdate = async (filter, update) => {
        const want = filter["payment.refundStatus"];
        const cur = doc.payment.refundStatus;
        const matches =
          want === undefined ? true
          : typeof want === "string" ? cur === want
          : want && typeof want === "object" && "$ne" in want ? cur !== want.$ne
          : true;
        if (!matches) return null;
        for (const [k, v] of Object.entries(update.$set || {})) {
          const ks = String(k).split(".");
          let t = doc;
          for (let i = 0; i < ks.length - 1; i++) t = t[ks[i]];
          t[ks[ks.length - 1]] = v;
        }
        if (update.$push?.statusHistory) doc.statusHistory.push(update.$push.statusHistory);
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
      const cookNotices = notifLog.filter((n) => String(n.user) === "cook1" && n.type === "refund_processed");
      check("assigned cook hears the approval too", cookNotices.length === 1 && /cook payout for this booking will not proceed/i.test(cookNotices[0].message), cookNotices.map((n) => n.message).join("|"));
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
    const savedClaim = Booking.findOneAndUpdate;
    const savedLedger = LedgerEntry.create;
    LedgerEntry.create = async (e) => e;
    try {
      const doc = eligibleBooking({
        status: "cancelled",
        payment: { status: "paid", paidAmount: 349, refundStatus: "manual", refundAmount: 349 },
      });
      Booking.findById = async () => doc;
      Booking.findOneAndUpdate = async (filter, update) => {
        const cur = doc.payment.refundStatus;
        const want = filter["payment.refundStatus"];
        const ok = want && typeof want === "object" && "$in" in want ? want.$in.includes(cur) : cur === want;
        if (!ok) return null;
        for (const [k, v] of Object.entries(update.$set || {})) {
          const ks = String(k).split(".");
          let t = doc;
          for (let i = 0; i < ks.length - 1; i++) t = t[ks[i]];
          t[ks[ks.length - 1]] = v;
        }
        if (update.$push?.statusHistory) doc.statusHistory.push(update.$push.statusHistory);
        return doc;
      };
      let r = makeRes();
      await payoutCtrl.markRefundSettled({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "MANUALREF001", amount: 999 } }, r, next);
      check("over-approved manual amount refused", r.statusCode === 400, `s=${r.statusCode}`);
      r = makeRes();
      await payoutCtrl.markRefundSettled({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "MANUALREF001", amount: 349 } }, r, next);
      check("exact manual amount settles", r.statusCode === 200 && doc.payment.refundStatus === "processed", `s=${r.statusCode}`);
      r = makeRes();
      await payoutCtrl.markRefundSettled({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "x", amount: 349 } }, r, next);
      check("malformed manual reference refused", r.statusCode === 400, `s=${r.statusCode}`);
    } finally {
      Booking.findById = savedFindById;
      Booking.findOneAndUpdate = savedClaim;
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
    Booking.find = () => ({ select: () => ({ lean: async () => [] }) });
    let updateCalls = 0;
    Booking.updateOne = async () => { updateCalls += 1; return {}; };
    const body = { cook: "cook1", date: "2099-02-02", startTime: "10:00", endTime: "12:00", durationHours: 2, bookingId: "b1" };
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
    const savedFindOneAndUpdate = Booking.findOneAndUpdate;
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
      Booking.findOneAndUpdate = async (filter, update) => {
        if (String(filter._id) !== String(doc._id)) return null;
        if (filter.status && doc.status !== filter.status) return null;
        const pne = filter["payment.status"] && filter["payment.status"].$ne;
        if (pne !== undefined && doc.payment && doc.payment.status === pne) return null;
        for (const [k, v] of Object.entries(update.$set || {})) {
          const parts = k.split(".");
          let cur = doc;
          for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
          cur[parts[parts.length - 1]] = v;
        }
        if (update.$push?.statusHistory) doc.statusHistory.push(update.$push.statusHistory);
        return doc;
      };
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
      check("duplicate delivery acked w/o reprocessing", b.out().p?.handled === "duplicate" && saves === 0, `saves=${saves}`);
    } finally {
      WebhookEvent.create = savedCreate;
      Booking.findOne = savedFindOne;
      Booking.findOneAndUpdate = savedFindOneAndUpdate;
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

  console.log("\n═══ ADVERSARIAL: payout state machine ═══");
  {
    const tick = () => new Promise((r) => setImmediate(r));
    const getPath = (o, p) => String(p).split(".").reduce((a, k) => a?.[k], o);
    const setPath = (o, p, v) => {
      const ks = String(p).split(".");
      let t = o;
      for (let i = 0; i < ks.length - 1; i++) {
        if (t[ks[i]] == null || typeof t[ks[i]] !== "object") t[ks[i]] = {};
        t = t[ks[i]];
      }
      t[ks[ks.length - 1]] = v;
    };
    const matchCond = (val, cond) => {
      if (cond && typeof cond === "object" && !Array.isArray(cond)) {
        return Object.entries(cond).every(([op, ov]) => {
          if (op === "$in") return ov.includes(val);
          if (op === "$ne") return val !== ov;
          if (op === "$gt") return val > ov;
          if (op === "$gte") return val >= ov;
          if (op === "$exists") return ov ? val !== undefined : val === undefined;
          return false;
        });
      }
      return val === cond;
    };
    const matchFilter = (doc, filter) =>
      Object.entries(filter || {}).every(([k, v]) => {
        if (k === "$or") return v.some((c) => matchFilter(doc, c));
        if (k === "$and") return v.every((c) => matchFilter(doc, c));
        return matchCond(getPath(doc, k), v);
      });
    const applyUpdate = (doc, update = {}) => {
      for (const [k, v] of Object.entries(update.$set || {})) setPath(doc, k, v);
      for (const [k, v] of Object.entries(update.$push || {})) {
        const arr = getPath(doc, k);
        if (Array.isArray(arr)) arr.push(v);
      }
    };
    const store = new Map();
    let beforeClaimHook = null;
    const mkDoc = (id, over = {}) => {
      const d = eligibleBooking({ _id: id, ...over });
      store.set(id, d);
      return d;
    };
    const installStore = () => {
      Booking.findById = async (id) => store.get(String(id)) || null;
      Booking.findOne = (filter) => ({
        select: async () => {
          for (const d of store.values()) if (matchFilter(d, filter)) return d;
          return null;
        },
      });
      Booking.findOneAndUpdate = async (filter, update) => {
        if (beforeClaimHook) await beforeClaimHook();
        await tick();
        let target = null;
        for (const d of store.values()) if (matchFilter(d, filter)) { target = d; break; }
        if (!target) return null;
        const newKey = update.$set?.["payout.referenceKey"];
        if (newKey) {
          for (const d of store.values()) {
            if (d !== target && d.payout?.status === "settled" && d.payout?.referenceKey === newKey) {
              const e = new Error("E11000 duplicate key"); e.code = 11000; throw e;
            }
          }
        }
        applyUpdate(target, update);
        return target;
      };
    };
    const savedFindById = Booking.findById;
    const savedFindOne = Booking.findOne;
    const savedClaim = Booking.findOneAndUpdate;
    const savedLedger = LedgerEntry.create;
    const savedNotif = Notification.create;
    const ledgerRows = [];
    const ledgerKeys = new Set();
    LedgerEntry.create = async (e) => {
      await tick();
      if (ledgerKeys.has(e.idempotencyKey)) { const err = new Error("dup"); err.code = 11000; throw err; }
      ledgerKeys.add(e.idempotencyKey);
      ledgerRows.push(e);
      return e;
    };
    Notification.create = async (d) => { notifLog.push(d); return d; };
    const CookProfile = require("./models/CookProfile");
    const savedProfile = CookProfile.findOne;
    CookProfile.findOne = () => ({ select: () => ({ lean: async () => ({ payoutDetails: { method: "upi", upiId: "cook@okhdfc", holderName: "C", bankName: "", accountLast4: "", ifsc: "" } }) }) });
    const admin = { id: "admin1" };
    const settle = (id, ref) => {
      const r = makeRes();
      return payoutCtrl.settlePayout({ params: { id }, user: admin, body: { reference: ref } }, r, next).then(() => r);
    };
    try {
      installStore();

      mkDoc("s1");
      let r = await settle("s1", "UTRSTATE001");
      check("pending -> settled 200", r.statusCode === 200 && store.get("s1").payout.status === "settled", `s=${r.statusCode}`);
      r = await settle("s1", "UTRSTATE001");
      check("settled -> settle idempotent (no dup ledger)", r.statusCode === 200 && ledgerRows.filter((l) => l.idempotencyKey === "payout:s1").length === 1, `s=${r.statusCode}`);
      r = makeRes();
      await payoutCtrl.rejectPayout({ params: { id: "s1" }, user: admin, body: {} }, r, next);
      check("settled -> reject is no-op success", r.statusCode === 200 && store.get("s1").payout.status === "settled", `s=${r.statusCode}`);
      mkDoc("s2");
      r = makeRes();
      await payoutCtrl.rejectPayout({ params: { id: "s2" }, user: admin, body: { reason: "bad service" } }, r, next);
      check("pending -> not_applicable 200", r.statusCode === 200 && store.get("s2").payout.status === "not_applicable", `s=${r.statusCode}`);
      r = makeRes();
      await payoutCtrl.rejectPayout({ params: { id: "s2" }, user: admin, body: {} }, r, next);
      check("not_applicable -> reject idempotent", r.statusCode === 200, `s=${r.statusCode}`);
      r = await settle("s2", "UTRSTATE002");
      check("not_applicable -> settle refused 400", r.statusCode === 400 && store.get("s2").payout.status === "not_applicable", `s=${r.statusCode}`);

      const legacy = eligibleBooking({ _id: "s3" });
      delete legacy.payout;
      store.set("s3", legacy);
      r = await settle("s3", "UTRSTATE003");
      check("missing payout subdoc settles (treated pending)", r.statusCode === 200 && store.get("s3").payout?.status === "settled", `s=${r.statusCode}`);
      const legacy2 = eligibleBooking({ _id: "s4" });
      delete legacy2.payout;
      store.set("s4", legacy2);
      r = makeRes();
      await payoutCtrl.rejectPayout({ params: { id: "s4" }, user: admin, body: {} }, r, next);
      check("missing payout subdoc rejects (treated pending)", r.statusCode === 200 && store.get("s4").payout?.status === "not_applicable", `s=${r.statusCode}`);

      mkDoc("s5");
      const before = ledgerRows.length;
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => settle("s5", `UTRRACE${String(i).padStart(3, "0")}`)));
      const okAll = results.every((x) => x.statusCode === 200);
      const refs = new Set(results.map((x) => x.body?.payout?.reference));
      check("10 concurrent settles: all 200, one reference", okAll && refs.size === 1, `${results.map((x) => x.statusCode).join(",")} refs=${[...refs]}`);
      check("10 concurrent settles: one ledger row", ledgerRows.filter((l) => l.idempotencyKey === "payout:s5").length === 1, `rows=${ledgerRows.length - before}`);
      check("10 concurrent settles: one settledAt", store.get("s5").payout.status === "settled");

      mkDoc("s6");
      const [rs, rj] = await Promise.all([
        settle("s6", "UTRRACEB01"),
        (async () => { const rr = makeRes(); await payoutCtrl.rejectPayout({ params: { id: "s6" }, user: admin, body: {} }, rr, next); return rr; })(),
      ]);
      const terminal = store.get("s6").payout.status;
      const settledLedgers = ledgerRows.filter((l) => l.idempotencyKey === "payout:s6").length;
      const rejectLedgers = ledgerRows.filter((l) => l.idempotencyKey === "payout-reject:s6").length;
      check("settle+reject race: one terminal state", terminal === "settled" || terminal === "not_applicable", `${rs.statusCode}/${rj.statusCode} -> ${terminal}`);
      check("settle+reject race: ledger matches winner", (terminal === "settled" && settledLedgers === 1 && rejectLedgers === 0) || (terminal === "not_applicable" && rejectLedgers === 1 && settledLedgers === 0), `settle=${settledLedgers} reject=${rejectLedgers}`);

      mkDoc("s7");
      beforeClaimHook = async () => { store.get("s7").payment.refundStatus = "pending"; };
      r = await settle("s7", "UTRRACEC01");
      beforeClaimHook = null;
      check("refund queued mid-settle -> 409, stays pending", r.statusCode === 409 && store.get("s7").payout.status === "pending", `s=${r.statusCode}`);

      const { razorpay: rzClient } = require("./config/razorpay");
      let gatewayCalls = 0;
      const savedRefund = rzClient?.payments?.refund;
      if (rzClient?.payments) rzClient.payments.refund = async () => { gatewayCalls++; return { id: "rf_x" }; };
      mkDoc("s8", { status: "cancelled", hoursCompleted: false, serviceStartedAt: null, cookArrived: false, payment: { status: "paid", paidAmount: 349, testMode: false, refundStatus: "pending", refundAmount: 349 } });
      beforeClaimHook = async () => { store.get("s8").payout.status = "settled"; };
      r = makeRes();
      await payoutCtrl.approveRefund({ params: { id: "s8" }, user: admin, body: {} }, r, next);
      beforeClaimHook = null;
      if (rzClient?.payments && savedRefund) rzClient.payments.refund = savedRefund;
      check("settle-during-approve -> 400, gateway untouched", r.statusCode === 400 && gatewayCalls === 0, `s=${r.statusCode} gw=${gatewayCalls}`);

      mkDoc("s9", { status: "cancelled", hoursCompleted: false, serviceStartedAt: null, cookArrived: false, payment: { status: "paid", paidAmount: 349, testMode: false, refundStatus: "pending", refundAmount: 349 } });
      r = makeRes();
      await payoutCtrl.approveRefund({ params: { id: "s9" }, user: admin, body: { clawback: true } }, r, next);
      const note9 = (store.get("s9").statusHistory || []).map((h) => h.note).join(" ");
      check("clawback flag on unsettled: no fabricated settled-claim", r.statusCode === 200 && !/already settled/i.test(note9), `s=${r.statusCode}`);
      mkDoc("s10", { status: "cancelled", hoursCompleted: false, serviceStartedAt: null, cookArrived: false, payment: { status: "paid", paidAmount: 349, testMode: false, refundStatus: "pending", refundAmount: 349 }, payout: { status: "settled" } });
      r = makeRes();
      await payoutCtrl.approveRefund({ params: { id: "s10" }, user: admin, body: { clawback: true } }, r, next);
      const note10 = (store.get("s10").statusHistory || []).map((h) => h.note).join(" ");
      check("clawback on settled: allowed + recorded", /already settled/i.test(note10), `s=${r.statusCode}`);

      mkDoc("s11");
      r = await settle("s11", "AbC123x4");
      check("settle stores exact reference", r.statusCode === 200 && store.get("s11").payout.reference === "AbC123x4", `s=${r.statusCode}`);
      check("referenceKey normalized", store.get("s11").payout.referenceKey === "abc123x4", store.get("s11").payout.referenceKey);
      mkDoc("s12");
      r = await settle("s12", "abc123X4");
      check("case-variant reference rejected 409", r.statusCode === 409 && store.get("s12").payout.status === "pending", `s=${r.statusCode}`);
      mkDoc("s13");
      r = await settle("s13", "ABC  123X4");
      check("whitespace-variant reference rejected 409", r.statusCode === 409, `s=${r.statusCode}`);
      mkDoc("s14"); mkDoc("s15");
      const [ra, rb] = await Promise.all([settle("s14", "UTRSHARED01"), settle("s15", "UTRSHARED01")]);
      const won = [ra, rb].filter((x) => x.statusCode === 200).length;
      const lost = [ra, rb].filter((x) => x.statusCode === 409).length;
      check("concurrent duplicate reference: one 200, one 409", won === 1 && lost === 1, `${ra.statusCode}/${rb.statusCode}`);
      for (const [label, ref, want] of [
        ["short rejected", "ab", 400],
        ["blank rejected", "   ", 400],
        ["unicode lookalike rejected", "АBC12345", 400],
        ["control char rejected", "AB\x01C12345", 400],
        ["overlong rejected", "X".repeat(121), 400],
      ]) {
        mkDoc(`ref-${label.length}`);
        r = await settle(`ref-${label.length}`, ref);
        check(`reference ${label}`, r.statusCode === want, `s=${r.statusCode}`);
      }
      check("normalizePayoutReference folds case/space", normalizePayoutReference("  AbC  123X ") === "abc123x", normalizePayoutReference("  AbC  123X "));

      mkDoc("s16");
      r = makeRes();
      await payoutCtrl.settlePayout({ params: { id: "s16" }, user: admin, body: { reference: "UTRTAMPER01", amount: 1, cookPayout: 999999999, settledBy: "evil", actor: "admin:evil" } }, r, next);
      const p16 = store.get("s16").payout;
      check("client amount ignored", r.statusCode === 200 && p16.amount === 262, `s=${r.statusCode} amount=${p16.amount}`);
      check("settler forged-proof (server identity)", String(p16.settledBy) === "admin1", String(p16.settledBy));
      mkDoc("s17");
      for (const evil of [{ amount: -5 }, { amount: 0 }, { amount: 1e12 }, { amount: "x" }, { amount: NaN }]) {
        r = makeRes();
        await payoutCtrl.settlePayout({ params: { id: "s17" }, user: admin, body: { reference: "UTRTAMPER02", ...evil } }, r, next);
      }
      check("hostile amounts never corrupt payout", store.get("s17").payout.amount === 262 && store.get("s17").payout.status === "settled");

      mkDoc("s18", { payment: { status: "paid", paidAmount: 349, testMode: true, refundStatus: "none" } });
      r = await settle("s18", "UTRTESTMODE1");
      check("testMode settle refused", r.statusCode === 400 && store.get("s18").payout.status === "pending", `s=${r.statusCode}`);

      for (const [rs, want] of [["none", true], ["rejected", true], ["pending", false], ["processing", false], ["processed", false], ["failed", false], ["manual", false]]) {
        const e = payoutEligibility(eligibleBooking({ payment: { status: "paid", paidAmount: 349, testMode: false, refundStatus: rs } }));
        check(`refund ${rs} ${want ? "permits" : "blocks"} payout`, e.eligible === want);
      }

      mkDoc("s19");
      const savedCreate = LedgerEntry.create;
      LedgerEntry.create = async () => { throw new Error("ledger db down"); };
      r = await settle("s19", "UTRLEDGER01");
      LedgerEntry.create = savedCreate;
      check("ledger outage: settlement still commits 200", r.statusCode === 200 && store.get("s19").payout.status === "settled", `s=${r.statusCode}`);
      check("ledger outage: gap is detectable", !ledgerRows.some((l) => l.idempotencyKey === "payout:s19"));
      LedgerEntry.findOne = (q) => ({ select: () => ({ lean: async () => (ledgerKeys.has(q.idempotencyKey) ? { _id: "x" } : null) }) });
      Booking.find = () => ({ select: () => ({ limit: () => ({ lean: async () => [...store.values()].filter((d) => d.payout?.status === "settled").map((d) => ({ _id: d._id, payout: d.payout, payment: d.payment })) }) }) });
      r = makeRes();
      await payoutCtrl.reconcileMissingPayoutLedger({ user: admin }, r, next);
      check("reconcile backfills the gap", r.statusCode === 200 && r.body?.reconciled?.includes("s19"), `s=${r.statusCode} ${JSON.stringify(r.body)}`);
      r = makeRes();
      await payoutCtrl.reconcileMissingPayoutLedger({ user: admin }, r, next);
      check("reconcile rerun is a no-op (idempotent)", r.statusCode === 200 && r.body?.reconciled?.length === 0 && r.body?.alreadyLogged?.includes("s19"), JSON.stringify(r.body));
    } finally {
      Booking.findById = savedFindById;
      Booking.findOne = savedFindOne;
      Booking.findOneAndUpdate = savedClaim;
      LedgerEntry.create = savedLedger;
      Notification.create = savedNotif;
      CookProfile.findOne = savedProfile;
      delete Booking.find;
      delete LedgerEntry.findOne;
    }
  }

  console.log("\n═══ ADVERSARIAL: cross-endpoint reconciliation ═══");
  {
    const C1 = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const C2 = "bbbbbbbbbbbbbbbbbbbbbbbb";
    const books = [
      { _id: "r1", cook: C1, customer: "u1", status: "completed", hoursCompleted: true, serviceStartedAt: new Date(1), cookArrived: true, amount: 349, commission: 87, cookPayout: 262, date: new Date("2026-09-10"), payment: { status: "paid", paidAmount: 349, testMode: false, refundStatus: "none" }, payout: { status: "settled", amount: 262, reference: "R1", referenceKey: "r1", settledAt: new Date("2026-09-11") }, statusHistory: [] },
      { _id: "r2", cook: C1, customer: "u2", status: "completed", hoursCompleted: true, serviceStartedAt: new Date(1), cookArrived: true, amount: 499, commission: 125, cookPayout: 374, date: new Date("2026-09-12"), payment: { status: "paid", paidAmount: 499, testMode: false, refundStatus: "none" }, payout: { status: "pending" }, statusHistory: [] },
      { _id: "r3", cook: C1, customer: "u1", status: "cancelled", hoursCompleted: false, amount: 199, commission: 50, cookPayout: 149, date: new Date("2026-09-13"), payment: { status: "paid", paidAmount: 199, testMode: false, refundStatus: "processed", refundAmount: 199 }, payout: { status: "pending" }, statusHistory: [] },
      { _id: "r4", cook: C1, customer: "u3", status: "completed", hoursCompleted: true, serviceStartedAt: new Date(1), cookArrived: true, amount: 349, commission: 87, cookPayout: 262, date: new Date("2026-09-14"), payment: { status: "paid", paidAmount: 349, testMode: true, refundStatus: "none" }, payout: { status: "pending" }, statusHistory: [] },
      { _id: "r5", cook: C2, customer: "u4", status: "completed", hoursCompleted: true, serviceStartedAt: new Date(1), cookArrived: true, amount: 649, commission: 162, cookPayout: 487, date: new Date("2026-09-15"), payment: { status: "paid", paidAmount: 649, testMode: false, refundStatus: "none" }, payout: { status: "settled", amount: 487, reference: "R2", referenceKey: "r2", settledAt: new Date("2026-09-16") }, statusHistory: [] },
    ];
    const ledger = [
      { idempotencyKey: "payout:r1", booking: "r1", type: "payout.settled", amount: 262 },
      { idempotencyKey: "payout:r5", booking: "r5", type: "payout.settled", amount: 487 },
      { idempotencyKey: "refund-approve:r3", booking: "r3", type: "refund.approved", amount: 199 },
    ];
    const real = (b) => b.payment?.status === "paid" && b.payment?.testMode !== true;
    const settledBooks = books.filter((b) => b.payout?.status === "settled" && real(b));
    const EXP_SETTLED = settledBooks.reduce((a, b) => a + (b.payout.amount || 0), 0); // 749
    const EXP_COUNT = settledBooks.length; // 2
    const EXP_CAPTURED = books.filter(real).reduce((a, b) => a + (b.payment.paidAmount || 0), 0); // 1696
    const EXP_REFUNDED = books.filter((b) => real(b) && ["processed", "manual"].includes(b.payment.refundStatus)).reduce((a, b) => a + (b.payment.refundAmount || 0), 0); // 199
    const EXP_QUEUE = books.filter((b) => real(b) && b.status === "completed" && b.hoursCompleted === true && (b.cookPayout || 0) > 0 && b.payout?.status === "pending");
    const EXP_QUEUE_AMT = EXP_QUEUE.reduce((a, b) => a + b.cookPayout, 0); // 374 (r2 only)
    const EXP_LEDGER_SETTLED = ledger.filter((l) => l.type === "payout.settled").reduce((a, l) => a + l.amount, 0); // 749
    const stmtOf = (cook) => {
      const rows = books.filter((b) => String(b.cook) === cook && real(b) && ["confirmed", "in_progress", "completed", "cancelled"].includes(b.status));
      const earnings = rows.reduce((a, b) => a + (b.cookPayout || 0), 0);
      const refunded = rows.filter((b) => ["processed", "manual"].includes(b.payment.refundStatus)).reduce((a, b) => a + (b.payment.refundAmount || 0), 0);
      const settled = rows.filter((b) => b.payout?.status === "settled").reduce((a, b) => a + (b.payout.amount || b.cookPayout || 0), 0);
      const pending = rows.filter((b) => (!b.payout || b.payout.status === "pending") && b.status === "completed" && b.hoursCompleted === true && !(b.payment.refundStatus && !["none", "rejected"].includes(b.payment.refundStatus))).reduce((a, b) => a + (b.cookPayout || 0), 0);
      return { earnings, refunded, net: earnings - refunded, settled, pending };
    };
    const EXP_C1 = stmtOf(C1); // earnings 785, refunded 199, net 586, settled 262, pending 374
    const EXP_C2 = stmtOf(C2); // settled 487

    const getP = (o, p) => String(p).split(".").reduce((a, k) => a?.[k], o);
    const mCond = (val, cond) => {
      if (cond && typeof cond === "object" && !Array.isArray(cond)) {
        return Object.entries(cond).every(([op, ov]) => {
          if (op === "$in") return ov.includes(val);
          if (op === "$ne") return val !== ov;
          if (op === "$gt") return val > ov;
          if (op === "$gte") return val >= ov;
          if (op === "$exists") return ov ? val !== undefined : val === undefined;
          return false;
        });
      }
      return val === cond;
    };
    const mFilter = (doc, filter) => Object.entries(filter || {}).every(([k, v]) => {
      if (k === "$or") return v.some((c) => mFilter(doc, c));
      if (k === "$and") return v.every((c) => mFilter(doc, c));
      return mCond(getP(doc, k), v);
    });
    const ev = (row, e) => {
      if (e && typeof e === "object") {
        if ("$cond" in e) { const [c, t, f] = e.$cond; return ev(row, c) ? ev(row, t) : ev(row, f); }
        if ("$and" in e) return e.$and.every((x) => ev(row, x));
        if ("$eq" in e) return ev(row, e.$eq[0]) === ev(row, e.$eq[1]);
        if ("$ne" in e) return ev(row, e.$ne[0]) !== ev(row, e.$ne[1]);
        if ("$in" in e) return (ev(row, e.$in[1]) || []).includes(ev(row, e.$in[0]));
        if ("$ifNull" in e) { const v = ev(row, e.$ifNull[0]); return v == null ? e.$ifNull[1] : v; }
      }
      if (typeof e === "string" && e.startsWith("$")) return getP(row, e.slice(1));
      return e;
    };
    const runPipe = (docs, pipe) => {
      let rows = docs.map((d) => ({ ...d }));
      for (const st of pipe) {
        if (st.$match) rows = rows.filter((r) => mFilter(r, st.$match));
        else if (st.$group) {
          const g = new Map();
          for (const r of rows) {
            const gid = st.$group._id === null ? null : typeof st.$group._id === "string" ? ev(r, st.$group._id) : Object.fromEntries(Object.entries(st.$group._id).map(([k, v]) => [k, ev(r, v)]));
            const gk = JSON.stringify(gid);
            if (!g.has(gk)) { const init = { _id: gid }; for (const [k, v] of Object.entries(st.$group)) { if (k !== "_id") { if (v.$sum !== undefined) init[k] = 0; if (v.$push !== undefined) init[k] = []; } } g.set(gk, init); }
            const o = g.get(gk);
            for (const [k, v] of Object.entries(st.$group)) {
              if (k === "_id") continue;
              if (v.$sum !== undefined) o[k] += typeof v.$sum === "number" ? v.$sum : Number(ev(r, v.$sum)) || 0;
              if (v.$push !== undefined) o[k].push(ev(r, v.$push));
            }
          }
          rows = [...g.values()];
        } else if (st.$sort) { const es = Object.entries(st.$sort); rows.sort((a, b) => { for (const [k, d] of es) { if (a[k] !== b[k]) return (a[k] < b[k] ? -1 : 1) * d; } return 0; }); }
        else if (st.$limit) rows = rows.slice(0, st.$limit);
        else if (st.$project) rows = rows.map((r) => { const o = {}; for (const [k, v] of Object.entries(st.$project)) { if (k === "_id" && v === 0) continue; else if (v === 1) { if (r[k] !== undefined) o[k] = r[k]; } else if (typeof v === "string" && v.startsWith("$")) o[k] = ev(r, v); } return o; });
      }
      return rows;
    };
    const qfind = (arr) => (filter) => {
      let rows = arr.filter((d) => mFilter(d, filter));
      const q = {
        sort: () => q, populate: () => q, select: () => q,
        skip: (n) => { rows = rows.slice(n); return q; },
        limit: (n) => { rows = rows.slice(0, n); return q; },
        lean: async () => rows,
        then: (res, rej) => Promise.resolve(rows).then(res, rej),
      };
      return q;
    };
    const sBookingFind = Booking.find, sBookingCount = Booking.countDocuments, sBookingAgg = Booking.aggregate;
    const sLedgerAgg = LedgerEntry.aggregate, sLedgerFind = LedgerEntry.find;
    const sCPFind = CookProfile.find, sCPFindOne = CookProfile.findOne;
    Booking.find = qfind(books);
    Booking.countDocuments = async (f) => books.filter((d) => mFilter(d, f || {})).length;
    Booking.aggregate = async (p) => runPipe(books, p);
    LedgerEntry.aggregate = async (p) => runPipe(ledger, p);
    LedgerEntry.find = (f) => ({ select: () => ({ lean: async () => ledger.filter((d) => mFilter(d, f || {})) }) });
    CookProfile.find = () => ({ select: () => ({ lean: async () => [] }) });
    CookProfile.findOne = () => ({ select: () => ({ lean: async () => null }) });
    const get = (fn, req) => { const r = makeRes(); return fn(req, r, next).then(() => r); };
    try {
      let r = await get(payoutCtrl.getPayoutQueue, { query: {} });
      check("queue holds exactly the eligible row", r.statusCode === 200 && r.body?.length === 1 && r.body[0]._id === "r2", `s=${r.statusCode} n=${r.body?.length}`);
      check("queue row flagged eligible with no blockers", r.body[0].payoutEligible === true && (r.body[0].payoutBlockers || []).length === 0);
      check("queue pending == independent", r.body.reduce((a, b) => a + b.cookPayout, 0) === EXP_QUEUE_AMT, `${EXP_QUEUE_AMT}`);
      r = await get(payoutCtrl.getPayoutHistory, { query: {} });
      const histSum = (r.body || []).reduce((a, b) => a + (b.payout?.amount || 0), 0);
      check("history settled total == independent", histSum === EXP_SETTLED, `${histSum}==${EXP_SETTLED}`);
      r = await get(payoutCtrl.getPayoutStatement, { params: { cookId: "me" }, user: { id: C1, role: "cook" } });
      check("cook cannot spoof me-path (uses own id)", r.body?.statement && typeof r.body.statement.settled === "number", `s=${r.statusCode}`);
      const st1 = r.body.statement;
      check("statement c1 earnings/refunded/net", st1.earnings === EXP_C1.earnings && st1.refunded === EXP_C1.refunded && st1.netEarnings === EXP_C1.net, JSON.stringify({ e: st1.earnings, r: st1.refunded, n: st1.netEarnings }));
      check("statement c1 settled/pending", st1.settled === EXP_C1.settled && st1.pending === EXP_C1.pending, `set=${st1.settled} pend=${st1.pending}`);
      r = await get(payoutCtrl.getPayoutStatement, { params: { cookId: C2 }, user: { id: "admin1", role: "admin" } });
      check("admin statement c2 settled == independent", r.body?.statement?.settled === EXP_C2.settled, `${r.body?.statement?.settled}`);
      r = await get(payoutCtrl.getPayoutStatement, { params: { cookId: C2 }, user: { id: C1, role: "cook" } });
      check("cook-to-cook statement IDOR blocked 403", r.statusCode === 403, `s=${r.statusCode}`);
      r = await get(payoutCtrl.getLedgerSummary, {});
      const b = r.body?.bookings || {};
      check("summary captured == independent", b.captured === EXP_CAPTURED, `${b.captured}==${EXP_CAPTURED}`);
      check("summary refunded == independent", b.refunded === EXP_REFUNDED, `${b.refunded}==${EXP_REFUNDED}`);
      check("summary settled == history == ledger == statements", b.settledPayouts === EXP_SETTLED && b.settledPayouts === EXP_LEDGER_SETTLED && b.settledPayouts === EXP_C1.settled + EXP_C2.settled, `${b.settledPayouts}/${EXP_SETTLED}/${EXP_LEDGER_SETTLED}`);
      check("summary settledCount == 2", b.settledCount === EXP_COUNT, `${b.settledCount}`);
      check("summary has blocked + dup diagnostics", Array.isArray(r.body?.missingPayoutLedger) && r.body?.blockedPayouts && Array.isArray(r.body?.duplicateReferences));
      check("summary missing-ledger empty (all logged)", (r.body?.missingPayoutLedger || []).length === 0);
      check("summary duplicate-refs empty", (r.body?.duplicateReferences || []).length === 0);
    } finally {
      Booking.find = sBookingFind;
      Booking.countDocuments = sBookingCount;
      Booking.aggregate = sBookingAgg;
      LedgerEntry.aggregate = sLedgerAgg;
      LedgerEntry.find = sLedgerFind;
      CookProfile.find = sCPFind;
      CookProfile.findOne = sCPFindOne;
    }
  }

  console.log("\n═══ payout index guarantee ═══");
  {
    const { ensurePayoutIndexesOnce, PAYOUT_INDEXES } = require("./utils/payoutIndexes");
    check("declares payout + refund + payment + clientKey indexes", PAYOUT_INDEXES.length === 6 && PAYOUT_INDEXES.every((x) => x.options.unique !== false));
    const created = [];
    const conn = { readyState: 1 };
    const coll = { createIndex: async (spec, options) => { created.push([spec, options]); return options.name; } };
    let r = await ensurePayoutIndexesOnce({ connection: conn, collection: coll, onLog: () => {} });
    check("connected: all booking indexes ensured", r.ok === true && created.length === 6, JSON.stringify(created.map((c) => c[1].name)));
    check("referenceKey index is unique+partial", created.some(([, o]) => o.name === "uniq_payout_reference_key" && o.unique && o.partialFilterExpression));
    check("refund referenceKey index is unique+partial", created.some(([, o]) => o.name === "uniq_refund_reference_key" && o.unique && o.partialFilterExpression));
    check("payment id index is unique", created.some(([, o]) => o.name === "uniq_payment_razorpayPaymentId" && o.unique));
    check("clientKey index is unique", created.some(([, o]) => o.name === "uniq_booking_clientKey" && o.unique));
    const failing = { createIndex: async () => { throw new Error("boom"); } };
    r = await ensurePayoutIndexesOnce({ connection: conn, collection: failing, onLog: () => {} });
    check("failure is reported, never thrown", r.ok === false && /boom/.test(r.error || ""));
    r = await ensurePayoutIndexesOnce({ connection: { readyState: 0 }, collection: coll, onLog: () => {} });
    check("disconnected: reports without touching db", r.ok === false);
    let calls = 0;
    const flaky = { createIndex: async (s, o) => { calls++; if (calls === 1) throw new Error("transient"); return o.name; } };
    r = await ensurePayoutIndexesOnce({ connection: conn, collection: flaky, retryMs: 5, onLog: () => {} });
    check("once-mode surfaces first failure", r.ok === false);
    const { ensurePayoutIndexes } = require("./utils/payoutIndexes");
    let calls2 = 0;
    const flaky2 = { createIndex: async (s, o) => { calls2++; if (calls2 <= 2) throw new Error("transient"); return o.name; } };
    const logs = [];
    const p = ensurePayoutIndexes({ connection: conn, collection: flaky2, retryMs: 5, onLog: (m) => logs.push(m) });
    r = await p;
    check("loop-mode retries to success", r.ok === true && calls2 >= 3, `calls=${calls2}`);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
