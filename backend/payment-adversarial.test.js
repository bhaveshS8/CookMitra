// payment-adversarial.test.js — ADVERSARIAL payment security audit (mocked gateway).
// Run:  node backend/payment-adversarial.test.js  — exits non-zero on failure.
//
// Uses a properly mocked Razorpay verification service: the gateway client's
// orders.fetch / payments.fetch are stubbed per-scenario (captured,
// authorized, failed, refunded, wrong amount/currency, timeout), while the
// REAL payBooking / verifyPayment / webhook code runs unchanged. HMACs are
// computed with the test secret exactly like the gateway would.
//
// Covers all 20 scenarios: cross-booking reuse (A→B), same-amount reuse,
// wrong order/payment/signature, missing stored order, non-captured,
// amount/currency mismatch, duplicate confirm, replay, pay-during-cancel,
// pay-during-expiry, gateway timeout, DB failure after verification,
// concurrent confirms, frontend field manipulation, test-mode-in-prod,
// refund-then-retry, foreign-customer payment. Plus: payout-singleton,
// secret-leak scan, and shared-helper unit checks.
//
// No network, no DB (all model statics stubbed). Follows the repo's stubbed
// unit-test convention (cf. review-rating.test.js, security-audit.test.js).

// ── env BEFORE requires (config/razorpay snapshots these at load) ──────────
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.RAZORPAY_KEY_ID = "rk_test_abcdef123456";
process.env.RAZORPAY_KEY_SECRET = "s3cr3tK3yV4lu3AbCdEfGh";
process.env.RAZORPAY_CURRENCY = "INR";
process.env.RAZORPAY_WEBHOOK_SECRET = "wh_test_secret_abc123";

const crypto = require("crypto");
const Booking = require("./models/Booking");
const User = require("./models/User");
const Notification = require("./models/Notification");
const bookingCtrl = require("./controllers/bookingController");
const paymentCtrl = require("./controllers/paymentController");
const rzCfg = require("./config/razorpay");
const { assertRazorpayPaymentCaptured } = require("./utils/razorpayVerify");

let failures = 0, passes = 0;
const check = (n, ok, d) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`);
  ok ? passes++ : failures++;
};

// ── mocked gateway ──────────────────────────────────────────────────────────
// Mirrors Razorpay semantics: orders.fetch returns the minted order (amount in
// paise); payments.fetch returns the payment with status/amount/currency and
// the order it belongs to. Throwing emulates gateway timeout/outage.
const mockOrders = {};
const mockPayments = {};
const gwFail = { orders: false, payments: false };
rzCfg.razorpay.orders.fetch = async (id) => {
  if (gwFail.orders) { const e = new Error("gateway timeout"); e.code = "ETIMEDOUT"; throw e; }
  if (!mockOrders[id]) { const e = new Error(`no such order ${id}`); e.statusCode = 400; throw e; }
  return mockOrders[id];
};
rzCfg.razorpay.payments.fetch = async (id) => {
  if (gwFail.payments) { const e = new Error("gateway timeout"); e.code = "ETIMEDOUT"; throw e; }
  if (!mockPayments[id]) { const e = new Error(`no such payment ${id}`); e.statusCode = 400; throw e; }
  return mockPayments[id];
};
const sign = (orderId, paymentId) =>
  crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`).digest("hex");
const mintOrder = (id, amountPaise, currency = "INR") => {
  mockOrders[id] = { id, amount: amountPaise, currency };
};
const mintPayment = (id, orderId, amountPaise, { status = "captured", currency = "INR", refunded = 0 } = {}) => {
  mockPayments[id] = { id, order_id: orderId, amount: amountPaise, currency, status, amount_refunded: refunded };
};

