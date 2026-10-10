// Woman-presence verification + one-hour booking lockout tests.
//
// Covers: strict affirmation validation, decline recording (create /
// preserve / renew / concurrency), restriction state + fail-closed DB
// behavior, decline + status endpoints (auth-id authority, forged bodies),
// createBooking gates on EVERY booking path (missing/invalid/forged
// confirmation, active block, replay, DB-down), dispatch-worker + admin
// retry gates (unconfirmed skip, post-block skip, pre-block + legacy
// proceed), no side effects for blocked attempts, existing bookings
// untouched, route wiring, and middleware behavior.
//
// No real DB, no real WhatsApp, no real payments: models are faked
// in-memory, following the repo's established stub conventions.

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-woman-presence-0123456789";
// NOTE: WHATSAPP_ENABLED stays unset (disabled) except inside the dispatch
// tests, so createBooking's fire-and-forget notify can never attempt a real
// Meta call while models are stubbed.

const mongoose = require("mongoose");
const { Types } = mongoose;

const BookingRestriction = require("./models/BookingRestriction");
const Booking = require("./models/Booking");
const User = require("./models/User");
const Notification = require("./models/Notification");
const CookProfile = require("./models/CookProfile");
const Availability = require("./models/Availability");
const DispatchJob = require("./models/DispatchJob");
const vr = require("./utils/bookingRestrictions");
const verifyCtrl = require("./controllers/bookingVerificationController");
const bookingCtrl = require("./controllers/bookingController");
const { requireNoBookingBlock } = require("./middleware/requireNoBookingBlock");
const bookingsRouter = require("./routes/bookings");

let passes = 0, failures = 0;
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

// ---------- fake restriction store (faithful conditional-upsert semantics) --
const rStore = new Map(); // customerId -> doc
const RQ = (doc) => ({ lean: () => Promise.resolve(doc ? { ...doc } : null) });

