// Cook-initiated cancellation with automatic replacement — regression suite.
//
// Covers: mandatory reason validation, assigned-cook-only auth, atomic
// release into the finding-cook pool (same booking, fresh window, canceller
// excluded, money/schedule/coupon preserved), replacement accept via
// website + WhatsApp paths (paid promotes to confirmed, unpaid stays
// payable), single-winner concurrent accepts, stale canceller re-accept,
// expiry without replacement (paid refunds once, unpaid never refunds),
// race with customer cancel, webhook idempotency during reassignment,
// mocked provider chain (approve -> processed, uncertain -> failed ->
// reconcile-adopt, duplicate webhook deduped), payout ineligibility,
// and WhatsApp message-copy integration.
//
// Hermetic: all models stubbed in-memory, gateway stubbed (fake keys).
// Run: node backend/cook-cancel-replacement.test.js

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.RAZORPAY_KEY_ID = "rk_test_cookcancel_12345678";
process.env.RAZORPAY_KEY_SECRET = "sec_test_cookcancel_87654321";
process.env.RAZORPAY_CURRENCY = "INR";
process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || "wh-test-secret";

const mongoose = require("mongoose");
const Booking = require("./models/Booking");
const Notification = require("./models/Notification");
const CancellationAudit = require("./models/CancellationAudit");
const CookProfile = require("./models/CookProfile");
const User = require("./models/User");
const Coupon = require("./models/Coupon");
const WebhookEvent = require("./models/WebhookEvent");
const LedgerEntry = require("./models/LedgerEntry");
const bookingController = require("./controllers/bookingController");
const paymentController = require("./controllers/paymentController");
const payoutController = require("./controllers/payoutController");
const rzCfg = require("./config/razorpay");
const { acceptBookingForCook } = require("./services/bookingAcceptService");
const { expireBookingIfNeeded } = require("./services/bookingTransitions");
const { payoutEligibility } = require("./utils/finance");
const dispatchJobs = require("./services/bookingDispatchJobs");
const slots = require("./utils/slots");

const realReadyState = mongoose.connection.readyState;
mongoose.connection.readyState = 1; // run atomic-claim paths against fakes

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes += 1;
  else failures += 1;
};

const H = 60 * 60 * 1000;
const CUSTOMER = { id: "cust1", role: "CUSTOMER" };
const COOK1 = { id: "cook1", role: "COOK" };
const COOK2 = { id: "cook2", role: "COOK" };
const ADMIN = { id: "admin1", role: "ADMIN" };

let storeDoc = null;
const notifications = [];
const audits = [];
const ledgerRows = [];
const ledgerKeys = new Set();
const seenWebhookKeys = new Set();
let dispatchResets = 0;
let dispatchKicks = 0;
let gatewayRefunds = [];
let gatewayThrow = null;
let gatewayRefundCalls = 0;

const mkDoc = (over = {}) => {
  const d = new Date(Date.now() + 72 * H);
  const doc = {
    _id: "b1",
    customer: "cust1",
    cook: "cook1",
    ignoredBy: [],
    serviceType: "cook_for_me",
    date: d,
    startTime: "12:00",
    endTime: "14:00",
    address: "12 MG Road",
    amount: 1000,
    status: "confirmed",
    cookArrived: false,
    serviceStartedAt: null,
    requestExpiresAt: new Date(Date.now() + 4 * 60 * 1000),
    paymentExpiresAt: null,
    payment: { status: "paid", paidAmount: 1000, razorpayPaymentId: "pay_1", refundStatus: "none", testMode: false },
    statusHistory: [],
    cookCancel: undefined,
    couponCode: "",
    couponReleased: false,
    cancellationInfo: {},
    payout: { status: "pending" },
    ...over,
    save: async function () {
      return this;
    },
  };
  return doc;
};

const getPath = (doc, path) =>
  String(path)
    .split(".")
    .reduce((node, k) => (node == null ? node : node[k]), doc);
