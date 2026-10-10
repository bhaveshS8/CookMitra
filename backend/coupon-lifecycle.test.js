// Coupon lifecycle tests: validate <-> create agreement, tamper-proofing,
// second-use/exhausted/disable paths, legacy codes, release/reuse, atomic
// concurrency, and a full mocked-gateway E2E (validate -> book -> order ->
// pay -> webhook -> duplicate webhook).
//
// No real DB, no real gateway, no real money: models are faked in-memory,
// Razorpay is stubbed at the client, signatures use real HMAC.

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-coupon-lifecycle-0123456789";
process.env.RAZORPAY_KEY_ID = "rk_test_abcdef123456";
process.env.RAZORPAY_KEY_SECRET = "s3cr3tK3yV4lu3AbCdEfGh";
process.env.RAZORPAY_CURRENCY = "INR";
process.env.RAZORPAY_WEBHOOK_SECRET = "wh_test_secret_abc123";

const crypto = require("crypto");
const mongoose = require("mongoose");
const { Types } = mongoose;

const Coupon = require("./models/Coupon");
const Booking = require("./models/Booking");
const User = require("./models/User");
const Notification = require("./models/Notification");
const CookProfile = require("./models/CookProfile");
const Availability = require("./models/Availability");
const DispatchJob = require("./models/DispatchJob");
const WebhookEvent = require("./models/WebhookEvent");
const LedgerEntry = require("./models/LedgerEntry");
const BookingRestriction = require("./models/BookingRestriction");
const slots = require("./utils/slots");
const couponCtrl = require("./controllers/couponController");
const bookingCtrl = require("./controllers/bookingController");
const paymentCtrl = require("./controllers/paymentController");
const rzCfg = require("./config/razorpay");
const { INITIAL_COUPONS } = require("./utils/couponCatalog");
const { computeDiscount } = require("./utils/coupons");

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

// ---------- coupon fake store (atomic conditional redemption) ------------
const couponStore = new Map(); // code -> doc
let couponWrites = 0;
const seedCouponStore = (docs) => {
  couponStore.clear();
  couponWrites = 0;
  for (const d of docs) couponStore.set(d.code, JSON.parse(JSON.stringify(d)));
};
const mkCouponDoc = (over = {}) => ({
  _id: new Types.ObjectId().toString(),
  code: "FESTIVE20",
  description: "t",
  discountType: "percent",
  percent: 20,
  flatAmount: null,
  maxDiscount: 70,
  minOrder: 499,
  usageLimit: null,
  usedCount: 0,
  usedBy: [],
  perUserLimit: 1,
  firstBookingOnly: false,
  applicableServices: [],
  validFrom: null,
  validTo: null,
  active: true,
  ...over,
});
// Faithful synchronous evaluation of the controller's $expr guard.
const exprPasses = (andClauses, doc, userIdStr, isFirstBooking) => {
  const val = (node) => {
    if (node && typeof node === "object") {
      if ("$literal" in node) return node.$literal;
      if ("$toString" in node) return String(val(node.$toString));
      if ("$ifNull" in node) {
        const [a, b] = node.$ifNull;
        const va = getVal(a);
        return va === null || va === undefined ? b : va;
      }
      if ("$size" in node) {
        const arr = val(node.$size);
        return Array.isArray(arr) ? arr.length : 0;
      }
      if ("$filter" in node) {
        const arr = val(node.$filter.input) || [];
        return arr.filter(() => true).filter((item) => {
          const cond = node.$filter.cond;
          return String(item) === String(userIdStr) && cond && cond.$eq;
        });
      }
      return undefined;
    }
    if (typeof node === "string" && node.startsWith("$")) {
      return getVal(node);
    }
    return node;
  };
  const getVal = (path) => {
    if (path === "$active") return doc.active;
    if (path === "$usedCount") return doc.usedCount;
    if (path === "$usedBy") return doc.usedBy;
    if (path === "$$this") return undefined;
    return undefined;
  };
  const test = (clause) => {
    if (clause.$ne) {
      const [a, b] = clause.$ne;
      return val(a) !== b;
    }
    if (clause.$lt) {
      const [a, b] = clause.$lt;
      return Number(val(a)) < Number(b);
    }
    if (clause.$eq) {
      const [a, b] = clause.$eq;
      return val(a) === b;
    }
    return false;
  };
  return (andClauses || []).every(test);
};

