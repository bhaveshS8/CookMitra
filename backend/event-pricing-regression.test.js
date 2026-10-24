// Event pricing + booking guard regressions against an isolated test database.
// Run: node backend/event-pricing-regression.test.js
// Exits non-zero on failure; SKIPs when MONGODB_URI is unavailable.

require("dotenv").config();
const mongoose = require("mongoose");

process.env.EVENT_PAYMENTS_REQUIRED = "false";
process.env.WHATSAPP_DISPATCH_WORKER = "false";
process.env.EVENT_OUTBOX_WORKER = "false";
process.env.EXPIRED_BOOKING_SWEEP = "false";

const RUN = `evprice${Date.now().toString(36)}`;
const TEST_DB = "cookmitra_eventpricing_test";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) failures++;
};
const mockRes = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b) => {
    res.body = b;
    return res;
  };
  res.set = () => res;
  return res;
};
const failNext = (e) => check("controller did not call next(err)", false, String((e && e.message) || e));

const futureDateStr = (daysAhead) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const countSlots = (table) => {
  const EventPricing = require("./models/EventPricing");
  let n = 0;
  for (const svc of EventPricing.SERVICE_KEYS) {
    for (const dk of EventPricing.DURATION_KEYS) {
      if (Number.isFinite(Number(table?.servicePrices?.[svc]?.[dk]))) n++;
    }
  }
  return n;
};

