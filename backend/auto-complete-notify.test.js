
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const User = require("./models/User");
const Notification = require("./models/Notification");
const controller = require("./controllers/bookingController");

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes += 1;
  else failures += 1;
};

const H = 60 * 60 * 1000;
const notificationLog = [];

User.findById = () => ({ select: async () => ({ name: "Rahul" }) });
Notification.create = async (payload) => {
  notificationLog.push(payload);
  return payload;
};

const baseDoc = (over = {}) => {
  const doc = {
    _id: "booking1",
    customer: "cust1",
    cook: "cook1",
    status: "in_progress",
    serviceStartedAt: new Date(Date.now() - 3 * H),
    serviceEndsAt: new Date(Date.now() - H),
    cookArrived: true,
    cookArrivedAt: new Date(Date.now() - 3 * H),
    hoursCompleted: false,
    date: new Date(Date.now() - 3 * H),
    startTime: "10:00",
    endTime: "12:00",
    durationHours: 2,
    payment: { status: "paid", paidAmount: 349, refundStatus: "none", testMode: false },
    payout: { status: "pending" },
    statusHistory: [],
    async save() {
      return this;
    },
  };
  if (over.payment) {
    doc.payment = { ...doc.payment, ...over.payment };
    delete over.payment;
  }
  return Object.assign(doc, over);
};

(async () => {
  {
    notificationLog.length = 0;
    const doc = baseDoc();
    await controller.markHoursCompleteIfNeeded(doc);
    check("1. auto-completes past-end live session", doc.status === "completed", doc.status);
    const to = notificationLog.map((n) => String(n.user));
    check("1. customer rate-prompt sent", to.includes("cust1") && notificationLog.some((n) => String(n.user) === "cust1" && /rate your cook/i.test(n.message)), to.join(","));
    check("1. cook notified too", to.includes("cook1") && notificationLog.some((n) => String(n.user) === "cook1" && n.type === "booking_completed"), to.join(","));
    check("1. exactly one completion notice per side", notificationLog.filter((n) => String(n.user) === "cust1" && n.type === "booking_completed").length === 1 && notificationLog.filter((n) => String(n.user) === "cook1" && n.type === "booking_completed").length === 1, `n=${notificationLog.length}`);
  }

  {
    notificationLog.length = 0;
    const doc = baseDoc({ status: "completed", hoursCompleted: true });
    await controller.markHoursCompleteIfNeeded(doc);
    check("2. no duplicate completion notices", notificationLog.length === 0, `n=${notificationLog.length}`);
  }

  {
    notificationLog.length = 0;
    const doc = baseDoc({ serviceEndsAt: new Date(Date.now() + H) });
    await controller.markHoursCompleteIfNeeded(doc);
    check("3. running session untouched, silent", doc.status === "in_progress" && notificationLog.length === 0, `${doc.status}/${notificationLog.length}`);
  }

  {
    notificationLog.length = 0;
    const doc = baseDoc({
      status: "confirmed",
      serviceStartedAt: null,
      serviceEndsAt: null,
      cookArrived: true,
      payment: { status: "pending" },
    });
    await controller.markHoursCompleteIfNeeded(doc);
    check("4. unpaid arrival-only not completed", doc.status === "confirmed", doc.status);
    check("4. no completion notices", notificationLog.every((n) => n.type !== "booking_completed"), notificationLog.map((n) => n.type).join(","));
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