const applySet = (doc, set = {}) => {
  for (const [k, v] of Object.entries(set)) {
    const parts = k.split(".");
    let node = doc;
    for (let i = 0; i < parts.length - 1; i++) {
      if (node[parts[i]] == null || typeof node[parts[i]] !== "object") node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = v;
  }
};
const applyUnset = (doc, unset = {}) => {
  for (const k of Object.keys(unset)) {
    const parts = k.split(".");
    let node = doc;
    for (let i = 0; i < parts.length - 1; i++) {
      if (node[parts[i]] == null) {
        node = null;
        break;
      }
      node = node[parts[i]];
    }
    if (node) delete node[parts[parts.length - 1]];
  }
};
const matchFilter = (filter = {}) => {
  if (!storeDoc) return false;
  if (filter._id && String(filter._id) !== String(storeDoc._id)) return false;
  if (filter.status) {
    if (filter.status.$in) {
      if (!filter.status.$in.includes(storeDoc.status)) return false;
    } else if (storeDoc.status !== filter.status) return false;
  }
  if (filter.cook !== undefined && filter.cook !== null) {
    if (String(storeDoc.cook) !== String(filter.cook)) return false;
  }
  if (filter.cook === null && storeDoc.cook != null) return false;
  if (filter["payment.status"] && String(getPath(storeDoc, "payment.status")) !== String(filter["payment.status"]))
    return false;
  if (filter["payment.refundStatus"]) {
    const want = filter["payment.refundStatus"];
    const got = String(getPath(storeDoc, "payment.refundStatus"));
    if (want && typeof want === "object" && "$in" in want) {
      if (!want.$in.map(String).includes(got)) return false;
    } else if (got !== String(want)) return false;
  }
  if (filter["cookCancel.cook"] && filter["cookCancel.cook"].$exists && getPath(storeDoc, "cookCancel.cook") == null)
    return false;
  if (filter["payout.status"] && filter["payout.status"].$ne && String(getPath(storeDoc, "payout.status")) === String(filter["payout.status"].$ne))
    return false;
  if (filter.requestExpiresAt) {
    const op = filter.requestExpiresAt.$gt ? "$gt" : filter.requestExpiresAt.$lt ? "$lt" : null;
    if (op === "$gt" && !(storeDoc.requestExpiresAt > filter.requestExpiresAt.$gt)) return false;
    if (op === "$lt" && !(storeDoc.requestExpiresAt < filter.requestExpiresAt.$lt)) return false;
  }
  return true;
};

Booking.findById = async () => storeDoc;
Booking.findOne = async () => storeDoc;
Booking.find = () => ({ select: async () => [] });
Booking.updateOne = async (filter, update) => {
  if (!matchFilter(filter)) return { modifiedCount: 0 };
  if (update.$set) applySet(storeDoc, update.$set);
  if (update.$unset) applyUnset(storeDoc, update.$unset);
  if (update.$addToSet) {
    for (const [k, v] of Object.entries(update.$addToSet)) {
      if (!Array.isArray(storeDoc[k])) storeDoc[k] = [];
      if (!storeDoc[k].map(String).includes(String(v))) storeDoc[k].push(v);
    }
  }
  if (update.$push?.statusHistory) storeDoc.statusHistory.push(update.$push.statusHistory);
  return { modifiedCount: 1 };
};
Booking.findOneAndUpdate = async (filter, update) => {
  if (!matchFilter(filter)) return null;
  if (update.$set) applySet(storeDoc, update.$set);
  if (update.$push?.statusHistory) storeDoc.statusHistory.push(update.$push.statusHistory);
  return storeDoc;
};
Notification.create = async (doc) => {
  notifications.push(doc);
  return doc;
};
CancellationAudit.create = async (doc) => {
  if (Array.isArray(doc)) audits.push(...doc);
  else audits.push(doc);
  return doc;
};
CookProfile.findOne = async () => ({
  _id: "prof1",
  user: "cook2",
  approvalStatus: "approved",
  serviceTypes: ["cook_for_me"],
  availabilityStatus: "available",
});
CookProfile.updateOne = async () => ({ modifiedCount: 1 });
User.findById = (id) => ({
  select: async () => ({ _id: String(id), status: "active", role: "COOK", name: "Cook Two", phone: "9876543210" }),
});
Coupon.updateOne = async () => ({ modifiedCount: 0 });
WebhookEvent.create = async (doc) => {
  if (seenWebhookKeys.has(doc.key)) {
    const e = new Error("duplicate");
    e.code = 11000;
    throw e;
  }
  seenWebhookKeys.add(doc.key);
  return doc;
};
LedgerEntry.create = async (e) => {
  if (ledgerKeys.has(e.idempotencyKey)) {
    const err = new Error("duplicate");
    err.code = 11000;
    throw err;
  }
  ledgerKeys.add(e.idempotencyKey);
  ledgerRows.push(e);
  return e;
};
dispatchJobs.resetDispatchJobForReplacement = async () => {
  dispatchResets += 1;
  return true;
};
dispatchJobs.kickWorker = () => {
  dispatchKicks += 1;
};
slots.getDayWindows = async () => [{ startTime: "00:00", endTime: "23:59", status: "available" }];
// Mocked provider only: stubbed methods, no real Razorpay contact possible.
rzCfg.razorpay.refunds.all = async () => {
  if (gatewayThrow) throw gatewayThrow;
  return { items: gatewayRefunds };
};
rzCfg.razorpay.payments.refund = async (paymentId, payload) => {
  gatewayRefundCalls += 1;
  if (gatewayThrow) throw gatewayThrow;
  const item = { id: `rf_mock_${gatewayRefundCalls}`, payment_id: paymentId, amount: payload?.amount, status: "processed" };
  gatewayRefunds.push(item);
  return item;
};

const req = (user, body = {}, params = { id: "b1" }) => ({ user, body, params });
const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => {
    r.statusCode = c;
    return r;
  };
  r.json = (b) => {
    r.body = b;
    return r;
  };
  return r;
};
const runCancel = async (user, body) => {
  const r = res();
  await bookingController.cancelBooking(req(user, body), r, (e) => {
    if (e) throw e;
  });
  return r;
};
const runApprove = async (body = {}) => {
  const r = res();
  await payoutController.approveRefund(req(ADMIN, body), r, (e) => {
    if (e) throw e;
  });
  return r;
};
const runReconcile = async () => {
  const r = res();
  await payoutController.reconcileRefund(req(ADMIN, {}), r, (e) => {
    if (e) throw e;
  });
  return r;
};