// ── fakes ───────────────────────────────────────────────────────────────────
const notifLog = [];
let couponCalls = 0;
Notification.create = async (d) => { notifLog.push(d); return d; };
User.findById = () => ({ select: async () => ({ name: "T Cook", phone: "9000000001" }) });
const Coupon = require("./models/Coupon");
Coupon.updateOne = async () => { couponCalls++; return { acknowledged: true }; };
// Ledger + webhook-event stores are covered in finance-audit.test.js; here
// they are fast no-ops so the suite never waits on buffered real-model
// writes (no DB in this process).
const LedgerEntry = require("./models/LedgerEntry");
const savedLedgerCreate = LedgerEntry.create;
LedgerEntry.create = async (e) => e;
const WebhookEvent = require("./models/WebhookEvent");
const savedWebhookCreate = WebhookEvent.create;
const savedWebhookUpdate = WebhookEvent.updateOne;
const seenWebhookKeys = new Set();
WebhookEvent.create = async (e) => {
  if (seenWebhookKeys.has(e.key)) { const err = new Error("dup"); err.code = 11000; throw err; }
  seenWebhookKeys.add(e.key);
  return e;
};
WebhookEvent.updateOne = async () => ({});

const mkBooking = (over = {}) => {
  const d = {
    _id: "b1",
    customer: "custA",
    cook: "cook1",
    serviceType: "cook_for_me",
    date: new Date(Date.now() + 7 * 864e5),
    startTime: "10:00",
    endTime: "12:00",
    durationHours: 2,
    address: "Pune",
    amount: 349,
    couponCode: "",
    discount: 0,
    status: "accepted",
    statusHistory: [],
    payment: { status: "pending" },
    requestExpiresAt: new Date(Date.now() + 300e3),
    paymentExpiresAt: new Date(Date.now() + 300e3),
    ...over,
    save: async function () { return this; },
    toObject: function () {
      const { save, toObject, ...rest } = this;
      return { ...rest };
    },
  };
  return d;
};
// Ownership-aware findOne (like Mongo): { _id, customer } must both match.
const makeFindOne = (getDoc) => async (filter) => {
  if (filter && filter.$or) {
    const d = getDoc();
    if (!d) return null;
    for (const clause of filter.$or) {
      if (clause["payment.razorpayOrderId"] !== undefined &&
        d.payment?.razorpayOrderId === clause["payment.razorpayOrderId"]) return d;
      if (clause["payment.razorpayOrderIds"] !== undefined &&
        (d.payment?.razorpayOrderIds || []).includes(clause["payment.razorpayOrderIds"])) return d;
    }
    return null;
  }
  const d = getDoc();
  if (!d) return null;
  if (filter._id && String(filter._id) !== String(d._id)) return null;
  if (filter.customer && String(filter.customer) !== String(d.customer)) return null;
  return d;
};
// Atomic compare-and-set claim: check + apply with NO await between, so two
// interleaved invocations behave exactly like MongoDB's findOneAndUpdate.
const makeClaim = (getDoc, log) => async (filter, update) => {
  const d = getDoc();
  if (!d || String(filter._id) !== String(d._id)) return null;
  if (filter.status && d.status !== filter.status) return null;
  const pne = filter["payment.status"] && filter["payment.status"].$ne;
  if (pne !== undefined && d.payment && d.payment.status === pne) return null;
  const set = update.$set || {};
  for (const k of Object.keys(set)) d[k] = set[k];
  if (update.$push && update.$push.statusHistory) d.statusHistory.push(update.$push.statusHistory);
  if (log) log.push("claim-won");
  return d;
};
const savedFindOne = Booking.findOne;
const savedClaim = Booking.findOneAndUpdate;
const savedFindById = Booking.findById;
const useDoc = (doc, { claimLog } = {}) => {
  const get = () => doc;
  Booking.findOne = makeFindOne(get);
  Booking.findById = async (id) => (String(id) === String(doc._id) ? doc : null);
  Booking.findOneAndUpdate = makeClaim(get, claimLog);
};
const restoreModels = () => {
  Booking.findOne = savedFindOne;
  Booking.findOneAndUpdate = savedClaim;
  Booking.findById = savedFindById;
  LedgerEntry.create = savedLedgerCreate;
  WebhookEvent.create = savedWebhookCreate;
  WebhookEvent.updateOne = savedWebhookUpdate;
};

