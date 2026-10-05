
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const mongoose = require("mongoose");
const Booking = require("./models/Booking");
const CookProfile = require("./models/CookProfile");
const User = require("./models/User");
const Notification = require("./models/Notification");
const controller = require("./controllers/bookingController");
const { timeToMinutes } = require("./utils/slots");
const { istDayString, istMidnight, istEventInstant } = require("./utils/time");

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes += 1;
  else failures += 1;
};

const istDayOffset = (offset) => istDayString(new Date(Date.now() + offset * 24 * 60 * 60 * 1000));

const CUSTOMER = { id: "cust1", role: "CUSTOMER" };
const STRANGER = { id: "cust9", role: "CUSTOMER" };
const COOK = { id: "cook1", role: "COOK" };
const ADMIN = { id: "admin1", role: "ADMIN" };

let bookingDoc = null;
let profiles = {};
let users = {};
let rivalsByCook = {};
let claimStub = null;
let claimCalls = [];
const notificationLog = [];

const oid = (n) => `${"a".repeat(23)}${n}`; // valid 24-hex mongo ids
const COOK1 = oid(1);
const COOK2 = oid(2);
const COOK3 = oid(3);

const baseDoc = (over = {}) => {
  const doc = {
    _id: "booking1",
    customer: "cust1",
    cook: COOK1,
    serviceType: "cook_with_me",
    date: istMidnight(istDayOffset(3)),
    startTime: "10:00",
    endTime: "12:00",
    durationHours: 2,
    guests: 4,
    address: "12 MG Road",
    amount: 1110,
    status: "requested",
    payment: { status: "pending" },
    serviceOtp: "4321",
    rescheduleCount: 0,
    statusHistory: [],
    reschedules: [],
    requestExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    paymentExpiresAt: null,
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
    toObject() {
      const { save, toObject, ...rest } = this;
      return { ...rest, statusHistory: [...this.statusHistory], reschedules: [...this.reschedules] };
    },
  };
  return Object.assign(doc, over);
};

const profileFor = (cookId, over = {}) => ({
  _id: `p-${cookId}`,
  user: { _id: cookId, name: cookId === COOK2 ? "Priya" : "Rahul", status: "active" },
  approvalStatus: "approved",
  availabilityStatus: "available",
  unavailableDate: "",
  serviceTypes: [],
  rating: { average: 4.8, count: 10, sum: 48 },
  photoUrl: "https://cdn.example/x.jpg",
  experienceYears: 5,
  serviceArea: "Kothrud",
  specialties: ["Biryani"],
  schedule: {},
  ...over,
});

const reset = (over = {}, profileOver = {}, rivalsOver = {}) => {
  bookingDoc = baseDoc(over);
  profiles = {
    [COOK1]: profileFor(COOK1),
    [COOK2]: profileFor(COOK2),
    ...(profileOver || {}),
  };
  users = {
    [COOK1]: { _id: COOK1, name: "Rahul", status: "active" },
    [COOK2]: { _id: COOK2, name: "Priya", status: "active" },
    [COOK3]: { _id: COOK3, name: "Verma", status: "active" },
  };
  rivalsByCook = { ...(rivalsOver || {}) };
  claimStub = null;
  claimCalls = [];
  notificationLog.length = 0;
  mongoose.connection.readyState = 0;
  return bookingDoc;
};

const chainable = (doc) => ({
  select: () => chainable(doc),
  lean: () => chainable(doc),
  then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
});

