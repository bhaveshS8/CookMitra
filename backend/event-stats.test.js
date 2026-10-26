require("dotenv").config();
const mongoose = require("mongoose");

const RUN = `evst${Date.now().toString(36)}`;
const TEST_DB = "cookmitra_eventstats";
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
  return res;
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

  const EventBooking = require("./models/EventBooking");
  const User = require("./models/User");
  const { istMidnight } = require("./utils/time");
  const { getEventStats } = require("./controllers/eventBookingController");

  try {
    await mongoose.connection.db.dropDatabase();
    const customer = await User.create({
      name: `${RUN} customer`,
      email: `${RUN}@test.example.com`,
      password: "Test1234!",
      phone: "9876543210",
      role: "CUSTOMER",
      status: "active",
    });
    const base = {
      customerId: customer._id,
      eventType: "Birthday",
      eventDate: istMidnight("2031-01-20"),
      startTime: "09:00",
      duration: 2,
      guestCount: 10,
      address: "1 Test St",
      menu: "Rice, Dal",
      serviceType: "preparation_cooking",
    };
    await EventBooking.create({ ...base, bookingId: `${RUN}-P`, bookingStatus: "pending", totalAmount: 1000 });
    await EventBooking.create({
      ...base,
      bookingId: `${RUN}-C`,
      bookingStatus: "completed",
      totalAmount: 500,
      payment: { status: "paid", paidAmount: 500, paidAt: new Date(), testMode: false },
    });
    await EventBooking.create({ ...base, bookingId: `${RUN}-X`, bookingStatus: "cancelled", totalAmount: 300 });

    const res = mockRes();
    await getEventStats({}, res, (e) => {
      check("stats did not call next(err)", false, String((e && e.message) || e));
    });
    check("stats returns 200", res.statusCode === 200, String(res.statusCode));
    check("captured event payment is reported as collected revenue", res.body?.totalRevenue === 500, JSON.stringify({
      totalRevenue: res.body?.totalRevenue,
      collectedRevenue: res.body?.collectedRevenue,
    }));
    check("booked value excludes cancelled events", res.body?.bookedValue === 1500, String(res.body?.bookedValue));
    check("unpaid value excludes collected revenue", res.body?.unpaidValue === 1000, String(res.body?.unpaidValue));
    check(
      "per-status totals separate booked value from collected revenue",
      res.body?.byStatus?.cancelled?.bookedValue === 300 &&
        res.body?.byStatus?.pending?.collectedRevenue === 0 &&
        res.body?.byStatus?.completed?.collectedRevenue === 500,
      JSON.stringify(res.body?.byStatus)
    );
  } catch (e) {
    check("test execution completed without exception", false, String((e && e.stack) || e));
  } finally {
    try {
      await mongoose.connection.db.dropDatabase();
    } catch {}
    await mongoose.disconnect();
    console.log(`EVENT_STATS_FAILURES=${failures}`);
    process.exit(failures ? 1 : 0);
  }
})();