const installCouponFake = () => {
  const saved = { findOne: Coupon.findOne, find: Coupon.find, fou: Coupon.findOneAndUpdate, updateOne: Coupon.updateOne };
  Coupon.findOne = async (filter = {}) => {
    if (filter._id) {
      for (const d of couponStore.values()) if (String(d._id) === String(filter._id)) return { ...d };
      return null;
    }
    if (filter.code !== undefined) {
      const d = couponStore.get(String(filter.code));
      return d ? { ...d } : null;
    }
    return null;
  };
  Coupon.find = async () => [...couponStore.values()].map((d) => ({ ...d }));
  Coupon.findOneAndUpdate = async (filter = {}, update = {}) => {
    couponWrites += 1;
    const doc = [...couponStore.values()].find((d) => String(d._id) === String(filter._id));
    if (!doc) return null;
    const userIdStr = String((update.$push || {}).usedBy || "");
    // Reconstruct the controller's pre-read inputs for the literal check.
    const lit = (filter.$expr?.$and || []).find((c) => c.$eq && c.$eq[0]?.$literal !== undefined);
    const isFirst = lit ? lit.$eq[0].$literal : true;
    if (!exprPasses(filter.$expr?.$and || [], doc, userIdStr, isFirst)) return null;
    doc.usedCount = (Number(doc.usedCount) || 0) + 1;
    doc.usedBy = [...(doc.usedBy || []), userIdStr];
    return { ...doc };
  };
  Coupon.updateOne = async (filter = {}, update = {}) => {
    couponWrites += 1;
    const doc = couponStore.get(String(filter.code));
    if (!doc) return { modifiedCount: 0 };
    if (update.$inc && update.$inc.usedCount) doc.usedCount = (Number(doc.usedCount) || 0) + update.$inc.usedCount;
    if (update.$pull && update.$pull.usedBy !== undefined) {
      doc.usedBy = (doc.usedBy || []).filter((u) => String(u) !== String(update.$pull.usedBy));
    }
    if (update.$set) Object.assign(doc, update.$set);
    return { modifiedCount: 1 };
  };
  return () => {
    Coupon.findOne = saved.findOne; Coupon.find = saved.find;
    Coupon.findOneAndUpdate = saved.fou; Coupon.updateOne = saved.updateOne;
  };
};

// ---------- generic booking fake store -----------------------------------
const bookingStore = new Map();
const setDeep = (obj, dotted, value) => {
  const parts = String(dotted).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
};
const getDeep = (obj, dotted) => String(dotted).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const applyBookingUpdate = (doc, update = {}) => {
  if (update.$set) for (const k of Object.keys(update.$set)) setDeep(doc, k, update.$set[k]);
  if (update.$inc) for (const k of Object.keys(update.$inc)) setDeep(doc, k, (Number(getDeep(doc, k)) || 0) + update.$inc[k]);
  if (update.$push) for (const k of Object.keys(update.$push)) {
    const cur = getDeep(doc, k) || [];
    const v = update.$push[k];
    if (v && v.$each) cur.push(...v.$each);
    else cur.push(v);
    setDeep(doc, k, cur);
  }
};
const installBookingFake = () => {
  const saved = {
    findOne: Booking.findOne, findById: Booking.findById, find: Booking.find,
    create: Booking.create, updateOne: Booking.updateOne, count: Booking.countDocuments,
    fou: Booking.findOneAndUpdate,
  };
  Booking.findOne = async (filter = {}) => {
    for (const d of bookingStore.values()) {
      let ok = true;
      for (const k of Object.keys(filter)) {
        if (k === "$or") {
          ok = filter.$or.some((cl) => Object.keys(cl).every((ck) => {
            const dv = getDeep(d, ck);
            const cv = cl[ck];
            return Array.isArray(dv) ? dv.map(String).includes(String(cv)) : String(dv) === String(cv);
          }));
        } else if (filter[k] && typeof filter[k] === "object" && !(filter[k] instanceof Date) && !Array.isArray(filter[k])) {
          const cond = filter[k];
          const dv = getDeep(d, k);
          if ("$ne" in cond && String(dv) === String(cond.$ne)) ok = false;
        } else if (String(getDeep(d, k)) !== String(filter[k])) ok = false;
      }
      if (ok) return d;
    }
    return null;
  };
  Booking.findById = (id) => {
    const d = bookingStore.get(String(id)) || null;
    const q = Promise.resolve(d);
    q.select = async () => d;
    q.lean = async () => (d ? JSON.parse(JSON.stringify(d)) : null);
    return q;
  };
  Booking.find = () => {
    // Chainable + awaitable like a real Mongoose query.
    const q = {
      select: () => q,
      lean: async () => [],
      sort: () => q,
      limit: () => q,
      populate: () => q,
      then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
    };
    return q;
  };
  Booking.create = async (doc) => {
    const full = { _id: new Types.ObjectId().toString(), ...JSON.parse(JSON.stringify(doc)) };
    full.save = async function () { return this; };
    full.toObject = function () { const { save, toObject, ...rest } = this; return { ...rest }; };
    bookingStore.set(String(full._id), full);
    return full;
  };
  Booking.updateOne = async (filter = {}, update = {}) => {
    const d = bookingStore.get(String(filter._id));
    if (!d) return { modifiedCount: 0 };
    if (filter.status && d.status !== filter.status) return { modifiedCount: 0 };
    if (filter.couponReleased && filter.couponReleased.$ne === true && d.couponReleased === true) return { modifiedCount: 0 };
    applyBookingUpdate(d, update);
    return { modifiedCount: 1 };
  };
  Booking.countDocuments = async (filter = {}) => {
    if (filter.customer) return [...bookingStore.values()].filter((d) => String(d.customer) === String(filter.customer)).length;
    return bookingStore.size;
  };
  Booking.findOneAndUpdate = async (filter = {}, update = {}, opts = {}) => {
    const d = bookingStore.get(String(filter._id));
    if (!d) return null;
    if (filter.status && d.status !== filter.status) return null;
    if (filter["payment.status"] && filter["payment.status"].$ne === "paid" && d.payment?.status === "paid") return null;
    applyBookingUpdate(d, update);
    const copy = JSON.parse(JSON.stringify(d));
    copy.save = async function () { return this; };
    copy.toObject = function () { const { save, toObject, ...rest } = this; return { ...rest }; };
    return opts.new === false ? null : copy;
  };
  return () => {
    Booking.findOne = saved.findOne; Booking.findById = saved.findById;
    Booking.find = saved.find; Booking.create = saved.create;
    Booking.updateOne = saved.updateOne; Booking.countDocuments = saved.count;
    Booking.findOneAndUpdate = saved.fou;
  };
};

