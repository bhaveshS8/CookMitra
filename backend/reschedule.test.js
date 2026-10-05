
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const fs = require("fs");
const path = require("path");
const Booking = require("./models/Booking");
const CookProfile = require("./models/CookProfile");
const Notification = require("./models/Notification");
const controller = require("./controllers/bookingController");
const { timeToMinutes, minutesToTime } = require("./utils/slots");
const { istDayString, istNowMinutes, istMidnight, istEventInstant } = require("./utils/time");

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
let rivals = [];
let cookProfile = null;
const notificationLog = [];

const baseDoc = (over = {}) => {
  const doc = {
    _id: "booking1",
    customer: "cust1",
    cook: "cook1",
    serviceType: "cook_with_me",
    date: istMidnight(istDayOffset(3)),
    startTime: "10:00",
    endTime: "12:00",
    durationHours: 2,
    guests: 4,
    address: "12 MG Road",
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
      return {
        ...rest,
        statusHistory: [...this.statusHistory],
        reschedules: [...this.reschedules],
      };
    },
  };
  return Object.assign(doc, over);
};

const defaultProfile = () => ({
  _id: "p1",
  user: "cook1",
  approvalStatus: "approved",
  availabilityStatus: "available",
});

const reset = (over = {}) => {
  bookingDoc = baseDoc(over);
  rivals = [];
  cookProfile = defaultProfile();
  notificationLog.length = 0;
  return bookingDoc;
};

const chainable = (doc) => ({
  select: () => chainable(doc),
  lean: () => chainable(doc),
  then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
});

