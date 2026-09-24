// Standalone regression test for the post-payment WhatsApp shares + customer
// confirmation notification (no deps, no DB).
// Run:  node backend/pay-whatsapp.test.js — exits non-zero on failure.
// Uses a locally-signed Razorpay-style payment (verified path only — the old
// demo mark-paid path is gone, so bare { method } must NOT confirm).
const crypto = require("crypto");
process.env.RAZORPAY_KEY_SECRET = "test_secret_for_unit_test";
const Booking = require("./models/Booking");
const User = require("./models/User");
const Notification = require("./models/Notification");
const CookProfile = require("./models/CookProfile");
const ctrl = require("./controllers/bookingController");

const check = (label, ok, detail) =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -> ${detail}`);

const bookingDoc = new Booking({
  _id: "507f1f77bcf86cd799439011",
  customer: "507f1f77bcf86cd799439012",
  cook: "507f1f77bcf86cd799439013",
  serviceType: "cook_for_me",
  date: new Date("2026-09-10"),
  startTime: "10:00",
  endTime: "13:00",
  durationHours: 3,
  address: "H-12 Green Park, Delhi",
  addressDetails: { flatNo: "H-12", society: "Green Park", city: "Delhi" },
  location: { lat: 28.6139, lng: 77.209 },
  amount: 900,
  // Stored by POST /payments/order at checkout time — payBooking binds the
  // submitted triple to this id (replay protection). Fixtures must carry it,
  // exactly like a real booking awaiting confirmation.
  payment: { status: "pending", razorpayOrderId: "order_test_1" },
  status: "accepted",
  statusHistory: [],
});
bookingDoc.save = async function () {
  return this;
};

const savedFindOne = Booking.findOne;
const savedFindOneAndUpdate = Booking.findOneAndUpdate;
const savedUserFindById = User.findById;
const savedNotifCreate = Notification.create;
const savedProfileFindOne = CookProfile.findOne;
const LedgerEntry = require("./models/LedgerEntry");
const savedLedgerCreate = LedgerEntry.create;
const ledgerRows = [];

const notifications = [];
Booking.findOne = () => bookingDoc;
// Emulate the atomic pay claim (accepted+unpaid -> confirmed+paid) without a
// DB: only the live booking wins; anything else loses like the real
// conditional update. Ledger writes are captured in-memory (no buffering).
Booking.findOneAndUpdate = async (filter, update) => {
  if (String(filter?._id) !== String(bookingDoc._id)) return null;
  if (bookingDoc.status !== "accepted" || bookingDoc.payment?.status === "paid") return null;
  const set = update?.$set || {};
  if (set.payment) bookingDoc.payment = { ...(bookingDoc.payment || {}), ...set.payment };
  if (set.status) bookingDoc.status = set.status;
  const pushed = update?.$push?.statusHistory;
  if (pushed) bookingDoc.statusHistory.push(pushed);
  return bookingDoc;
};
LedgerEntry.create = async (e) => {
  ledgerRows.push(e);
  return e;
};
User.findById = (id) => ({
  select: async () =>
    String(id) === "507f1f77bcf86cd799439013"
      ? { _id: id, name: "Priya Sharma", phone: "9876543210" }
      : { _id: id, name: "Aditi Rao", phone: "9123456780" },
});
Notification.create = async (doc) => {
  notifications.push(doc);
};
CookProfile.findOne = () => ({
  select: async () => ({ user: "507f1f77bcf86cd799439013", liveLocation: { lat: 28.61, lng: 77.2 } }),
});

const resBody = {};
const res = {
  statusCode: 0,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(b) {
    Object.assign(resBody, b);
  },
};
const next = (e) => {
  if (e) throw e;
};

(async () => {
  try {
    // Unverified payments must NEVER confirm: bare { method } is rejected.
    const bareDoc = new Booking({
      _id: "507f1f77bcf86cd799439021",
      customer: "507f1f77bcf86cd799439012",
      cook: "507f1f77bcf86cd799439013",
      serviceType: "cook_for_me",
      date: new Date("2026-09-10"),
      startTime: "10:00",
      endTime: "13:00",
      durationHours: 3,
      address: "H-12 Green Park, Delhi",
      amount: 900,
      payment: { status: "pending" },
      status: "accepted",
      statusHistory: [],
    });
    bareDoc.save = async function () {
      return this;
    };
    Booking.findOne = () => bareDoc;
    const bareRes = { statusCode: 0, status(c) { this.statusCode = c; return this; }, json(b) { Object.assign(this, b); } };
    await ctrl.payBooking(
      {
        params: { id: "b2" },
        user: { id: "507f1f77bcf86cd799439012", role: "customer" },
        body: { method: "upi" },
      },
      bareRes,
      next
    );
    const bareRejected = bareRes.statusCode === 400;
    const bareUnchanged = bareDoc.status === "accepted";
    check("bare method without payment is rejected", bareRejected, String(bareRes.statusCode));
    check("unverified booking stays accepted", bareUnchanged, bareDoc.status);
    Booking.findOne = () => bookingDoc;

    const razorpayOrderId = "order_test_1";
    const razorpayPaymentId = "pay_test_1";
    const razorpaySignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");
    await ctrl.payBooking(
      {
        params: { id: "b1" },
        user: { id: "507f1f77bcf86cd799439012", role: "customer" },
        body: {
          method: "upi",
          payment: { razorpayOrderId, razorpayPaymentId, razorpaySignature },
        },
      },
      res,
      next
    );

    const cookWa = resBody.cookWhatsappUrl || "";
    const selfWa = resBody.customerWhatsappUrl || "";

    check("booking confirmed after payment", resBody.status === "confirmed", resBody.status);
    check("payment recorded as paid", resBody.payment?.status === "paid", resBody.payment?.status);

    // --- In-app notifications (cook + customer website account) ---
    check(
      "two notifications created (cook + customer)",
      notifications.length === 2,
      String(notifications.length)
    );
    const customerNotif = notifications.find((n) => String(n.user) === "507f1f77bcf86cd799439012");
    const cookNotif = notifications.find((n) => String(n.user) === "507f1f77bcf86cd799439013");
    check(
      "customer website notification is booking_confirmed",
      customerNotif?.type === "booking_confirmed",
      customerNotif?.type || "(missing)"
    );
    check(
      "customer notification names the cook",
      typeof customerNotif?.message === "string" && customerNotif.message.includes("Priya Sharma"),
      customerNotif?.message || "(missing)"
    );
    check(
      "cook still notified in-app",
      cookNotif?.type === "booking_confirmed",
      cookNotif?.type || "(missing)"
    );

    // --- Job sheet -> cook's WhatsApp ---
    check(
      "cookWhatsappUrl targets the cook's number",
      cookWa.startsWith("https://wa.me/919876543210"),
      cookWa.split("?")[0] || "(missing)"
    );
    const cookMsg = decodeURIComponent(cookWa.split("text=")[1] || "");
    check("job sheet has customer name", cookMsg.includes("Customer: Aditi Rao"), "name");
    check("job sheet has customer number", cookMsg.includes("9123456780"), "number");
    check("job sheet has venue address", cookMsg.includes("H-12 Green Park"), "address");
    check(
      "job sheet has GPS location pin",
      cookMsg.includes("https://www.google.com/maps?q=28.6139,77.209"),
      "pin"
    );

    // --- Confirmation -> customer's own WhatsApp ---
    const selfMsg = decodeURIComponent(selfWa.split("text=")[1] || "");
    console.log("--- Customer confirmation message ---");
    console.log(selfMsg);
    console.log("-------------------------------------");
    check(
      "customerWhatsappUrl targets the customer's own number",
      selfWa.startsWith("https://wa.me/919123456780"),
      selfWa.split("?")[0] || "(missing)"
    );
    check("confirmation marks payment received", selfMsg.includes("Payment Received"), "header");
    check("confirmation includes cook's name", selfMsg.includes("Cook: Priya Sharma"), "cook name");
    check(
      "confirmation includes cook's number",
      selfMsg.includes("Cook's number: 9876543210"),
      "cook number"
    );
    check(
      "confirmation carries no live-location pin (tracking removed)",
      !selfMsg.includes("Cook's live location: https://www.google.com/maps"),
      "no live pin"
    );
    check(
      "confirmation includes service hours",
      selfMsg.includes("Service hours: 10:00 - 13:00 (3 hrs)"),
      "service hours"
    );
    check(
      "confirmation carries no tracking link (tracking removed)",
      !selfMsg.includes("Live tracking link:"),
      "no tracking"
    );

    process.exit(
      bareRejected &&
        bareUnchanged &&
        resBody.status === "confirmed" &&
        resBody.payment?.status === "paid" &&
        notifications.length === 2 &&
        customerNotif?.type === "booking_confirmed" &&
        customerNotif?.message?.includes("Priya Sharma") &&
        cookNotif?.type === "booking_confirmed" &&
        cookWa.startsWith("https://wa.me/919876543210") &&
        cookMsg.includes("Customer: Aditi Rao") &&
        cookMsg.includes("9123456780") &&
        cookMsg.includes("H-12 Green Park") &&
        cookMsg.includes("https://www.google.com/maps?q=28.6139,77.209") &&
        selfWa.startsWith("https://wa.me/919123456780") &&
        selfMsg.includes("Payment Received") &&
        selfMsg.includes("Cook: Priya Sharma") &&
        selfMsg.includes("Cook's number: 9876543210") &&
        !selfMsg.includes("Cook's live location: https://www.google.com/maps") &&
        selfMsg.includes("Service hours: 10:00 - 13:00 (3 hrs)") &&
        !selfMsg.includes("Live tracking link:")
        ? 0
        : 1
    );
  } catch (err) {
    console.error("TEST ERROR:", err);
    process.exit(1);
  } finally {
    Booking.findOne = savedFindOne;
    Booking.findOneAndUpdate = savedFindOneAndUpdate;
    User.findById = savedUserFindById;
    Notification.create = savedNotifCreate;
    CookProfile.findOne = savedProfileFindOne;
    LedgerEntry.create = savedLedgerCreate;
  }
})();
