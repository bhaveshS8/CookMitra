// security-audit.test.js — regression tests for the P0/P1 audit fixes.
// Run:  node backend/security-audit.test.js  — exits non-zero on any failure.
//
// Covers (stubbed, no DB):
//  1. time utils: strict HH:MM, 30-min grid, real calendar dates, IST day.
//  2. completeBooking: unpaid blocked, instant-complete blocked, idempotent.
//  3. cancelBooking: idempotent cancelled, OTP-started cancel blocked,
//     cook cancel bumps reliability count.
//     (Manual arrival taps are disabled — presence is proven by the
//     OTP-verified start, so no arrived/cancel interaction is tested.)
//  4. markCookArrived: manual arrival disabled (410, no state change).
//  5. rescheduleBooking: self-serve removal enforced (410 tombstone).
//  6. payBooking: zero-amount without coupon rejected.
//  7. createReview: unpaid bookings rejected.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const Booking = require("./models/Booking");
const Coupon = require("./models/Coupon");
const CookProfile = require("./models/CookProfile");
const Notification = require("./models/Notification");
const bookingCtrl = require("./controllers/bookingController");
const reviewCtrl = require("./controllers/reviewController");
const {
  parseTimeStrict,
  isOnGrid,
  parseDayStrict,
  istDayString,
} = require("./utils/time");

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
const cookReq = (over = {}) => ({ params: { id: "b1" }, body: {}, user: { id: "cook1", role: "COOK" }, ...over });
const custReq = (over = {}) => ({ params: { id: "b1" }, body: {}, user: { id: "cust1", role: "CUSTOMER" }, ...over });

const doc = (over = {}) => ({
  _id: "b1",
  customer: "cust1",
  cook: "cook1",
  status: "confirmed",
  statusHistory: [],
  payment: { status: "paid", testMode: false },
  ...over,
  save: async function () { return this; },
  toObject: function () { const { save, toObject, ...rest } = this; return { ...rest }; },
});

