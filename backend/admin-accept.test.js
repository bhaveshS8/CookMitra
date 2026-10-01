// Standalone regression test for the admin "accept/reject service request on
// behalf of the cook" flow (no deps, no DB).
// Run:  node backend/admin-accept.test.js  — exits non-zero on any failure.
//
// It patches the mongoose model statics that acceptBooking/rejectBooking touch
// (Booking, Notification, CookProfile, User) with in-memory fakes, then drives
// the REAL controller functions with fake req/res objects. The Booking stub
// applies the query filter's `_id`/`cook` equality like MongoDB would, so an
// unscoped cook query (missing ownership filter) genuinely fails the test.

const Booking = require("./models/Booking");
const Notification = require("./models/Notification");
const CookProfile = require("./models/CookProfile");
const User = require("./models/User");
const controller = require("./controllers/bookingController");

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  -> " + detail : ""));
  if (!ok) failures++;
};
// Schema guard (runs before any scenario): every notification type the
// controllers emit must exist on the REAL Notification enum. Notification.create
// is stubbed below, so without this a type/enum drift (e.g. "booking_expired"
// missing) would pass these suites and only explode at runtime as a 500.
{
  const USED_TYPES = [
    "booking_request",
    "booking_accepted",
    "booking_rejected",
    "booking_confirmed",
    "booking_completed",
    "booking_expired",
    "booking_cancelled",
    "booking_rescheduled",
    "service_started",
    "cook_arrived",
    "cooking_hours_completed",
    "review_received",
    "profile_approved",
    "profile_rejected",
    "general",
  ];
  try {
    const allowed = Notification.schema.path("type")?.enumValues || [];
    const missing = USED_TYPES.filter((t) => !allowed.includes(t));
    check(
      "notification enum covers every type the controllers emit",
      missing.length === 0,
      missing.join(", ") || `allowed=${allowed.join(",")}`
    );
  } catch (e) {
    check("notification enum covers every type the controllers emit", false, String((e && e.message) || e));
  }
}

// ── In-memory fakes ─────────────────────────────────────────────────────────
let bookingDoc = null; // the single booking "in the DB"
let lastFilter = null; // filter passed to Booking.findOne (ownership check)
const notificationLog = []; // every Notification.create payload

const makeBookingDoc = (overrides = {}) => {
  const doc = {
    _id: "booking1",
    cook: "cook1",
    customer: "cust1",
    serviceType: "cook_for_me",
    date: new Date(Date.now() + 24 * 60 * 60 * 1000),
    startTime: "10:00",
    endTime: "13:00",
    status: "requested",
    statusHistory: [],
    requestExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    paymentExpiresAt: null,
    cookLocation: null,
    guests: 4,
    amount: 1500,
    ...overrides,
    save: async function () {
      return this;
    },
    toObject() {
      const { save, toObject, ...rest } = this;
      return { ...rest, statusHistory: [...this.statusHistory] };
    },
  };
  return doc;
};

// Applies the same equality semantics MongoDB would for the fields the
// controller filters on: `_id` (always) and `cook` (only when present —
// admins omit it, cooks are scoped to their own bookings).
const findOneStub = async (filter) => {
  lastFilter = filter;
  if (!bookingDoc) return null;
  if (filter._id && String(filter._id) !== String(bookingDoc._id)) return null;
  if (filter.cook != null && String(filter.cook) !== String(bookingDoc.cook)) return null;
  return bookingDoc;
};

const makeReq = (user) => ({ params: { id: "booking1" }, user });
const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
};
const next = (err) => {
  throw err || new Error("next() called unexpectedly");
};

// Patch model statics, remembering the originals for restore.
const originals = {
  bookingFindOne: Booking.findOne,
  bookingFind: Booking.find,
  notifCreate: Notification.create,
  profileFindOne: CookProfile.findOne,
  userFindById: User.findById,
};
Booking.findOne = findOneStub;
// Chainable fake: the accept pre-check awaits `Booking.find(...).select(...)`,
// so the stub must expose `.select` (a bare array threw → 500). Also thenable
// so an awaited `Booking.find(...)` keeps working.
Booking.find = () => ({
  select: async () => [],
  then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
}); // no rival bookings → no slot conflict
Notification.create = async (doc) => {
  notificationLog.push(doc);
  return doc;
};
CookProfile.findOne = () => ({ select: async () => null }); // no live-location snapshot available
// Chainable fake: controller awaits `User.findById(x).select(...)`; the fake
// supports both `await ...select(...)` and a bare `await User.findById(x)`.
const fakeUser = (data) => ({
  select: () => Promise.resolve(data),
  then: (resolve, reject) => Promise.resolve(data).then(resolve, reject),
});
User.findById = (id) =>
  String(id) === "cook1"
    ? fakeUser({ name: "Chef Ravi", phone: "919999999999" })
    : fakeUser({ name: "Aditi Rao", phone: "918888888888" });
const restore = () => {
  Booking.findOne = originals.bookingFindOne;
  Booking.find = originals.bookingFind;
  Notification.create = originals.notifCreate;
  CookProfile.findOne = originals.profileFindOne;
  User.findById = originals.userFindById;
};

// ── Scenario helpers ────────────────────────────────────────────────────────
const runAccept = async (user, overrides = {}) => {
  bookingDoc = makeBookingDoc(overrides);
  notificationLog.length = 0;
  lastFilter = null;
  const res = makeRes();
  await controller.acceptBooking(makeReq(user), res, next);
  return res;
};
const runReject = async (user, overrides = {}) => {
  bookingDoc = makeBookingDoc(overrides);
  notificationLog.length = 0;
  lastFilter = null;
  const res = makeRes();
  await controller.rejectBooking(makeReq(user), res, next);
  return res;
};
const lastHistory = (doc) => doc.statusHistory[doc.statusHistory.length - 1];
const notifFor = (userId) => notificationLog.find((n) => String(n.user) === String(userId));

