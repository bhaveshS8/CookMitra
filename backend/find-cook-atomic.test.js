// Find-Cook atomic assignment suite (no deps, no DB).
// Run:  node backend/find-cook-atomic.test.js  — exits non-zero on any failure.
//
// Covers the broadcast lifecycle with in-memory fakes driving the REAL
// controllers: creation ignores untrusted cook/price ids, exactly one cook
// wins the atomic claim, losers/ignored/expired/cancelled attempts fail
// safely, Ignore never kills the request, and payment stays locked to
// server-assigned ACCEPTED bookings.

const mongoose = require("mongoose");

// ── Stub the slot engine BEFORE the controller loads (destructured import).
const slots = require("./utils/slots");
slots.getDayWindows = async () => [{ startTime: "08:00", endTime: "20:00" }];
slots.resolveCookAvailability = async () => true;

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

const setDbReady = (on) => {
  try {
    Object.defineProperty(mongoose.connection, "readyState", { value: on ? 1 : 0, configurable: true });
  } catch {
    mongoose.connection.readyState = on ? 1 : 0;
  }
};

const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const next = (e) => { if (e) throw e; };

// ── Shared fakes ─────────────────────────────────────────────────────────
const notificationLog = [];
let createdPayload = null;

const chainSelect = (rows) => ({ select: async () => rows });
const fakeUserDoc = (data) => {
  const q = { select: () => q, lean: async () => data };
  q.then = (res, rej) => Promise.resolve(data).then(res, rej);
  return q;
};

const approvedProfiles = (ids) => ids.map((id) => ({
  user: { _id: id, name: `Cook ${id}`, status: "active" },
  approvalStatus: "approved",
  serviceTypes: [],
}));
CookProfile.find = (filter) => ({
  populate: () => ({ lean: async () => approvedProfiles(["cookA", "cookB", "cookC", "cookD"]) }),
});
CookProfile.findOne = async (q) => {
  const id = String(q?.user || "");
  if (["cookA", "cookB", "cookC", "cookD"].includes(id)) {
    return { user: id, approvalStatus: "approved", serviceTypes: [] };
  }
  return null;
};
User.findById = (id) => fakeUserDoc({ _id: String(id), name: `User ${id}`, phone: "9100000001", status: "active" });
Notification.create = async (d) => { notificationLog.push(d); return d; };

const custReq = (body) => ({
  body,
  user: { id: "cust1", role: "customer", name: "Aditi" },
  params: {},
});