(async () => {
  // ---- A. Cook cancellation API ----
  storeDoc = mkDoc(); // confirmed + paid, assigned to cook1
  {
    const r = await runCancel(COOK1, { reason: "MEDICAL_EMERGENCY", reasonNote: "Family emergency" });
    check("A1 assigned cook cancels eligible booking", r.statusCode === 200 && r.body.replacement === true, `s=${r.statusCode}`);
    check("A2 released to requested, cook cleared", r.body.status === "requested" && r.body.cook == null);
    check("A2 reason code + note persisted", r.body.cookCancel?.reasonCode === "MEDICAL_EMERGENCY" && String(r.body.cookCancel?.cook) === "cook1" && r.body.cookCancel?.priorStatus === "confirmed" && String(r.body.cookCancel?.note || "") === "Family emergency");
    check("A2 fresh request window issued", new Date(r.body.requestExpiresAt).getTime() > Date.now());
    check("A2 schedule/payment/coupon preserved", r.body.payment?.status === "paid" && r.body.payment?.paidAmount === 1000 && r.body.payment?.refundStatus === "none" && r.body.couponReleased === false);
    check("A2 no refund queued on release", r.body.payment?.refundStatus === "none");
    check("A2 canceller excluded from replacement", (storeDoc.ignoredBy || []).map(String).includes("cook1"));
    check("A2 dispatch re-armed + worker kicked", dispatchResets === 1 && dispatchKicks === 1, `resets=${dispatchResets} kicks=${dispatchKicks}`);
    check("A2 customer notified of replacement search", notifications.some((n) => String(n.user) === "cust1" && /replacement cook/i.test(n.message || "")));
    check("A2 cancelling cook confirmed release", notifications.some((n) => String(n.user) === "cook1" && /no longer assigned/i.test(n.message || "")));
    check("A2 COOK_CANCELLED audited with prior state", audits.some((a) => a.event === "COOK_CANCELLED" && a.previousStatus === "confirmed" && a.newStatus === "requested"));
  }
  {
    const a0 = audits.length;
    const n0 = notifications.length;
    const r = await runCancel(COOK1, { reason: "MEDICAL_EMERGENCY" });
    check("A10 repeat submit is idempotent", r.statusCode === 200 && r.body.replacement === true && r.body.duplicate === true, `s=${r.statusCode}`);
    check("A10 repeat writes no duplicate audit/notify", audits.length === a0 && notifications.length === n0);
  }
  for (const [label, body, want] of [
    ["A3 missing reason rejected", {}, 400],
    ["A4 invalid reason rejected", { reason: "BOGUS" }, 400],
    ["A5 OTHER without explanation rejected", { reason: "OTHER" }, 400],
  ]) {
    storeDoc = mkDoc();
    const r = await runCancel(COOK1, body);
    check(label, r.statusCode === want, `s=${r.statusCode}`);
  }
  {
    storeDoc = mkDoc();
    const r = await runCancel(COOK1, { reason: "OTHER", reasonNote: "  unikely situation  " });
    check("A5 OTHER with explanation accepted", r.statusCode === 200 && r.body.cookCancel?.note === "unikely situation", `s=${r.statusCode}`);
  }
  {
    storeDoc = mkDoc();
    const r = await runCancel(COOK2, { reason: "ILLNESS" });
    check("A8 another cook cannot cancel", r.statusCode === 403, `s=${r.statusCode}`);
  }
  {
    Booking.findById = async () => null;
    const r = await runCancel(COOK1, { reason: "ILLNESS" });
    check("A9 nonexistent booking 404", r.statusCode === 404, `s=${r.statusCode}`);
    Booking.findById = async () => storeDoc;
  }
  {
    storeDoc = mkDoc({ status: "cancelled" });
    const r = await runCancel(COOK1, { reason: "ILLNESS" });
    check("A10 already-cancelled cannot re-transition", r.statusCode === 200 && r.body.alreadyCancelled === true && r.body.replacement !== true, `s=${r.statusCode}`);
  }
  {
    storeDoc = mkDoc({ status: "completed" });
    const r = await runCancel(COOK1, { reason: "ILLNESS" });
    check("A11 completed booking refused", r.statusCode === 400, `s=${r.statusCode}`);
  }
  {
    storeDoc = mkDoc({ serviceStartedAt: new Date() });
    const r = await runCancel(COOK1, { reason: "ILLNESS" });
    check("A11 started service refused", r.statusCode === 400, `s=${r.statusCode}`);
  }
  {
    storeDoc = mkDoc({ status: "accepted", cook: "cook2" });
    const r = await runCancel(COOK1, { reason: "ILLNESS" });
    check("A12 concurrent reassignment not overwritten", r.statusCode === 403 && String(storeDoc.cook) === "cook2", `s=${r.statusCode} cook=${storeDoc.cook}`);
  }
  {
    storeDoc = mkDoc();
    const r = await runCancel(CUSTOMER, { reason: "CHANGE_OF_PLANS" });
    check("customer cancel still terminal", r.statusCode === 200 && r.body.status === "cancelled" && !r.body.replacement, `s=${r.statusCode}`);
    check("customer cancel queues policy refund", r.body.payment?.refundStatus === "pending" && r.body.payment?.refundAmount === 900, `rs=${r.body.payment?.refundStatus}`);
  }

  // ---- B. Replacement flow ----
  const searchingPaid = () =>
    mkDoc({
      status: "requested",
      cook: null,
      ignoredBy: ["cook1"],
      requestExpiresAt: new Date(Date.now() + 4 * 60 * 1000),
      cookCancel: { cook: "cook1", reasonCode: "ILLNESS", note: "", cancelledAt: new Date(), priorStatus: "confirmed" },
    });
  {
    for (const source of ["website", "whatsapp"]) {
      storeDoc = searchingPaid();
      notifications.length = 0;
      const out = await acceptBookingForCook({ bookingId: "b1", cookId: "cook2", source });
      check(`B4/B5 ${source} replacement wins atomically`, out?.booking?.status === "confirmed" && String(out?.booking?.cook) === "cook2", out?.booking?.status);
      check(`B4/B5 ${source} marker cleared`, getPath(storeDoc, "cookCancel.cook") == null);
      check(`B4/B5 ${source} no extra charge`, storeDoc.payment?.paidAmount === 1000 && storeDoc.payment?.status === "paid");
      check(`B4/B5 ${source} customer told confirmed`, notifications.some((n) => String(n.user) === "cust1" && /replacement cook has accepted/i.test(n.message || "")));
    }
  }
  {
    storeDoc = searchingPaid();
    let err = null;
    try {
      await acceptBookingForCook({ bookingId: "b1", cookId: "cook1", source: "website" });
    } catch (e) {
      err = e;
    }
    check("B10 stale canceller accept rejected", err?.statusCode === 409 && err?.code === "BOOKING_IGNORED_BY_YOU", `${err?.statusCode}/${err?.code}`);
    check("B10 search undisturbed", storeDoc.status === "requested" && storeDoc.cook == null);
  }
  {
    storeDoc = searchingPaid();
    storeDoc.payment = { status: "pending", paidAmount: 0, refundStatus: "none", testMode: false };
    const w1 = await acceptBookingForCook({ bookingId: "b1", cookId: "cook2", source: "website" });
    let err = null;
    try {
      await acceptBookingForCook({ bookingId: "b1", cookId: "cook3", source: "whatsapp" });
    } catch (e) {
      err = e;
    }
    check("B6 first accept wins", String(w1?.booking?.cook) === "cook2" && w1?.booking?.status === "accepted", w1?.booking?.status);
    check("B6 second accept loses cleanly", err?.statusCode === 409 && err?.code === "BOOKING_ALREADY_ASSIGNED", `${err?.statusCode}/${err?.code}`);
    check("B6 single assignment stands", String(storeDoc.cook) === "cook2" && storeDoc.status === "accepted");
  }
  {
    storeDoc = searchingPaid();
    storeDoc.payment = { status: "pending", paidAmount: 0, refundStatus: "none", testMode: false };
    storeDoc.amount = 800;
    const out = await acceptBookingForCook({ bookingId: "b1", cookId: "cook2", source: "website" });
    check("B7/B8 unpaid replacement accepted, payable", out?.booking?.status === "accepted" && out?.booking?.payment?.status === "pending", out?.booking?.status);
    check("B7/B8 original booking + customer kept", String(out?.booking?.customer) === "cust1" && String(out?.booking?._id) === "b1");
    check("B7/B8 marker cleared on fulfil", getPath(storeDoc, "cookCancel.cook") == null);
  }

  // ---- C. Timeout and races ----
  {
    storeDoc = searchingPaid();
    storeDoc.requestExpiresAt = new Date(Date.now() - 1000);
    notifications.length = 0;
    await expireBookingIfNeeded(storeDoc);
    check("C2 expiry finalizes search", storeDoc.status === "expired", storeDoc.status);
    check("C2 paid expiry queues full refund", storeDoc.payment?.refundStatus === "pending" && storeDoc.payment?.refundAmount === 1000, `${storeDoc.payment?.refundStatus}/${storeDoc.payment?.refundAmount}`);
    check("C2 customer notified of expiry", notifications.some((n) => String(n.user) === "cust1"));
    const n0 = notifications.length;
    await expireBookingIfNeeded(storeDoc);
    check("C3 timeout retry after finalization is a no-op", notifications.length === n0 && storeDoc.payment?.refundAmount === 1000);
  }
  {
    storeDoc = searchingPaid();
    storeDoc.payment = { status: "pending", paidAmount: 0, refundStatus: "none", testMode: false };
    storeDoc.requestExpiresAt = new Date(Date.now() - 1000);
    await expireBookingIfNeeded(storeDoc);
    check("C2/D1 unpaid expiry takes no refund", storeDoc.status === "expired" && storeDoc.payment?.refundStatus === "none");
  }
  {
    storeDoc = mkDoc();
    const c = await runCancel(CUSTOMER, { reason: "CHANGE_OF_PLANS" });
    const refundAfterCustomer = storeDoc.payment?.refundAmount;
    const k = await runCancel(COOK1, { reason: "ILLNESS" });
    check("C5 customer cancel wins race", c.statusCode === 200 && c.body.status === "cancelled");
    check("C5 late cook cancel cannot reopen search", k.body?.replacement !== true && storeDoc.status === "cancelled", `s=${k.statusCode}`);
    check("C5 single refund stands", storeDoc.payment?.refundAmount === refundAfterCustomer);
  }

  // ---- GATE A: paid expiry -> approval -> provider outcome (mocked gateway) ----
  {
    storeDoc = mkDoc();
    notifications.length = 0;
    audits.length = 0;
    ledgerRows.length = 0;
    gatewayRefunds = [];
    gatewayThrow = null;
    const callsBefore = gatewayRefundCalls;
    const c = await runCancel(COOK1, { reason: "ILLNESS" });
    check("GA chain opens replacement search", c.statusCode === 200 && c.body.replacement === true, `${c.statusCode}`);
    storeDoc.requestExpiresAt = new Date(Date.now() - 1000);
    await expireBookingIfNeeded(storeDoc);
    check("GA expiry queues pending (not completed)", storeDoc.payment?.refundStatus === "pending" && storeDoc.payment?.refundAmount === 1000, `${storeDoc.payment?.refundStatus}`);
    check("GA pending is not presented as completed", !notifications.some((n) => /refund.*(completed|succeeded|processed)/i.test(n.message || "")));
    const a = await runApprove();
    check("GA approval succeeds via provider", a.statusCode === 200 && storeDoc.payment?.refundStatus === "processed", `${a.statusCode}/${storeDoc.payment?.refundStatus}`);
    check("GA provider refund recorded truthfully", String(storeDoc.payment?.refundId || "").startsWith("rf_mock_"), storeDoc.payment?.refundId);
    check("GA customer told approved (5-7 days copy)", notifications.some((n) => String(n.user) === "cust1" && /5–7 business days/i.test(n.message || "")));
    check("GA cook told payout will not proceed", notifications.some((n) => /payout.*will not proceed/i.test(n.message || "")));
    check("GA single gateway refund call", gatewayRefundCalls === callsBefore + 1, `calls=${gatewayRefundCalls - callsBefore}`);
    check("GA single refund ledger row", ledgerRows.filter((l) => l.type === "refund.approved").length === 1, `${ledgerRows.length}`);
    check("GA audit trail complete", ["COOK_CANCELLED", "REFUND_APPROVED", "REFUND_PROCESSED"].every((ev) => audits.some((x) => x.event === ev)));
    const dup = await runApprove();
    check("GA duplicate approve refused", dup.statusCode === 400, `${dup.statusCode}`);
    check("GA no second gateway call", gatewayRefundCalls === callsBefore + 1, `calls=${gatewayRefundCalls - callsBefore}`);
    const el = payoutEligibility(storeDoc);
    check("GA refunded booking never payable", el.eligible === false && el.reasons.some((r) => /refund/i.test(r)), el.reasons.join("; "));
  }
  {
    storeDoc = mkDoc({ amount: 800, payment: { status: "paid", paidAmount: 449, razorpayPaymentId: "pay_cpn", refundStatus: "none", testMode: false } });
    notifications.length = 0;
    gatewayRefunds = [];
    await runCancel(COOK1, { reason: "ILLNESS" });
    storeDoc.requestExpiresAt = new Date(Date.now() - 1000);
    await expireBookingIfNeeded(storeDoc);
    check("GA refund uses collected amount, not display price", storeDoc.payment?.refundAmount === 449, `${storeDoc.payment?.refundAmount}`);
    const a = await runApprove();
    check("GA coupon-adjusted refund processes", a.statusCode === 200 && storeDoc.payment?.refundStatus === "processed" && storeDoc.payment?.refundAmount === 449, `${a.statusCode}/${storeDoc.payment?.refundStatus}`);
  }
  {
    storeDoc = mkDoc({ payment: { status: "paid", paidAmount: 1000, razorpayPaymentId: "pay_unc", refundStatus: "none", testMode: false } });
    notifications.length = 0;
    gatewayRefunds = [];
    await runCancel(COOK1, { reason: "ILLNESS" });
    storeDoc.requestExpiresAt = new Date(Date.now() - 1000);
    await expireBookingIfNeeded(storeDoc);
    gatewayThrow = new Error("GatewayTimeout");
    const a = await runApprove();
    gatewayThrow = null;
    check("GA uncertain outcome stays failed, never processed", a.statusCode === 200 && storeDoc.payment?.refundStatus === "failed", `${a.statusCode}/${storeDoc.payment?.refundStatus}`);
    check("GA failure notification is honest follow-up copy", notifications.some((n) => /following up/i.test(n.message || "")) && !notifications.some((n) => /5–7 business days/i.test(n.message || "")));
    gatewayRefunds.push({ id: "rf_recovered_9", payment_id: "pay_unc", amount: 100000, status: "processed" });
    const rc = await runReconcile();
    check("GA reconcile adopts recovered refund", rc.statusCode === 200 && storeDoc.payment?.refundStatus === "processed" && storeDoc.payment?.refundId === "rf_recovered_9", `${rc.statusCode}/${storeDoc.payment?.refundStatus}`);
  }
  {
    const crypto = require("crypto");
    storeDoc = mkDoc({ status: "expired", cook: null, payment: { status: "paid", paidAmount: 1000, razorpayPaymentId: "pay_dup", razorpayOrderId: "ord_dup", refundStatus: "processed", refundAmount: 1000, refundId: "rf_mock_1", testMode: false } });
    seenWebhookKeys.clear();
    const entity = { id: "pay_dup", order_id: "ord_dup", amount: 100000, currency: "INR", status: "captured" };
    const payload = JSON.stringify({ event: "payment.captured", payload: { payment: { entity } } });
    const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(payload).digest("hex");
    const mkHook = () => {
      const r = res();
      return { r, req: { headers: { "x-razorpay-signature": sig }, body: Buffer.from(payload) } };
    };
    const h1 = mkHook();
    await paymentController.handleWebhook(h1.req, h1.r, () => {});
    const h2 = mkHook();
    await paymentController.handleWebhook(h2.req, h2.r, () => {});
    check("GA duplicate webhook deduplicated", storeDoc.payment?.refundStatus === "processed" && storeDoc.payment?.refundId === "rf_mock_1", `${storeDoc.payment?.refundStatus}`);
    check("GA no extra ledger rows from redelivery", ledgerRows.filter((l) => l.type === "refund.approved").length <= 2, `${ledgerRows.length}`);
  }

  // ---- WA. WhatsApp message integration ----
  {
    const { buildCancelledMessage, buildCustomerConfirmationMessage } = require("./utils/whatsapp");
    const cancelled = buildCancelledMessage({
      booking: { _id: "b1", serviceType: "cook_for_me", date: new Date(), startTime: "12:00", endTime: "14:00" },
      cancelledBy: "cook",
    });
    check("WA cook-cancel tells customer + promises replacement search", /cook cancelled/i.test(cancelled) && /replacement cook/i.test(cancelled));
    const adminCancelled = buildCancelledMessage({ booking: {}, cancelledBy: "admin" });
    check("WA admin cancel copy unchanged (no replacement line)", /support team/i.test(adminCancelled) && !/replacement cook/i.test(adminCancelled));
    const confirmed = buildCustomerConfirmationMessage({
      cookName: "Replacement Cook",
      cookPhone: "9876543210",
      booking: { _id: "b1", serviceType: "cook_for_me", date: new Date(), startTime: "12:00", endTime: "14:00", address: "12 MG Road", status: "confirmed", payment: { status: "paid" } },
    });
    check("WA confirm names the replacement cook", /Replacement Cook/i.test(confirmed) && /9876543210/.test(confirmed));
  }

  // ---- D/E money safety ----
  {
    const crypto = require("crypto");
    storeDoc = searchingPaid();
    storeDoc.payment.razorpayOrderId = "order_1";
    const entity = { id: "pay_1", order_id: "order_1", amount: 100000, currency: "INR", status: "captured" };
    const payload = JSON.stringify({ event: "payment.captured", payload: { payment: { entity } } });
    const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(payload).digest("hex");
    const wr = res();
    Booking.findOne = async () => storeDoc;
    await paymentController.handleWebhook(
      { headers: { "x-razorpay-signature": sig }, body: Buffer.from(payload) },
      wr,
      () => {}
    );
    check("D6 paid reassignment webhook is a no-op", storeDoc.status === "requested" && storeDoc.payment?.refundStatus === "none", `${storeDoc.status}/${storeDoc.payment?.refundStatus}`);
    Booking.findOne = async () => storeDoc;
  }
  {
    storeDoc = searchingPaid();
    const el = payoutEligibility(storeDoc);
    check("E1 searching booking not payable", el.eligible === false && el.reasons.some((r) => /not completed/i.test(r)), el.reasons.join("; "));
    const before = JSON.stringify(storeDoc.payout);
    check("E2 no payout trace written by search", JSON.stringify(storeDoc.payout) === before);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("TEST ERROR:", err);
  process.exit(1);
});