const realReadyState = mongoose.connection.readyState;
const setDbReady = (on) => {
  try { mongoose.connection.readyState = on ? 1 : 0; } catch { /* ignore */ }
};

// Shared stubs for the booking-creation path (mirrors master-suite 4.1).
const withCreationStubs = async (fn) => {
  const oW = slots.getDayWindows, oA = slots.resolveCookAvailability;
  const oCP1 = CookProfile.findOne, oCP = CookProfile.find, oAF = Availability.find;
  const oNC = Notification.create, oUF = User.findById;
  const oDJU = DispatchJob.updateOne, oDJF = DispatchJob.findOne, oDJFU = DispatchJob.findOneAndUpdate;
  const oBR = BookingRestriction.findOne;
  const cookId = new Types.ObjectId().toString();
  const win = { _id: new Types.ObjectId(), startTime: "09:00", endTime: "11:00" };
  slots.getDayWindows = async () => [{ startTime: "08:00", endTime: "20:00" }];
  slots.resolveCookAvailability = async () => true;
  CookProfile.findOne = async () => ({ rate: 500, liveLocation: null });
  CookProfile.find = () => ({ populate: () => ({ lean: async () => [{ user: { _id: cookId, name: "Chef", status: "active" }, approvalStatus: "approved", serviceTypes: [] }] }) });
  Availability.find = () => ({ sort: () => Promise.resolve([win]) });
  Notification.create = async (d) => d;
  User.findById = () => ({ select: () => Promise.resolve({ name: "Neha", phone: "9876543210" }) });
  DispatchJob.updateOne = async () => ({ modifiedCount: 0 });
  DispatchJob.findOneAndUpdate = async () => null;
  DispatchJob.findOne = () => ({ lean: async () => null });
  // Woman-presence gate: no customer is blocked in this suite.
  BookingRestriction.findOne = () => ({ lean: async () => null });
  const restoreC = installCouponFake();
  const restoreB = installBookingFake();
  setDbReady(true);
  try {
    return await fn({ cookId });
  } finally {
    slots.getDayWindows = oW; slots.resolveCookAvailability = oA;
    CookProfile.findOne = oCP1; CookProfile.find = oCP; Availability.find = oAF;
    Notification.create = oNC; User.findById = oUF;
    DispatchJob.updateOne = oDJU; DispatchJob.findOne = oDJF; DispatchJob.findOneAndUpdate = oDJFU;
    BookingRestriction.findOne = oBR;
    restoreC(); restoreB();
    setDbReady(realReadyState === 1);
  }
};

const futureDateStr = (days = 30) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
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
const SLAB2 = 349; // 2-hour launch slab

async function testAgreementMatrix() {
  console.log("\n═══ VALIDATE <-> CREATE AGREEMENT ═══");
  const cases = [
    { code: "FIRSTFREE", slab: 199, hours: 1, slot: ["09:00", "10:00"], want: { discount: 199, payable: 0 } },
    { code: "WELCOME50", slab: 349, hours: 2, slot: ["09:00", "11:00"], want: { discount: 50, payable: 299 } },
    { code: "FESTIVE20", slab: 499, hours: 3, slot: ["09:00", "12:00"], want: { discount: 70, payable: 429 } },
    { code: "REBOOK75", slab: 649, hours: 4, slot: ["09:00", "13:00"], want: { discount: 75, payable: 574 }, extra: { maxDiscount: null, percent: null } },
  ];
  for (const t of cases) {
    const def = INITIAL_COUPONS.find((c) => c.code === t.code);
    await withCreationStubs(async () => {
      bookingStore.clear();
      seedCouponStore([mkCouponDoc({ ...def, ...(t.extra || {}) })]);
      const uid = new Types.ObjectId().toString();
      const r1 = makeRes();
      await couponCtrl.validateCoupon(
        { body: { code: ` ${t.code.toLowerCase()} `, amount: t.slab, serviceType: "cook_for_me" }, user: { id: uid } },
        r1, next
      );
      const vok = r1.statusCode === 200 && r1.body.discount === t.want.discount && r1.body.payable === t.want.payable;
      check(`CL-A1 validate ${t.code}@${t.slab} -> ${t.want.discount}/${t.want.payable}`,
        vok, `s=${r1.statusCode} ${JSON.stringify(r1.body)}`);
      const r2 = makeRes();
      await bookingCtrl.createBooking(
        { user: { id: uid, name: "T" }, body: baseBody({ couponCode: t.code, date: futureDateStr(), startTime: t.slot[0], endTime: t.slot[1], durationHours: t.hours }) },
        r2, next
      );
      const b = r2.body || {};
      check(`CL-A2 booking persists validate's numbers (${t.code})`,
        (r2.statusCode === 201 || r2.statusCode === 200) && b.discount === t.want.discount && b.amount === t.want.payable && b.couponCode === t.code && b.slabPrice === t.slab,
        `s=${r2.statusCode} discount=${b.discount} amount=${b.amount} code=${b.couponCode}`);
    });
  }
  // Rejections agree on both layers with the same reason.
  const rejCases = [
    { code: "WELCOME50", slab: 199, why: "minimum", slot: ["09:00", "10:00"], hours: 1 },
    { code: "DIWALI90", slab: 649, why: "inactive", slot: ["09:00", "13:00"], hours: 4 },
    { code: "NOPEXYZ", slab: 499, why: "unknown", slot: ["09:00", "12:00"], hours: 3 },
  ];
  for (const t of rejCases) {
    await withCreationStubs(async () => {
      bookingStore.clear();
      seedCouponStore(INITIAL_COUPONS.map((c) => mkCouponDoc({ ...c })));
      const uid = new Types.ObjectId().toString();
      const r1 = makeRes();
      await couponCtrl.validateCoupon({ body: { code: t.code, amount: t.slab, serviceType: "cook_for_me" }, user: { id: uid } }, r1, next);
      const r2 = makeRes();
      await bookingCtrl.createBooking({ user: { id: uid, name: "T" }, body: baseBody({ couponCode: t.code, date: futureDateStr(), startTime: t.slot[0], endTime: t.slot[1], durationHours: t.hours }) }, r2, next);
      const bothReject = r1.statusCode === 400 && r2.statusCode === 400;
      const sameReason = (r1.body?.message || "") === (r2.body?.message || "");
      let created = 0;
      const origCreate = Booking.create;
      Booking.create = async (d) => { created += 1; return origCreate(d); };
      const r3 = makeRes();
      try {
        await bookingCtrl.createBooking({ user: { id: uid, name: "T" }, body: baseBody({ couponCode: t.code, date: futureDateStr(), startTime: t.slot[0], endTime: t.slot[1], durationHours: t.hours, clientKey: `rej-${t.code}-${Date.now()}` }) }, r3, next);
      } finally { Booking.create = origCreate; }
      check(`CL-A3 ${t.code}@${t.slab} rejected identically on both layers (${t.why})`,
        bothReject && sameReason && r3.statusCode === 400 && created === 0,
        `v=${r1.statusCode} c=${r2.statusCode} same=${sameReason} creates=${created}`);
    });
  }
}