(async () => {
  const baseUri = (process.env.MONGODB_URI || "").trim();
  if (!baseUri) {
    console.log("SKIP  no MONGODB_URI - isolated pricing regressions cannot run here");
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
    console.log(`SKIP  test database unreachable - ${(e.message || "").slice(0, 100)}`);
    process.exit(0);
  }
  console.log(`Connected to isolated test database "${TEST_DB}" (run ${RUN})`);

  const EventPricing = require("./models/EventPricing");
  const EventBooking = require("./models/EventBooking");
  const EventType = require("./models/EventType");
  const User = require("./models/User");
  await Promise.all([EventPricing.init(), EventBooking.init(), EventType.init()]);
  const pricingCtrl = require("./controllers/eventPricingController");
  const bookingCtrl = require("./controllers/eventBookingController");
  const { getPricingSnapshot, normalizePricing, MAX_PRICE } = require("./utils/eventPricing");

  const email = (n) => `${RUN}-${n}@test.example.com`;
  const mkUser = (n, role) =>
    User.create({
      name: `${RUN} ${n}`,
      email: email(n),
      password: "Test1234!",
      phone: "9876543210",
      role,
      status: "active",
    });

  const mkBookingBody = (over = {}) => ({
    eventType: `${RUN}-Birthday`,
    eventDate: futureDateStr(20),
    startTime: "12:00",
    duration: 4,
    guestCount: 25,
    address: "12 Regression Lane, Pune",
    area: "Kothrud",
    landmark: "Near regression park",
    foodType: "Full Meal",
    menu: "Paneer, roti, rice, dal",
    serviceType: "preparation_cooking",
    additionalCook: 0,
    extraHours: 0,
    distanceKm: 7,
    customerNotes: "Regression booking",
    ...over,
  });
  const createBooking = async (customer, over = {}) => {
    const res = mockRes();
    let nextErr = null;
    await bookingCtrl.createEventBooking(
      { user: { id: String(customer._id), role: "CUSTOMER" }, body: mkBookingBody(over) },
      res,
      (e) => {
        nextErr = e;
      }
    );
    return { res, nextErr };
  };
  const quote = async (over = {}) => {
    const res = mockRes();
    let nextErr = null;
    await pricingCtrl.calculateQuote(
      {
        body: {
          serviceType: "preparation_cooking",
          duration: 4,
          distanceKm: 7,
          additionalCook: 0,
          extraHours: 0,
          ...over,
        },
      },
      res,
      (e) => {
        nextErr = e;
      }
    );
    return { res, nextErr };
  };

  try {
    await mongoose.connection.dropDatabase();
    await EventType.create({ name: `${RUN}-Birthday`, description: "regression", active: true });
    const admin = await mkUser("admin", "ADMIN");
    const customer = await mkUser("customer", "CUSTOMER");
    const adminReq = { id: String(admin._id), role: "admin" };
    const callUpdate = async (body) => {
      const res = mockRes();
      await pricingCtrl.updatePricing({ user: adminReq, body }, res, failNext);
      return res;
    };
    // Failure-path variant: captures next(err) instead of treating it as an
    // unexpected test failure (used for simulated DB write failures).
    const callUpdateCatch = async (body) => {
      const res = mockRes();
      let nextErr = null;
      await pricingCtrl.updatePricing(
        { user: adminReq, body },
        res,
        (e) => {
          nextErr = e;
        }
      );
      return { res, nextErr };
    };
    const callStatus = async (bookingId, status) => {
      const res = mockRes();
      await bookingCtrl.updateEventBookingStatus(
        { params: { id: String(bookingId) }, body: { status }, user: adminReq },
        res,
        failNext
      );
      return res;
    };
    const callCancel = async (bookingId, user = customer) => {
      const res = mockRes();
      await bookingCtrl.cancelEventBooking(
        {
          params: { id: String(bookingId) },
          user: { id: String(user._id), role: String(user.role || "CUSTOMER").toUpperCase() },
        },
        res,
        failNext
      );
      return res;
    };

    // 1. Fresh install: no pricing document -> launch defaults (version 0).
    const fresh = await getPricingSnapshot();
    check("fresh install uses launch defaults", fresh.version === 0 && countSlots(fresh.table) === 21);

    // 2. Partial admin save succeeds, returns and persists the complete table.
    const r1 = await callUpdate({ servicePrices: { cooking_only: { upto2: 123 } } });
    check("partial pricing update returns 200", r1.statusCode === 200, `got ${r1.statusCode}`);
    check("partial update response is complete", countSlots(r1.body) === 21);
    const saved1 = await EventPricing.findOne({ key: "default" }).lean();
    check("partial update persists complete table", countSlots(normalizePricing(saved1)) === 21);
    check(
      "partial update changes only the requested slot",
      r1.body.servicePrices.cooking_only.upto2 === 123 &&
        r1.body.servicePrices.preparation_cooking.slot_4_5 ===
          EventPricing.DEFAULT_PRICING.servicePrices.preparation_cooking.slot_4_5
    );
    const q1 = await quote();
    check(
      "quote works after partial update",
      q1.res.statusCode === 200 && q1.res.body.totalAmount === 1699,
      JSON.stringify(q1.res.body)
    );

    // 3. Booking snapshot is complete, server-computed, and later price edits
    //    never rewrite an existing booking.
    const b1 = await createBooking(customer);
    check("booking succeeds after partial pricing update", b1.res.statusCode === 201, `got ${b1.res.statusCode}`);
    const bookingId1 = b1.res.body?._id;
    const stored1 = await EventBooking.findById(bookingId1).lean();
    check(
      "booking stores the authoritative full snapshot",
      stored1 &&
        stored1.serviceAmount === 1599 &&
        stored1.additionalCookAmount === 0 &&
        stored1.extraHourAmount === 0 &&
        stored1.travelCharge === 100 &&
        stored1.totalAmount === 1699
    );
    const r2 = await callUpdate({ additionalCookPrice: 500 });
    check(
      "second partial update preserves earlier override",
      r2.statusCode === 200 &&
        r2.body.servicePrices.cooking_only.upto2 === 123 &&
        r2.body.additionalCookPrice === 500
    );
    const q2 = await quote({ additionalCook: 1 });
    check(
      "new quote uses updated additional-cook price",
      q2.res.statusCode === 200 && q2.res.body.totalAmount === 2199,
      JSON.stringify(q2.res.body)
    );
    const storedAfter = await EventBooking.findById(bookingId1).lean();
    check(
      "existing booking total is immutable",
      storedAfter.totalAmount === 1699 && storedAfter.serviceAmount === 1599
    );

    // 3b. Empty payload is a no-op: 200, complete table, no version bump
    //     (a version bump would invalidate customers reviewing a live quote).
    const vBeforeEmpty = (await EventPricing.findOne({ key: "default" }).lean()).__v;
    const rEmpty = await callUpdate({});
    const vAfterEmpty = (await EventPricing.findOne({ key: "default" }).lean()).__v;
    check(
      "empty pricing update is a safe no-op",
      rEmpty.statusCode === 200 &&
        countSlots(rEmpty.body) === 21 &&
        rEmpty.body.additionalCookPrice === 500 &&
        rEmpty.body.servicePrices.cooking_only.upto2 === 123 &&
        vBeforeEmpty === vAfterEmpty,
      `status=${rEmpty.statusCode} v=${vBeforeEmpty}/${vAfterEmpty}`
    );

    // 3c. Boundary values: 0 is a valid free price; MAX_PRICE is inclusive;
    //     MAX_PRICE + 1 is rejected and leaves the last valid value intact.
    const rZero = await callUpdate({ servicePrices: { cooking_only: { upto2: 0 } } });
    check(
      "zero price is accepted",
      rZero.statusCode === 200 && rZero.body.servicePrices.cooking_only.upto2 === 0,
      `got ${rZero.statusCode}`
    );
    const rMax = await callUpdate({ servicePrices: { cooking_only: { upto2: MAX_PRICE } } });
    check(
      "upper boundary price is accepted",
      rMax.statusCode === 200 && rMax.body.servicePrices.cooking_only.upto2 === MAX_PRICE,
      `got ${rMax.statusCode}`
    );
    const rOver = await callUpdate({ servicePrices: { cooking_only: { upto2: MAX_PRICE + 1 } } });
    const afterOver = await EventPricing.findOne({ key: "default" }).lean();
    check(
      "above-boundary price is rejected without persisting",
      rOver.statusCode === 400 &&
        normalizePricing(afterOver).servicePrices.cooking_only.upto2 === MAX_PRICE,
      `status=${rOver.statusCode}`
    );
    await callUpdate({ servicePrices: { cooking_only: { upto2: 123 } } });

    // 3d. Failed database write must leave the previously valid config intact.
    const beforeFailWrite = await EventPricing.findOne({ key: "default" }).lean();
    const originalSave = EventPricing.prototype.save;
    EventPricing.prototype.save = async function saveFailure() {
      throw new Error("simulated database write failure");
    };
    let failedWrite;
    try {
      failedWrite = await callUpdateCatch({ additionalCookPrice: 777 });
    } finally {
      EventPricing.prototype.save = originalSave;
    }
    const afterFailWrite = await EventPricing.findOne({ key: "default" }).lean();
    check(
      "failed database write surfaces an error",
      failedWrite.nextErr && /simulated database write failure/.test(String(failedWrite.nextErr.message)),
      String(failedWrite.nextErr && failedWrite.nextErr.message)
    );
    check(
      "failed database write leaves the prior pricing intact",
      afterFailWrite.additionalCookPrice === beforeFailWrite.additionalCookPrice &&
        afterFailWrite.servicePrices.cooking_only.upto2 === 123 &&
        countSlots(normalizePricing(afterFailWrite)) === 21
    );

    // 3e. Admin price changes never rewrite pending / confirmed / completed
    //     booking snapshots; only new quotes use the new table.
    const bPending = await createBooking(customer, { startTime: "05:00" });
    const bConfirmed = await createBooking(customer, { startTime: "06:00" });
    const bCompleted = await createBooking(customer, { startTime: "07:00" });
    await EventBooking.updateOne(
      { _id: bConfirmed.res.body._id },
      { $set: { bookingStatus: "confirmed", cookId: admin._id } }
    );
    await EventBooking.updateOne(
      { _id: bCompleted.res.body._id },
      { $set: { bookingStatus: "completed", cookId: admin._id } }
    );
    const snapshotsBefore = await EventBooking.find({
      _id: { $in: [bPending.res.body._id, bConfirmed.res.body._id, bCompleted.res.body._id] },
    })
      .select("bookingStatus serviceAmount additionalCookAmount extraHourAmount travelCharge totalAmount")
      .lean();
    const rPriceMove = await callUpdate({
      servicePrices: { preparation_cooking: { slot_4_5: 1777 } },
    });
    const snapshotsAfter = await EventBooking.find({
      _id: { $in: [bPending.res.body._id, bConfirmed.res.body._id, bCompleted.res.body._id] },
    })
      .select("bookingStatus serviceAmount additionalCookAmount extraHourAmount travelCharge totalAmount")
      .lean();
    const byId = (rows) => new Map(rows.map((row) => [String(row._id), row]));
    const beforeMap = byId(snapshotsBefore);
    const afterMap = byId(snapshotsAfter);
    const untouched = [...beforeMap.entries()].every(([id, before]) => {
      const after = afterMap.get(id);
      return (
        after &&
        after.bookingStatus === before.bookingStatus &&
        after.serviceAmount === before.serviceAmount &&
        after.additionalCookAmount === before.additionalCookAmount &&
        after.extraHourAmount === before.extraHourAmount &&
        after.travelCharge === before.travelCharge &&
        after.totalAmount === before.totalAmount
      );
    });
    check(
      "pricing changes leave pending/confirmed/completed snapshots intact",
      rPriceMove.statusCode === 200 && untouched && snapshotsBefore.length === 3,
      `status=${rPriceMove.statusCode} rows=${snapshotsBefore.length}`
    );
    const qNew = await quote();
    check(
      "new quote uses the changed table",
      qNew.res.statusCode === 200 && qNew.res.body.serviceAmount === 1777 && qNew.res.body.totalAmount === 1877,
      JSON.stringify(qNew.res.body)
    );

    // 3f. Idempotency fingerprint ignores letter case (EVT-AUD-007): a retry
    //     that differs only in casing replays the original booking.
    const caseKey = `${RUN}-CASE-KEY-1`;
    const caseFirst = await createBooking(customer, { startTime: "08:00", idempotencyKey: caseKey });
    const caseReplay = await createBooking(customer, {
      startTime: "08:00",
      idempotencyKey: caseKey,
      menu: "PANEER, ROTI, RICE, DAL",
      address: "12 REGRESSION LANE, PUNE",
      customerNotes: "REGRESSION BOOKING",
    });
    check(
      "case-only retry replays the original booking",
      caseFirst.res.statusCode === 201 &&
        caseReplay.res.statusCode === 200 &&
        String(caseFirst.res.body._id) === String(caseReplay.res.body._id),
      `codes=${caseFirst.res.statusCode}/${caseReplay.res.statusCode}`
    );

    // 4. Invalid edits are rejected without touching the stored config.
    const rBad = await callUpdate({
      additionalCookPrice: 600,
      servicePrices: { cooking_only: { upto2: -1 } },
    });
    const afterBad = await EventPricing.findOne({ key: "default" }).lean();
    check("invalid pricing update returns 400", rBad.statusCode === 400, `got ${rBad.statusCode}`);
    check("invalid pricing update is not persisted", afterBad.additionalCookPrice === 500);

    // 5. Legacy partial document: normalize fills all missing slots at read time.
    await EventPricing.collection.deleteMany({});
    await EventPricing.collection.insertOne({
      key: "default",
      servicePrices: { cooking_only: { upto2: 77 } },
      __v: 7,
    });
    const legacy = await getPricingSnapshot();
    check(
      "legacy partial document is normalized",
      legacy.version === 7 &&
        legacy.table.servicePrices.cooking_only.upto2 === 77 &&
        legacy.table.servicePrices.preparation_cooking.slot_4_5 === 1599 &&
        countSlots(legacy.table) === 21
    );
    const legacyQuote = await quote({ serviceType: "preparation_cooking" });
    check(
      "legacy partial document still supports quotes",
      legacyQuote.res.statusCode === 200 && legacyQuote.res.body.totalAmount === 1699
    );
    const rFill = await callUpdate({ additionalCookPrice: 450 });
    const filled = await EventPricing.findOne({ key: "default" }).lean();
    check(
      "saving a legacy doc repairs it to a complete table",
      rFill.statusCode === 200 && countSlots(normalizePricing(filled)) === 21
    );

    // 6. Database outage is explicit (503), never silently priced from defaults.
    const beforeOutage = await EventBooking.countDocuments({});
    const origFindOne = EventPricing.findOne;
    EventPricing.findOne = () => {
      throw new Error("simulated pricing outage");
    };
    let outageErr = null;
    try {
      await getPricingSnapshot();
    } catch (e) {
      outageErr = e;
    }
    check(
      "pricing snapshot exposes DB outage as 503",
      outageErr && outageErr.statusCode === 503 && outageErr.code === "PRICING_UNAVAILABLE",
      String(outageErr && outageErr.message)
    );
    const qOut = await quote();
    check(
      "quote propagates pricing outage as 503",
      qOut.nextErr && qOut.nextErr.statusCode === 503 && qOut.res.statusCode === 200,
      `next=${qOut.nextErr && qOut.nextErr.statusCode}`
    );
    const bOut = await createBooking(customer, { startTime: "13:00" });
    const afterOutage = await EventBooking.countDocuments({});
    check(
      "booking is not created during pricing outage",
      bOut.nextErr &&
        bOut.nextErr.statusCode === 503 &&
        bOut.res.statusCode !== 201 &&
        afterOutage === beforeOutage
    );
    EventPricing.findOne = origFindOne;
    const recovered = await getPricingSnapshot();
    check(
      "pricing recovers after DB returns",
      countSlots(recovered.table) === 21 && recovered.table.additionalCookPrice === 450
    );

    // 7. Concurrent admin edits either serialize or conflict, never corrupt.
    const [c1, c2] = await Promise.all([
      callUpdate({ servicePrices: { cooking_only: { upto2: 88 } } }),
      callUpdate({ servicePrices: { cooking_only: { upto2: 99 } } }),
    ]);
    const concurrentOk = [c1, c2].every((r) => [200, 409].includes(r.statusCode));
    const finalConcurrent = normalizePricing(
      await EventPricing.findOne({ key: "default" }).lean()
    );
    check(
      "concurrent pricing edits are consistent",
      concurrentOk &&
        [88, 99].includes(finalConcurrent.servicePrices.cooking_only.upto2) &&
        countSlots(finalConcurrent) === 21,
      `statuses=${c1.statusCode},${c2.statusCode} value=${finalConcurrent.servicePrices.cooking_only.upto2}`
    );

    // 8. Manual status moves cannot bypass cook assignment.
    const b2 = await createBooking(customer, { startTime: "15:00" });
    const bypass = await callStatus(b2.res.body._id, "cook_assigned");
    const b2Stored = await EventBooking.findById(b2.res.body._id).lean();
    check(
      "manual cook_assigned status is rejected",
      bypass.statusCode === 400 &&
        bypass.body.code === "USE_ASSIGN_ENDPOINT" &&
        b2Stored.bookingStatus === "pending" &&
        !b2Stored.cookId,
      JSON.stringify(bypass.body)
    );

    // 9. Paid in-progress cancellation is blocked until policy is approved.
    const b3 = await createBooking(customer, { startTime: "17:00" });
    await EventBooking.updateOne(
      { _id: b3.res.body._id },
      {
        $set: {
          bookingStatus: "in_progress",
          "payment.status": "paid",
          "payment.paidAmount": b3.res.body.totalAmount,
          "payment.refundStatus": "none",
        },
      }
    );
    const cancelStarted = await callCancel(b3.res.body._id);
    const b3Stored = await EventBooking.findById(b3.res.body._id).lean();
    check(
      "paid in-progress cancellation is blocked",
      cancelStarted.statusCode === 409 &&
        cancelStarted.body.code === "REFUND_POLICY_UNRESOLVED" &&
        b3Stored.bookingStatus === "in_progress" &&
        b3Stored.payment.refundStatus === "none",
      JSON.stringify(cancelStarted.body)
    );

    // 10. Paid pre-start cancellation still queues a full refund.
    const b4 = await createBooking(customer, { startTime: "19:00" });
    await EventBooking.updateOne(
      { _id: b4.res.body._id },
      {
        $set: {
          bookingStatus: "confirmed",
          "payment.status": "paid",
          "payment.paidAmount": b4.res.body.totalAmount,
          "payment.refundStatus": "none",
        },
      }
    );
    const cancelBefore = await callCancel(b4.res.body._id);
    const b4Stored = await EventBooking.findById(b4.res.body._id).lean();
    check(
      "paid pre-start cancellation queues full refund",
      cancelBefore.statusCode === 200 &&
        b4Stored.bookingStatus === "cancelled" &&
        b4Stored.payment.refundStatus === "pending" &&
        b4Stored.payment.refundAmount === b4Stored.payment.paidAmount,
      JSON.stringify(cancelBefore.body && cancelBefore.body.payment)
    );
  } catch (e) {
    check("unexpected test error", false, (e && e.stack) || String(e));
  } finally {
    try {
      await mongoose.connection.dropDatabase();
    } catch {}
    try {
      await mongoose.disconnect();
    } catch {}
  }

  console.log(`SUMMARY pass=${failures === 0 ? "all" : "partial"} fail=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})();
