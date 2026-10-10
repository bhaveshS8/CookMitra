// Location validation + saved-history tests.
//
// Covers: saved-location scoping/dedup (distinct pins stay separate,
// non-finite pins never leak to the client), booking-create coordinate
// pairing (complete pair persists; partial/NaN/out-of-range stripped, never
// persisted), and manual booking without coordinates.

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-location-0123456789";

const mongoose = require("mongoose");
const { Types } = mongoose;

const Booking = require("./models/Booking");
const User = require("./models/User");
const Notification = require("./models/Notification");
const CookProfile = require("./models/CookProfile");
const Availability = require("./models/Availability");
const DispatchJob = require("./models/DispatchJob");
const BookingRestriction = require("./models/BookingRestriction");
const slots = require("./utils/slots");
const bookingCtrl = require("./controllers/bookingController");

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

const realReadyState = mongoose.connection.readyState;
const setDbReady = (on) => {
  try { mongoose.connection.readyState = on ? 1 : 0; } catch { /* ignore */ }
};

const withStubs = async (fn, bookingRows = []) => {
  const saved = {
    BF: Booking.find, BC: Booking.create, BFO: Booking.findOne, BUO: Booking.updateOne, BCD: Booking.countDocuments,
    CP1: CookProfile.findOne, CP: CookProfile.find, AF: Availability.find,
    NC: Notification.create, UF: User.findById,
    DJU: DispatchJob.updateOne, DJF: DispatchJob.findOne, DJFU: DispatchJob.findOneAndUpdate,
    BR: BookingRestriction.findOne, W: slots.getDayWindows, A: slots.resolveCookAvailability,
  };
  const cookId = new Types.ObjectId().toString();
  const win = { _id: new Types.ObjectId(), startTime: "09:00", endTime: "11:00" };
  const created = [];
  slots.getDayWindows = async () => [{ startTime: "08:00", endTime: "20:00" }];
  slots.resolveCookAvailability = async () => true;
  CookProfile.findOne = async () => ({ rate: 500, liveLocation: null });
  CookProfile.find = () => ({ populate: () => ({ lean: async () => [{ user: { _id: cookId, name: "Chef", status: "active" }, approvalStatus: "approved", serviceTypes: [] }] }) });
  Availability.find = () => ({ sort: () => Promise.resolve([win]) });
  Booking.find = () => ({ select: () => ({ sort: () => ({ limit: async () => bookingRows }) }) });
  Booking.findOne = async () => null;
  Booking.create = async (d) => {
    const doc = { _id: new Types.ObjectId(), ...JSON.parse(JSON.stringify(d)), toObject() { return JSON.parse(JSON.stringify(d)); } };
    created.push(doc);
    return doc;
  };
  Booking.updateOne = async () => ({ modifiedCount: 0 });
  Booking.countDocuments = async () => 0;
  Notification.create = async (d) => d;
  User.findById = () => ({ select: () => Promise.resolve({ name: "Neha", phone: "9876543210" }) });
  DispatchJob.updateOne = async () => ({ modifiedCount: 0 });
  DispatchJob.findOneAndUpdate = async () => null;
  DispatchJob.findOne = () => ({ lean: async () => null });
  BookingRestriction.findOne = () => ({ lean: async () => null });
  setDbReady(true);
  try {
    return await fn({ cookId, created });
  } finally {
    Booking.find = saved.BF; Booking.create = saved.BC; Booking.findOne = saved.BFO;
    Booking.updateOne = saved.BUO; Booking.countDocuments = saved.BCD;
    CookProfile.findOne = saved.CP1; CookProfile.find = saved.CP; Availability.find = saved.AF;
    Notification.create = saved.NC; User.findById = saved.UF;
    DispatchJob.updateOne = saved.DJU; DispatchJob.findOne = saved.DJF; DispatchJob.findOneAndUpdate = saved.DJFU;
    BookingRestriction.findOne = saved.BR;
    slots.getDayWindows = saved.W; slots.resolveCookAvailability = saved.A;
    setDbReady(realReadyState === 1);
  }
};