Booking.findById = async (id) => (String(id) === "booking1" && bookingDoc ? bookingDoc : null);
Booking.find = () => chainable(rivals);
CookProfile.findOne = () => chainable(cookProfile);
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
  {
    const doc = reset();
    const firstWindow = doc.requestExpiresAt.getTime();
    const target = istDayOffset(5);
    const r = await callMove(CUSTOMER, { date: target, startTime: "14:00" });
    check("customer move -> 200", r.status === 200, `s=${r.status} ${r.payload?.message || ""}`);
    check("response has no unchanged flag on a real move", r.payload?.unchanged === undefined, String(r.payload?.unchanged));
    check("target day stored as the IST midnight instant", istDayString(doc.date) === target, String(doc.date));
    check("start/end recomputed from the booking duration", doc.startTime === "14:00" && doc.endTime === "16:00", `${doc.startTime}-${doc.endTime}`);
    check("rescheduleCount incremented", doc.rescheduleCount === 1, String(doc.rescheduleCount));
    check("history note records the move", /Rescheduled from .+ to .+ by customer/.test(String(doc.statusHistory[0]?.note)), JSON.stringify(doc.statusHistory));
    check(
      "structured audit entry written",
      Array.isArray(doc.reschedules) && doc.reschedules.length === 1 &&
        doc.reschedules[0].by === "customer" && doc.reschedules[0].toStartTime === "14:00",
      JSON.stringify(doc.reschedules)
    );
    check(
      "request window renewed (5 min)",
      doc.requestExpiresAt.getTime() > firstWindow && doc.requestExpiresAt.getTime() > Date.now() + 4 * 60 * 1000,
      String(doc.requestExpiresAt)
    );
    check(
      "cook + customer both notified",
      notificationLog.length === 2 &&
        notificationLog.every((n) => n.type === "booking_rescheduled") &&
        new Set(notificationLog.map((n) => String(n.user))).has("cook1") &&
        new Set(notificationLog.map((n) => String(n.user))).has("cust1"),
      JSON.stringify(notificationLog)
    );
    check("response strips the service OTP", r.payload && !("serviceOtp" in r.payload), Object.keys(r.payload || {}).join(","));
    check("response carries the new slot", r.payload?.startTime === "14:00" && r.payload?.endTime === "16:00", `${r.payload?.startTime}-${r.payload?.endTime}`);
  }

  {
    const doc = reset({ status: "accepted", paymentExpiresAt: new Date(Date.now() + 60 * 1000) });
    const before = doc.paymentExpiresAt.getTime();
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "09:00" });
    check("accepted move -> 200", r.status === 200, `s=${r.status}`);
    check(
      "payment window renewed (5 min)",
      doc.paymentExpiresAt.getTime() > before && doc.paymentExpiresAt.getTime() > Date.now() + 4 * 60 * 1000,
      String(doc.paymentExpiresAt)
    );
    check("accepted move keeps the status (no re-accept dance)", doc.status === "accepted", doc.status);
  }

  {
    const doc = reset({
      status: "confirmed",
      couponCode: "WELCOME50",
      discount: 150,
      amount: 199,
      payment: { status: "paid", paidAmount: 199, razorpayPaymentId: "pay_1", refundStatus: "none" },
      paymentExpiresAt: new Date(Date.now() - 60 * 1000),
    });
    const moneySnapshot = JSON.stringify(doc.payment);
    const r = await callMove(CUSTOMER, { date: istDayOffset(6), startTime: "11:00" });
    check("confirmed (paid) move -> 200", r.status === 200, `s=${r.status}`);
    check("payment document is unchanged after the move", JSON.stringify(doc.payment) === moneySnapshot, JSON.stringify(doc.payment));
    check("no refund queued", !doc.payment.refundStatus || doc.payment.refundStatus === "none", String(doc.payment.refundStatus));
    check("coupon never released by a move", doc.couponReleased !== true, String(doc.couponReleased));
    check("amount untouched", Number(doc.amount) === 199, String(doc.amount));
  }

  {
    const doc = reset({ status: "confirmed" });
    const r = await callMove(CUSTOMER, { date: istDayOffset(3), startTime: "10:00" });
    check("re-requesting the current slot -> 200 unchanged", r.status === 200 && r.payload?.unchanged === true, `s=${r.status} unchanged=${r.payload?.unchanged}`);
    check("no-op writes nothing and notifies nobody", doc.saveCalls === 0 && doc.rescheduleCount === 0 && notificationLog.length === 0, `saves=${doc.saveCalls} n=${notificationLog.length}`);
  }

  {
    reset();
    let r = await callMove(STRANGER, { date: istDayOffset(4), startTime: "14:00" });
    check("stranger customer -> 403", r.status === 403, `s=${r.status}`);

    reset();
    r = await callMove(COOK, { date: istDayOffset(4), startTime: "14:00" });
    check("the assigned cook cannot move a booking in v1 -> 403", r.status === 403, `s=${r.status}`);
    check("cook attempt leaves the booking untouched", bookingDoc.rescheduleCount === 0 && bookingDoc.saveCalls === 0, "");

    reset();
    r = await callMove(ADMIN, { date: istDayOffset(4), startTime: "14:00" });
    check("admin move -> 200", r.status === 200, `s=${r.status}`);
    check(
      "admin move notifies BOTH parties",
      notificationLog.length === 2 && new Set(notificationLog.map((n) => String(n.user))).size === 2,
      JSON.stringify(notificationLog.map((n) => n.user))
    );
    check(
      "admin move records actor=admin",
      /by admin/.test(String(bookingDoc.statusHistory[0]?.note)) && bookingDoc.reschedules[0].by === "admin",
      String(bookingDoc.statusHistory[0]?.note)
    );
  }

  for (const status of ["in_progress", "completed", "cancelled", "rejected", "expired", "unattended"]) {
    const doc = reset({ status });
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "14:00" });
    check(`${status} cannot be moved -> 400`, r.status === 400, `s=${r.status}`);
    check(`${status} stays untouched`, doc.rescheduleCount === 0 && doc.saveCalls === 0 && notificationLog.length === 0, `saves=${doc.saveCalls}`);
  }

  for (const flag of ["serviceStartedAt", "cookArrived", "hoursCompleted"]) {
    reset({ status: "confirmed", [flag]: flag === "hoursCompleted" ? true : new Date() });
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "14:00" });
    check(`${flag} blocks the move -> 400`, r.status === 400 && /under way/.test(String(r.payload?.message)), `s=${r.status} ${r.payload?.message}`);
  }

  {
    const lockStart = minutesToTime(Math.floor(istNowMinutes() / 30) * 30);
    const doc = reset({
      status: "confirmed",
      date: istMidnight(istDayString()),
      startTime: lockStart,
      endTime: minutesToTime(timeToMinutes(lockStart) + 120),
    });
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "14:00" });
    check("move inside the cutoff -> 400", r.status === 400 && /30 minutes before/.test(String(r.payload?.message)), `s=${r.status} ${r.payload?.message}`);
    check("locked move leaves the booking untouched", doc.rescheduleCount === 0 && doc.saveCalls === 0, `count=${doc.rescheduleCount} saves=${doc.saveCalls}`);
    const rAdmin = await callMove(ADMIN, { date: istDayOffset(4), startTime: "14:00" });
    check("admin is exempt from the cutoff -> 200", rAdmin.status === 200, `s=${rAdmin.status}`);
  }

  {
    const nowMin = istNowMinutes();
    const leadStart = nowMin % 30 === 0 ? nowMin : Math.ceil(nowMin / 30) * 30;
    const doc = reset({
      status: "confirmed",
      date: istMidnight(istDayOffset(1)),
      startTime: "10:00",
      endTime: "12:00",
    });
    const r = await callMove(CUSTOMER, { date: istDayString(), startTime: minutesToTime(leadStart) });
    check("new slot inside the 30-minute lead -> 400", r.status === 400, `s=${r.status} ${r.payload?.message}`);
    check(
      "lead refusal names the 30-minute rule (or the time already passed just after midnight)",
      /30 minutes from now|already passed/.test(String(r.payload?.message)),
      String(r.payload?.message)
    );
    check("lead refusal leaves the booking untouched", doc.rescheduleCount === 0 && doc.saveCalls === 0, "");
  }

  {
    const doc = reset({ status: "confirmed", rescheduleCount: 2 });
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "14:00" });
    check("third customer move -> 400", r.status === 400 && /already been rescheduled twice/.test(String(r.payload?.message)), `s=${r.status} ${r.payload?.message}`);
    check("capped booking untouched", doc.saveCalls === 0 && doc.rescheduleCount === 2, `count=${doc.rescheduleCount}`);
    const rAdmin = await callMove(ADMIN, { date: istDayOffset(4), startTime: "14:00" });
    check("admin is exempt from the cap -> 200", rAdmin.status === 200, `s=${rAdmin.status}`);
    check("admin move still increments the counter", bookingDoc.rescheduleCount === 3, String(bookingDoc.rescheduleCount));
  }

  {
    const cases = [
      ["off-grid start", { date: istDayOffset(4), startTime: "14:15" }, /30-minute interval/],
      ["missing startTime", { date: istDayOffset(4), startTime: "" }, /Valid start time/],
      ["malformed date", { date: "14-10-2026", startTime: "14:00" }, /Valid date/],
      ["impossible calendar date", { date: "2026-02-30", startTime: "14:00" }, /Valid date/],
      ["past date", { date: "2000-01-01", startTime: "14:00" }, /already passed/],
      ["beyond the booking horizon", { date: istDayOffset(400), startTime: "14:00" }, /too far ahead/],
      ["out-of-range clock", { date: istDayOffset(4), startTime: "25:00" }, /Valid start time/],
    ];
    for (const [label, body, re] of cases) {
      const doc = reset();
      const r = await callMove(CUSTOMER, body);
      check(`${label} -> 400`, r.status === 400 && re.test(String(r.payload?.message)), `s=${r.status} ${r.payload?.message}`);
      check(`${label} writes nothing`, doc.saveCalls === 0 && notificationLog.length === 0, "");
    }
  }

  {
    reset();
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "19:00" });
    check("a 2h session may not run past 8 PM -> 400", r.status === 400 && /8:00 AM and 8:00 PM/.test(String(r.payload?.message)), `s=${r.status} ${r.payload?.message}`);
  }
  {
    reset();
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "07:00" });
    check("a session may not start before 8 AM -> 400", r.status === 400, `s=${r.status} ${r.payload?.message}`);
  }
  {
    const doc = reset({ durationHours: 0 });
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "14:00" });
    check("unusable duration -> 400", r.status === 400 && /no usable duration/.test(String(r.payload?.message)), `s=${r.status} ${r.payload?.message}`);
    check("duration refusal writes nothing", doc.saveCalls === 0, "");
  }

  {
    reset();
    cookProfile = null;
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "14:00" });
    check("unknown/unapproved cook -> 400", r.status === 400 && /not approved/.test(String(r.payload?.message)), `s=${r.status} ${r.payload?.message}`);
  }
  {
    reset();
    cookProfile = { _id: "p1", user: "cook1", approvalStatus: "approved", availabilityStatus: "unavailable", unavailableDate: "" };
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "14:00" });
    check("cook toggled unavailable -> 400", r.status === 400 && /unavailable/.test(String(r.payload?.message)), `s=${r.status} ${r.payload?.message}`);
  }

  {
    reset();
    rivals = [{ _id: "rival1", startTime: "14:00", endTime: "16:00", status: "confirmed" }];
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "14:00" });
    check("rival booking on the target slot -> 409", r.status === 409, `s=${r.status} ${r.payload?.message}`);
  }
  {
    reset();
    rivals = [{ _id: "booking1", startTime: "14:00", endTime: "16:00", status: "confirmed" }];
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "14:00" });
    check("the booking itself never blocks its own move", r.status === 200, `s=${r.status}`);
  }
  {
    reset({ date: istMidnight(istDayOffset(4)), startTime: "10:00", endTime: "12:00" });
    rivals = [{ _id: "rival1", startTime: "11:00", endTime: "13:00", status: "accepted" }];
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "11:00" });
    check("partial overlap on the target slot -> 409", r.status === 409, `s=${r.status}`);
  }

  {
    reset();
    const r = await callOptions(CUSTOMER, { date: istDayOffset(4) });
    check("options -> 200 with slots", r.status === 200 && Array.isArray(r.payload?.slots) && r.payload.slots.length > 0, `s=${r.status} n=${r.payload?.slots?.length}`);
    check("options carry the duration + current slot", r.payload?.durationHours === 2 && r.payload?.currentSlot?.startTime === "10:00", JSON.stringify(r.payload?.currentSlot));
    check(
      "options slots are duration-sized, grid-aligned and inside the service day",
      (r.payload?.slots || []).every(
        (s) =>
          timeToMinutes(s.endTime) - timeToMinutes(s.startTime) === 120 &&
          timeToMinutes(s.startTime) % 30 === 0 &&
          timeToMinutes(s.startTime) >= 8 * 60 &&
          timeToMinutes(s.endTime) <= 20 * 60
      ),
      JSON.stringify((r.payload?.slots || []).slice(0, 3))
    );
    check("options never leak the service OTP", r.payload && !("serviceOtp" in r.payload), Object.keys(r.payload || {}).join(","));

    const r2 = await callOptions(STRANGER, { date: istDayOffset(4) });
    check("options: stranger -> 403", r2.status === 403, `s=${r2.status}`);
    const r3 = await callOptions(CUSTOMER, { date: "nope" });
    check("options: bad date -> 400", r3.status === 400, `s=${r3.status}`);
    const r4 = await callOptions(CUSTOMER, { date: "2000-01-01" });
    check("options: past date -> 400", r4.status === 400, `s=${r4.status}`);
  }
  {
    reset();
    rivals = [{ _id: "booking1", startTime: "10:00", endTime: "12:00", status: "confirmed" }];
    const r = await callOptions(CUSTOMER, { date: istDayOffset(4) });
    check("options exclude the booking's own hold", (r.payload?.slots || []).some((s) => s.startTime === "10:00"), JSON.stringify((r.payload?.slots || []).map((s) => s.startTime)));
  }
  {
    reset();
    const rCust = await callOptions(CUSTOMER, { date: istDayString() });
    const leadOk = (rCust.payload?.slots || []).every((s) => {
      const inst = istEventInstant(istDayString(), s.startTime);
      return Boolean(inst) && inst.getTime() - Date.now() >= 30 * 60 * 1000;
    });
    check("options on today respect the 30-minute lead (customer)", rCust.status === 200 && leadOk, `n=${rCust.payload?.slots?.length}`);
    const rAdmin = await callOptions(ADMIN, { date: istDayString() });
    check(
      "options: admin sees at least as much of today as the customer",
      rAdmin.status === 200 && (rAdmin.payload?.slots?.length || 0) >= (rCust.payload?.slots?.length || 0),
      `admin=${rAdmin.payload?.slots?.length} customer=${rCust.payload?.slots?.length}`
    );
  }

  {
    const routeSrc = fs.readFileSync(path.join(__dirname, "routes", "bookings.js"), "utf8");
    const reschedIdx = routeSrc.indexOf('"/:id/reschedule"');
    check("route keeps /:id/reschedule", reschedIdx !== -1);
    if (reschedIdx !== -1) {
      const block = routeSrc.slice(reschedIdx, routeSrc.indexOf(");", reschedIdx));
      const flat = block.replace(/\s+/g, " ").trim();
      check(
        "route validates date + startTime and runs validate",
        /body\("date"\)/.test(block) && /body\("startTime"\)/.test(block) && /validate/.test(block),
        flat
      );
      check("route is customer+admin (cooks cannot move bookings in v1)", /authorize\("customer", "admin"\)/.test(block), flat);
    }
    check("options route is mounted", routeSrc.includes('"/:id/reschedule-options"'));
    check(
      "controller exports the reschedule surface",
      typeof controller.rescheduleBooking === "function" &&
        typeof controller.getRescheduleOptions === "function" &&
        typeof controller.rescheduleLocked === "function",
      ""
    );
  }

  {
    reset();
    const r = await callMove(CUSTOMER, { date: istDayOffset(4), startTime: "14:00" });
    check("no 410 tombstone remains", r.status !== 410, `s=${r.status}`);
    const src = fs.readFileSync(path.join(__dirname, "controllers", "bookingController.js"), "utf8");
    check("tombstone message is gone from the controller", !/Rescheduling is no longer available/.test(src));
    const modelSrc = fs.readFileSync(path.join(__dirname, "models", "Booking.js"), "utf8");
    check(
      "Booking model documents the counter + audit trail instead of legacy",
      !/self-serve reschedule was removed/i.test(modelSrc) && /reschedules: \[/.test(modelSrc),
      ""
    );
    const notifSrc = fs.readFileSync(path.join(__dirname, "models", "Notification.js"), "utf8");
    check("notification type is no longer marked legacy", !/nothing emits this any more/.test(notifSrc));
  }

  {
    check("far-future slot is not locked", controller.rescheduleLocked({ date: istMidnight(istDayOffset(2)), startTime: "10:00" }) === false);
    const soonStart = minutesToTime(Math.floor(istNowMinutes() / 30) * 30);
    check("slot at/inside 30 minutes is locked", controller.rescheduleLocked({ date: istMidnight(istDayString()), startTime: soonStart }) === true, soonStart);
    check("unknown start fails open", controller.rescheduleLocked({}) === false);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " FAILURES");
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