Booking.findById = async (id) => (String(id) === "booking1" && bookingDoc ? bookingDoc : null);
Booking.find = (filter = {}) => ({
  select: () => ({
    lean: async () => {
      const c = filter?.cook;
      if (c && typeof c === "object" && Array.isArray(c.$in)) {
        return c.$in.flatMap((id) => rivalsByCook[String(id)] || []);
      }
      return rivalsByCook[String(c)] || [];
    },
  }),
});
Booking.findOneAndUpdate = async (filter, update, opts) => {
  claimCalls.push({ filter, update, opts });
  if (typeof claimStub === "function") return claimStub(filter, update, opts);
  return null;
};
CookProfile.findOne = (filter = {}) => chainable(profiles[String(filter?.user)] || null);
CookProfile.find = () => ({
  populate: () => ({
    sort: () => ({ limit: () => ({ lean: async () => Object.values(profiles) }) }),
  }),
});
User.findById = (id) => ({ select: async () => users[String(id)] || null });
Notification.create = async (payload) => {
  notificationLog.push(payload);
  return payload;
};

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (s) => {
    res.statusCode = s;
    return res;
  };
  res.json = (p) => {
    res.body = p;
    return res;
  };
  return res;
};

const callMove = (user, body) =>
  new Promise((resolve, reject) => {
    const req = { params: { id: "booking1" }, user, body };
    const res = makeRes();
    Promise.resolve(controller.rescheduleBooking(req, res, reject)).then(() =>
      resolve({ status: res.statusCode, payload: res.body })
    );
  });

const callOptions = (user, query) =>
  new Promise((resolve, reject) => {
    const req = { params: { id: "booking1" }, user, query };
    const res = makeRes();
    Promise.resolve(controller.getRescheduleOptions(req, res, reject)).then(() =>
      resolve({ status: res.statusCode, payload: res.body })
    );
  });

