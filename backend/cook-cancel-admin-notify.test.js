// Cook-cancel admin notification — targeted replacement alert.
//
// Proves: (1) a successful cook cancel emits `booking_replacement_needed`
// scoped to ADMIN with only booking ID + minimal metadata; (2) customer and
// cancelling-cook in-app notifications are preserved and no admin
// Notification doc is created; (3) an idempotent repeat emits nothing new
// (no WhatsApp to admin exists anywhere on this path).
// Hermetic: models stubbed in-memory, realtime spied. No DB, no network.
// Run: node backend/cook-cancel-admin-notify.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const mongoose = require("mongoose");
const Booking = require("./models/Booking");
const Notification = require("./models/Notification");
const CancellationAudit = require("./models/CancellationAudit");
const CookProfile = require("./models/CookProfile");
const realtime = require("./utils/realtime");
const bookingController = require("./controllers/bookingController");
const dispatchJobs = require("./services/bookingDispatchJobs");

let passes = 0; let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); ok ? passes++ : failures++; };

const realReadyState = mongoose.connection.readyState;
try { mongoose.connection.readyState = 1; } catch { mongoose.connection.readyState = 1; }

const H = 60 * 60 * 1000;
const mkDoc = () => ({
  _id: "b-admin-1",
  customer: "cust1",
  cook: "cook1",
  ignoredBy: [],
  serviceType: "cook_for_me",
  date: new Date(Date.now() + 72 * H),
  startTime: "12:00",
  endTime: "14:00",
  address: "12 MG Road",
  amount: 1000,
  status: "confirmed",
  serviceStartedAt: null,
  requestExpiresAt: new Date(Date.now() + 4 * 60 * 1000),
  paymentExpiresAt: null,
  payment: { status: "paid", paidAmount: 1000, razorpayPaymentId: "pay_1", refundStatus: "none", testMode: false },
  statusHistory: [],
  cookCancel: undefined,
  couponCode: "",
  couponReleased: false,
  payout: { status: "pending" },
  save: async function () { return this; },
});
let storeDoc = mkDoc();

const notifications = [];
const emitted = [];
const strip = (doc) => ({ ...(doc.toObject ? doc.toObject() : doc) });
const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = { ...strip(p) }; return r; };
  return r;
};
const req = (user, body) => ({ params: { id: "b-admin-1" }, user, body: body || {} });
const next = (e) => { if (e) throw e; };

Booking.findById = async () => storeDoc;
Booking.updateOne = async (filter, update) => {
  const okId = !filter._id || String(filter._id) === String(storeDoc._id);
  const okStatus = !filter.status || (filter.status.$in || []).includes(storeDoc.status);
  const okCook = filter.cook === undefined || String(storeDoc.cook) === String(filter.cook);
  const noService = !storeDoc.serviceStartedAt;
  if (!(okId && okStatus && okCook && noService)) return { modifiedCount: 0 };
  if (update.$set) for (const [k, v] of Object.entries(update.$set)) storeDoc[k] = v;
  if (update.$addToSet) for (const [k, v] of Object.entries(update.$addToSet)) {
    if (!Array.isArray(storeDoc[k])) storeDoc[k] = [];
    if (!storeDoc[k].map(String).includes(String(v))) storeDoc[k].push(v);
  }
  if (update.$push && update.$push.statusHistory) storeDoc.statusHistory.push(update.$push.statusHistory);
  return { modifiedCount: 1 };
};
Notification.create = async (n) => { notifications.push(n); return n; };
CancellationAudit.create = async () => ({});
CookProfile.updateOne = async () => ({});
dispatchJobs.resetDispatchJobForReplacement = async () => true;
dispatchJobs.kickWorker = () => {};
const oEmit = realtime.emit;
realtime.emit = (type, data, opts) => { emitted.push({ type, data, opts }); };

(async () => {
  try {
    const r1 = res();
    await bookingController.cancelBooking(
      req({ id: "cook1", role: "COOK" }, { reason: "MEDICAL_EMERGENCY", reasonNote: "Family emergency" }),
      r1, next
    );
    check("N1 cook cancel succeeds with replacement flag", r1.statusCode === 200 && r1.body?.replacement === true, `s=${r1.statusCode}`);
    const adminEvents = emitted.filter((e) => e.type === "booking_replacement_needed");
    check("N1 admin replacement event emitted once", adminEvents.length === 1, `${adminEvents.length}x`);
    const ev = adminEvents[0] || {};
    check("N1 event scoped to admins", Array.isArray(ev.opts?.targetRoles) && ev.opts.targetRoles.join(",").toUpperCase() === "ADMIN", JSON.stringify(ev.opts));
    const keys = Object.keys(ev.data || {}).sort();
    check("N1 payload is booking ID + minimal metadata", JSON.stringify(keys) === JSON.stringify(["bookingId", "cancelledAt"]), keys.join(","));
    check("N1 payload carries correct booking", ev.data?.bookingId === "b-admin-1", String(ev.data?.bookingId));
    const users = notifications.map((n) => String(n.user)).sort();
    check("N2 customer + cancelling cook notified", users.includes("cust1") && users.includes("cook1"), users.join(","));
    check("N2 no admin Notification doc created", !users.includes("admin1") && notifications.length === 2, `${notifications.length} docs`);

    // Idempotent repeat: same cancel again -> duplicate answer, no new events.
    const before = emitted.length;
    const r2 = res();
    await bookingController.cancelBooking(
      req({ id: "cook1", role: "COOK" }, { reason: "MEDICAL_EMERGENCY", reasonNote: "Family emergency" }),
      r2, next
    );
    check("N3 repeat is idempotent duplicate", r2.statusCode === 200 && r2.body?.duplicate === true, `s=${r2.statusCode}`);
    check("N3 repeat emits nothing new", emitted.length === before, `events=${emitted.length - before} new`);
  } catch (e) { check("admin notify suite", false, e.message); }
  finally {
    realtime.emit = oEmit;
    try { mongoose.connection.readyState = realReadyState; } catch { }
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