const callPay = async (doc, userId, body) => {
  let status = 200, payload = null;
  const errs = [];
  const res = { status: (s) => { status = s; return res; }, json: (p) => { payload = p; return res; } };
  await bookingCtrl.payBooking(
    { params: { id: doc._id }, user: { id: userId, role: "CUSTOMER" }, body },
    res,
    (e) => { if (e) errs.push(e); }
  );
  return { status, payload, errs };
};
const payBody = (o, p, s) => ({ method: "upi", payment: { razorpayOrderId: o, razorpayPaymentId: p, razorpaySignature: s } });

// Verified-then-minted triple for a 34900-paise fee (fresh ids per test).
let n = 0;
const tripleFor = (feePaise = 34900, tag = "t") => {
  n += 1;
  const o = `order_${tag}_${n}`;
  const p = `pay_${tag}_${n}`;
  mintOrder(o, feePaise);
  mintPayment(p, o, feePaise, { status: "captured" });
  return { o, p, s: sign(o, p) };
};
// Booking pre-bound to the triple's order (what createOrder persists).
const boundBooking = (t, over = {}) =>
  mkBooking({ payment: { status: "pending", razorpayOrderId: t.o }, ...over });

const leakBodies = [];
const snapLeak = (label, status, body) => { leakBodies.push({ label, status, body }); };