async function testTamperProof() {
  console.log("\n═══ TAMPER-PROOF BOOKING TOTALS ═══");
  await withCreationStubs(async () => {
    bookingStore.clear();
    seedCouponStore([mkCouponDoc({ code: "FESTIVE20", discountType: "percent", percent: 20, maxDiscount: 70, minOrder: 499, perUserLimit: 1, firstBookingOnly: false, active: true })]);
    const uid = new Types.ObjectId().toString();
    const r = makeRes();
    await bookingCtrl.createBooking({
      user: { id: uid, name: "T" },
      body: {
        ...baseBody({ couponCode: "festive20", date: futureDateStr(), startTime: "09:00", endTime: "12:00", durationHours: 3 }),
        discount: 9999, amount: 1, slabPrice: 1, couponCode: "  festive20 ",
        customer: new Types.ObjectId().toString(), status: "confirmed",
      },
    }, r, next);
    const b = r.body || {};
    check("CL-B1 forged discount/amount/slab/status ignored; server recomputes",
      (r.statusCode === 201 || r.statusCode === 200) && b.discount === 70 && b.amount === 429 && b.slabPrice === 499 && b.couponCode === "FESTIVE20" && b.status === "requested" && String(b.customer) === uid,
      `s=${r.statusCode} discount=${b.discount} amount=${b.amount} code=${b.couponCode} status=${b.status}`);
  });
  // Cross-user: B cannot validate against A's redemption record.
  await withCreationStubs(async () => {
    bookingStore.clear();
    const uidA = new Types.ObjectId().toString();
    seedCouponStore([mkCouponDoc({ code: "WELCOME50", discountType: "flat", flatAmount: 50, minOrder: 349, perUserLimit: 1, firstBookingOnly: true, active: true, usedBy: [uidA] })]);
    const r = makeRes();
    await couponCtrl.validateCoupon({ body: { code: "WELCOME50", amount: 349, serviceType: "cook_for_me" }, user: { id: uidA } }, r, next);
    check("CL-B2 same user re-validates used coupon -> 400", r.statusCode === 400 && /already used/i.test(r.body?.message || ""), `s=${r.statusCode}`);
    const uidB = new Types.ObjectId().toString();
    const r2 = makeRes();
    await couponCtrl.validateCoupon({ body: { code: "WELCOME50", amount: 349, serviceType: "cook_for_me" }, user: { id: uidB } }, r2, next);
    check("CL-B3 other user unaffected by A's redemption", r2.statusCode === 200 && r2.body.discount === 50, `s=${r2.statusCode}`);
  });
}