(async () => {
  const DAY = istDayOffset(4);

  {
    reset();
    const r = await callMove(CUSTOMER, { date: DAY, startTime: "14:00" });
    check("1. same-cook move -> 200", r.status === 200, `s=${r.status}`);
    check("1. cook unchanged", String(r.payload?.cook || bookingDoc.cook) === COOK1, String(r.payload?.cook || bookingDoc.cook));
  }

  {
    reset();
    const r = await callOptions(CUSTOMER, { date: DAY, startTime: "14:00" });
    check("2. options slot mode -> 200 available", r.status === 200 && r.payload?.currentCookAvailable === true, `s=${r.status} avail=${r.payload?.currentCookAvailable}`);
    check("2. no replacements when current is free", Array.isArray(r.payload?.availableCooks) && r.payload.availableCooks.length === 0, `n=${r.payload?.availableCooks?.length}`);
    check("2. slot echo + duration preserved", r.payload?.slot?.startTime === "14:00" && r.payload?.slot?.endTime === "16:00", JSON.stringify(r.payload?.slot));
  }

  {
    reset({}, {}, { [COOK1]: [{ _id: "r1", startTime: "14:00", endTime: "16:00", status: "confirmed" }] });
    const r = await callOptions(CUSTOMER, { date: DAY, startTime: "14:00" });
    check("3. current flagged unavailable", r.status === 200 && r.payload?.currentCookAvailable === false, `s=${r.status} avail=${r.payload?.currentCookAvailable}`);
    check("3. replacement cook returned", (r.payload?.availableCooks || []).some((c) => c.cookId === COOK2), JSON.stringify((r.payload?.availableCooks || []).map((c) => c.cookId)));
    const card = (r.payload?.availableCooks || []).find((c) => c.cookId === COOK2) || {};
    check(
      "3. card exposes no PII",
      card.name === "Priya" &&
        !("phone" in card) && !("email" in card) && !("aadharCardUrl" in card) && !("panCardUrl" in card) && !("payoutDetails" in card),
      Object.keys(card).join(",")
    );
  }

  {
    reset({}, {}, { [COOK1]: [{ _id: "r1", startTime: "14:00", endTime: "16:00", status: "confirmed" }] });
    const r = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: COOK2, reason: "Change of plans" });
    check("4. swap move -> 200", r.status === 200, `s=${r.status} ${r.payload?.message || ""}`);
    check("4. cook reassigned", String(bookingDoc.cook) === COOK2, String(bookingDoc.cook));
    check("4. slot moved", bookingDoc.startTime === "14:00" && bookingDoc.endTime === "16:00", `${bookingDoc.startTime}-${bookingDoc.endTime}`);
    check("4. count incremented once", bookingDoc.rescheduleCount === 1, String(bookingDoc.rescheduleCount));
    const audit = bookingDoc.reschedules[0] || {};
    check("4. audit records from/to cook + reason", String(audit.fromCook) === COOK1 && String(audit.toCook) === COOK2 && audit.reason === "Change of plans" && audit.by === "customer", JSON.stringify({ f: audit.fromCook, t: audit.toCook, r: audit.reason }));
    check("4. history note names the swap", /cook reassigned/i.test(String(bookingDoc.statusHistory[0]?.note)) && /Change of plans/.test(String(bookingDoc.statusHistory[0]?.note)), String(bookingDoc.statusHistory[0]?.note));
    const to = notificationLog.map((n) => String(n.user));
    check("4. old + new cook notified", to.includes(COOK1) && to.includes(COOK2), to.join(","));
    check("4. customer confirmed too", to.includes("cust1") && notificationLog.some((n) => String(n.user) === "cust1" && /has been rescheduled/i.test(n.message)), to.join(","));
    check("4. old cook released message", notificationLog.some((n) => String(n.user) === COOK1 && /no longer/i.test(n.message)), notificationLog.filter((n) => String(n.user) === COOK1).map((n) => n.message).join("|"));
    check("4. new cook assigned message", notificationLog.some((n) => String(n.user) === COOK2 && /assigned/i.test(n.message)), notificationLog.filter((n) => String(n.user) === COOK2).map((n) => n.message).join("|"));
  }

  {
    reset({}, { [COOK2]: profileFor(COOK2, { approvalStatus: "pending" }) });
    const r = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: COOK2 });
    check("5. unverified cook -> 400", r.status === 400, `s=${r.status} ${r.payload?.message || ""}`);
    check("5. booking untouched", String(bookingDoc.cook) === COOK1 && bookingDoc.rescheduleCount === 0 && bookingDoc.saveCalls === 0, `${bookingDoc.cook}/${bookingDoc.rescheduleCount}/${bookingDoc.saveCalls}`);
  }

  {
    reset({}, {}, { [COOK2]: [{ _id: "r2", startTime: "15:00", endTime: "17:00", status: "accepted" }] });
    const r = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: COOK2 });
    check("6. clashing replacement -> 409", r.status === 409, `s=${r.status} ${r.payload?.message || ""}`);
    check("6. controlled message", /just booked|another cook/i.test(String(r.payload?.message)), String(r.payload?.message));
    check("6. booking untouched", String(bookingDoc.cook) === COOK1 && bookingDoc.rescheduleCount === 0, `${bookingDoc.cook}/${bookingDoc.rescheduleCount}`);
  }

  {
    const narrowWeek = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startTime: "08:00", endTime: "10:00", enabled: true }));
    reset({}, { [COOK2]: profileFor(COOK2, { schedule: { weekly: narrowWeek, blockedDates: [] } }) });
    const r = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: COOK2 });
    check("7. out-of-hours replacement -> 400", r.status === 400, `s=${r.status} ${r.payload?.message || ""}`);
    check("7. booking untouched", String(bookingDoc.cook) === COOK1 && bookingDoc.saveCalls === 0, "");
  }

  {
    reset({}, { [COOK2]: profileFor(COOK2, { serviceTypes: ["teach_me"] }) });
    const r = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: COOK2 });
    check("8. wrong-service cook -> 400", r.status === 400 && /service/i.test(String(r.payload?.message)), `s=${r.status} ${r.payload?.message}`);
  }

  {
    reset({
      status: "confirmed",
      payment: { status: "paid", paidAmount: 1110, razorpayPaymentId: "pay_1", refundStatus: "none", testMode: false },
      amount: 1110,
    });
    const r = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: COOK2, reason: "Cook unavailable" });
    check("9. paid swap -> 200", r.status === 200, `s=${r.status}`);
    check("9. payment document unchanged", bookingDoc.payment.status === "paid" && bookingDoc.payment.paidAmount === 1110 && bookingDoc.payment.razorpayPaymentId === "pay_1", JSON.stringify(bookingDoc.payment));
    check("9. no refund queued", bookingDoc.payment.refundStatus === "none", String(bookingDoc.payment.refundStatus));
    check("9. coupon never released", !bookingDoc.couponReleased, String(bookingDoc.couponReleased));
    check("9. amount untouched", bookingDoc.amount === 1110, String(bookingDoc.amount));
    check("9. single write, both sides notified once", bookingDoc.saveCalls === 1 && notificationLog.length === 3, `saves=${bookingDoc.saveCalls} n=${notificationLog.length}`);
  }

  {
    reset({}, {}, { [COOK1]: [{ _id: "r1", startTime: "14:00", endTime: "16:00", status: "confirmed" }] });
    const r = await callMove(ADMIN, { date: DAY, startTime: "14:00", cookId: COOK2 });
    check("10. admin swap -> 200", r.status === 200, `s=${r.status}`);
    const to = notificationLog.map((n) => String(n.user));
    check("10. old+new+customer notified", to.includes(COOK1) && to.includes(COOK2) && to.includes("cust1"), to.join(","));
    check("10. customer message names the new cook", notificationLog.some((n) => String(n.user) === "cust1" && /new cook/i.test(n.message)), notificationLog.filter((n) => String(n.user) === "cust1").map((n) => n.message).join("|"));
  }

  {
    reset({ rescheduleCount: 2 });
    const capped = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: COOK2 });
    check("11. capped customer + cookId -> 400", capped.status === 400 && /twice/.test(String(capped.payload?.message)), `s=${capped.status}`);
    reset({ status: "cancelled" });
    const dead = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: COOK2 });
    check("11. terminal status + cookId -> 400", dead.status === 400, `s=${dead.status}`);
    const stranger = await callMove(STRANGER, { date: DAY, startTime: "14:00", cookId: COOK2 });
    check("11. stranger -> 403", stranger.status === 403, `s=${stranger.status}`);
    const cook = await callMove(COOK, { date: DAY, startTime: "14:00", cookId: COOK2 });
    check("11. cook cannot reschedule -> 403", cook.status === 403, `s=${cook.status}`);
    reset();
    const badId = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: "not-an-id" });
    check("11. malformed cookId -> 400", badId.status === 400, `s=${badId.status}`);
    const longReason = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", reason: "x".repeat(201) });
    check("11. overlong reason -> 400", longReason.status === 400, `s=${longReason.status}`);
  }

  {
    reset();
    const r = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: COOK2, amount: 1, rescheduleCount: 99, payment: { status: "paid" } });
    check("12. swap still -> 200", r.status === 200, `s=${r.status}`);
    check("12. count advanced by exactly one", bookingDoc.rescheduleCount === 1, String(bookingDoc.rescheduleCount));
    check("12. amount/payment not taken from the request", bookingDoc.amount === 1110 && bookingDoc.payment.status === "pending", `${bookingDoc.amount}/${bookingDoc.payment.status}`);
  }

  {
    reset();
    const first = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: COOK2, reason: "Change of plans" });
    const savesAfterFirst = bookingDoc.saveCalls;
    const notesAfterFirst = notificationLog.length;
    const retry = await callMove(CUSTOMER, { date: istDayString(bookingDoc.date), startTime: bookingDoc.startTime, cookId: String(bookingDoc.cook) });
    check("13. first swap -> 200", first.status === 200, `s=${first.status}`);
    check("13. retry -> 200 unchanged", retry.status === 200 && retry.payload?.unchanged === true, `s=${retry.status} u=${retry.payload?.unchanged}`);
    check("13. no duplicate write/notify", bookingDoc.saveCalls === savesAfterFirst && notificationLog.length === notesAfterFirst, `saves=${bookingDoc.saveCalls} n=${notificationLog.length}`);
  }

  {
    reset({}, {}, { [COOK1]: [{ _id: "r1", startTime: "14:00", endTime: "16:00", status: "confirmed" }] });
    mongoose.connection.readyState = 1;
    const movedDoc = { _id: "booking1", cook: COOK2, date: istMidnight(DAY), startTime: "14:00", endTime: "16:00", status: "requested", rescheduleCount: 1, toObject() { return { ...this }; } };
    claimStub = async () => movedDoc;
    const r = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: COOK2, reason: "Change of plans" });
    check("14. connected swap -> 200", r.status === 200, `s=${r.status} ${r.payload?.message || ""}`);
    const set = claimCalls[0]?.update?.$set || {};
    check("14. claim pins status + count", claimCalls[0]?.filter?.status === "requested" && claimCalls[0]?.filter?.rescheduleCount === 0, JSON.stringify(claimCalls[0]?.filter));
    check("14. claim $set carries date+time+cook+count", String(set.cook) === COOK2 && set.startTime === "14:00" && set.rescheduleCount === 1, JSON.stringify({ cook: set.cook, s: set.startTime, n: set.rescheduleCount }));
    const push = claimCalls[0]?.update?.$push || {};
    check("14. claim pushes history + audit", Boolean(push.statusHistory) && String(push.reschedules?.toCook) === COOK2 && push.reschedules?.reason === "Change of plans", JSON.stringify({ t: push.reschedules?.toCook, r: push.reschedules?.reason }));
    check("14. OTP stripped from the response", r.payload && !("serviceOtp" in r.payload), Object.keys(r.payload || {}).join(","));

    reset();
    mongoose.connection.readyState = 1;
    let calls = 0;
    claimStub = async () => {
      calls += 1;
      if (calls === 1) return { _id: "booking1", cook: COOK1, date: istMidnight(DAY), startTime: "14:00", endTime: "16:00", status: "requested", rescheduleCount: 1, toObject() { return { ...this }; } };
      return null;
    };
    const r1 = await callMove(CUSTOMER, { date: DAY, startTime: "14:00" });
    bookingDoc.rescheduleCount = 1;
    bookingDoc.startTime = "14:00";
    bookingDoc.endTime = "16:00";
    const r2 = await callMove(CUSTOMER, { date: DAY, startTime: "16:00" });
    check("14. first racer -> 200", r1.status === 200, `s=${r1.status}`);
    check("14. second racer refused (409)", r2.status === 409, `s=${r2.status} ${r2.payload?.message || ""}`);
    mongoose.connection.readyState = 0;
  }

  {
    reset();
    users[COOK3] = { _id: COOK3, name: "Verma", status: "suspended" };
    profiles[COOK3] = profileFor(COOK3);
    mongoose.connection.readyState = 1;
    claimStub = async () => null;
    const r = await callMove(CUSTOMER, { date: DAY, startTime: "14:00", cookId: COOK3 });
    check("15. suspended cook -> 400", r.status === 400 && /no longer available/i.test(String(r.payload?.message)), `s=${r.status} ${r.payload?.message || ""}`);
    check("15. claim never attempted", claimCalls.length === 0, `calls=${claimCalls.length}`);
    mongoose.connection.readyState = 0;
  }

  {
    const fs = require("fs");
    const path = require("path");
    const routeSrc = fs.readFileSync(path.join(__dirname, "routes", "bookings.js"), "utf8");
    check("16. PATCH validates reason + cookId", /body\("reason"\)/.test(routeSrc) && /body\("cookId"\)/.test(routeSrc), "");
    check("16. GET options validates date + optional startTime", /query\("date"\)/.test(routeSrc) && /query\("startTime"\)/.test(routeSrc), "");
    const patchIdx = routeSrc.indexOf('"/:id/reschedule"');
    const patchBlock = patchIdx === -1 ? "" : routeSrc.slice(patchIdx, routeSrc.indexOf("rescheduleBooking", patchIdx));
    check("16. price/payment/count still absent from validators", !/body\("amount"\)/.test(patchBlock) && !/body\("payment"\)/.test(patchBlock) && !/body\("rescheduleCount"\)/.test(patchBlock), "");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) {
    console.log("FAILURES PRESENT");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED");
  }
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
