// Standalone regression test for the REMOVED self-serve reschedule
// (no deps, no DB).
// Run:  node backend/reschedule.test.js  — exits non-zero on any failure.
//
// Self-serve reschedule is gone: the only way to move a booking now is to
// cancel it and create a new one. The API endpoint survives as a permanent
// 410 tombstone so old/cached clients get an explicit reason instead of a
// confusing 404. This suite drives the REAL rescheduleBooking controller with
// in-memory fakes and asserts:
//   1. every caller (customer, cook, admin, stranger) gets 410
//   2. the request never touches the DB — no read, no save, no history note
//   3. no notification is emitted
//   4. the route is a bare tombstone (no validators left behind)
//   5. the 30-minute cancel cutoff the details page mirrors still behaves:
//      open outside the window, locked inside it, fail-open when unknown

const fs = require("fs");
const path = require("path");
const Booking = require("./models/Booking");
const Availability = require("./models/Availability");
const Notification = require("./models/Notification");
const controller = require("./controllers/bookingController");

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  -> " + detail : ""));
  if (!ok) failures++;
};

const p2 = (n) => String(n).padStart(2, "0");
const dayStr = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
const TOMORROW = dayStr(1);

// ── In-memory fakes ─────────────────────────────────────────────────────────
let bookingDoc = null;
let saveCalls = 0;
let dbTouches = 0; // any read or write the tombstone should never make
const notificationLog = [];

const resetBooking = () => {
  saveCalls = 0;
  dbTouches = 0;
  notificationLog.length = 0;
  bookingDoc = {
    _id: "booking1",
    cook: "cook1",
    customer: "cust1",
    serviceType: "cook_with_me",
    date: new Date(TOMORROW + "T00:00:00"),
    startTime: "10:00",
    endTime: "13:00",
    durationHours: 3,
    status: "confirmed",
    statusHistory: [],
    save: async function () {
      saveCalls++;
      return this;
    },
  };
};
const snapshot = () => JSON.stringify(bookingDoc);

Booking.findById = async (id) => {
  dbTouches++;
  return String(id) === "booking1" ? bookingDoc : null;
};
Booking.find = () => {
  dbTouches++;
  return { select: async () => [] };
};
Booking.updateOne = async () => {
  dbTouches++;
  return {};
};
Availability.find = () => {
  dbTouches++;
  return { sort: async () => [] };
};
Notification.create = async (payload) => {
  notificationLog.push(payload);
  return payload;
};

const call = (user, body = {}) => {
  const req = { params: { id: "booking1" }, user, body };
  let status = 200;
  let payload = null;
  const res = {
    status: (s) => {
      status = s;
      return res;
    },
    json: (p) => {
      payload = p;
      return res;
    },
  };
  return controller
    .rescheduleBooking(req, res, (e) => {
      throw e;
    })
    .then(() => ({ status, payload }));
};

(async () => {
  // 1) The tombstone answers 410 for every role — including the admin, since
  //    the feature is gone for everyone, not only self-serve users.
  for (const [label, user] of [
    ["customer", { id: "cust1", role: "CUSTOMER" }],
    ["cook", { id: "cook1", role: "COOK" }],
    ["admin", { id: "admin1", role: "ADMIN" }],
    ["stranger", { id: "stranger", role: "CUSTOMER" }],
  ]) {
    resetBooking();
    const before = snapshot();
    const r = await call(user, { date: TOMORROW, startTime: "14:00" });
    check(`${label} gets 410`, r.status === 410, "s=" + r.status);
    check(
      `${label} leaves the booking untouched`,
      snapshot() === before && saveCalls === 0 && bookingDoc.statusHistory.length === 0,
      `saves=${saveCalls} history=${bookingDoc.statusHistory.length}`
    );
    check(
      `${label} touches no DB and sends no notification`,
      dbTouches === 0 && notificationLog.length === 0,
      `dbTouches=${dbTouches} notifications=${notificationLog.length}`
    );
    if (label === "customer") {
      const msg = String(r.payload?.message || "");
      check("message points at cancel + rebook", /cancel/i.test(msg) && /new/i.test(msg), msg);
    }
  }

  // 2) The route itself is a bare tombstone: no leftover validators.
  const routeSrc = fs.readFileSync(path.join(__dirname, "routes", "bookings.js"), "utf8");
  const reschedIdx = routeSrc.indexOf('"/:id/reschedule"');
  check("route keeps the /reschedule tombstone path", reschedIdx !== -1);
  if (reschedIdx !== -1) {
    const routeBlock = routeSrc.slice(reschedIdx, routeSrc.indexOf(");", reschedIdx));
    check(
      "route has no validators (pure 410 tombstone)",
      !/body\(|validate/.test(routeBlock),
      routeBlock.replace(/\s+/g, " ").trim()
    );
  }

  // 3) Reschedule-only plumbing is gone from the controller surface.
  check("no reschedule lock alias exported", controller.cancelRescheduleLocked === undefined);
  check("no renewed-window helper exported", controller.renewedWindow === undefined);
  check("cancel cutoff helper still exported", typeof controller.cancelLocked === "function");

  // 4) The 30-minute cancel cutoff (what the UI mirrors) still behaves.
  const tomorrowDoc = { date: new Date(TOMORROW + "T00:00:00"), startTime: "10:00" };
  check("far-future start is not locked", controller.cancelLocked(tomorrowDoc) === false);
  // A start 10 minutes from now is inside the window and must be locked. If
  // the +10min time crossed midnight the start is already past, which is
  // locked too — either way the answer is true.
  const soon = new Date(Date.now() + 10 * 60 * 1000);
  const soonHM = p2(soon.getHours()) + ":" + p2(soon.getMinutes());
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  check(
    "start in 10 minutes is locked",
    controller.cancelLocked({ date: todayMidnight, startTime: soonHM }) === true
  );
  check("unknown start fails open", controller.cancelLocked({}) === false);

  console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " FAILURES");
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