async function testSecondUseExhaustedDisabled() {
  console.log("\n═══ SECOND USE / EXHAUSTED / DISABLED ═══");
  await withCreationStubs(async () => {
    bookingStore.clear();
    const uid = new Types.ObjectId().toString();
    seedCouponStore([mkCouponDoc({ code: "WELCOME50", discountType: "flat", flatAmount: 50, minOrder: 349, perUserLimit: 1, firstBookingOnly: false, active: true, usedBy: [uid], usedCount: 1 })]);
    const before = couponStore.get("WELCOME50").usedCount;
    const r = makeRes();
    await bookingCtrl.createBooking({ user: { id: uid, name: "T" }, body: baseBody({ couponCode: "WELCOME50" }) }, r, next);
    check("CL-C1 second personal use -> 400, counter untouched",
      r.statusCode === 400 && /already used/i.test(r.body?.message || "") && couponStore.get("WELCOME50").usedCount === before,
      `s=${r.statusCode} used=${couponStore.get("WELCOME50").usedCount}`);
  });
  await withCreationStubs(async () => {
    bookingStore.clear();
    seedCouponStore([mkCouponDoc({ code: "TINY", discountType: "flat", flatAmount: 10, minOrder: 0, usageLimit: 1, usedCount: 1, perUserLimit: null, active: true })]);
    const r = makeRes();
    await bookingCtrl.createBooking({ user: { id: new Types.ObjectId().toString(), name: "T" }, body: baseBody({ couponCode: "TINY", durationHours: 1, startTime: "09:00", endTime: "10:00", date: futureDateStr() }) }, r, next);
    check("CL-C2 exhausted global limit -> 400 race-safe message path",
      r.statusCode === 400 || r.statusCode === 409, `s=${r.statusCode} ${r.body?.message || ""}`);
  });
  await withCreationStubs(async () => {
    bookingStore.clear();
    seedCouponStore([mkCouponDoc({ code: "FESTIVE20", active: true })]);
    const uid = new Types.ObjectId().toString();
    const rv = makeRes();
    await couponCtrl.validateCoupon({ body: { code: "FESTIVE20", amount: 499, serviceType: "cook_for_me" }, user: { id: uid } }, rv, next);
    couponStore.get("FESTIVE20").active = false; // disabled between validate and book
    const rb = makeRes();
    await bookingCtrl.createBooking({ user: { id: uid, name: "T" }, body: baseBody({ couponCode: "FESTIVE20", durationHours: 3, startTime: "09:00", endTime: "12:00", date: futureDateStr() }) }, rb, next);
    check("CL-C3 disabled between validate and book -> 400, nothing created",
      rv.statusCode === 200 && rb.statusCode === 400 && bookingStore.size === 0,
      `v=${rv.statusCode} b=${rb.statusCode} bookings=${bookingStore.size}`);
  });
  // Legacy spaced code resolves through the fallback.
  await withCreationStubs(async () => {
    bookingStore.clear();
    seedCouponStore([mkCouponDoc({ code: "FIRST FREE", discountType: "percent", percent: 100, maxDiscount: 649, minOrder: 0, perUserLimit: 1, firstBookingOnly: false, active: true })]);
    const r = makeRes();
    await couponCtrl.validateCoupon({ body: { code: "first-free", amount: 199, serviceType: "cook_for_me" }, user: { id: new Types.ObjectId().toString() } }, r, next);
    check("CL-C4 legacy spaced code resolves via fallback",
      r.statusCode === 200 && r.body.discount === 199, `s=${r.statusCode} ${JSON.stringify(r.body)}`);
  });
}

async function testAtomicConcurrency() {
  console.log("\n═══ ATOMIC CONCURRENCY ═══");
  await withCreationStubs(async () => {
    bookingStore.clear();
    seedCouponStore([mkCouponDoc({ code: "ONEUSE", discountType: "flat", flatAmount: 25, minOrder: 0, usageLimit: 1, usedCount: 0, usedBy: [], perUserLimit: 1, firstBookingOnly: false, active: true })]);
    const uidA = new Types.ObjectId().toString();
    const uidB = new Types.ObjectId().toString();
    const mkReq = (uid, key) => ({ user: { id: uid, name: "T" }, body: baseBody({ couponCode: "ONEUSE", clientKey: key, date: futureDateStr(), durationHours: 1, startTime: "09:00", endTime: "10:00" }) });
    const [ra, rb] = [makeRes(), makeRes()];
    await Promise.all([
      bookingCtrl.createBooking(mkReq(uidA, "race-a"), ra, next),
      bookingCtrl.createBooking(mkReq(uidB, "race-b"), rb, next),
    ]);
    const codes = [ra.statusCode, rb.statusCode].sort();
    const stored = couponStore.get("ONEUSE");
    check("CL-D1 last global use: exactly one booking wins",
      JSON.stringify(codes) === JSON.stringify([201, 409]) && bookingStore.size === 1 && stored.usedCount === 1,
      `statuses=${codes} bookings=${bookingStore.size} used=${stored.usedCount}`);
  });
  await withCreationStubs(async () => {
    bookingStore.clear();
    seedCouponStore([mkCouponDoc({ code: "MINE1", discountType: "flat", flatAmount: 25, minOrder: 0, perUserLimit: 1, usedBy: [], active: true })]);
    const uid = new Types.ObjectId().toString();
    const mkReq = (key) => ({ user: { id: uid, name: "T" }, body: baseBody({ couponCode: "MINE1", clientKey: key, date: futureDateStr(), durationHours: 1, startTime: "09:00", endTime: "10:00" }) });
    const [ra, rb] = [makeRes(), makeRes()];
    await Promise.all([
      bookingCtrl.createBooking(mkReq("mine-a"), ra, next),
      bookingCtrl.createBooking(mkReq("mine-b"), rb, next),
    ]);
    const mine = [...bookingStore.values()].filter((b) => String(b.customer) === uid);
    const okCount = [ra, rb].filter((r) => r.statusCode === 201 || r.statusCode === 200).length;
    check("CL-D2 same-user double submit: one booking, no double count",
      mine.length === 1 && okCount === 1 && couponStore.get("MINE1").usedCount === 1,
      `mine=${mine.length} ok=${okCount} used=${couponStore.get("MINE1").usedCount}`);
  });
  // Validation never reserves capacity, however often it runs.
  await withCreationStubs(async () => {
    bookingStore.clear();
    seedCouponStore([mkCouponDoc({ code: "FESTIVE20" })]);
    const uid = new Types.ObjectId().toString();
    for (let i = 0; i < 5; i++) {
      const r = makeRes();
      await couponCtrl.validateCoupon({ body: { code: "FESTIVE20", amount: 499, serviceType: "cook_for_me" }, user: { id: uid } }, r, next);
      if (r.statusCode !== 200) check("CL-D3 validate is reservation-free", false, `iter ${i} s=${r.statusCode}`);
    }
    check("CL-D3 validate is reservation-free (5x, counter still 0)",
      couponStore.get("FESTIVE20").usedCount === 0 && couponWrites === 0,
      `used=${couponStore.get("FESTIVE20").usedCount} writes=${couponWrites}`);
  });
}

