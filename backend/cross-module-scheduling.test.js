require("dotenv").config();
const mongoose = require("mongoose");

const RUN = `xms${Date.now().toString(36)}`;
const TEST_DB = "cookmitra_crosstest";
let failures = 0;

const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) failures++;
};

const mockRes = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.set = () => res;
  return res;
};

const nextFail = (e) => {
  check("controller did not call next(err)", false, String((e && e.message) || e));
};

const futureDay = (daysAhead) => {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

(async () => {
  const baseUri = String(process.env.MONGODB_URI || "").trim();
  if (!baseUri) {
    console.log("SKIP  no MONGODB_URI");
    process.exit(0);
  }
  const testUri = baseUri.replace(/\/([^/?]+)(\?|$)/, `/${TEST_DB}$2`);
  if (testUri === baseUri) {
    console.log("SKIP  could not derive isolated test database URI");
    process.exit(0);
  }
  try {
    await mongoose.connect(testUri, { serverSelectionTimeoutMS: 12000 });
  } catch (e) {
    console.log(`SKIP  test database unreachable — ${(e.message || "").slice(0, 100)}`);
    process.exit(0);
  }

  const Booking = require("./models/Booking");
  const EventBooking = require("./models/EventBooking");
  const CookProfile = require("./models/CookProfile");
  const User = require("./models/User");
  const { istMidnight } = require("./utils/time");
  const bookingCtrl = require("./controllers/bookingController");
  const availabilityCtrl = require("./controllers/availabilityController");

  const DAY = futureDay(20);
  const dayDate = istMidnight(DAY);
  const email = (name) => `${RUN}-${name}@test.example.com`;

  try {
    await mongoose.connection.db.dropDatabase();
    const customer = await User.create({
      name: `${RUN} customer`,
      email: email("customer"),
      password: "Test1234!",
      phone: "9876543210",
      role: "CUSTOMER",
      status: "active",
    });
    const admin = await User.create({
      name: `${RUN} admin`,
      email: email("admin"),
      password: "Test1234!",
      phone: "9876543211",
      role: "ADMIN",
      status: "active",
    });
    const cook = await User.create({
      name: `${RUN} cook`,
      email: email("cook"),
      password: "Test1234!",
      phone: "9876543212",
      role: "COOK",
      status: "active",
    });
    await CookProfile.create({
      user: cook._id,
      approvalStatus: "approved",
      availabilityStatus: "available",
      serviceTypes: ["cook_for_me"],
    });
    const event = await EventBooking.create({
      bookingId: `${RUN}-EVT`,
      customerId: customer._id,
      cookId: cook._id,
      eventType: "Birthday",
      eventDate: dayDate,
      startTime: "09:30",
      duration: 2,
      guestCount: 10,
      address: "1 Test St",
      menu: "Rice, Dal",
      serviceType: "preparation_cooking",
      bookingStatus: "cook_assigned",
    });

    const eligible = await bookingCtrl.findEligibleCooks({
      date: DAY,
      startTime: "09:00",
      endTime: "10:00",
      serviceType: "cook_for_me",
      diagnostics: true,
    });
    check(
      "eligible-cook search excludes an event-conflicted cook",
      eligible.eligible.length === 0 && eligible.excluded.eventOverlap === 1,
      JSON.stringify({ eligible: eligible.eligible.length, excluded: eligible.excluded })
    );

    const request = await Booking.create({
      customer: customer._id,
      cook: null,
      serviceType: "cook_for_me",
      date: dayDate,
      startTime: "09:00",
      endTime: "10:00",
      durationHours: 1,
      address: "1 Test St",
      status: "requested",
      requestExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    const adminAcceptRes = mockRes();
    await bookingCtrl.acceptBooking(
      {
        params: { id: String(request._id) },
        body: { cookId: String(cook._id) },
        user: { id: String(admin._id), role: "ADMIN", name: admin.name },
      },
      adminAcceptRes,
      nextFail
    );
    check(
      "admin acceptance rejects a cook with an overlapping event",
      adminAcceptRes.statusCode === 409 && /event booking/.test(adminAcceptRes.body?.message || ""),
      `${adminAcceptRes.statusCode}: ${adminAcceptRes.body?.message}`
    );
    const requestAfter = await Booking.findById(request._id).select("status cook");
    check(
      "rejected admin acceptance leaves the request unassigned",
      requestAfter.status === "requested" && requestAfter.cook == null,
      `status=${requestAfter.status} cook=${requestAfter.cook}`
    );

    const movable = await Booking.create({
      customer: customer._id,
      cook: cook._id,
      serviceType: "cook_for_me",
      date: dayDate,
      startTime: "08:00",
      endTime: "09:00",
      durationHours: 1,
      address: "1 Test St",
      status: "confirmed",
      payment: { status: "paid", paidAmount: 500, paidAt: new Date() },
    });
    const rescheduleRes = mockRes();
    await bookingCtrl.rescheduleBooking(
      {
        params: { id: String(movable._id) },
        body: { date: DAY, startTime: "09:30" },
        user: { id: String(customer._id), role: "CUSTOMER" },
      },
      rescheduleRes,
      nextFail
    );
    check(
      "same-cook reschedule rejects an overlapping event",
      rescheduleRes.statusCode === 409 && /event booking/.test(rescheduleRes.body?.message || ""),
      `${rescheduleRes.statusCode}: ${rescheduleRes.body?.message}`
    );
    const movableAfter = await Booking.findById(movable._id).select("date startTime endTime cook status");
    check(
      "rejected reschedule leaves the original slot intact",
      movableAfter.startTime === "08:00" && movableAfter.endTime === "09:00",
      `${movableAfter.startTime}-${movableAfter.endTime}`
    );

    const payable = await Booking.create({
      customer: customer._id,
      cook: cook._id,
      serviceType: "cook_for_me",
      date: dayDate,
      startTime: "09:00",
      endTime: "10:00",
      durationHours: 1,
      address: "1 Test St",
      amount: 500,
      status: "accepted",
      payment: { status: "pending", paidAmount: 0 },
    });
    const payRes = mockRes();
    await bookingCtrl.payBooking(
      {
        params: { id: String(payable._id) },
        body: {},
        user: { id: String(customer._id), role: "CUSTOMER" },
      },
      payRes,
      nextFail
    );
    check(
      "payment rejects a slot that now overlaps an event",
      payRes.statusCode === 409 && payRes.body?.code === "SLOT_UNAVAILABLE",
      `${payRes.statusCode}: ${payRes.body?.code} ${payRes.body?.message}`
    );
    const payableAfter = await Booking.findById(payable._id).select("status payment.status");
    check(
      "rejected payment leaves the booking unpaid",
      payableAfter.status === "accepted" && payableAfter.payment?.status === "pending",
      `status=${payableAfter.status} payment=${payableAfter.payment?.status}`
    );

    const availabilityRes = mockRes();
    await availabilityCtrl.searchAvailability(
      { query: { date: DAY, durationHours: "1" }, user: null },
      availabilityRes,
      nextFail
    );
    const availableCook = (availabilityRes.body?.cooks || []).find(
      (entry) => String(entry.user?._id || entry.user) === String(cook._id)
    );
    const slots = availableCook?.slots || [];
    check(
      "availability search removes slots occupied by an event",
      slots.length > 0 && !slots.some((slot) => slot.startTime === "09:30" || slot.startTime === "10:00"),
      JSON.stringify(slots.map((slot) => slot.startTime))
    );

    check("test event fixture remained assigned", String(event.cookId) === String(cook._id));
  } catch (e) {
    check("test execution completed without exception", false, String((e && e.stack) || e));
  } finally {
    try {
      await mongoose.connection.db.dropDatabase();
    } catch {}
    await mongoose.disconnect();
    console.log(`CROSS_MODULE_SCHEDULING_FAILURES=${failures}`);
    process.exit(failures ? 1 : 0);
  }
})();