// ── Scenarios ───────────────────────────────────────────────────────────────
(async () => {
  try {
    // 1. Admin accepts a request that belongs to a different user.
    let res = await runAccept({ id: "admin1", role: "admin" });
    check("admin accept succeeds on someone else's booking", res.statusCode === 200 && bookingDoc.status === "accepted", `status=${res.statusCode} booking=${bookingDoc.status}`);
    check("admin query is NOT scoped to own bookings", lastFilter.cook === undefined, JSON.stringify(lastFilter || {}));
    check("admin accept leaves audit note in statusHistory", lastHistory(bookingDoc) && lastHistory(bookingDoc).status === "accepted" && lastHistory(bookingDoc).note === "Accepted by admin on behalf of the cook", JSON.stringify(lastHistory(bookingDoc) || {}));
    check("admin accept opens the 5-minute payment window", bookingDoc.paymentExpiresAt instanceof Date && bookingDoc.paymentExpiresAt > new Date(), String(bookingDoc.paymentExpiresAt));
    check("cook is notified of the on-behalf accept", (() => { const n = notifFor("cook1"); return !!n && n.type === "booking_accepted" && n.message.includes("on your behalf"); })(), JSON.stringify(notifFor("cook1") || {}));
    check("customer is notified of the accept", (() => { const n = notifFor("cust1"); return !!n && n.type === "booking_accepted"; })(), JSON.stringify(notifFor("cust1") || {}));

    // 2. Cook accepts their own request: no audit note, no self-notification.
    res = await runAccept({ id: "cook1", role: "cook" });
    check("cook accept succeeds on own booking", res.statusCode === 200 && bookingDoc.status === "accepted", `status=${res.statusCode} booking=${bookingDoc.status}`);
    // Find-Cook broadcast bookings (cook == null) are fetched by id and then
    // ownership-checked in code (same pattern as cancelBooking): an assigned
    // booking still 404s for any other cook (scenario 3 below proves it).
    check("cook fetch targets only this booking id", String(lastFilter._id) === "booking1", JSON.stringify(lastFilter || {}));
    check("cook accept adds NO on-behalf note", !lastHistory(bookingDoc).note, JSON.stringify(lastHistory(bookingDoc) || {}));
    check("cook is NOT notified for their own accept", !notifFor("cook1"), JSON.stringify(notifFor("cook1") || {}));
    check("customer still notified on cook accept", (() => { const n = notifFor("cust1"); return !!n && n.type === "booking_accepted"; })(), "");

    // 3. A different cook cannot act on someone else's request (404).
    res = await runAccept({ id: "cook2", role: "cook" });
    check("other cook gets 404 and booking untouched", res.statusCode === 404 && bookingDoc.status === "requested" && bookingDoc.statusHistory.length === 0, `status=${res.statusCode} booking=${bookingDoc.status}`);

    // 4. Admin accepting an expired request is refused (410) and flips expiry.
    res = await runAccept({ id: "admin1", role: "admin" }, { requestExpiresAt: new Date(Date.now() - 60 * 1000) });
    check("expired request returns 410 to admin", res.statusCode === 410, String(res.statusCode));
    check("expired request auto-marks expired", bookingDoc.status === "expired", bookingDoc.status);
    check("expired path notifies customer, not cook", (() => { const c = notifFor("cust1"); return !!c && c.type === "booking_expired" && !notifFor("cook1"); })(), JSON.stringify(notifFor("cust1") || {}));

    // 5. Only pending "requested" bookings can be accepted (400).
    res = await runAccept({ id: "admin1", role: "admin" }, { status: "confirmed" });
    check("non-requested booking refused with 400", res.statusCode === 400 && /pending/i.test(res.body?.message || ""), `status=${res.statusCode} body=${JSON.stringify(res.body)}`);

    // 6. Admin declines on behalf: audit note + cook + customer notified.
    res = await runReject({ id: "admin1", role: "admin" });
    check("admin reject succeeds on someone else's booking", res.statusCode === 200 && bookingDoc.status === "rejected", `status=${res.statusCode} booking=${bookingDoc.status}`);
    check("admin reject leaves audit note", lastHistory(bookingDoc).note === "Declined by admin on behalf of the cook", JSON.stringify(lastHistory(bookingDoc) || {}));
    check("cook is notified of the on-behalf decline", (() => { const n = notifFor("cook1"); return !!n && n.type === "booking_rejected" && n.message.includes("on your behalf"); })(), JSON.stringify(notifFor("cook1") || {}));
    check("customer is notified of the reject", (() => { const n = notifFor("cust1"); return !!n && n.type === "booking_rejected"; })(), "");

    // 7. Cook declines their own request: no note, no self-notification.
    res = await runReject({ id: "cook1", role: "cook" });
    check("cook reject succeeds on own booking", res.statusCode === 200 && bookingDoc.status === "rejected", `status=${res.statusCode} booking=${bookingDoc.status}`);
    check("cook reject adds NO on-behalf note", !lastHistory(bookingDoc).note, JSON.stringify(lastHistory(bookingDoc) || {}));
    check("cook is NOT notified for their own reject", !notifFor("cook1"), JSON.stringify(notifFor("cook1") || {}));
  } catch (error) {
    check("no unexpected error", false, (error && error.stack) || String(error));
  } finally {
    restore();
  }

  console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED");
  process.exit(failures === 0 ? 0 : 1);
})();

