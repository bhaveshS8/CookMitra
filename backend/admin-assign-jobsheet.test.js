// Admin manual assignment triggers the cook job sheet (with location).
//
// Proves: an admin assigning an eligible cook to a paid requested booking
// emits exactly one `booking.accepted` dispatch event carrying the assigned
// booking (the dispatch service turns it into the Marathi job sheet with
// the customer address + map link, paid-gated and idempotent). A repeat
// accept emits nothing new. Original booking ID and payment untouched.
// Hermetic: models/services stubbed. No DB, no network, no real sends.
// Run: node backend/admin-assign-jobsheet.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.WHATSAPP_ENABLED = "true";
process.env.WHATSAPP_TOKEN = "test_token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";

const mongoose = require("mongoose");
const Booking = require("./models/Booking");
const Notification = require("./models/Notification");
const CookProfile = require("./models/CookProfile");
const User = require("./models/User");
const slots = require("./utils/slots");
const dispatch = require("./services/whatsappDispatch");
const controller = require("./controllers/bookingController");

let passes = 0; let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); ok ? passes++ : failures++; };

const realReadyState = mongoose.connection.readyState;
try { mongoose.connection.readyState = 1; } catch { mongoose.connection.readyState = 1; }

const H = 60 * 60 * 1000;
const doc = {
  _id: "b-adm-1",
  customer: "cust1",
  cook: null,
  ignoredBy: ["cookX"],
  serviceType: "cook_for_me",
  date: new Date(Date.now() + 72 * H),
  startTime: "10:00",
  endTime: "12:00",
  address: "Flat 7, Sunshine Society, Pune",
  location: { lat: 18.5204, lng: 73.8567 },
  amount: 699,
  status: "requested",
  statusHistory: [],
  requestExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
  paymentExpiresAt: null,
  payment: { status: "paid", paidAmount: 699, refundStatus: "none", testMode: false },
  payout: { status: "pending" },
  save: async function () { return this; },
  toObject() { const { save, toObject, ...rest } = this; return { ...rest }; },
};

Booking.findOne = async () => doc;
Booking.findById = async () => doc;
Booking.find = () => ({ select: async () => [] });
Booking.updateOne = async (filter, update) => {
  if (filter.status && filter.status !== doc.status && !(filter.status.$gt)) {
    if (String(filter.status) !== String(doc.status)) return { modifiedCount: 0 };
  }
  if (filter._id && String(filter._id) !== String(doc._id)) return { modifiedCount: 0 };
  if (update.$set) for (const [k, v] of Object.entries(update.$set)) {
    if (!String(k).includes("$")) doc[k] = v;
  }
  if (update.$push) for (const [k, v] of Object.entries(update.$push)) {
    if (Array.isArray(doc[k])) doc[k].push(v); else doc[k] = [v];
  }
  return { modifiedCount: 1 };
};
CookProfile.findOne = async () => ({ user: "cookB", approvalStatus: "approved", serviceTypes: ["cook_for_me"] });
User.findById = (id) => ({
  select: () => ({
    lean: async () => String(id) === "cookB"
      ? { _id: "cookB", name: "Cook B", phone: "9876543210", status: "active" }
      : { _id: String(id), name: "Aditi Rao", phone: "9123456780", status: "active" },
  }),
});
slots.getDayWindows = async () => [{ startTime: "00:00", endTime: "23:59", status: "available" }];
slots.resolveCookAvailability = async () => true;
slots.getDayWindows = async () => [{ startTime: "00:00", endTime: "23:59", status: "available" }];
slots.resolveCookAvailability = async () => true;
Notification.create = async () => ({});
const events = [];
const oNotify = dispatch.notifyWhatsAppEvent;
dispatch.notifyWhatsAppEvent = (...a) => { events.push(a); };

const mkRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
};
const nx = (e) => { if (e) throw e; };

(async () => {
  try {
    const r1 = mkRes();
    await controller.acceptBooking(
      { params: { id: "b-adm-1" }, user: { id: "admin1", role: "ADMIN" }, body: { cookId: "cookB" } },
      r1, nx
    );
    check("A1 admin assign succeeds", r1.statusCode === 200 && r1.body?.success === true, `s=${r1.statusCode}`);
    const accepted = events.filter((e) => e[0] === "booking.accepted");
    check("A1 jobsheet event emitted once", accepted.length === 1, `${accepted.length}x`);
    const carried = accepted[0]?.[1] || {};
    check(
      "A1 booking ID + paid status preserved",
      String(carried._id) === "b-adm-1" && String(carried.payment?.status) === "paid" && String(carried.cook) === "cookB",
      `id=${carried._id} pay=${carried.payment?.status} cook=${carried.cook}`
    );
    const r2 = mkRes();
    await controller.acceptBooking(
      { params: { id: "b-adm-1" }, user: { id: "admin1", role: "ADMIN" }, body: { cookId: "cookB" } },
      r2, nx
    );
    check("A1 repeat is idempotent", r2.statusCode === 200, `s=${r2.statusCode}`);
    check("A1 repeat emits nothing new", events.filter((e) => e[0] === "booking.accepted").length === 1, `${events.length} total`);
  } catch (e) { check("admin assign jobsheet suite", false, e.message); }
  finally {
    dispatch.notifyWhatsAppEvent = oNotify;
    try { mongoose.connection.readyState = realReadyState; } catch { }
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