async function main() {
  console.log("═══ time utils ═══");
  check("strict HH:MM rejects prefix junk", parseTimeStrict("10:00abc") === null);
  check("strict HH:MM rejects bad hour", parseTimeStrict("24:00") === null);
  check("strict HH:MM rejects bad minute", parseTimeStrict("10:99") === null);
  check("strict HH:MM accepts 09:30", parseTimeStrict("09:30") === 570);
  check("grid enforces 30-min", isOnGrid(615) === false && isOnGrid(630) === true);
  check("calendar rejects Feb 30", parseDayStrict("2026-02-30") === null);
  check("calendar accepts leap-adjacent", parseDayStrict("2026-02-28") instanceof Date);
  check("IST day string shape", /^\d{4}-\d{2}-\d{2}$/.test(istDayString()));

  console.log("\n═══ completeBooking ═══");
  // Unpaid confirmed must not complete.
  {
    const d = doc({ status: "confirmed", payment: { status: "pending" }, serviceStartedAt: new Date() });
    Booking.findOne = async () => d;
    const r = makeRes();
    await bookingCtrl.completeBooking(cookReq(), r, next);
    check("unpaid complete blocked", r.statusCode === 400, `s=${r.statusCode}`);
  }
  // Paid confirmed without OTP start and without legacy hours must not complete.
  {
    const d = doc({ status: "confirmed", payment: { status: "paid" } });
    delete d.serviceStartedAt;
    d.hoursCompleted = false;
    Booking.findOne = async () => d;
    const r = makeRes();
    await bookingCtrl.completeBooking(cookReq(), r, next);
    check("instant complete blocked", r.statusCode === 400, `s=${r.statusCode}`);
  }
  // Already completed is idempotent 200.
  {
    const d = doc({ status: "completed", payment: { status: "paid" }, serviceStartedAt: new Date() });
    Booking.findOne = async () => d;
    const r = makeRes();
    await bookingCtrl.completeBooking(cookReq(), r, next);
    check("completed idempotent", r.statusCode === 200 && r.body?.alreadyCompleted === true, `s=${r.statusCode}`);
  }
  // Paid + OTP-started completes.
  {
    const d = doc({ status: "in_progress", payment: { status: "paid" }, serviceStartedAt: new Date() });
    Booking.findOne = async () => d;
    Notification.create = async () => ({});
    const User = require("./models/User");
    const oF = User.findById;
    User.findById = () => ({ select: async () => ({ name: "C" }) });
    const r = makeRes();
    await bookingCtrl.completeBooking(cookReq(), r, next);
    User.findById = oF;
    check("started service completes", r.statusCode === 200 && d.status === "completed", `s=${r.statusCode}`);
  }

  console.log("\n═══ cancelBooking ═══");
  // Already cancelled is idempotent 200.
  {
    const d = doc({ status: "cancelled" });
    Booking.findById = async () => d;
    const r = makeRes();
    await bookingCtrl.cancelBooking({ params: { id: "b1" }, user: { id: "cust1", role: "CUSTOMER" } }, r, next);
    check("cancelled idempotent", r.statusCode === 200 && r.body?.alreadyCancelled === true, `s=${r.statusCode}`);
  }
  // OTP-started service can no longer self-serve cancel.
  {
    const future = new Date(Date.now() + 48 * 3600 * 1000);
    const d = doc({
      status: "in_progress",
      payment: { status: "paid" },
      serviceStartedAt: new Date(),
      date: future,
      startTime: "10:00",
    });
    Booking.findById = async () => d;
    const r = makeRes();
    await bookingCtrl.cancelBooking({ params: { id: "b1" }, user: { id: "cust1", role: "CUSTOMER" } }, r, next);
    check("started service cancel blocked", r.statusCode === 400, `s=${r.statusCode}`);
  }
  // Cook cancel bumps reliability count atomically.
  {
    const future = new Date(Date.now() + 48 * 3600 * 1000);
    const d = doc({ status: "accepted", payment: { status: "pending" }, date: future, startTime: "10:00" });
    Booking.findById = async () => d;
    Notification.create = async () => ({});
    let incArg = null;
    CookProfile.updateOne = async (f, u) => { incArg = u; return {}; };
    const r = makeRes();
    await bookingCtrl.cancelBooking({ params: { id: "b1" }, user: { id: "cook1", role: "COOK" } }, r, next);
    check("cook cancel bumps count", r.statusCode === 200 && incArg?.$inc?.cancelledByCookCount === 1, `s=${r.statusCode}`);
  }

  console.log("\n═══ reschedule removed ═══");
  {
    // Self-serve reschedule was deleted; the endpoint survives only as a 410
    // tombstone so old clients get an explicit reason, never a silent move.
    const d = doc({ status: "confirmed", date: new Date(Date.now() + 48 * 3600 * 1000), startTime: "10:00", endTime: "12:00", durationHours: 2 });
    Booking.findById = async () => d;
    const r = makeRes();
    await bookingCtrl.rescheduleBooking(
      { params: { id: "b1" }, body: { date: "2099-01-02", startTime: "10:00" }, user: { id: "cust1", role: "CUSTOMER" } },
      r,
      next
    );
    check("reschedule tombstone is 410", r.statusCode === 410, `s=${r.statusCode} ${r.body?.message || ""}`);
  }

  console.log("\n═══ payBooking zero-amount ═══");
  {
    const future = new Date(Date.now() + 48 * 3600 * 1000);
    const d = doc({
      status: "accepted",
      amount: 0,
      couponCode: "",
      payment: { status: "pending" },
      date: future,
      startTime: "10:00",
      endTime: "11:00",
      paymentExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      requestExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    Booking.findOne = async (q) => {
      if (q && q._id && q.status) return null; // atomic claim unused here
      return d;
    };
    const r = makeRes();
    await bookingCtrl.payBooking({ params: { id: "b1" }, body: {}, user: { id: "cust1", role: "CUSTOMER" } }, r, next);
    check("zero without coupon rejected", r.statusCode === 400, `s=${r.statusCode}`);
  }

  console.log("\n═══ markCookArrived (manual arrival disabled) ═══");
  {
    let saved = false;
    const d = doc({ status: "accepted", payment: { status: "pending" }, cookArrived: false });
    d.save = async function () { saved = true; return this; };
    const r = makeRes();
    await bookingCtrl.markCookArrived({ params: { id: "b1" }, user: { id: "cook1", role: "COOK" } }, r, next);
    check("manual arrival refused with 410", r.statusCode === 410, `s=${r.statusCode}`);
    check("manual arrival writes nothing", saved === false && d.cookArrived === false, `saved=${saved} arrived=${d.cookArrived}`);
  }

  console.log("\n═══ createReview ═══");
  {
    const Review = require("./models/Review");
    Booking.findById = async () => doc({ status: "confirmed", payment: { status: "pending" }, hoursCompleted: true });
    const r = makeRes();
    await reviewCtrl.createReview({ body: { booking: "b1", rating: 5, comment: "x" }, user: { id: "cust1", role: "CUSTOMER" } }, r, next);
    check("unpaid review rejected", r.statusCode === 400, `s=${r.statusCode}`);
    Review.findOne = async () => null;
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
