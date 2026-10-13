
const Booking = require("./models/Booking");
const Notification = require("./models/Notification");
const controller = require("./controllers/bookingController");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) failures++;
};

let bookingDoc = null;
const notificationLog = [];

const resetBooking = (overrides = {}) => {
  bookingDoc = {
    _id: "booking1",
    cook: "cook1",
    customer: "cust1",
    serviceType: "cook_with_me",
    date: new Date(Date.now() + 24 * 60 * 60 * 1000),
    startTime: "10:00",
    endTime: "12:00",
    durationHours: 2,
    status: "confirmed",
    statusHistory: [],
    payment: { status: "paid", paidAmount: 499 },
    serviceOtp: "4321",
    serviceOtpGeneratedAt: new Date(),
    serviceStartedAt: null,
    serviceEndsAt: null,
    cookArrived: false,
    cookArrivedAt: null,
    ...overrides,
    save: async function () {
      return this;
    },
  };
};

Booking.findOne = async (filter) => {
  if (!bookingDoc || String(filter._id) !== "booking1") return null;
  if (filter.cook && String(filter.cook) !== String(bookingDoc.cook)) return null;
  return bookingDoc;
};
Notification.create = async (payload) => {
  notificationLog.push(payload);
  return payload;
};

const call = (userId, role, body) => {
  const req = { params: { id: "booking1" }, user: { id: userId, role }, body };
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
    .startService(req, res, (e) => {
      throw e;
    })
    .then(() => ({ status, payload }));
};

(async () => {
  resetBooking();
  notificationLog.length = 0;
  const before = Date.now();
  let r = await call("cook1", "cook", { otp: "4321" });
  check("correct OTP starts service", r.status === 200 && r.payload.serviceStarted === true, "s=" + r.status);
  check("live clock set for 2h", !!bookingDoc.serviceStartedAt && bookingDoc.serviceEndsAt - bookingDoc.serviceStartedAt === 2 * 3600 * 1000, String(bookingDoc.serviceEndsAt - bookingDoc.serviceStartedAt));
  check("clock starts now", bookingDoc.serviceStartedAt.getTime() >= before, "");
  check("arrival marked", bookingDoc.cookArrived === true, "");
  check("status in_progress", bookingDoc.status === "in_progress", bookingDoc.status);
  check(
    "history notes OTP start",
    bookingDoc.statusHistory.some((h) => /OTP verified/.test(h.note || "")),
    JSON.stringify(bookingDoc.statusHistory.map((h) => h.note))
  );
  check("OTP never leaks to cook", !("serviceOtp" in (r.payload || {})), Object.keys(r.payload || {}).join(","));
  check(
    "customer notified of start",
    notificationLog.some((n) => String(n.user) === "cust1" && n.type === "service_started"),
    notificationLog.map((n) => n.type).join(",")
  );

  resetBooking();
  notificationLog.length = 0;
  r = await call("cook1", "cook", { otp: "0000" });
  check("wrong OTP refused with 400", r.status === 400, "s=" + r.status);
  check("clock untouched", !bookingDoc.serviceStartedAt, "");

  resetBooking({ status: "requested" });
  r = await call("cook1", "cook", { otp: "4321" });
  check("requested refused with 400", r.status === 400, "s=" + r.status);

  resetBooking({ status: "accepted", payment: { status: "pending", paidAmount: 0 } });
  notificationLog.length = 0;
  r = await call("cook1", "cook", { otp: "4321" });
  check("accepted-unpaid refused with 400", r.status === 400, "s=" + r.status);
  check("clock untouched on unpaid", !bookingDoc.serviceStartedAt, "");

  resetBooking({ serviceStartedAt: new Date(), serviceEndsAt: new Date(Date.now() + 3600000), status: "in_progress" });
  const histLen = bookingDoc.statusHistory.length;
  r = await call("cook1", "cook", { otp: "4321" });
  check("re-start idempotent", r.status === 200 && r.payload.serviceStarted === true, "s=" + r.status);
  check("no duplicate history", bookingDoc.statusHistory.length === histLen, "");

  resetBooking();
  r = await call("cook9", "cook", { otp: "4321" });
  check("foreign booking 404", r.status === 404, "s=" + r.status);

  resetBooking();
  bookingDoc = null;
  r = await call("cook1", "cook", { otp: "4321" });
  check("unknown booking 404", r.status === 404, "s=" + r.status);

  console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " FAILURES");
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