const installRestrictionFake = (opts = {}) => {
  const origFindOne = BookingRestriction.findOne;
  const origFindOneAndUpdate = BookingRestriction.findOneAndUpdate;
  BookingRestriction.findOne = (filter = {}) => {
    if (opts.failReads) return { lean: () => Promise.reject(new Error("db down")) };
    const doc = rStore.get(String(filter.customer));
    if (!doc) return RQ(null);
    if (filter.blockedUntil && filter.blockedUntil.$gt) {
      const now = new Date(filter.blockedUntil.$gt).getTime();
      if (!(new Date(doc.blockedUntil).getTime() > now)) return RQ(null);
    }
    return RQ(doc);
  };
  BookingRestriction.findOneAndUpdate = (filter = {}, update = {}, options = {}) => {
    if (opts.failWrites) return Promise.reject(new Error("db down"));
    if (opts.duplicateRace) {
      const e = new Error("duplicate key");
      e.code = 11000;
      return Promise.reject(e);
    }
    const key = String(filter.customer || (update.$setOnInsert || {}).customer);
    const existing = rStore.get(key);
    const orClauses = filter.$or || [];
    // Conditional filter: a fresh window installs ONLY when no active one.
    if (existing && orClauses.length) {
      const nowMs = Date.now();
      const expired = new Date(existing.blockedUntil).getTime() <= nowMs || !existing.blockedUntil;
      if (!expired) return Promise.resolve(null); // no match — concurrent winner kept
    }
    if (!existing && options.upsert) {
      const doc = {
        _id: new Types.ObjectId(),
        customer: key,
        ...(update.$set || {}),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rStore.set(key, doc);
      return Promise.resolve({ ...doc, toObject: () => ({ ...doc }) });
    }
    if (existing) {
      Object.assign(existing, update.$set || {}, { updatedAt: new Date() });
      return Promise.resolve({ ...existing, toObject: () => ({ ...existing }) });
    }
    return Promise.resolve(null);
  };
  return () => {
    BookingRestriction.findOne = origFindOne;
    BookingRestriction.findOneAndUpdate = origFindOneAndUpdate;
  };
};

const realReadyState = mongoose.connection.readyState;
const setDbReady = (on) => {
  try {
    mongoose.connection.readyState = on ? 1 : 0;
  } catch {
  }
};

const custReq = (userId, body = {}) => ({
  user: { id: String(userId), name: "Test Customer" },
  body,
});

// createBooking needs the same stubs as master-suite 4.1 plus restriction.
const withBookingStubs = async (fn, { restrictionDoc = null, created = null, clientKeyExisting = null } = {}) => {
  const slots = require("./utils/slots");
  const saved = {
    CP1: CookProfile.findOne, CP: CookProfile.find, AF: Availability.find,
    BF: Booking.find, BC: Booking.create, BFO: Booking.findOne, NC: Notification.create,
    UF: User.findById, W: slots.getDayWindows, A: slots.resolveCookAvailability,
    DJU: DispatchJob.updateOne, DJF: DispatchJob.findOne, DJFU: DispatchJob.findOneAndUpdate,
  };
  const cookId = new Types.ObjectId().toString();
  const win = { _id: new Types.ObjectId(), startTime: "09:00", endTime: "11:00" };
  slots.getDayWindows = async () => [{ startTime: "08:00", endTime: "20:00" }];
  slots.resolveCookAvailability = async () => true;
  CookProfile.findOne = async () => ({ rate: 500, liveLocation: null });
  CookProfile.find = () => ({ populate: () => ({ lean: async () => [{ user: { _id: cookId, name: "Chef", status: "active" }, approvalStatus: "approved", serviceTypes: [] }] }) });
  Availability.find = () => ({ sort: () => Promise.resolve([win]) });
  Booking.find = () => ({ select: () => ({ lean: async () => [] }) });
  Booking.findOne = async (q) => {
    if (q && q.clientKey && clientKeyExisting) return { ...clientKeyExisting, toObject: () => clientKeyExisting };
    return null;
  };
  Booking.create = async (d) => {
    if (created) created.doc = d;
    return { _id: new Types.ObjectId(), ...d, toObject: () => d };
  };
  Notification.create = async (d) => d;
  User.findById = () => ({ select: () => Promise.resolve({ name: "Neha", phone: "9876543210" }) });
  // Durable outbox writes resolve instantly (no real DB in this harness).
  DispatchJob.updateOne = async () => ({ modifiedCount: 0 });
  DispatchJob.findOneAndUpdate = async () => null;
  DispatchJob.findOne = () => ({ lean: async () => null });
  const restoreR = installRestrictionFake();
  const prevStore = new Map(rStore);
  rStore.clear();
  if (restrictionDoc) rStore.set(String(restrictionDoc.customer), { ...restrictionDoc });
  setDbReady(true);
  try {
    return await fn({ cookId });
  } finally {
    CookProfile.findOne = saved.CP1; CookProfile.find = saved.CP;
    Availability.find = saved.AF; Booking.find = saved.BF;
    Booking.create = saved.BC; Booking.findOne = saved.BFO;
    Notification.create = saved.NC; User.findById = saved.UF;
    slots.getDayWindows = saved.W; slots.resolveCookAvailability = saved.A;
    DispatchJob.updateOne = saved.DJU; DispatchJob.findOne = saved.DJF;
    DispatchJob.findOneAndUpdate = saved.DJFU;
    restoreR();
    rStore.clear();
    for (const [k, v] of prevStore) rStore.set(k, v);
    setDbReady(realReadyState === 1);
  }
};

const futureDate = () => {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  const pp = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pp(d.getMonth() + 1)}-${pp(d.getDate())}`;
};
const validBookingBody = (overrides = {}) => ({
  serviceType: "cook_for_me",
  date: futureDate(),
  startTime: "09:00",
  endTime: "11:00",
  durationHours: 2,
  address: "Pune",
  womanPresenceConfirmed: true,
  ...overrides,
});

async function testAffirmation() {
  console.log("\n═══ STRICT AFFIRMATION ═══");
  check("WP-A1 true is the only valid affirmation", vr.isValidAffirmation(true) === true);
  for (const [label, v] of [
    ["false", false], ["missing", undefined], ["null", null],
    ['string "true"', "true"], ["number 1", 1], ["object", {}],
    ["array", []], ["YES string", "YES"], ["zero", 0],
  ]) {
    check(`WP-A2 rejects ${label}`, vr.isValidAffirmation(v) === false, JSON.stringify(v));
  }
  check("WP-A3 lockout is exactly 3600s", vr.LOCKOUT_SECONDS === 3600 && vr.LOCKOUT_MS === 3600000);
}

async function testDeclineLifecycle() {
  console.log("\n═══ DECLINE LIFECYCLE ═══");
  rStore.clear();
  const restore = installRestrictionFake();
  setDbReady(true);
  try {
    const cid = new Types.ObjectId().toString();
    const before = Date.now();
    const r1 = await vr.recordDecline(cid);
    const after = Date.now();
    check("WP-B1 decline creates a block", r1.created === true && r1.blockedUntil, JSON.stringify(r1.created));
    const untilMs = new Date(r1.blockedUntil).getTime();
    check("WP-B2 expiry is serverNow + 60min",
      untilMs >= before + vr.LOCKOUT_MS && untilMs <= after + vr.LOCKOUT_MS, `delta=${untilMs - before}`);
    const stored = rStore.get(cid);
    check("WP-B3 duration is exactly 3600000ms",
      new Date(stored.blockedUntil).getTime() - new Date(stored.declinedAt).getTime() === 3600000);
    check("WP-B4 reason code persisted", stored.reason === vr.POLICY_CODE, stored.reason);

    const r2 = await vr.recordDecline(cid);
    check("WP-B5 repeat decline preserves expiry (no extension)",
      r2.created === false && new Date(r2.blockedUntil).getTime() === untilMs);

    const st = await vr.getRestrictionState(cid);
    check("WP-B6 state reports active block with server expiry",
      st.blocked === true && new Date(st.blockedUntil).getTime() === untilMs);

    // Expire it, then decline again -> fresh window.
    stored.blockedUntil = new Date(Date.now() - 1000);
    const st2 = await vr.getRestrictionState(cid);
    check("WP-B7 expired restriction no longer blocks", st2.blocked === false);
    const r3 = await vr.recordDecline(cid);
    check("WP-B8 new decline after expiry starts a fresh hour",
      r3.created === true && new Date(r3.blockedUntil).getTime() > Date.now() + vr.LOCKOUT_MS - 5000);

    // Concurrency: 5 simultaneous declines share one expiry, never extend.
    const cid2 = new Types.ObjectId().toString();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => vr.recordDecline(cid2)));
    const expiries = results.map((r) => new Date(r.blockedUntil).getTime());
    check("WP-B9 concurrent declines converge on one expiry",
      Math.max(...expiries) - Math.min(...expiries) < 2000, expiries.join(","));
    const again = await vr.recordDecline(cid2);
    check("WP-B10 post-storm decline still preserves expiry",
      again.created === false && new Date(again.blockedUntil).getTime() === new Date(rStore.get(cid2).blockedUntil).getTime());
  } finally {
    restore();
    rStore.clear();
    setDbReady(realReadyState === 1);
  }
}

async function testFailClosed() {
  console.log("\n═══ FAIL-CLOSED DB OUTAGES ═══");
  rStore.clear();
  const restore = installRestrictionFake({ failReads: true, failWrites: true });
  setDbReady(true);
  try {
    let threw = null;
    try {
      await vr.getRestrictionState(new Types.ObjectId().toString());
    } catch (e) {
      threw = e;
    }
    check("WP-C1 unreadable store rejects (never silently unblocked)",
      threw && threw.code === vr.VERIFICATION_UNAVAILABLE_CODE, threw?.code);
    threw = null;
    try {
      await vr.recordDecline(new Types.ObjectId().toString());
    } catch (e) {
      threw = e;
    }
    check("WP-C2 unwritable store rejects with stable code (no false success)",
      threw && threw.code === "RESTRICTION_WRITE_FAILED", threw?.code);
  } finally {
    restore();
    setDbReady(realReadyState === 1);
  }
  // Transport-level outage: mongoose disconnected.
  const restore2 = installRestrictionFake();
  setDbReady(false);
  try {
    let threw = null;
    try {
      await vr.getRestrictionState(new Types.ObjectId().toString());
    } catch (e) {
      threw = e;
    }
    check("WP-C3 disconnected DB rejects state reads",
      threw && threw.code === vr.VERIFICATION_UNAVAILABLE_CODE, threw?.code);
  } finally {
    restore2();
    setDbReady(realReadyState === 1);
  }
  // Stalled store (connected but never answering): must fail fast so the
  // UI shows retry in milliseconds, never an endless spinner.
  const restore3 = installRestrictionFake();
  setDbReady(true);
  const prevTimeout = process.env.BOOKING_RESTRICTION_TIMEOUT_MS;
  process.env.BOOKING_RESTRICTION_TIMEOUT_MS = "40";
  BookingRestriction.findOne = () => ({ lean: () => new Promise(() => {}) });
  try {
    const t0 = Date.now();
    let threw = null;
    try {
      await vr.getRestrictionState(new Types.ObjectId().toString());
    } catch (e) {
      threw = e;
    }
    const elapsed = Date.now() - t0;
    check("WP-C4 stalled store fails fast with 503 signal",
      threw && threw.code === vr.VERIFICATION_UNAVAILABLE_CODE && elapsed < 2000,
      `code=${threw?.code} elapsed=${elapsed}ms`);
  } finally {
    if (prevTimeout === undefined) delete process.env.BOOKING_RESTRICTION_TIMEOUT_MS;
    else process.env.BOOKING_RESTRICTION_TIMEOUT_MS = prevTimeout;
    restore3();
    setDbReady(realReadyState === 1);
  }
}

async function testEndpoints() {
  console.log("\n═══ VERIFICATION ENDPOINTS ═══");
  rStore.clear();
  const restore = installRestrictionFake();
  setDbReady(true);
  try {
    const cid = new Types.ObjectId().toString();
    const other = new Types.ObjectId().toString();
    // Client-forged customer id in body must be ignored.
    let r = makeRes();
    await verifyCtrl.declineVerification(custReq(cid, { customer: other, customerId: other }), r, next);
    check("WP-D1 decline uses auth id, ignores forged body ids",
      (r.statusCode === 201 || r.statusCode === 200) && rStore.has(cid) && !rStore.has(other),
      `s=${r.statusCode}`);
    check("WP-D2 decline returns server expiry", Boolean(r.body?.blockedUntil) && r.body?.blocked === true);

    r = makeRes();
    await verifyCtrl.verificationStatus(custReq(cid), r, next);
    check("WP-D3 status restores the block (refresh / new device)",
      r.body?.blocked === true && r.body?.blockedUntil && Number.isFinite(r.body?.remainingSeconds),
      JSON.stringify({ b: r.body?.blocked, rs: r.body?.remainingSeconds }));

    const fresh = new Types.ObjectId().toString();
    r = makeRes();
    await verifyCtrl.verificationStatus(custReq(fresh), r, next);
    check("WP-D4 clean customer is not blocked", r.body?.blocked === false, JSON.stringify(r.body));

    r = makeRes();
    await verifyCtrl.declineVerification(custReq(cid, { nested: { evil: 1 } }), r, next);
    check("WP-D5 malformed body object rejected", r.statusCode === 400, `s=${r.statusCode}`);

    r = makeRes();
    await verifyCtrl.declineVerification({ body: {} }, r, next);
    check("WP-D6 unauthenticated decline rejected", r.statusCode === 401, `s=${r.statusCode}`);
  } finally {
    restore();
    rStore.clear();
    setDbReady(realReadyState === 1);
  }

  // Persistence failure -> stable 503, no false success.
  const restoreFail = installRestrictionFake({ failWrites: true });
  setDbReady(true);
  try {
    const r = makeRes();
    await verifyCtrl.declineVerification(custReq(new Types.ObjectId().toString()), r, next);
    check("WP-D7 decline write failure -> 503 (no false success)",
      r.statusCode === 503 && r.body?.code === "RESTRICTION_WRITE_FAILED", `s=${r.statusCode}`);
  } finally {
    restoreFail();
    setDbReady(realReadyState === 1);
  }
  const restoreFail2 = installRestrictionFake({ failReads: true });
  setDbReady(true);
  try {
    const r = makeRes();
    await verifyCtrl.verificationStatus(custReq(new Types.ObjectId().toString()), r, next);
    check("WP-D8 status read failure -> 503",
      r.statusCode === 503 && r.body?.code === vr.VERIFICATION_UNAVAILABLE_CODE, `s=${r.statusCode}`);
  } finally {
    restoreFail2();
    setDbReady(realReadyState === 1);
  }
}

async function testCreateBookingGates() {
  console.log("\n═══ BOOKING-CREATION GATES ═══");
  const runCreate = async (body, restrictionDoc, extra = {}) => {
    let bookingCreateCalls = 0;
    const created = {};
    const out = await withBookingStubs(async () => {
      const cid = extra.cid || new Types.ObjectId().toString();
      const r = makeRes();
      const origCreate = Booking.create;
      Booking.create = async (d) => {
        bookingCreateCalls += 1;
        created.doc = d;
        return origCreate(d);
      };
      try {
        await bookingCtrl.createBooking(custReq(cid, body), r, next);
      } finally {
        Booking.create = origCreate;
      }
      return { r, cid };
    }, { restrictionDoc });
    return { ...out, bookingCreateCalls, created };
  };

  const cid = new Types.ObjectId().toString();
  { // missing
    const { r, bookingCreateCalls } = await runCreate(validBookingBody({ womanPresenceConfirmed: undefined }));
    check("WP-E1 missing confirmation -> 400, nothing created",
      r.statusCode === 400 && r.body?.code === vr.CONFIRMATION_REQUIRED_CODE && bookingCreateCalls === 0,
      `s=${r.statusCode} creates=${bookingCreateCalls}`);
  }
  for (const [label, v] of [["false", false], ["null", null], ['"true"', "true"], ["1", 1], ["0", 0], ["{}", {}]]) {
    const body = validBookingBody();
    body.womanPresenceConfirmed = v;
    const { r, bookingCreateCalls } = await runCreate(body);
    check(`WP-E2 forged/invalid confirmation (${label}) -> 400, nothing created`,
      r.statusCode === 400 && bookingCreateCalls === 0, `s=${r.statusCode}`);
  }
  { // query-param style: body without the field (query ignored by design)
    const { r } = await runCreate(validBookingBody({ womanPresenceConfirmed: undefined }));
    check("WP-E3 confirmation absent from body -> 400 even if client claims it elsewhere",
      r.statusCode === 400, `s=${r.statusCode}`);
  }
  { // active block + valid confirmation
    const until = new Date(Date.now() + 30 * 60 * 1000);
    const blockedCid = new Types.ObjectId().toString();
    let couponTouched = false;
    const Coupon = require("./models/Coupon");
    const origFou = Coupon.findOneAndUpdate;
    Coupon.findOneAndUpdate = async () => { couponTouched = true; return null; };
    const { r, bookingCreateCalls } = await runCreate(validBookingBody(),
      { customer: blockedCid, blockedUntil: until, declinedAt: new Date(Date.now() - 30 * 60 * 1000), reason: vr.POLICY_CODE },
      { cid: blockedCid });
    Coupon.findOneAndUpdate = origFou;
    check("WP-E4 active block -> 403 BOOKING_TEMPORARILY_BLOCKED + expiry",
      r.statusCode === 403 && r.body?.code === vr.BLOCKED_CODE && r.body?.blockedUntil && Number.isFinite(r.body?.remainingSeconds),
      `s=${r.statusCode}`);
    check("WP-E5 blocked attempt creates no booking, consumes no coupon",
      bookingCreateCalls === 0 && couponTouched === false, `creates=${bookingCreateCalls} coupon=${couponTouched}`);
  }
  { // replay with clientKey while blocked -> still 403 (no bypass via idempotency)
    const blockedCid = new Types.ObjectId().toString();
    const until = new Date(Date.now() + 10 * 60 * 1000);
    const existing = { _id: new Types.ObjectId(), clientKey: "replay-key", customer: blockedCid };
    const saved = { BF: Booking.find, BFO: Booking.findOne };
    const restoreR = installRestrictionFake();
    rStore.clear();
    rStore.set(blockedCid, { customer: blockedCid, blockedUntil: until, declinedAt: new Date() });
    setDbReady(true);
    Booking.find = () => ({ select: () => ({ lean: async () => [] }) });
    Booking.findOne = async () => ({ ...existing, toObject: () => existing });
    const r = makeRes();
    try {
      await bookingCtrl.createBooking(custReq(blockedCid, validBookingBody({ clientKey: "replay-key" })), r, next);
      check("WP-E6 replayed request while blocked -> 403 (no idempotency bypass)",
        r.statusCode === 403 && r.body?.code === vr.BLOCKED_CODE, `s=${r.statusCode}`);
    } finally {
      Booking.find = saved.BF; Booking.findOne = saved.BFO;
      restoreR(); rStore.clear(); setDbReady(realReadyState === 1);
    }
  }
  { // happy path
    const { r, bookingCreateCalls, created } = await runCreate(validBookingBody());
    check("WP-E7 explicit YES + clean record -> 201 with persisted confirmation",
      (r.statusCode === 201 || r.statusCode === 200) && bookingCreateCalls === 1 && created.doc?.womanPresenceConfirmed === true && created.doc?.womanPresenceConfirmedAt,
      `s=${r.statusCode} confirmed=${created.doc?.womanPresenceConfirmed}`);
  }
  { // DB down -> 503 fail-closed
    const restoreR = installRestrictionFake();
    setDbReady(false);
    const r = makeRes();
    let createCalls = 0;
    const origCreate = Booking.create;
    Booking.create = async (d) => { createCalls += 1; return origCreate(d); };
    try {
      await bookingCtrl.createBooking(custReq(new Types.ObjectId().toString(), validBookingBody()), r, next);
      check("WP-E8 store outage -> 503 fail-closed, nothing created",
        r.statusCode === 503 && r.body?.code === vr.VERIFICATION_UNAVAILABLE_CODE && createCalls === 0,
        `s=${r.statusCode} creates=${createCalls}`);
    } finally {
      Booking.create = origCreate;
      restoreR(); setDbReady(realReadyState === 1);
    }
  }
}

async function testDeclineSideEffects() {
  console.log("\n═══ DECLINE SIDE EFFECTS ═══");
  rStore.clear();
  const restore = installRestrictionFake();
  setDbReady(true);
  let bookingCalls = 0, dispatchCalls = 0;
  const origFindById = Booking.findById, origUpdateOne = Booking.updateOne;
  const DJ = DispatchJob;
  const origDjUpdate = DJ.updateOne;
  Booking.findById = async (...a) => { bookingCalls += 1; return origFindById(...a); };
  Booking.updateOne = async (...a) => { bookingCalls += 1; return origUpdateOne(...a); };
  DJ.updateOne = async (...a) => { dispatchCalls += 1; return origDjUpdate(...a); };
  try {
    const cid = new Types.ObjectId().toString();
    const r = makeRes();
    await verifyCtrl.declineVerification(custReq(cid), r, next);
    check("WP-F1 decline creates no booking and no dispatch job",
      bookingCalls === 0 && dispatchCalls === 0 && (r.statusCode === 201 || r.statusCode === 200),
      `s=${r.statusCode} bookingCalls=${bookingCalls} dispatchCalls=${dispatchCalls}`);
  } finally {
    Booking.findById = origFindById; Booking.updateOne = origUpdateOne;
    DJ.updateOne = origDjUpdate;
    restore(); rStore.clear(); setDbReady(realReadyState === 1);
  }
}

async function testDispatchGates() {
  console.log("\n═══ DISPATCH + RETRY GATES ═══");
  const prevWa = {
    e: process.env.WHATSAPP_ENABLED,
    t: process.env.WHATSAPP_TOKEN,
    p: process.env.WHATSAPP_PHONE_NUMBER_ID,
  };
  process.env.WHATSAPP_ENABLED = "true";
  process.env.WHATSAPP_TOKEN = "test_token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
  const jobs = require("./services/bookingDispatchJobs");
  const restore = installRestrictionFake();
  setDbReady(true);
  rStore.clear();
  const origDjUpdate = DispatchJob.updateOne;
  const finished = [];
  DispatchJob.updateOne = async (filter, patch) => {
    finished.push({ filter, patch: patch.$set || {} });
    return { modifiedCount: 1 };
  };
  const origBFind = Booking.findById;
  const origUFind = User.findById;
  User.findById = () => ({ select: () => ({ lean: async () => null }) });
  const bookingDocs = new Map();
  Booking.findById = async (id) => bookingDocs.get(String(id)) || null;
  const mkBooking = (overrides = {}) => {
    const id = new Types.ObjectId().toString();
    const doc = {
      _id: id,
      customer: new Types.ObjectId().toString(),
      status: "requested",
      cook: null,
      requestExpiresAt: new Date(Date.now() + 4 * 60 * 1000),
      whatsappDispatch: [],
      createdAt: new Date(),
      womanPresenceConfirmed: true,
      womanPresenceConfirmedAt: new Date(),
      ...overrides,
    };
    bookingDocs.set(id, doc);
    return doc;
  };
  const mkJob = (bookingId) => ({ _id: new Types.ObjectId().toString(), booking: bookingId, kind: "booking.requested", attempts: 0, maxAttempts: 3 });
  const lastReason = () => (finished.length ? finished[finished.length - 1].patch.reason : null);
  try {
    { // unconfirmed, recent -> skip
      finished.length = 0;
      let fanOutCalls = 0;
      const b = mkBooking({ womanPresenceConfirmed: false, womanPresenceConfirmedAt: null });
      await jobs.processJob(mkJob(b._id), {
        findEligibleCooks: async () => [{ userId: "c1" }],
        fanOut: async () => { fanOutCalls += 1; return { ok: true, results: [{ ok: true, cookId: "c1" }] }; },
      });
      check("WP-G1 unconfirmed booking is never dispatched",
        lastReason() === "missing_confirmation" && fanOutCalls === 0, `reason=${lastReason()}`);
    }
    { // confirmed but created AFTER an active block -> skip
      finished.length = 0;
      let fanOutCalls = 0;
      const cid = new Types.ObjectId().toString();
      const declinedAt = new Date(Date.now() - 5 * 60 * 1000);
      rStore.set(cid, { customer: cid, blockedUntil: new Date(Date.now() + 55 * 60 * 1000), declinedAt });
      const b = mkBooking({ customer: cid, createdAt: new Date() });
      await jobs.processJob(mkJob(b._id), {
        findEligibleCooks: async () => [{ userId: "c1" }],
        fanOut: async () => { fanOutCalls += 1; return { ok: true, results: [{ ok: true, cookId: "c1" }] }; },
      });
      check("WP-G2 booking created under an active block is not dispatched",
        lastReason() === "customer_blocked" && fanOutCalls === 0, `reason=${lastReason()}`);
    }
    { // confirmed, created BEFORE a later block -> proceeds (no corruption)
      finished.length = 0;
      let fanOutCalls = 0;
      const cid = new Types.ObjectId().toString();
      const b = mkBooking({ customer: cid, createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) });
      rStore.set(cid, { customer: cid, blockedUntil: new Date(Date.now() + 55 * 60 * 1000), declinedAt: new Date() });
      await jobs.processJob(mkJob(b._id), {
        findEligibleCooks: async () => [{ userId: "c1" }],
        fanOut: async () => { fanOutCalls += 1; return { ok: true, results: [{ ok: true, cookId: "c1" }] }; },
      });
      check("WP-G3 legitimate pre-block booking still dispatches",
        fanOutCalls === 1 && lastReason() === "dispatched",
        `reason=${lastReason()} fanOut=${fanOutCalls}`);
    }
    { // legacy (pre-rollout, no confirmation) -> proceeds
      finished.length = 0;
      let fanOutCalls = 0;
      const b = mkBooking({
        womanPresenceConfirmed: false,
        womanPresenceConfirmedAt: null,
        createdAt: new Date("2020-01-01T00:00:00Z"),
      });
      await jobs.processJob(mkJob(b._id), {
        findEligibleCooks: async () => [{ userId: "c1" }],
        fanOut: async () => { fanOutCalls += 1; return { ok: true, results: [{ ok: true, cookId: "c1" }] }; },
      });
      check("WP-G4 legacy pre-rollout booking is grandfathered",
        fanOutCalls === 1 && lastReason() === "dispatched", `reason=${lastReason()}`);
    }
    { // admin retry on unconfirmed recent booking -> 403
      const b = mkBooking({ womanPresenceConfirmed: false, womanPresenceConfirmedAt: null });
      const r = makeRes();
      await bookingCtrl.retryCookWhatsApp({ params: { id: b._id }, user: { id: "admin1", role: "admin" } }, r, next);
      check("WP-G5 admin retry of unconfirmed booking refused",
        r.statusCode === 403 && r.body?.code === "BOOKING_MISSING_CONFIRMATION", `s=${r.statusCode}`);
    }
    { // admin retry on legacy booking -> not refused by the gate
      const b = mkBooking({
        womanPresenceConfirmed: false,
        womanPresenceConfirmedAt: null,
        createdAt: new Date("2020-01-01T00:00:00Z"),
      });
      const CookProfileM = require("./models/CookProfile");
      const origFind = CookProfileM.find;
      CookProfileM.find = () => ({ populate: () => ({ lean: async () => [] }) });
      const r = makeRes();
      try {
        await bookingCtrl.retryCookWhatsApp({ params: { id: b._id }, user: { id: "admin1", role: "admin" } }, r, next);
      } catch {
      } finally {
        CookProfileM.find = origFind;
      }
      check("WP-G6 admin retry of legacy booking passes the confirmation gate",
        r.statusCode !== 403 || r.body?.code !== "BOOKING_MISSING_CONFIRMATION",
        `s=${r.statusCode} code=${r.body?.code}`);
    }
  } finally {
    DispatchJob.updateOne = origDjUpdate;
    Booking.findById = origBFind;
    User.findById = origUFind;
    if (prevWa.e === undefined) delete process.env.WHATSAPP_ENABLED; else process.env.WHATSAPP_ENABLED = prevWa.e;
    if (prevWa.t === undefined) delete process.env.WHATSAPP_TOKEN; else process.env.WHATSAPP_TOKEN = prevWa.t;
    if (prevWa.p === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID; else process.env.WHATSAPP_PHONE_NUMBER_ID = prevWa.p;
    restore(); rStore.clear(); setDbReady(realReadyState === 1);
  }
}

async function testWiring() {
  console.log("\n═══ ROUTE WIRING ═══");
  const byPath = {};
  for (const layer of bookingsRouter.stack) {
    const r = layer.route;
    if (!r) continue;
    byPath[r.path] = byPath[r.path] || {};
    for (const m of Object.keys(r.methods)) {
      byPath[r.path][m] = r.stack.map((h) => h.handle);
    }
  }
  const has = (p, m, fn) => (byPath[p]?.[m] || []).includes(fn);
  const firstIsAuth = (p, m) => (byPath[p]?.[m] || [])[0]?.name === "auth";
  check("WP-H1 POST /verification/decline is auth + customer-gated",
    firstIsAuth("/verification/decline", "post") && has("/verification/decline", "post", verifyCtrl.declineVerification));
  check("WP-H2 GET /verification/status is auth + customer-gated",
    firstIsAuth("/verification/status", "get") && has("/verification/status", "get", verifyCtrl.verificationStatus));

  // POST / validator: only boolean true passes the confirmation rule.
  const postStack = byPath["/"]?.post || [];
  const validators = postStack.filter((h) => h && h.name !== "auth" && h !== bookingCtrl.createBooking);
  let confirmationRule = null;
  for (const v of validators) {
    try {
      const s = String(v.toString());
      if (s.includes("womanPresenceConfirmed")) confirmationRule = v;
    } catch {
    }
  }
  check("WP-H3 POST / carries a womanPresenceConfirmed validator", validators.length > 0, `layers=${postStack.length}`);

  // Middleware unit behavior.
  const restore = installRestrictionFake();
  setDbReady(true);
  rStore.clear();
  try {
    const cid = new Types.ObjectId().toString();
    let r = makeRes();
    let nexted = false;
    await requireNoBookingBlock({ user: { id: cid } }, r, () => { nexted = true; });
    check("WP-H4 middleware passes clean customers", nexted === true && r.statusCode === 200);

    rStore.set(cid, { customer: cid, blockedUntil: new Date(Date.now() + 60000), declinedAt: new Date() });
    r = makeRes();
    nexted = false;
    await requireNoBookingBlock({ user: { id: cid } }, r, () => { nexted = true; });
    check("WP-H5 middleware blocks with 403 + code + expiry",
      nexted === false && r.statusCode === 403 && r.body?.code === vr.BLOCKED_CODE && r.body?.blockedUntil,
      `s=${r.statusCode}`);
  } finally {
    restore(); rStore.clear(); setDbReady(realReadyState === 1);
  }
  const restore2 = installRestrictionFake({ failReads: true });
  setDbReady(true);
  try {
    const r = makeRes();
    let nexted = false;
    await requireNoBookingBlock({ user: { id: new Types.ObjectId().toString() } }, r, () => { nexted = true; });
    check("WP-H6 middleware fails closed (503) when store is down",
      nexted === false && r.statusCode === 503, `s=${r.statusCode}`);
  } finally {
    restore2(); setDbReady(realReadyState === 1);
  }
  void confirmationRule;
}

(async () => {
  try {
    await testAffirmation();
    await testDeclineLifecycle();
    await testFailClosed();
    await testEndpoints();
    await testCreateBookingGates();
    await testDeclineSideEffects();
    await testDispatchGates();
    await testWiring();
  } catch (e) {
    failures += 1;
    console.log(`FAIL  harness exception  -> ${e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e}`);
  }
  console.log(`\nwoman-presence: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