async function testReleaseReuse() {
  console.log("\n═══ RELEASE + REUSE ═══");
  await withCreationStubs(async () => {
    bookingStore.clear();
    const uid = new Types.ObjectId().toString();
    seedCouponStore([mkCouponDoc({ code: "FESTIVE20" })]);
    const r = makeRes();
    await bookingCtrl.createBooking({ user: { id: uid, name: "T" }, body: baseBody({ couponCode: "FESTIVE20", durationHours: 3, startTime: "09:00", endTime: "12:00", date: futureDateStr() }) }, r, next);
    const booking = [...bookingStore.values()][0];
    const usedAfterCreate = couponStore.get("FESTIVE20").usedCount;
    // Simulate request expiry (no cook accepted): usage must be released.
    booking.requestExpiresAt = new Date(Date.now() - 1000);
    booking.status = "requested";
    const { expireBookingIfNeeded } = bookingCtrl;
    await expireBookingIfNeeded(booking);
    const usedAfterExpire = couponStore.get("FESTIVE20").usedCount;
    check("CL-E1 expiry releases the redemption",
      (r.statusCode === 201 || r.statusCode === 200) && usedAfterCreate === 1 && usedAfterExpire === 0 && booking.couponReleased === true,
      `create=${usedAfterCreate} expire=${usedAfterExpire} released=${booking.couponReleased}`);
    // And the same customer can redeem again afterwards.
    const r2 = makeRes();
    await bookingCtrl.createBooking({ user: { id: uid, name: "T" }, body: baseBody({ couponCode: "FESTIVE20", durationHours: 3, startTime: "09:00", endTime: "12:00", date: futureDateStr(), clientKey: "reuse-1" }) }, r2, next);
    check("CL-E2 released coupon is reusable",
      (r2.statusCode === 201 || r2.statusCode === 200) && couponStore.get("FESTIVE20").usedCount === 1,
      `s=${r2.statusCode} used=${couponStore.get("FESTIVE20").usedCount}`);
  });
}

// ---------- mocked-gateway E2E -------------------------------------------
const mockOrders = {};
const mockPayments = {};
const signCheckout = (orderId, paymentId) =>
  crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
const webhookSign = (raw) =>
  crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest("hex");