const futureDateStr = () => {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  const pp = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pp(d.getMonth() + 1)}-${pp(d.getDate())}`;
};
const baseBody = (over = {}) => ({
  serviceType: "cook_for_me",
  date: futureDateStr(),
  startTime: "09:00",
  endTime: "11:00",
  durationHours: 2,
  address: "Flat 1, Pune",
  womanPresenceConfirmed: true,
  ...over,
});

async function testHistory() {
  console.log("\n═══ SAVED-LOCATION HISTORY ═══");
  const mkRow = (over = {}) => ({
    address: "A-402, Sunshine, Hadapsar",
    addressDetails: { flatNo: "A-402", society: "Sunshine", city: "Hadapsar" },
    location: null,
    createdAt: new Date(),
    ...over,
  });
  const rows = [
    mkRow({ location: { lat: 18.5, lng: 73.8 } }),
    mkRow({ location: { lat: 18.61, lng: 73.95 } }),
    mkRow({ address: "Other street", addressDetails: {}, location: null }),
    mkRow({ address: "NaN pin", addressDetails: {}, location: { lat: NaN, lng: 73.8 } }),
    mkRow({ address: "   ", addressDetails: {}, location: { lat: 1, lng: 1 } }),
  ];
  const oF = Booking.find;
  let seenFilter = null;
  Booking.find = (f) => {
    seenFilter = f;
    return { select: () => ({ sort: () => ({ limit: async () => rows }) }) };
  };
  const r = makeRes();
  const uid = new Types.ObjectId().toString();
  try {
    await bookingCtrl.getMyLocations({ user: { id: uid } }, r, next);
    const list = r.body || [];
    const pins = list.filter((e) => e.location).map((e) => `${e.location.lat},${e.location.lng}`);
    check("LOC-H1 history scoped to the authenticated customer",
      seenFilter && String(seenFilter.customer) === uid, JSON.stringify(seenFilter));
    check("LOC-H2 materially different pins are not merged",
      pins.includes("18.5,73.8") && pins.includes("18.61,73.95"), pins.join(" | "));
    check("LOC-H3 pin-less entry has null location",
      list.some((e) => e.address === "Other street" && e.location === null),
      JSON.stringify(list.map((e) => e.address)));
    const nanEntry = list.find((e) => e.address === "NaN pin");
    check("LOC-H4 non-finite pins never leak to the client",
      nanEntry && nanEntry.location === null, JSON.stringify(nanEntry?.location));
    check("LOC-H5 blank addresses skipped",
      !list.some((e) => !String(e.address || "").trim()), `entries=${list.length}`);
  } finally {
    Booking.find = oF;
  }
}

async function testCreatePairing() {
  console.log("\n═══ CREATE-TIME PAIRING ═══");
  await withStubs(async ({ created }) => {
    const uid = new Types.ObjectId().toString();
    const r = makeRes();
    await bookingCtrl.createBooking({
      user: { id: uid, name: "T" },
      body: baseBody({ location: { lat: 18.5204, lng: 73.8567 } }),
    }, r, next);
    check("LOC-C1 complete valid pair persists",
      (r.statusCode === 201 || r.statusCode === 200) && created[0]?.location?.lat === 18.5204 && created[0]?.location?.lng === 73.8567,
      `s=${r.statusCode} loc=${JSON.stringify(created[0]?.location)}`);
  });
  await withStubs(async ({ created }) => {
    const uid = new Types.ObjectId().toString();
    const r = makeRes();
    await bookingCtrl.createBooking({
      user: { id: uid, name: "T" },
      body: baseBody({ location: { lat: 18.5204 } }),
    }, r, next);
    check("LOC-C2 partial pair stripped, booking proceeds on address",
      (r.statusCode === 201 || r.statusCode === 200) && created[0]?.location === undefined,
      `s=${r.statusCode} loc=${JSON.stringify(created[0]?.location)}`);
  });
  await withStubs(async ({ created }) => {
    const uid = new Types.ObjectId().toString();
    for (const [label, loc] of [
      ["NaN", { lat: NaN, lng: 73.8 }],
      ["out-of-range", { lat: 200, lng: 73.8 }],
      ["strings", { lat: "abc", lng: "def" }],
    ]) {
      const r = makeRes();
      await bookingCtrl.createBooking({
        user: { id: uid, name: "T" },
        body: baseBody({ location: loc, clientKey: `loc-${label}-${Date.now()}-${Math.random()}` }),
      }, r, next);
      const ok = (r.statusCode === 201 || r.statusCode === 200) && created[created.length - 1]?.location === undefined;
      check(`LOC-C3 invalid ${label} never persists`, ok, `s=${r.statusCode}`);
    }
  });
  await withStubs(async ({ created }) => {
    const uid = new Types.ObjectId().toString();
    const r = makeRes();
    await bookingCtrl.createBooking({
      user: { id: uid, name: "T" },
      body: baseBody({ location: { lat: "18.5204", lng: "73.8567" } }),
    }, r, next);
    check("LOC-C4 numeric strings normalize to numbers",
      created[0]?.location?.lat === 18.5204 && created[0]?.location?.lng === 73.8567,
      JSON.stringify(created[0]?.location));
  });
  await withStubs(async ({ created }) => {
    const uid = new Types.ObjectId().toString();
    const r = makeRes();
    await bookingCtrl.createBooking({
      user: { id: uid, name: "T" },
      body: baseBody(),
    }, r, next);
    check("LOC-C5 manual booking without coordinates works",
      (r.statusCode === 201 || r.statusCode === 200) && created[0]?.location === undefined,
      `s=${r.statusCode}`);
  });
}

(async () => {
  try {
    await testHistory();
    await testCreatePairing();
  } catch (e) {
    failures += 1;
    console.log(`FAIL  harness exception  -> ${e && e.stack ? e.stack.split("\n").slice(0, 4).join(" | ") : e}`);
  }
  console.log(`\nlocation: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