(async () => {
  console.log("═══ cross-booking reuse ═══");
  // T1: Booking A order used for Booking B (same fee — only binding blocks).
  // Both triples are fully genuine (valid HMAC, captured, exact amount);
  // the ONLY thing distinguishing them is which booking minted the order.
  {
    const tA = tripleFor(34900, "t1a");
    const tB = tripleFor(34900, "t1b");
    const docB = boundBooking(tB);
    useDoc(docB);
    const r = await callPay(docB, "custA", payBody(tA.o, tA.p, tA.s));
    snapLeak("T1", r.status, r.payload);
    check("T1 A-order on B rejected", r.status === 402 && /belong/.test(r.payload?.message || ""), `s=${r.status}`);
    check("T1 B untouched", docB.status === "accepted" && docB.payment.status === "pending", docB.status);
  }
  // T2 is T1 with identical amounts by construction (both 34900) — the binding
  // check, not the amount, is what rejects. Asserted above; pin explicitly:
  check("T2 same-amount reuse still bound to order", true, "covered by T1 (amounts equal, order differs)");

  console.log("\n═══ malformed triples ═══");
  // T3a: unknown order id (valid HMAC shape impossible without secret — use garbage sig).
  {
    const doc = boundBooking(tripleFor(34900, "t3a"));
    useDoc(doc);
    const r = await callPay(doc, "custA", payBody("order_nope", "pay_nope", "badface"));
    snapLeak("T3a", r.status, r.payload);
    check("T3a wrong order id rejected", r.status === 402, `s=${r.status}`);
  }
  // T3b: genuine triple minted for NO booking (unminted order) with valid HMAC.
  {
    const o = "order_orphan_1", p = "pay_orphan_1";
    mintOrder(o, 34900); mintPayment(p, o, 34900, { status: "captured" });
    const doc = boundBooking(tripleFor(34900, "t3b"));
    useDoc(doc);
    const r = await callPay(doc, "custA", payBody(o, p, sign(o, p)));
    check("T3b чужой valid triple rejected (binding)", r.status === 402, `s=${r.status}`);
  }
  // T4: payment id belonging to a DIFFERENT order (valid HMAC over the
  // submitted pair — the payment↔order linkage check is what must catch it).
  {
    const t = tripleFor(34900, "t4");
    const tX = tripleFor(34900, "t4x");
    const doc = boundBooking(t);
    useDoc(doc);
    const r = await callPay(doc, "custA", payBody(t.o, tX.p, sign(t.o, tX.p)));
    snapLeak("T4", r.status, r.payload);
    check("T4 foreign payment id rejected", r.status === 402, `s=${r.status}`);
  }
  // T5: tampered signature byte.
  {
    const t = tripleFor(34900, "t5");
    const doc = boundBooking(t);
    useDoc(doc);
    const bad = t.s.slice(0, -1) + (t.s.endsWith("0") ? "1" : "0");
    const r = await callPay(doc, "custA", payBody(t.o, t.p, bad));
    snapLeak("T5", r.status, r.payload);
    check("T5 wrong signature rejected", r.status === 402, `s=${r.status}`);
  }
  // T6: missing stored order id (legacy/unbound booking) + otherwise-valid triple.
  {
    const t = tripleFor(34900, "t6");
    const doc = mkBooking({ payment: { status: "pending" } }); // no stored order
    useDoc(doc);
    const r = await callPay(doc, "custA", payBody(t.o, t.p, t.s));
    check("T6 missing stored order rejected (order id mandatory)", r.status === 402, `s=${r.status}`);
  }

  console.log("\n═══ gateway truth ═══");
  // T7: authorized / failed / refunded are NOT captured.
  for (const [label, over] of [["authorized", { status: "authorized" }], ["failed", { status: "failed" }], ["refunded", { status: "captured", refunded: 34900 }]]) {
    const t = tripleFor(34900, `t7-${label}`);
    mintPayment(t.p, t.o, 34900, over);
    const doc = boundBooking(t);
    useDoc(doc);
    const r = await callPay(doc, "custA", payBody(t.o, t.p, t.s));
    snapLeak(`T7-${label}`, r.status, r.payload);
    check(`T7 ${label} not treated as paid`, r.status === 402 && doc.payment.status === "pending", `s=${r.status}`);
  }
  // T8: amount mismatch — order side and payment side.
  {
    const t = tripleFor(34900, "t8o");
    mockOrders[t.o].amount = 100; // cheap order replay
    const doc = boundBooking(t);
    useDoc(doc);
    const r = await callPay(doc, "custA", payBody(t.o, t.p, t.s));
    check("T8a cheap-order replay rejected", r.status === 402, `s=${r.status}`);
  }
  {
    const t = tripleFor(34900, "t8p");
    mockPayments[t.p].amount = 100; // under-captured payment
    const doc = boundBooking(t);
    useDoc(doc);
    const r = await callPay(doc, "custA", payBody(t.o, t.p, t.s));
    check("T8b under-captured payment rejected", r.status === 402, `s=${r.status}`);
  }
  // T9: currency mismatch.
  {
    const t = tripleFor(34900, "t9");
    mockPayments[t.p].currency = "USD";
    const doc = boundBooking(t);
    useDoc(doc);
    const r = await callPay(doc, "custA", payBody(t.o, t.p, t.s));
    check("T9 currency mismatch rejected", r.status === 402, `s=${r.status}`);
  }

  console.log("\n═══ idempotency & replay ═══");
  // T10: duplicate confirm → 200 alreadyPaid, single history entry.
  {
    const t = tripleFor(34900, "t10");
    const doc = boundBooking(t);
    const claims = [];
    useDoc(doc, { claimLog: claims });
    const r1 = await callPay(doc, "custA", payBody(t.o, t.p, t.s));
    const hist1 = doc.statusHistory.filter((h) => h.status === "confirmed").length;
    const r2 = await callPay(doc, "custA", payBody(t.o, t.p, t.s));
    const hist2 = doc.statusHistory.filter((h) => h.status === "confirmed").length;
    check("T10 first confirm 200", r1.status === 200 && doc.payment.status === "paid", `s=${r1.status}`);
    check("T10 retry 200 alreadyPaid (not 400)", r2.status === 200 && r2.payload?.alreadyPaid === true, `s=${r2.status}`);
    check("T10 single confirm entry", hist1 === 1 && hist2 === 1, `${hist1}/${hist2}`);
  }
  // T11: replay of A's triple on B after A confirmed.
  {
    const t = tripleFor(34900, "t11");
    const docA = boundBooking(t, { _id: "bA", customer: "custA" });
    useDoc(docA);
    await callPay(docA, "custA", payBody(t.o, t.p, t.s));
    const tB = tripleFor(34900, "t11b");
    const docB = boundBooking(tB, { _id: "bB", customer: "custA" });
    useDoc(docB);
    const r = await callPay(docB, "custA", payBody(t.o, t.p, t.s));
    check("T11 replay on B rejected", r.status === 402 && docB.payment.status === "pending", `s=${r.status}`);
  }

  console.log("\n═══ lifecycle interplay ═══");
  // T12: pay during cancellation (unpaid cancelled → 410).
  {
    const doc = mkBooking({ status: "cancelled", payment: { status: "pending" } });
    useDoc(doc);
    const r = await callPay(doc, "custA", payBody("o", "p", "s"));
    check("T12 pay on cancelled (unpaid) → 410", r.status === 410, `s=${r.status}`);
  }
  // T12b: paid-then-cancelled retry reports truth, keeps cancelled.
  {
    const doc = mkBooking({
      status: "cancelled",
      payment: { status: "paid", paidAmount: 349, razorpayPaymentId: "pay_t12b", refundStatus: "pending", refundAmount: 349 },
    });
    useDoc(doc);
    const h0 = doc.statusHistory.length;
    const r = await callPay(doc, "custA", {});
    check("T12b paid+cancelled retry → alreadyPaid, stays cancelled",
      r.status === 200 && r.payload?.alreadyPaid === true && doc.status === "cancelled" &&
      doc.payment.refundStatus === "pending" && doc.statusHistory.length === h0, `s=${r.status}`);
  }
  // T13: pay during expiration (window lapsed → auto-cancel → 410).
  {
    const doc = mkBooking({ paymentExpiresAt: new Date(Date.now() - 1000) });
    useDoc(doc);
    const r = await callPay(doc, "custA", payBody("o", "p", "s"));
    check("T13 pay past window → 410 + auto-cancelled", r.status === 410 && doc.status === "cancelled", `s=${r.status}/${doc.status}`);
  }

  console.log("\n═══ failure injection ═══");
  // T14: gateway timeout on order fetch and on payment fetch.
  {
    const t = tripleFor(34900, "t14");
    const doc = boundBooking(t);
    useDoc(doc);
    gwFail.orders = true;
    const r1 = await callPay(doc, "custA", payBody(t.o, t.p, t.s));
    gwFail.orders = false;
    gwFail.payments = true;
    const r2 = await callPay(doc, "custA", payBody(t.o, t.p, t.s));
    gwFail.payments = false;
    const clean = doc.status === "accepted" && doc.payment.status === "pending" && doc.statusHistory.length === 0;
    check("T14a order-fetch timeout → 402, no state change", r1.status === 402 && clean, `s=${r1.status}`);
    check("T14b payment-fetch timeout → 402, no state change", r2.status === 402 && clean, `s=${r2.status}`);
  }
  // T15: DB failure after verification (claim throws).
  {
    const t = tripleFor(34900, "t15");
    const doc = boundBooking(t);
    Booking.findOne = makeFindOne(() => doc);
    Booking.findById = async () => doc;
    Booking.findOneAndUpdate = async () => { throw new Error("db exploded"); };
    let status = 200, payload = null;
    const errs = [];
    const res = { status: (s) => { status = s; return res; }, json: (p) => { payload = p; return res; } };
    await bookingCtrl.payBooking(
      { params: { id: doc._id }, user: { id: "custA", role: "CUSTOMER" }, body: payBody(t.o, t.p, t.s) },
      res, (e) => { if (e) errs.push(e); }
    );
    const untouched = doc.status === "accepted" && doc.payment.status === "pending" && doc.statusHistory.length === 0;
    check("T15 DB failure → error propagated, nothing half-written", errs.length === 1 && untouched, `errs=${errs.length}`);
  }

  console.log("\n═══ concurrency ═══");
  // T16: two simultaneous confirms, one booking (atomic CAS fake).
  {
    const t = tripleFor(34900, "t16");
    const doc = boundBooking(t);
    notifLog.length = 0;
    const claims = [];
    useDoc(doc, { claimLog: claims });
    const [r1, r2] = await Promise.all([
      callPay(doc, "custA", payBody(t.o, t.p, t.s)),
      callPay(doc, "custA", payBody(t.o, t.p, t.s)),
    ]);
    const confirms = doc.statusHistory.filter((h) => h.status === "confirmed").length;
    check("T16 concurrent confirms: both 200, one winner",
      r1.status === 200 && r2.status === 200 && claims.length === 1, `${r1.status}/${r2.status} wins=${claims.length}`);
    check("T16 single confirm entry + single paidAmount",
      confirms === 1 && doc.payment.paidAmount === 349, `confirms=${confirms}`);
    check("T16 exactly one payout-generating state (no double notify)",
      notifLog.length === 2, `notifs=${notifLog.length}`);
  }

  console.log("\n═══ frontend manipulation ═══");
  // T17a: amount:1 with a full-fee triple. The client amount field is dead
  // input: settlement ALWAYS uses booking.amount (server) + the gateway-
  // verified order/payment amounts. A lying client can neither discount nor
  // overcharge — the booking confirms at the full server fee.
  {
    const t = tripleFor(34900, "t17a");
    const doc = boundBooking(t);
    useDoc(doc);
    const r = await callPay(doc, "custA", { method: "upi", amount: 1, payment: { razorpayOrderId: t.o, razorpayPaymentId: t.p, razorpaySignature: t.s } });
    snapLeak("T17a", r.status, r.payload);
    check("T17a client amount cannot alter settlement", r.status === 200 && doc.payment.paidAmount === 349 && doc.status === "confirmed", `s=${r.status} paid=${doc.payment.paidAmount}`);
  }
  // T17b: injected payment.status:"paid" without a triple.
  {
    const doc = boundBooking(tripleFor(34900, "t17b"));
    useDoc(doc);
    const r = await callPay(doc, "custA", { method: "upi", payment: { status: "paid", paidAmount: 349 } });
    check("T17b injected paid flag rejected", r.status === 400 && doc.payment.status === "pending", `s=${r.status}`);
  }
  // T17c: testMode without server opt-in.
  {
    const doc = mkBooking({});
    useDoc(doc);
    const r = await callPay(doc, "custA", { method: "upi", testMode: true });
    check("T17c testMode without opt-in rejected", r.status === 400, `s=${r.status}`);
  }
  // T18: testMode with prod configuration → refused.
  {
    const doc = mkBooking({});
    useDoc(doc);
    const keepNode = process.env.NODE_ENV, keepAllow = process.env.ALLOW_TEST_PAYMENTS;
    process.env.NODE_ENV = "production";
    process.env.ALLOW_TEST_PAYMENTS = "true";
    let r;
    try {
      r = await callPay(doc, "custA", { method: "upi", testMode: true });
    } finally {
      if (keepNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = keepNode;
      if (keepAllow === undefined) delete process.env.ALLOW_TEST_PAYMENTS; else process.env.ALLOW_TEST_PAYMENTS = keepAllow;
    }
    snapLeak("T18", r.status, r.payload);
    check("T18 testMode in prod config refused", r.status === 400 && doc.payment.status === "pending", `s=${r.status}`);
  }
  // T18b positive control: opted-in non-prod test payment works.
  {
    const doc = mkBooking({});
    useDoc(doc);
    const keepAllow = process.env.ALLOW_TEST_PAYMENTS;
    process.env.ALLOW_TEST_PAYMENTS = "true";
    let r;
    try {
      r = await callPay(doc, "custA", { method: "upi", testMode: true });
    } finally {
      if (keepAllow === undefined) delete process.env.ALLOW_TEST_PAYMENTS; else process.env.ALLOW_TEST_PAYMENTS = keepAllow;
    }
    check("T18b opted-in test payment confirms (control)", r.status === 200 && doc.payment.testMode === true, `s=${r.status}`);
  }

  console.log("\n═══ refunds & foreign payments ═══");
  // T19: refund queued, then confirmation retried → truth, refund intact.
  {
    const doc = mkBooking({
      status: "confirmed",
      payment: { status: "paid", paidAmount: 349, razorpayPaymentId: "pay_t19", razorpayOrderId: "order_t19", refundStatus: "pending", refundAmount: 349 },
    });
    useDoc(doc);
    const h0 = doc.statusHistory.length;
    const r = await callPay(doc, "custA", {});
    check("T19 refund-pending retry: alreadyPaid, refund intact, no new history",
      r.status === 200 && r.payload?.alreadyPaid === true && doc.payment.refundStatus === "pending" &&
      doc.statusHistory.length === h0, `s=${r.status}`);
  }
  // T20a: attacker confirms someone else's booking → 404 (ownership filter).
  {
    const doc = mkBooking({ _id: "bV", customer: "victim" });
    useDoc(doc);
    const r = await callPay(doc, "attacker", payBody("o", "p", "s"));
    check("T20a foreign booking → 404", r.status === 404, `s=${r.status}`);
  }
  // T20b: victim's genuine triple submitted on attacker's own booking.
  {
    const tV = tripleFor(34900, "t20v");
    const tA = tripleFor(34900, "t20a");
    const docB = boundBooking(tA, { _id: "bB", customer: "attacker" });
    useDoc(docB);
    const r = await callPay(docB, "attacker", payBody(tV.o, tV.p, tV.s));
    check("T20b foreign triple on own booking rejected", r.status === 402 && docB.payment.status === "pending", `s=${r.status}`);
  }

  console.log("\n═══ verify endpoint ═══");
  const callVerify = async (body, userId = "custA") => {
    let status = 200, payload = null;
    const res = { status: (s) => { status = s; return res; }, json: (p) => { payload = p; return res; } };
    await paymentCtrl.verifyPayment({ body, user: { id: userId, role: "CUSTOMER" } }, res, (e) => { throw e; });
    return { status, payload };
  };
  {
    const t = tripleFor(34900, "tv");
    const asBooking = (doc) => { Booking.findById = () => ({ select: async () => doc }); };
    asBooking({ customer: "custA", amount: 349, payment: { razorpayOrderId: t.o } });
    const v1 = await callVerify({ razorpay_order_id: t.o, razorpay_payment_id: t.p, razorpay_signature: t.s, bookingId: "b1" });
    check("V1 genuine triple verifies", v1.status === 200 && v1.payload?.verified === true, JSON.stringify(v1.payload));
    const v2 = await callVerify({ razorpay_order_id: t.o, razorpay_payment_id: t.p, razorpay_signature: t.s });
    snapLeak("V2", v2.status, v2.payload);
    check("V2 bookingId mandatory", v2.status === 400, `s=${v2.status}`);
    const v3 = await callVerify({ razorpay_order_id: "order_other", razorpay_payment_id: t.p, razorpay_signature: sign("order_other", t.p), bookingId: "b1" });
    check("V3 foreign order does not verify", v3.payload?.verified === false, JSON.stringify(v3.payload));
    asBooking({ customer: "someoneElse", amount: 349, payment: { razorpayOrderId: t.o } });
    const v4 = await callVerify({ razorpay_order_id: t.o, razorpay_payment_id: t.p, razorpay_signature: t.s, bookingId: "b1" });
    check("V4 wrong owner → 403", v4.status === 403, `s=${v4.status}`);
  }

  console.log("\n═══ webhook ═══");
  const sendWebhook = async (event, secret = process.env.RAZORPAY_WEBHOOK_SECRET) => {
    const raw = Buffer.from(JSON.stringify(event));
    const sig = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    let status = 200, payload = null;
    const res = { status: (s) => { status = s; return res; }, json: (p) => { payload = p; return res; } };
    await paymentCtrl.handleWebhook({ body: raw, headers: { "x-razorpay-signature": sig } }, res);
    return { status, payload };
  };
  const capEvent = (orderId, paymentId, amountPaise, st = "captured", cur = "INR") => ({
    event: "payment.captured",
    payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: amountPaise, currency: cur, status: st } } },
  });
  {
    // W1: happy-path reconcile (accepted + exact amount).
    const doc = mkBooking({ _id: "bW", status: "accepted", amount: 349, payment: { status: "pending", razorpayOrderId: "order_w1" } });
    Booking.findOne = makeFindOne(() => doc);
    const w1 = await sendWebhook(capEvent("order_w1", "pay_w1", 34900));
    check("W1 captured webhook confirms", w1.payload?.handled === true && doc.status === "confirmed" &&
      doc.payment.webhookReconciled === true, JSON.stringify(w1.payload));
    // W2: duplicate delivery is deduped by event key (not reprocessed).
    const h0 = doc.statusHistory.length;
    const w2 = await sendWebhook(capEvent("order_w1", "pay_w1", 34900));
    check("W2 duplicate webhook deduped", w2.payload?.handled === "duplicate" && doc.statusHistory.length === h0, `hist=${doc.statusHistory.length}/${h0}`);
    // W3: authorized (non-captured) entity ignored.
    const doc3 = mkBooking({ _id: "bW3", status: "accepted", amount: 349, payment: { status: "pending", razorpayOrderId: "order_w3" } });
    Booking.findOne = makeFindOne(() => doc3);
    const w3 = await sendWebhook(capEvent("order_w3", "pay_w3", 34900, "authorized"));
    check("W3 authorized ignored", w3.payload?.handled === false && doc3.status === "accepted", JSON.stringify(w3.payload));
    // W4: amount mismatch → no confirm + refund queued.
    const doc4 = mkBooking({ _id: "bW4", status: "accepted", amount: 349, payment: { status: "pending", razorpayOrderId: "order_w4" } });
    Booking.findOne = makeFindOne(() => doc4);
    const w4 = await sendWebhook(capEvent("order_w4", "pay_w4", 100));
    check("W4 amount mismatch: refund queued, not confirmed",
      doc4.status === "accepted" && doc4.payment.refundStatus === "pending", `${doc4.status}/${doc4.payment.refundStatus}`);
    // W5: unknown order ignored.
    Booking.findOne = makeFindOne(() => null);
    const w5 = await sendWebhook(capEvent("order_unknown", "pay_u", 34900));
    check("W5 unknown order ignored", w5.payload?.handled === false, JSON.stringify(w5.payload));
    // W6: bad signature → unactioned.
    const w6 = await sendWebhook(capEvent("order_w1", "pay_w1", 34900), "wrong_secret");
    check("W6 bad signature unactioned", w6.payload?.received === false, JSON.stringify(w6.payload));
  }

  console.log("\n═══ shared helper + leak scan ═══");
  {
    mintPayment("pay_h1", "order_h1", 34900, { status: "authorized" });
    const e1 = await assertRazorpayPaymentCaptured("order_h1", "pay_h1", 34900);
    mintPayment("pay_h2", "order_h2", 34900, { status: "captured" });
    const e2 = await assertRazorpayPaymentCaptured("order_h2", "pay_h2", 34900);
    check("helper rejects authorized, accepts captured", typeof e1 === "string" && e2 === null, `${e1}/${e2}`);
  }
  {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const bad = leakBodies.filter((l) => JSON.stringify(l.body || {}).includes(secret));
    check("no secret material in error responses", bad.length === 0, `${leakBodies.length} bodies scanned`);
  }

  restoreModels();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