async function testEndToEnd() {
  console.log("\n═══ END-TO-END (mocked gateway) ═══");
  rzCfg.razorpay.orders.fetch = async (id) => {
    if (!mockOrders[id]) { const e = new Error(`no such order ${id}`); e.statusCode = 400; throw e; }
    return mockOrders[id];
  };
  rzCfg.razorpay.orders.create = async ({ amount, currency }) => {
    const id = `order_e2e_${amount}`;
    mockOrders[id] = { id, amount, currency };
    return mockOrders[id];
  };
  rzCfg.razorpay.payments.fetch = async (id) => {
    if (!mockPayments[id]) { const e = new Error(`no such payment ${id}`); e.statusCode = 400; throw e; }
    return mockPayments[id];
  };
  const oLC = LedgerEntry.create, oWC = WebhookEvent.create, oWU = WebhookEvent.updateOne;
  const seenKeys = new Set();
  let ledgerWrites = 0;
  LedgerEntry.create = async (e) => { ledgerWrites += 1; return e; };
  WebhookEvent.create = async (e) => {
    if (seenKeys.has(e.key)) { const err = new Error("dup"); err.code = 11000; throw err; }
    seenKeys.add(e.key);
    return e;
  };
  WebhookEvent.updateOne = async () => ({});
  const COOK = new Types.ObjectId().toString();
  const CUST = new Types.ObjectId().toString();

  await withCreationStubs(async () => {
    bookingStore.clear();
    seedCouponStore([mkCouponDoc({ code: "FESTIVE20" })]);
    const oCP1 = CookProfile.findOne;
    CookProfile.findOne = async () => ({ user: COOK, approvalStatus: "approved", serviceTypes: [] });
    const oUF = User.findById;
    User.findById = (id) => ({ select: async () => ({ _id: String(id), name: "T", phone: "9000000001", status: "active" }) });
    const oGB = slots.getDayBookings;
    slots.getDayBookings = async () => [];
    const orderDate = futureDateStr(7);
    try {
      // 1. validate
      const rv = makeRes();
      await couponCtrl.validateCoupon({ body: { code: "FESTIVE20", amount: 499, serviceType: "cook_for_me" }, user: { id: CUST } }, rv, next);
      // 2. book (10:00-12:00 => 2h => slab 349? No: FESTIVE20 needs 499 => use 3h slot)
      const rb = makeRes();
      await bookingCtrl.createBooking({
        user: { id: CUST, name: "T" },
        body: baseBody({ couponCode: "FESTIVE20", date: orderDate, startTime: "10:00", endTime: "13:00", durationHours: 3, clientKey: "e2e-1" }),
      }, rb, next);
      const persisted = rb.body || {};
      const step3ok = persisted.discount === 70 && persisted.amount === 429 && rv.body.payable === 429;
      check("CL-F1 Step-3 source of truth: booking record == validate response",
        (rb.statusCode === 201 || rb.statusCode === 200) && step3ok && rv.body.discount === 70,
        `discount=${persisted.discount} amount=${persisted.amount}`);
      // 3. cook accepts (simulated) -> order
      const doc = bookingStore.get(String(persisted._id));
      doc.status = "accepted";
      doc.cook = COOK;
      doc.paymentExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
      doc.statusHistory.push({ status: "accepted", timestamp: new Date() });
      const realFindById = Booking.findById;
      Booking.findById = (id) => {
        const d = bookingStore.get(String(id)) || null;
        const q = Promise.resolve(d);
        q.select = async () => d;
        q.lean = async () => d;
        return q;
      };
      const ro = makeRes();
      await paymentCtrl.createOrder({
        user: { id: CUST },
        body: { cook: COOK, date: orderDate, startTime: "10:00", endTime: "13:00", durationHours: 3, bookingId: String(persisted._id) },
      }, ro, next);
      check("CL-F2 gateway order uses the discounted amount in paise",
        (ro.statusCode === 201 || ro.statusCode === 200) && ro.body.amountPaise === 42900 && ro.body.amount === 429,
        `s=${ro.statusCode} paise=${ro.body?.amountPaise}`);
      check("CL-F3 order id persisted on the booking",
        doc.payment?.razorpayOrderId === ro.body.orderId, String(doc.payment?.razorpayOrderId));
      // 4. pay with a real signature over the mocked capture
      const orderId = ro.body.orderId;
      mockPayments.pay_e2e_1 = { id: "pay_e2e_1", order_id: orderId, amount: 42900, currency: "INR", status: "captured", amount_refunded: 0 };
      const rp = makeRes();
      await bookingCtrl.payBooking({
        params: { id: String(persisted._id) }, user: { id: CUST },
        body: { method: "upi", payment: { razorpayOrderId: orderId, razorpayPaymentId: "pay_e2e_1", razorpaySignature: signCheckout(orderId, "pay_e2e_1") } },
      }, rp, next);
      check("CL-F4 payment settles the booking at the discounted amount",
        rp.statusCode === 200 && rp.body?.payment?.status === "paid" && rp.body?.payment?.paidAmount === 429 && rp.body?.status === "confirmed",
        `s=${rp.statusCode} paid=${rp.body?.payment?.paidAmount} st=${rp.body?.status}`);
      // 5. duplicate pay call is idempotent
      const rp2 = makeRes();
      await bookingCtrl.payBooking({
        params: { id: String(persisted._id) }, user: { id: CUST },
        body: { method: "upi", payment: { razorpayOrderId: orderId, razorpayPaymentId: "pay_e2e_1", razorpaySignature: signCheckout(orderId, "pay_e2e_1") } },
      }, rp2, next);
      check("CL-F5 duplicate pay is idempotent (alreadyPaid)",
        rp2.statusCode === 200 && rp2.body?.alreadyPaid === true, `s=${rp2.statusCode}`);
      // 6. webhook captured + redelivery
      const evt = { event: "payment.captured", payload: { payment: { entity: { id: "pay_e2e_1", order_id: orderId, status: "captured", amount: 42900, currency: "INR" } } } };
      const raw = Buffer.from(JSON.stringify(evt));
      const sig = webhookSign(raw);
      const rw = makeRes();
      await paymentCtrl.handleWebhook({ body: raw, headers: { "x-razorpay-signature": sig } }, rw, next);
      const rw2 = makeRes();
      await paymentCtrl.handleWebhook({ body: raw, headers: { "x-razorpay-signature": sig } }, rw2, next);
      check("CL-F6 webhook + redelivery stay idempotent, single redemption",
        rw.body?.handled === true && rw2.body?.handled === "duplicate" && doc.payment?.status === "paid" && couponStore.get("FESTIVE20").usedCount === 1,
        `w1=${rw.body?.handled} w2=${rw2.body?.handled} used=${couponStore.get("FESTIVE20").usedCount} ledger=${ledgerWrites}`);
      // 7. forged signature rejected
      const doc2id = new Types.ObjectId().toString();
      const doc2 = { ...JSON.parse(JSON.stringify(doc)), _id: doc2id, status: "accepted", payment: { status: "pending", paidAmount: 0 } };
      bookingStore.set(doc2id, doc2);
      const rf = makeRes();
      await bookingCtrl.payBooking({
        params: { id: doc2id }, user: { id: CUST },
        body: { method: "upi", payment: { razorpayOrderId: orderId, razorpayPaymentId: "pay_e2e_1", razorpaySignature: "forged" } },
      }, rf, next);
      check("CL-F7 forged signature -> 402, booking stays unpaid",
        rf.statusCode === 402 && doc2.payment?.status !== "paid", `s=${rf.statusCode}`);
      // 8. order of booking A cannot settle booking B
      const rb2 = makeRes();
      await bookingCtrl.payBooking({
        params: { id: doc2id }, user: { id: CUST },
        body: { method: "upi", payment: { razorpayOrderId: orderId, razorpayPaymentId: "pay_e2e_X", razorpaySignature: signCheckout(orderId, "pay_e2e_X") } },
      }, rb2, next);
      check("CL-F8 foreign order id rejected for another booking",
        rb2.statusCode === 402 && doc2.payment?.status !== "paid", `s=${rb2.statusCode}`);
      // 9. invalid-coupon and no-coupon sibling flows
      const ri = makeRes();
      await bookingCtrl.createBooking({ user: { id: CUST, name: "T" }, body: baseBody({ couponCode: "BOGUS1", date: orderDate, startTime: "14:00", endTime: "15:00", durationHours: 1, clientKey: "e2e-bad" }) }, ri, next);
      const rn = makeRes();
      await bookingCtrl.createBooking({ user: { id: CUST, name: "T" }, body: baseBody({ date: orderDate, startTime: "15:00", endTime: "16:00", durationHours: 1, clientKey: "e2e-plain" }) }, rn, next);
      check("CL-F9 invalid coupon books nothing; plain booking pays full slab",
        ri.statusCode === 400 && (rn.statusCode === 201 || rn.statusCode === 200) && rn.body.amount === 199 && rn.body.discount === 0 && rn.body.couponCode === "",
        `bad=${ri.statusCode} plain=${rn.statusCode} amount=${rn.body?.amount}`);
      Booking.findById = realFindById;
    } finally {
      CookProfile.findOne = oCP1; User.findById = oUF; slots.getDayBookings = oGB;
      LedgerEntry.create = oLC; WebhookEvent.create = oWC; WebhookEvent.updateOne = oWU;
    }
  });
  // Free order (100% coupon) path.
  await withCreationStubs(async () => {
    bookingStore.clear();
    seedCouponStore([mkCouponDoc({ code: "FIRSTFREE", discountType: "percent", percent: 100, maxDiscount: 649, minOrder: 0, perUserLimit: 1, firstBookingOnly: true, active: true })]);
    const oLC2 = LedgerEntry.create;
    LedgerEntry.create = async (e) => e;
    const CUST2 = new Types.ObjectId().toString();
    const COOK2 = new Types.ObjectId().toString();
    const oCP1 = CookProfile.findOne;
    CookProfile.findOne = async () => ({ user: COOK2, approvalStatus: "approved", serviceTypes: [] });
    const oUF = User.findById;
    User.findById = (id) => ({ select: async () => ({ _id: String(id), name: "T", phone: "9000000001", status: "active" }) });
    const oGB = slots.getDayBookings;
    slots.getDayBookings = async () => [];
    const orderDate = futureDateStr(7);
    try {
      const rb = makeRes();
      await bookingCtrl.createBooking({ user: { id: CUST2, name: "T" }, body: baseBody({ couponCode: "FIRSTFREE", date: orderDate, startTime: "10:00", endTime: "11:00", durationHours: 1, clientKey: "e2e-free" }) }, rb, next);
      const doc = bookingStore.get(String(rb.body?._id));
      doc.status = "accepted";
      doc.cook = COOK2;
      doc.paymentExpiresAt = new Date(Date.now() + 5 * 60 * 1000);
      const realFindById = Booking.findById;
      Booking.findById = (id) => {
        const d = bookingStore.get(String(id)) || null;
        const q = Promise.resolve(d);
        q.select = async () => d;
        return q;
      };
      const ro = makeRes();
      await paymentCtrl.createOrder({ user: { id: CUST2 }, body: { cook: COOK2, date: orderDate, startTime: "10:00", endTime: "11:00", durationHours: 1, bookingId: String(rb.body._id) } }, ro, next);
      const rp = makeRes();
      await bookingCtrl.payBooking({ params: { id: String(rb.body._id) }, user: { id: CUST2 }, body: { method: "upi", payment: null } }, rp, next);
      check("CL-F10 100% coupon: free order, paid without gateway",
        (rb.statusCode === 201 || rb.statusCode === 200) && rb.body.amount === 0 && ro.body?.free === true && rp.body?.payment?.status === "paid",
        `amount=${rb.body?.amount} free=${ro.body?.free} pay=${rp.body?.payment?.status}`);
      Booking.findById = realFindById;
    } finally {
      CookProfile.findOne = oCP1; User.findById = oUF; slots.getDayBookings = oGB;
      LedgerEntry.create = oLC2;
    }
  });
}

(async () => {
  try {
    await testAgreementMatrix();
    await testTamperProof();
    await testSecondUseExhaustedDisabled();
    await testAtomicConcurrency();
    await testReleaseReuse();
    await testEndToEnd();
  } catch (e) {
    failures += 1;
    console.log(`FAIL  harness exception  -> ${e && e.stack ? e.stack.split("\n").slice(0, 5).join(" | ") : e}`);
  }
  console.log(`\ncoupon-lifecycle: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