const futureDateStr = () => {
  const d = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

(async () => {
  try {
    // ══ A. Broadcast creation ══
    setDbReady(false);
    createdPayload = null;
    Booking.findOne = async (q) => (q?.clientKey ? null : null);
    Booking.find = () => chainSelect([]);
    Booking.create = async (doc) => {
      createdPayload = doc;
      return {
        _id: "bcast1",
        ...doc,
        statusHistory: [{ status: "requested" }],
        save: async function () { return this; },
        toObject() { const { save, toObject, ...rest } = this; return { ...rest }; },
      };
    };
    notificationLog.length = 0;
    {
      const r = makeRes();
      await controller.createBooking(custReq({
        serviceType: "cook_for_me",
        date: futureDateStr(),
        startTime: "10:00",
        endTime: "13:00",
        durationHours: 3,
        guests: 4,
        address: "Flat 1, Sunshine Society, Pune",
        notes: "less spicy",
        // Tampered / untrusted fields the server must ignore:
        cook: "someCookId",
        cookId: "someCookId",
        amount: 1,
        customer: "attacker",
        status: "confirmed",
      }), r, next);
      check("A1 broadcast creates 201 requested", r.statusCode === 201 && r.body?.status === "requested", `s=${r.statusCode} st=${r.body?.status}`);
      check("A1 cook is null (tampered ids ignored)", createdPayload && createdPayload.cook === null, JSON.stringify({ cook: createdPayload?.cook }));
      check("A1 amount recomputed server-side (₹1 ignored)", createdPayload && createdPayload.amount !== 1 && createdPayload.amount > 1, `amount=${createdPayload?.amount}`);
      const reqNotifs = notificationLog.filter((n) => n.type === "booking_request");
      const ids = new Set(reqNotifs.map((n) => String(n.booking)));
      check("A2 every eligible cook notified on the same booking", reqNotifs.length >= 2 && ids.size === 1, `notifs=${reqNotifs.length} bookings=${ids.size}`);
    }

    // A3: nobody eligible -> 409, no booking.
    {
      const savedFind = CookProfile.find;
      CookProfile.find = () => ({ populate: () => ({ lean: async () => [] }) });
      let created = false;
      Booking.create = async (d) => { created = true; return d; };
      const r = makeRes();
      await controller.createBooking(custReq({
        serviceType: "cook_for_me", date: futureDateStr(),
        startTime: "10:00", endTime: "13:00", durationHours: 3,
        address: "Flat 1, X, Pune",
      }), r, next);
      check("A3 no eligible cooks -> 409 + no booking", r.statusCode === 409 && created === false, `s=${r.statusCode}`);
      CookProfile.find = savedFind;
    }

    // A4: duplicate clientKey returns the original (idempotent).
    // NOTE: the pre-check is a production-DB branch — force it on here.
    {
      setDbReady(true);
      const original = { _id: "orig1", status: "requested", cook: null, toObject() { return { _id: "orig1", status: "requested", cook: null }; } };
      Booking.findOne = async (q) => (q?.clientKey === "dup-key-1" ? original : null);
      const r = makeRes();
      await controller.createBooking(custReq({
        serviceType: "cook_for_me", date: futureDateStr(),
        startTime: "10:00", endTime: "13:00", durationHours: 3,
        address: "Flat 1, X, Pune", clientKey: "dup-key-1",
      }), r, next);
      check("A4 duplicate clientKey -> 200 alreadyExists", r.statusCode === 200 && r.body?.alreadyExists === true, `s=${r.statusCode}`);
      setDbReady(false);
    }

    // ══ B. Atomic accept race (production claim path) ══
    setDbReady(true);
    const liveDoc = () => ({
      _id: "race1",
      customer: "cust1",
      cook: null,
      ignoredBy: [],
      serviceType: "cook_for_me",
      date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      startTime: "10:00",
      endTime: "13:00",
      status: "requested",
      statusHistory: [],
      payment: { status: "pending" },
      requestExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      save: async function () { return this; },
      toObject() { const { save, toObject, ...rest } = this; return { ...rest }; },
    });
    // Simulated DB state: exactly one conditional claim commits.
    let dbCook = null;
    let dbStatus = "requested";
    const claimFilters = [];
    const claimUpdates = [];
    Booking.find = () => chainSelect([]); // no rival bookings
    Booking.findOne = async (filter) => {
      const d = liveDoc();
      d.cook = dbCook;
      d.status = dbStatus;
      // The atomic $push lands in the DB doc: mirror one accepted entry so
      // the response carries exactly one authoritative history row.
      d.statusHistory = dbStatus === "accepted"
        ? [{ status: "accepted", note: `Accepted by cook ${dbCook}` }]
        : [];
      return d;
    };
    Booking.findById = async () => {
      const d = liveDoc();
      d.cook = dbCook;
      d.status = dbStatus;
      d.statusHistory = dbStatus === "accepted"
        ? [{ status: "accepted", note: `Accepted by cook ${dbCook}` }]
        : [];
      return d;
    };
    Booking.updateOne = async (filter, update) => {
      claimFilters.push(filter);
      claimUpdates.push(update);
      const wantsNullCook = filter.cook === null || (filter.cook === undefined && false);
      const match = String(filter._id) === "race1" && filter.status === "requested"
        && filter.requestExpiresAt?.$gt instanceof Date;
      if (!match) return { modifiedCount: 0 };
      if (wantsNullCook && dbCook !== null) return { modifiedCount: 0 }; // already assigned
      if (dbStatus !== "requested") return { modifiedCount: 0 };
      dbCook = update.$set?.cook ?? dbCook;
      dbStatus = update.$set?.status ?? dbStatus;
      return { modifiedCount: 1 };
    };
    const acceptAs = async (cookId, body) => {
      const r = makeRes();
      await controller.acceptBooking({ params: { id: "race1" }, user: { id: cookId, role: "cook" }, body: body || {} }, r, next);
      return r;
    };

    // B5: first cook wins; claim pins cook:null + requested + live window.
    notificationLog.length = 0;
    let r = await acceptAs("cookA");
    check("B5 first accept wins (200 + cook set)", r.statusCode === 200 && dbCook === "cookA" && dbStatus === "accepted", `s=${r.statusCode} cook=${dbCook}`);
    const bc = claimFilters.find((f) => f.cook === null);
    check("B5 claim filter is atomic (requested + cook:null + live expiry)", !!bc && bc.status === "requested" && !!bc.requestExpiresAt?.$gt, JSON.stringify(bc || {}));
    check("B5 exactly one acceptance history entry", (r.body?.statusHistory || []).filter((h) => h.status === "accepted").length === 1, JSON.stringify((r.body?.statusHistory || []).length));
    check("B5 only the winner's customer notified once", notificationLog.filter((n) => n.type === "booking_accepted" && String(n.user) === "cust1").length === 1, `${notificationLog.length}`);

    // B6/B7: late + same-cook double accept -> safe (no duplicate winner).
    r = await acceptAs("cookB");
    check("B6 second cook -> 409 BOOKING_ALREADY_ASSIGNED", r.statusCode === 409 && r.body?.code === "BOOKING_ALREADY_ASSIGNED", `s=${r.statusCode} code=${r.body?.code}`);
    r = await acceptAs("cookA");
    check("B7 winner double-accept idempotent (200, no state change)", r.statusCode === 200 && r.body?.alreadyAccepted === true, `s=${r.statusCode}`);
    check("B7 still exactly one cook assigned", dbCook === "cookA" && dbStatus === "accepted", `cook=${dbCook}`);

    // B8: ignored cook cannot accept (fresh requested doc, ignoredBy has them).
    {
      const d = liveDoc();
      d._id = "race2"; d.status = "requested"; d.cook = null; d.ignoredBy = ["cookC"];
      Booking.findOne = async () => d;
      const rr = makeRes();
      await controller.acceptBooking({ params: { id: "race2" }, user: { id: "cookC", role: "cook" }, body: {} }, rr, next);
      check("B8 ignored cook accept -> 409", rr.statusCode === 409, `s=${rr.statusCode}`);
    }

    // B9: expired -> 410; cancelled -> 400.
    {
      const d = liveDoc();
      d._id = "race3"; d.status = "requested"; d.cook = null;
      d.requestExpiresAt = new Date(Date.now() - 1000);
      d.save = async function () { this.status = "expired"; return this; };
      Booking.findOne = async () => d;
      const r2 = makeRes();
      await controller.acceptBooking({ params: { id: "race3" }, user: { id: "cookA", role: "cook" }, body: {} }, r2, next);
      check("B9 expired accept -> 410", r2.statusCode === 410, `s=${r2.statusCode}`);
      const d2 = liveDoc();
      d2.status = "cancelled"; d2.cook = null;
      Booking.findOne = async () => d2;
      const r3 = makeRes();
      await controller.acceptBooking({ params: { id: "race5" }, user: { id: "cookA", role: "cook" }, body: {} }, r3, next);
      check("B9 cancelled accept refused (not 200)", r3.statusCode !== 200, `s=${r3.statusCode}`);
    }

    // B10: admin broadcast accept needs a cook; with cookId it assigns atomically.
    {
      const d = liveDoc();
      d._id = "race6"; d.status = "requested"; d.cook = null;
      d.requestExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
      Booking.findOne = async () => d;
      let assignedTo = null;
      Booking.updateOne = async (filter, update) => {
        if (filter.cook === null && filter.status === "requested") {
          assignedTo = update.$set?.cook || null;
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
      };
      Booking.findById = async () => ({ ...d, cook: assignedTo, status: assignedTo ? "accepted" : d.status });
      const rNoCook = makeRes();
      await controller.acceptBooking({ params: { id: "race6" }, user: { id: "admin1", role: "admin" }, body: {} }, rNoCook, next);
      check("B10 admin broadcast accept without cook -> 400", rNoCook.statusCode === 400, `s=${rNoCook.statusCode}`);
      const rCook = makeRes();
      await controller.acceptBooking({ params: { id: "race6" }, user: { id: "admin1", role: "admin" }, body: { cookId: "cookD" } }, rCook, next);
      check("B10 admin broadcast accept with cookId assigns atomically", rCook.statusCode === 200 && assignedTo === "cookD", `s=${rCook.statusCode} to=${assignedTo}`);
    }

    // ══ C. Ignore keeps the request alive ══
    setDbReady(false);
    {
      const d = liveDoc();
      d._id = "ign1"; d.status = "requested"; d.cook = null; d.ignoredBy = [];
      d.save = async function () { return this; };
      Booking.findOne = async () => d;
      Booking.updateOne = async () => ({ modifiedCount: 1 });
      Booking.findById = async () => d;
      notificationLog.length = 0;
      const r1 = makeRes();
      await controller.rejectBooking({ params: { id: "ign1" }, user: { id: "cookA", role: "cook" }, body: {} }, r1, next);
      check("C11 ignore stays REQUESTED (200, not rejected)", r1.statusCode === 200 && r1.body?.status === "requested" && r1.body?.ignored === true, `s=${r1.statusCode} st=${r1.body?.status}`);
      check("C11 ignore recorded, customer NOT rejection-notified", (d.ignoredBy || []).map(String).includes("cookA") && !notificationLog.some((n) => n.type === "booking_rejected"), `ignored=${JSON.stringify(d.ignoredBy)} notifs=${notificationLog.length}`);
      const r2 = makeRes();
      await controller.rejectBooking({ params: { id: "ign1" }, user: { id: "cookA", role: "cook" }, body: {} }, r2, next);
      check("C12 repeat ignore idempotent (200, still requested)", r2.statusCode === 200 && r2.body?.status === "requested", `s=${r2.statusCode}`);
    }

    // ══ D. Payment locked to assigned ACCEPTED ══
    {
      const mk = (over) => ({
        _id: "pay1", customer: "cust1", cook: null, status: "requested",
        date: new Date(Date.now() + 86400000), startTime: "10:00", endTime: "13:00",
        amount: 499, payment: { status: "pending" }, statusHistory: [],
        save: async function () { return this; },
        toObject() { const { save, toObject, ...rest } = this; return { ...rest }; },
        ...over,
      });
      Booking.findOne = async () => mk();
      const rp = makeRes();
      await controller.payBooking({ params: { id: "pay1" }, user: { id: "cust1", role: "customer" }, body: {} }, rp, next);
      check("D13 requested/unassigned booking cannot pay (400)", rp.statusCode === 400, `s=${rp.statusCode}`);
      Booking.findOne = async () => mk({ status: "accepted", cook: null });
      const rp2 = makeRes();
      await controller.payBooking({ params: { id: "pay1" }, user: { id: "cust1", role: "customer" }, body: {} }, rp2, next);
      check("D14 accepted-but-unassigned booking cannot pay (400)", rp2.statusCode === 400, `s=${rp2.statusCode}`);
    }

    // ══ E. End-to-end lifecycle races ══
    setDbReady(true);
    // E15: customer cancel wins -> late cook accept refused, one final state.
    {
      let st = "requested";
      let withCook = null;
      const d = liveDoc();
      d._id = "race7";
      Booking.findById = async () => ({ ...d, status: st, cook: withCook });
      Booking.findOne = async () => ({ ...d, status: st, cook: withCook, ignoredBy: [] });
      Booking.updateOne = async (filter, update) => {
        if (filter.status?.$in && st === "requested") {
          st = "cancelled"; // cancel claim wins
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 }; // accept claim loses (not requested)
      };
      Booking.find = () => chainSelect([]);
      const rc = makeRes();
      await controller.cancelBooking({ params: { id: "race7" }, user: { id: "cust1", role: "customer" }, body: {} }, rc, next);
      const ra = makeRes();
      await controller.acceptBooking({ params: { id: "race7" }, user: { id: "cookA", role: "cook" }, body: {} }, ra, next);
      check("E15 cancel-then-accept: exactly one winner (cancel stands)", rc.statusCode === 200 && st === "cancelled" && ra.statusCode !== 200, `cancel=${rc.statusCode} accept=${ra.statusCode} st=${st}`);
    }
    // E16: broadcast reschedule moves the slot + renews the window.
    {
      const d = {
        _id: "rs1", customer: "cust1", cook: null, ignoredBy: ["cookA"],
        serviceType: "cook_for_me", date: new Date(Date.now() + 3 * 86400000),
        startTime: "10:00", endTime: "13:00", durationHours: 3,
        status: "requested", rescheduleCount: 0, statusHistory: [], reschedules: [],
        requestExpiresAt: new Date(Date.now() + 60000),
        save: async function () { return this; },
      };
      Booking.findById = async () => d;
      Booking.find = () => chainSelect([]);
      Booking.findOneAndUpdate = async () => ({
        ...d, startTime: "14:00", endTime: "17:00", ignoredBy: [], rescheduleCount: 1,
        toObject() { return { ...d }; },
      });
      const rr = makeRes();
      const day = new Date(Date.now() + 4 * 86400000);
      const p = (n) => String(n).padStart(2, "0");
      await controller.rescheduleBooking({
        params: { id: "rs1" },
        user: { id: "cust1", role: "customer" },
        body: { date: `${day.getFullYear()}-${p(day.getMonth() + 1)}-${p(day.getDate())}`, startTime: "14:00" },
      }, rr, next);
      check("E16 broadcast reschedule moves slot (200)", rr.statusCode === 200, `s=${rr.statusCode} ${JSON.stringify(rr.body)?.slice(0, 120)}`);
    }
    // E17: requests feed hides ignored + ineligible, shows live broadcast.
    {
      const live = {
        _id: "feed1", status: "requested", cook: null, serviceType: "cook_for_me",
        date: new Date(Date.now() + 3 * 86400000), startTime: "10:00", endTime: "13:00",
        customer: { _id: "cust1", name: "Aditi" }, ignoredBy: [],
      };
      const ignored = { ...live, _id: "feed2", ignoredBy: ["cookA"] };
      const feedRows = [live, ignored];
      Booking.find = () => ({
        populate: () => ({ sort: () => ({ limit: () => ({ lean: async () => [live, ignored] }) }) }),
        select: () => ({ lean: async () => [] }),
      });
      CookProfile.findOne = () => ({ lean: async () => ({ user: "cookA", approvalStatus: "approved", serviceTypes: [] }) });
      const rf = makeRes();
      await controller.getCookRequests({ user: { id: "cookA", role: "cook" } }, rf, next);
      const ids = (Array.isArray(rf.body) ? rf.body : []).map((b) => String(b._id));
      check("E17 feed shows live broadcast, hides ignored", rf.statusCode === 200 && ids.includes("feed1") && !ids.includes("feed2"), `s=${rf.statusCode} ids=${ids}`);
    }
  } catch (e) {
    check("no unexpected error", false, (e && e.stack) || String(e));
  }
  console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED");
  process.exit(failures === 0 ? 0 : 1);
})();
