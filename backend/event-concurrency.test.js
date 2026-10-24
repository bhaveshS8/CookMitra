// COOKMITRA EVENTS concurrency + lifecycle integration tests (REAL database).
// Run: node backend/event-concurrency.test.js — exits non-zero on failure.
//
// Uses an ISOLATED test database (cookmitra_eventtest) on the same cluster —
// never the development/production database — and drops it afterwards.
// Requires MONGODB_URI to be reachable; if not, the file prints SKIP and
// exits 0 so `npm test` stays green in offline environments (the limitation
// is reported, not hidden).
//
// Unlike event-security.test.js (pure functions + source assertions), every
// test below executes genuine concurrent database operations: Promise.all
// over real controller invocations against Atlas.

require("dotenv").config();
const mongoose = require("mongoose");

process.env.EVENT_PAYMENTS_REQUIRED = "false";

const RUN = `evct${Date.now().toString(36)}`;
const TEST_DB = "cookmitra_eventtest";

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
const failNext = (e) => {
  check("controller did not call next(err)", false, String((e && e.message) || e));
};

const futureDateStr = (daysAhead) => {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

(async () => {
  const baseUri = (process.env.MONGODB_URI || "").trim();
  if (!baseUri) {
    console.log("SKIP  no MONGODB_URI — isolated-DB concurrency tests cannot run here");
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
  console.log(`Connected to isolated test database "${TEST_DB}" (run ${RUN})`);

  const EventBooking = require("./models/EventBooking");
  const EventType = require("./models/EventType");
  const EventPricing = require("./models/EventPricing");
  const User = require("./models/User");
  const Booking = require("./models/Booking");
  const CookProfile = require("./models/CookProfile");
  const Notification = require("./models/Notification");
  const EventOutbox = require("./models/EventOutbox");
  await EventBooking.init();
  const bookingCtrl = require("./controllers/eventBookingController");
  const { travelChargeForDistance } = require("./utils/eventPricing");
  const { outboxSummary, startOutboxWorker, stopOutboxWorker } = require("./utils/eventOutbox");
  const { spawnSync } = require("child_process");
  const path = require("path");
  const BACKEND_DIR = __dirname;

  const email = (n) => `${RUN}-${n}@test.example.com`;
  const mkUser = (n, role, status = "active") =>
    User.create({ name: `${RUN} ${n}`, email: email(n), password: "Test1234!", phone: "9876543210", role, status });
  const mkCook = async (n, approval = "approved", availability = "available", status = "active") => {
    const u = await mkUser(n, "COOK", status);
    await CookProfile.create({ user: u._id, approvalStatus: approval, availabilityStatus: availability });
    return u;
  };
  const asUser = (u, role) => ({ id: String(u._id), role });
  const DAY = futureDateStr(30);
  const mkBookingReq = (customer, overrides = {}) => ({
    user: asUser(customer, "CUSTOMER"),
    body: {
      eventType: `${RUN}-Active`,
      eventDate: DAY,
      startTime: "10:00",
      duration: 2,
      guestCount: 10,
      address: "1 Test St",
      area: "Test Area",
      menu: "Rice, Dal",
      serviceType: "preparation_cooking",
      additionalCook: 0,
      extraHours: 0,
      distanceKm: 0,
      ...overrides,
    },
  });
  const callCreate = async (customer, overrides) => {
    const req = mkBookingReq(customer, overrides);
    const res = mockRes();
    await bookingCtrl.createEventBooking(req, res, failNext);
    return res;
  };
  const callAssign = (bookingId, cookId, admin) => {
    const res = mockRes();
    return bookingCtrl
      .assignCook({ params: { id: String(bookingId) }, body: { cookId: String(cookId) }, user: asUser(admin, "ADMIN") }, res, failNext)
      .then(() => res);
  };
  // Permission probe: same controller invoked under ANY role. The route's
  // authorize("admin") is the primary gate; assignCook's defense-in-depth
  // guard must reject non-admin callers even when reached directly.
  const callAssignAs = (bookingId, cookId, user, role) => {
    const res = mockRes();
    return bookingCtrl
      .assignCook({ params: { id: String(bookingId) }, body: { cookId: String(cookId) }, user: asUser(user, role) }, res, failNext)
      .then(() => res);
  };
  const callStatus = (bookingId, status, admin, note = "") => {
    const res = mockRes();
    return bookingCtrl
      .updateEventBookingStatus({ params: { id: String(bookingId) }, body: { status, note }, user: asUser(admin, "ADMIN") }, res, failNext)
      .then(() => res);
  };
  const callCancel = (bookingId, user, role) => {
    const res = mockRes();
    return bookingCtrl
      .cancelEventBooking({ params: { id: String(bookingId) }, body: {}, user: { id: String(user._id), role } }, res, failNext)
      .then(() => res);
  };
  const callVerify = (bookingId, distanceKm, admin) => {
    const res = mockRes();
    return bookingCtrl
      .verifyTravelDistance({ params: { id: String(bookingId) }, body: { distanceKm }, user: asUser(admin, "ADMIN") }, res, failNext)
      .then(() => res);
  };

  try {
    // ── Fixtures ──
    await EventType.create({ name: `${RUN}-Active`, description: "t", active: true });
    await EventType.create({ name: `${RUN}-Inactive`, description: "t", active: false });
    if (!(await EventPricing.findOne({ key: "default" }))) {
      const d = EventPricing.DEFAULT_PRICING;
      await EventPricing.create({
        key: "default",
        servicePrices: d.servicePrices,
        additionalCookPrice: d.additionalCookPrice,
        extraHourPrices: d.extraHourPrices,
        travelSlabs: d.travelSlabs,
      });
    }
    const customer = await mkUser("cust", "CUSTOMER");
    const customer2 = await mkUser("cust2", "CUSTOMER");
    const admin = await mkUser("admin", "ADMIN");
    const cookA = await mkCook("cookA");
    const cookB = await mkCook("cookB");
    const cookC = await mkCook("cookC");
    const cookPending = await mkCook("cookP", "pending");
    const cookInactive = await mkCook("cookI", "approved", "available", "inactive");
    const notACook = customer2;

    // ── 1. Creation basics + ownership + catalogue gate ──
    const r1 = await callCreate(customer);
    check("create → 201", r1.statusCode === 201, `got ${r1.statusCode}`);
    check("distance provisional (falsy verified)", r1.body && r1.body.distanceVerified !== true);
    check("status starts pending", r1.body && r1.body.bookingStatus === "pending");
    const adminNotices = await Notification.countDocuments({ type: "event_booking_request" });
    check("admin notified on creation", adminNotices >= 1, `count=${adminNotices}`);
    const adminNotice = await Notification.findOne({ type: "event_booking_request", message: { $regex: r1.body.bookingId } });
    check(
      "admin notice carries openable booking link",
      !!adminNotice && adminNotice.link === `/event-bookings/${r1.body._id}`,
      adminNotice ? adminNotice.link : "notice not found"
    );

    const rTamper = await callCreate(customer, { customerId: String(customer2._id), cookId: String(cookA._id), bookingStatus: "confirmed", totalAmount: 1, serviceAmount: 1 });
    check("customerId tamper ignored", String(rTamper.body.customerId) === String(customer._id));
    check("cook/status/amount tamper ignored", rTamper.body.cookId == null && rTamper.body.bookingStatus === "pending" && rTamper.body.totalAmount !== 1);

    const rInactive = await callCreate(customer, { eventType: `${RUN}-Inactive` });
    check("inactive catalogue type rejected", rInactive.statusCode === 400, `got ${rInactive.statusCode}`);
    const rNewType = await EventType.create({ name: `${RUN}-Fresh`, active: true });
    void rNewType;
    const rFresh = await callCreate(customer, { eventType: `${RUN}-Fresh` });
    check("newly created active type bookable", rFresh.statusCode === 201, `got ${rFresh.statusCode}`);

    // Idempotent booking submission: sequential retry, concurrent duplicate,
    // reused key with a different payload, and genuinely separate bookings.
    const idemKey = `${RUN}-IDEM-1`;
    const idemBody = { startTime: "11:00", duration: 1, idempotencyKey: idemKey };
    const rIdem1 = await callCreate(customer, idemBody);
    const rIdem2 = await callCreate(customer, idemBody);
    check(
      "idempotent retry returns the original booking",
      rIdem1.statusCode === 201 &&
        rIdem2.statusCode === 200 &&
        String(rIdem1.body._id) === String(rIdem2.body._id),
      `codes=${rIdem1.statusCode}/${rIdem2.statusCode}`
    );
    check(
      "idempotent retry creates no duplicate",
      (await EventBooking.countDocuments({ customerId: customer._id, idempotencyKey: idemKey })) === 1
    );
    const rIdemReuse = await callCreate(customer, { ...idemBody, duration: 2 });
    check(
      "reused key with different payload is rejected",
      rIdemReuse.statusCode === 409 && rIdemReuse.body?.code === "IDEMPOTENCY_KEY_REUSED",
      `got ${rIdemReuse.statusCode}: ${rIdemReuse.body?.code}`
    );
    const concurrentKey = `${RUN}-IDEM-2`;
    const concurrentBody = { startTime: "12:00", duration: 1, idempotencyKey: concurrentKey };
    const [rC1, rC2] = await Promise.all([
      callCreate(customer, concurrentBody),
      callCreate(customer, concurrentBody),
    ]);
    check(
      "concurrent duplicate submits return one booking",
      String(rC1.body?._id) === String(rC2.body?._id) &&
        [rC1.statusCode, rC2.statusCode].sort().join("/") === "200/201" &&
        (await EventBooking.countDocuments({ customerId: customer._id, idempotencyKey: concurrentKey })) === 1,
      `codes=${rC1.statusCode}/${rC2.statusCode} ids=${rC1.body?._id}/${rC2.body?._id}`
    );
    const rIdemOtherCustomer = await callCreate(customer2, { ...idemBody, startTime: "11:15" });
    check(
      "same key for another customer is a separate booking",
      rIdemOtherCustomer.statusCode === 201 &&
        String(rIdemOtherCustomer.body._id) !== String(rIdem1.body._id),
      `got ${rIdemOtherCustomer.statusCode}`
    );
    const rSeparate = await callCreate(customer, { startTime: "11:00", duration: 1, idempotencyKey: `${idemKey}-B` });
    check(
      "different key for the same intent creates a new booking",
      rSeparate.statusCode === 201 && String(rSeparate.body._id) !== String(rIdem1.body._id),
      `got ${rSeparate.statusCode}`
    );

    // ── 2. Same-booking concurrent assignment: exactly one winner ──
    const rb = await callCreate(customer, { startTime: "09:00" });
    const targetId = rb.body._id;

    // ── 1b. Permission gate: only an admin may assign (pending booking) ──
    const pCust = await callAssignAs(rb.body._id, cookC._id, customer, "CUSTOMER");
    check("customer assign pending → 403", pCust.statusCode === 403, `got ${pCust.statusCode}`);
    const pCook = await callAssignAs(rb.body._id, cookC._id, cookB, "COOK");
    check("cook assign pending → 403", pCook.statusCode === 403, `got ${pCook.statusCode}`);
    const pDeniedDoc = await EventBooking.findById(rb.body._id);
    check(
      "denied assign leaves booking untouched (still pending, no cook)",
      pDeniedDoc.bookingStatus === "pending" && pDeniedDoc.cookId == null,
      `status=${pDeniedDoc.bookingStatus} cook=${pDeniedDoc.cookId}`
    );

    const [ca, cb] = await Promise.all([callAssign(targetId, cookA._id, admin), callAssign(targetId, cookB._id, admin)]);
    const codes = [ca.statusCode, cb.statusCode].sort();
    check("same-booking race: one 200 + one 409", JSON.stringify(codes) === JSON.stringify([200, 409]), JSON.stringify(codes));
    const finalB = await EventBooking.findById(targetId);
    const winner = ca.statusCode === 200 ? cookA : cookB;
    check("single cook recorded", String(finalB.cookId) === String(winner._id), String(finalB.cookId));
    check("no duplicate history on race", finalB.statusHistory.length === 2, `len=${finalB.statusHistory.length}`);
    check("status+history consistent", finalB.statusHistory[finalB.statusHistory.length - 1].status === finalB.bookingStatus);
    const custNotes = await Notification.countDocuments({ user: customer._id, type: "event_cook_assigned" });
    const loserNotes = await Notification.countDocuments({ user: (winner === cookA ? cookB : cookA)._id, type: "event_assignment" });
    check("loser cook got no assignment notice", loserNotes === 0, `count=${loserNotes}`);
    check("customer got exactly one assign notice (no dupes)", custNotes === 1, `count=${custNotes}`);

    // Idempotent retry: same cook again → 200, no new history/notifications.
    const histBefore = finalB.statusHistory.length;
    const rRetry = await callAssign(targetId, winner._id, admin);
    const afterRetry = await EventBooking.findById(targetId);
    check("idempotent re-assign → 200", rRetry.statusCode === 200);
    check("idempotent re-assign adds no history", afterRetry.statusHistory.length === histBefore);
    const custNotes2 = await Notification.countDocuments({ user: customer._id, type: "event_cook_assigned" });
    check("idempotent re-assign sends no dupes", custNotes2 === custNotes);

    // ── 2b. Permission gate on REASSIGN + notification openability ──
    const raCust = await callAssignAs(rb.body._id, cookC._id, customer, "CUSTOMER");
    check("customer reassign assigned → 403", raCust.statusCode === 403, `got ${raCust.statusCode}`);
    const raCook = await callAssignAs(rb.body._id, cookC._id, cookA, "COOK");
    check("cook reassign assigned → 403", raCook.statusCode === 403, `got ${raCook.statusCode}`);
    const afterDenied = await EventBooking.findById(rb.body._id);
    check(
      "denied reassign keeps original cook + status",
      String(afterDenied.cookId) === String(winner._id) && afterDenied.bookingStatus === "cook_assigned",
      `cook=${afterDenied.cookId} status=${afterDenied.bookingStatus}`
    );
    const custAssignNotice = await Notification.findOne({ user: customer._id, type: "event_cook_assigned" });
    check(
      "customer assign notice links to the booking",
      !!custAssignNotice && custAssignNotice.link === `/event-bookings/${targetId}`,
      custAssignNotice ? custAssignNotice.link : "notice not found"
    );
    const cookAssignNotice = await Notification.findOne({ user: winner._id, type: "event_assignment" });
    check(
      "cook assign notice links to the booking",
      !!cookAssignNotice && cookAssignNotice.link === `/event-bookings/${targetId}`,
      cookAssignNotice ? cookAssignNotice.link : "notice not found"
    );

    // ── 3. Overlapping bookings, same cook, concurrent: no persistent double-book ──
    const o1 = await callCreate(customer, { startTime: "10:00", duration: 2 });
    const o2 = await callCreate(customer, { startTime: "11:00", duration: 2 }); // overlaps 11:00–12:00
    const [oa, ob] = await Promise.all([
      callAssign(o1.body._id, cookA._id, admin),
      callAssign(o2.body._id, cookA._id, admin),
    ]);
    check("overlap race responses are 200/409 only", [oa.statusCode, ob.statusCode].every((c) => c === 200 || c === 409), JSON.stringify([oa.statusCode, ob.statusCode]));
    const fo1 = await EventBooking.findById(o1.body._id);
    const fo2 = await EventBooking.findById(o2.body._id);
    const live = ["pending", "cook_assigned", "confirmed", "in_progress"];
    const bothLiveOnA =
      live.includes(fo1.bookingStatus) && live.includes(fo2.bookingStatus) &&
      String(fo1.cookId) === String(cookA._id) && String(fo2.cookId) === String(cookA._id);
    check("no persistent overlapping double-book", !bothLiveOnA, `o1=${fo1.bookingStatus}/${fo1.cookId} o2=${fo2.bookingStatus}/${fo2.cookId}`);
    // Notice hygiene for the race: the reverted (losing) side must leave ZERO
    // assign notifications behind (void + retract path); the standing side
    // keeps exactly its two (customer + cook). Works for either outcome,
    // including the documented both-reverted case.
    for (const f of [fo1, fo2]) {
      const raceNotices = await Notification.countDocuments({ eventKey: { $regex: `^${f.bookingId}:assign:` } });
      const stood = f.bookingStatus === "cook_assigned" && String(f.cookId) === String(cookA._id);
      check(
        `overlap race notice hygiene (${f.bookingId})`,
        stood ? raceNotices === 2 : raceNotices === 0,
        `status=${f.bookingStatus} notices=${raceNotices}`
      );
    }

    // ── 4. Reassignment self-exclusion + non-overlap allowed ──
    const n1 = await callCreate(customer, { startTime: "14:00", duration: 2 }); // no overlap with 10–12
    const rn1 = await callAssign(n1.body._id, cookA._id, admin);
    check("non-overlapping assign allowed", rn1.statusCode === 200, `got ${rn1.statusCode} ${rn1.body && rn1.body.message}`);
    // Deterministic self-exclusion proof: reassign n1 (currently on cookA) to
    // cookC, who is free all day. Without the excludeId self-check this would
    // 409 against the booking's own window.
    const rsSelf = await callAssign(n1.body._id, cookC._id, admin);
    const rsFinal = await EventBooking.findById(n1.body._id);
    check("reassign excludes current booking (no self-conflict)", rsSelf.statusCode === 200 && String(rsFinal.cookId) === String(cookC._id), `got ${rsSelf.statusCode} ${rsSelf.body && rsSelf.body.message}`);
    const reassign = await callAssign(o1.body._id === fo1._id.toString() && fo1.cookId ? o1.body._id : o1.body._id, cookB._id, admin);
    void reassign;
    // Reassign the booking that is currently assigned (whichever state) to a free cook.
    const cur1 = await EventBooking.findById(o1.body._id);
    if (String(cur1.cookId) === String(cookA._id) && cur1.bookingStatus === "cook_assigned") {
      const rr = await callAssign(o1.body._id, cookC._id, admin);
      check("reassign live booking to other cook", rr.statusCode === 200, `got ${rr.statusCode} ${rr.body && rr.body.message}`);
    } else {
      check("reassign live booking to other cook", true, "o1 was the reverted side; covered by n1 self-exclusion test above");
    }

    // ── 5. Cook eligibility ──
    const e1 = await callCreate(customer, { startTime: "16:00", duration: 1 });
    const ei = await callAssign(e1.body._id, cookInactive._id, admin);
    check("inactive cook rejected", ei.statusCode === 400, `got ${ei.statusCode}`);
    const ep = await callAssign(e1.body._id, cookPending._id, admin);
    check("unapproved cook rejected", ep.statusCode === 400, `got ${ep.statusCode}`);
    const en = await callAssign(e1.body._id, notACook._id, admin);
    check("non-cook user rejected", en.statusCode === 400, `got ${en.statusCode}`);

    // ── 6. Status race: confirm vs cancel from cook_assigned ──
    const s1 = await callCreate(customer, { startTime: "17:00", duration: 1 });
    await callAssign(s1.body._id, cookB._id, admin);
    const before = await EventBooking.findById(s1.body._id);
    const [stConfirm, stCancel] = await Promise.all([
      callStatus(s1.body._id, "confirmed", admin),
      callCancel(s1.body._id, admin, "ADMIN"),
    ]);
    const scodes = [stConfirm.statusCode, stCancel.statusCode].sort();
    check("status race: one 200 + one 409", JSON.stringify(scodes) === JSON.stringify([200, 409]), JSON.stringify(scodes));
    const sFinal = await EventBooking.findById(s1.body._id);
    check("status race: exactly one transition applied", sFinal.statusHistory.length === before.statusHistory.length + 1, `len=${sFinal.statusHistory.length}`);
    check("status+history consistent after race", sFinal.statusHistory[sFinal.statusHistory.length - 1].status === sFinal.bookingStatus);

    // ── 7. Cancel idempotency (sequential) + terminal guards ──
    const c1 = await callCreate(customer, { startTime: "18:00", duration: 1 });
    const cc1 = await callCancel(c1.body._id, customer, "CUSTOMER");
    check("customer cancels own → 200", cc1.statusCode === 200, `got ${cc1.statusCode}`);
    const cc2 = await callCancel(c1.body._id, customer, "CUSTOMER");
    const cFinal = await EventBooking.findById(c1.body._id);
    check("sequential cancel retry → 200 idempotent", cc2.statusCode === 200);
    check("cancel retry adds no history", cFinal.statusHistory.length === cc1.body.statusHistory.length);
    const crossCancel = await callCancel(c1.body._id, customer2, "CUSTOMER");
    check("other customer cancel → 403", crossCancel.statusCode === 403, `got ${crossCancel.statusCode}`);

    // Full lifecycle → completed → cancel/status rejected.
    const l1 = await callCreate(customer, { startTime: "08:00", duration: 1 });
    await callAssign(l1.body._id, cookB._id, admin);
    await callStatus(l1.body._id, "confirmed", admin);
    await callStatus(l1.body._id, "in_progress", admin);
    const done = await callStatus(l1.body._id, "completed", admin);
    check("lifecycle reaches completed", done.statusCode === 200 && done.body.bookingStatus === "completed");
    const cancelDone = await callCancel(l1.body._id, admin, "ADMIN");
    check("completed cannot be cancelled", cancelDone.statusCode === 400, `got ${cancelDone.statusCode}`);
    const moveDone = await callStatus(l1.body._id, "cancelled", admin);
    check("completed terminal (no transitions)", moveDone.statusCode === 400, `got ${moveDone.statusCode}`);
    const skipMove = await callStatus(l1.body._id, "confirmed", admin);
    check("invalid transition rejected", skipMove.statusCode === 400, `got ${skipMove.statusCode}`);

    // ── 8. Distance verification preserves the snapshot ──
    const v1 = await callCreate(customer, { startTime: "15:00", duration: 4, distanceKm: 0 });
    const origService = v1.body.serviceAmount;
    const origCook = v1.body.additionalCookAmount;
    const origExtra = v1.body.extraHourAmount;
    // Change the pricing table AFTER booking (simulates admin price edit).
    const pdoc = await EventPricing.findOne({ key: "default" });
    pdoc.servicePrices.get("preparation_cooking").set("slot_4_5", origService + 5000);
    const slabs = pdoc.travelSlabs.map((s) => ({ maxKm: s.maxKm, charge: s.charge }));
    const idx = slabs.findIndex((s) => s.maxKm === 8);
    slabs[idx] = { maxKm: 8, charge: 111 };
    pdoc.travelSlabs = slabs;
    pdoc.markModified("servicePrices");
    await pdoc.save();
    const vv = await callVerify(v1.body._id, 7, admin);
    check("verify → 200", vv.statusCode === 200, `got ${vv.statusCode} ${vv.body && vv.body.message}`);
    check("verify keeps original service snapshot", vv.body.serviceAmount === origService, `${vv.body.serviceAmount} vs ${origService}`);
    check("verify keeps cook/extra snapshot", vv.body.additionalCookAmount === origCook && vv.body.extraHourAmount === origExtra);
    check("verify uses current travel slab", vv.body.travelCharge === 111, `got ${vv.body.travelCharge}`);
    check(
      "verify total = snapshot + new travel",
      vv.body.totalAmount === Math.round(origService + origCook + origExtra + 111),
      `got ${vv.body.totalAmount}`
    );
    check("verify marks distanceVerified", vv.body.distanceVerified === true);
    const vTerm = await callVerify(c1.body._id, 5, admin);
    check("verify on cancelled → 400", vTerm.statusCode === 400, `got ${vTerm.statusCode}`);

    // ── 9. Pricing optimistic concurrency (live model) ──
    // Stale quote protection: a version captured before an admin price edit
    // must be rejected with the refreshed server quote, a current version
    // must succeed, and client-supplied totals must never be stored.
    const staleDoc = await EventPricing.findOne({ key: "default" });
    const staleVersion = staleDoc.__v;
    const staleBefore = staleDoc.servicePrices.get("preparation_cooking").get("slot_4_5");
    staleDoc.servicePrices.get("preparation_cooking").set("slot_4_5", staleBefore + 500);
    staleDoc.markModified("servicePrices");
    await staleDoc.save();
    const currentPricingDoc = await EventPricing.findOne({ key: "default" });
    const currentVersion = currentPricingDoc.__v;
    const staleRes = await callCreate(customer, { startTime: "11:30", duration: 4, pricingVersion: staleVersion });
    check(
      "stale pricing version rejected",
      staleRes.statusCode === 409 && staleRes.body?.code === "PRICING_CHANGED",
      `got ${staleRes.statusCode}: ${staleRes.body?.code}`
    );
    check(
      "stale response carries refreshed quote",
      staleRes.body?.quote?.pricingVersion === currentVersion &&
        staleRes.body?.quote?.serviceAmount === staleBefore + 500,
      JSON.stringify(staleRes.body?.quote)
    );
    check(
      "stale quote creates no booking",
      (await EventBooking.countDocuments({ customerId: customer._id, startTime: "11:30" })) === 0
    );
    const freshVersionRes = await callCreate(customer, { startTime: "11:30", duration: 4, pricingVersion: currentVersion });
    check(
      "current pricing version creates booking",
      freshVersionRes.statusCode === 201 &&
        freshVersionRes.body?.pricingVersion === currentVersion &&
        freshVersionRes.body?.serviceAmount === staleBefore + 500,
      `got ${freshVersionRes.statusCode} v=${freshVersionRes.body?.pricingVersion}`
    );
    const tamperVersionRes = await callCreate(customer, {
      startTime: "11:45",
      duration: 4,
      pricingVersion: currentVersion,
      totalAmount: 1,
      serviceAmount: 1,
      travelCharge: 0,
    });
    check(
      "client totals ignored with current quote",
      tamperVersionRes.statusCode === 201 &&
        tamperVersionRes.body?.serviceAmount === freshVersionRes.body?.serviceAmount &&
        tamperVersionRes.body?.totalAmount === freshVersionRes.body?.totalAmount &&
        tamperVersionRes.body?.totalAmount !== 1,
      `status=${tamperVersionRes.statusCode} total=${tamperVersionRes.body?.totalAmount}`
    );

    const pa = await EventPricing.findOne({ key: "default" });
    const pb = await EventPricing.findOne({ key: "default" });
    pa.additionalCookPrice = 401;
    await pa.save();
    pb.additionalCookPrice = 402;
    try {
      await pb.save();
      check("concurrent pricing save → VersionError", false, "second save succeeded");
    } catch (e) {
      check("concurrent pricing save → VersionError", e.name === "VersionError", e.name);
    }

    // ── 10. Backfill logic (legacy doc without the flag) ──
    await EventBooking.collection.insertOne({
      bookingId: `${RUN}-LEGACY`,
      customerId: customer._id,
      eventType: `${RUN}-Active`,
      eventDate: new Date(DAY),
      startTime: "10:00",
      duration: 2,
      guestCount: 5,
      address: "legacy",
      menu: "legacy",
      serviceType: "preparation_cooking",
      bookingStatus: "pending",
      statusHistory: [],
    });
    const legacyBefore = await EventBooking.findOne({ bookingId: `${RUN}-LEGACY` });
    check("legacy doc reads falsy flag (provisional)", legacyBefore.distanceVerified !== true);
    const back = await EventBooking.updateMany({ distanceVerified: { $exists: false } }, { $set: { distanceVerified: false } });
    void back;
    const legacyAfter = await EventBooking.findOne({ bookingId: `${RUN}-LEGACY` });
    check("backfill sets false without touching data", legacyAfter.distanceVerified === false && legacyAfter.totalAmount === legacyBefore.totalAmount);
    // Backfill idempotency: second run matches zero and modifies nothing.
    const back2 = await EventBooking.updateMany({ distanceVerified: { $exists: false } }, { $set: { distanceVerified: false } });
    check("backfill idempotent (rerun modifies 0)", (back2.modifiedCount ?? 0) === 0, `modified=${back2.modifiedCount}`);
    const verifiedCount = await EventBooking.countDocuments({ distanceVerified: true });
    check("backfill never touches verified bookings", verifiedCount >= 1, `verified=${verifiedCount}`);

    // ── 11. Outbox: fail → retry → delivered, idempotent, crash-safe ──
    const EventOutbox = require("./models/EventOutbox");
    const { processEventOutbox, deliverOutboxEvent, enqueueEventOutbox, outboxSummary } = require("./utils/eventOutbox");
    const badKey = `${RUN}-OB:fail-retry:1`;
    const { ObjectId } = require("mongoose").Types;
    const ghostUser = new ObjectId();
    await enqueueEventOutbox({
      eventKey: badKey,
      bookingPublicId: `${RUN}-OB`,
      action: "status",
      recipients: [{ user: ghostUser, type: "event_status", message: "x" }],
    });
    // Crash simulation: event committed (enqueued) but never delivered.
    let obDoc = await EventOutbox.findOne({ eventKey: badKey });
    check("outbox holds undelivered event after commit", obDoc && obDoc.status === "pending");
    // Temporary failure: point the recipient at an invalid notification type
    // (fails Notification validation on delivery) → stays queued with attempts.
    await EventOutbox.findOneAndUpdate({ eventKey: badKey }, { $set: { recipients: [{ user: customer._id, type: "__bogus__", message: "x" }] } });
    const w1 = await processEventOutbox({ limit: 5, workerId: "t1" });
    obDoc = await EventOutbox.findOne({ eventKey: badKey });
    check("failed delivery stays pending (not lost)", obDoc.status === "pending" && obDoc.attempts >= 1, `status=${obDoc.status} attempts=${obDoc.attempts}`);
    check("failure recorded without secrets", typeof obDoc.lastError === "string" && obDoc.lastError.length > 0 && !/MONGODB_URI|Bearer/i.test(obDoc.lastError));
    void w1;
    // Fix the recipient (ops recovery) and fast-forward past the backoff →
    // retry delivers exactly once.
    await EventOutbox.findOneAndUpdate(
      { eventKey: badKey },
      { $set: { recipients: [{ user: customer._id, type: "event_status", message: "retry-ok" }], nextRetryAt: new Date(Date.now() - 1000) } }
    );
    const w2 = await processEventOutbox({ limit: 5, workerId: "t2" });
    void w2;
    obDoc = await EventOutbox.findOne({ eventKey: badKey });
    check("retry delivers and marks sent", obDoc.status === "sent");
    const nCount = await Notification.countDocuments({ eventKey: badKey });
    check("exactly one notification delivered", nCount === 1, `count=${nCount}`);
    // Repeated processing never duplicates (idempotent redelivery).
    await processEventOutbox({ limit: 5, workerId: "t3" });
    await deliverOutboxEvent(await EventOutbox.findOne({ eventKey: badKey }));
    const nCount2 = await Notification.countDocuments({ eventKey: badKey });
    check("reprocessing does not duplicate", nCount2 === 1, `count=${nCount2}`);
    // Only the intended recipient received it.
    const who = await Notification.find({ eventKey: badKey }).select("user");
    check("only intended recipient notified", who.length === 1 && String(who[0].user) === String(customer._id));
    // Enqueue is idempotent on the same key (transaction retry safety).
    const dup = await enqueueEventOutbox({ eventKey: badKey, bookingPublicId: `${RUN}-OB`, action: "status", recipients: [] });
    check("duplicate enqueue returns existing (no dup event)", String(dup._id) === String(obDoc._id));
    const summ = await outboxSummary();
    check("outbox summary served", typeof summ.pending === "number" && typeof summ.dead === "number");

    // ── 12. Cook-eligibility flips: inactive / unapproved / unavailable ──
    const T = bookingCtrl._test;
    const eligFlip = await mkCook("cookFlip");
    const fx = await callCreate(customer, { startTime: "07:00", duration: 1 });
    check("eligible cook passes recheck helper", (await T.checkCookEligible(eligFlip._id)).ok === true);
    await User.findByIdAndUpdate(eligFlip._id, { status: "inactive" });
    check("deactivated cook fails recheck", (await T.checkCookEligible(eligFlip._id)).ok === false);
    const fxR = await callAssign(fx.body._id, eligFlip._id, admin);
    check("assign to deactivated cook → 400", fxR.statusCode === 400, `got ${fxR.statusCode}`);
    await User.findByIdAndUpdate(eligFlip._id, { status: "active" });
    await CookProfile.findOneAndUpdate({ user: eligFlip._id }, { approvalStatus: "rejected" });
    check("unapproved cook fails recheck", (await T.checkCookEligible(eligFlip._id)).ok === false);
    const fxR2 = await callAssign(fx.body._id, eligFlip._id, admin);
    check("assign to unapproved cook → 400", fxR2.statusCode === 400, `got ${fxR2.statusCode}`);
    await CookProfile.findOneAndUpdate({ user: eligFlip._id }, { approvalStatus: "approved", availabilityStatus: "unavailable", unavailableDate: "2099-12-31" });
    check("unavailable cook fails recheck", (await T.checkCookEligible(eligFlip._id)).ok === false);
    const fxR3 = await callAssign(fx.body._id, eligFlip._id, admin);
    check("assign to unavailable cook → 400", fxR3.statusCode === 400, `got ${fxR3.statusCode}`);

    // ── 13. Verify races lifecycle + repeated verify idempotency ──
    const rv = await callCreate(customer, { startTime: "13:00", duration: 2, distanceKm: 1 });
    await callAssign(rv.body._id, cookB._id, admin);
    const [vWin, cWin] = await Promise.all([
      callVerify(rv.body._id, 6, admin),
      callCancel(rv.body._id, admin, "ADMIN"),
    ]);
    const vCodes = [vWin.statusCode, cWin.statusCode].sort();
    check("verify-vs-cancel race: no 500, no silent overwrite", vCodes.every((c) => [200, 400, 409].includes(c)), JSON.stringify(vCodes));
    const rvFinal = await EventBooking.findById(rv.body._id);
    const consistent =
      (rvFinal.bookingStatus === "cancelled" && rvFinal.distanceVerified === false) ||
      (rvFinal.bookingStatus !== "cancelled" && rvFinal.distanceVerified === true) ||
      (rvFinal.bookingStatus === "cancelled" && rvFinal.distanceVerified === true);
    // Either order is valid; what must hold: status+history agree and the
    // loser did not clobber the winner (version guard).
    check("verify-vs-cancel leaves consistent state", consistent && rvFinal.statusHistory[rvFinal.statusHistory.length - 1].status === rvFinal.bookingStatus);
    const rv2 = await callCreate(customer, { startTime: "12:00", duration: 2, distanceKm: 2 });
    const vv1 = await callVerify(rv2.body._id, 6, admin);
    const vv1HistLen = vv1.body.statusHistory.length;
    const vv2 = await callVerify(rv2.body._id, 6, admin);
    check("repeated verify → 200 both times", vv1.statusCode === 200 && vv2.statusCode === 200);
    check("repeated verify stable amounts", vv1.body.totalAmount === vv2.body.totalAmount && vv1.body.travelCharge === vv2.body.travelCharge);
    const rv2Final = await EventBooking.findById(rv2.body._id);
    check("repeated verify adds no status history", rv2Final.statusHistory.length === vv1HistLen, `len=${rv2Final.statusHistory.length} vs ${vv1HistLen}`);

    // ── 14. Catalogue delete/deactivate/reactivate behaviour ──
    const delType = await EventType.create({ name: `${RUN}-Doomed`, active: true });
    await EventType.findByIdAndDelete(delType._id);
    const rDeleted = await callCreate(customer, { eventType: `${RUN}-Doomed` });
    check("deleted catalogue type rejected", rDeleted.statusCode === 400, `got ${rDeleted.statusCode}`);
    await EventType.findOneAndUpdate({ name: `${RUN}-Fresh` }, { active: false });
    const rDeact = await callCreate(customer, { eventType: `${RUN}-Fresh` });
    check("deactivated type rejected", rDeact.statusCode === 400, `got ${rDeact.statusCode}`);
    await EventType.findOneAndUpdate({ name: `${RUN}-Fresh` }, { active: true });
    const rReact = await callCreate(customer, { eventType: `${RUN}-Fresh` });
    check("reactivated type bookable again", rReact.statusCode === 201, `got ${rReact.statusCode}`);
    // History preserved: earlier booking keeps its label after deactivation.
    const kept = await EventBooking.findById(rFresh.body._id);
    check("existing bookings keep label after catalogue change", kept && kept.eventType === `${RUN}-Fresh`);

    // ── 15. Outbox void semantics: a superseded event must never deliver ──
    const EventOutbox2 = require("./models/EventOutbox");
    const { deliverOutboxEvent: deliver2, enqueueEventOutbox: enqueue2 } = require("./utils/eventOutbox");

    // 15a. A dead (voided) event is skipped on delivery and stays dead.
    const deadKey = `${RUN}-OB:void:1`;
    await enqueue2({ eventKey: deadKey, bookingPublicId: `${RUN}-OB`, action: "assign", recipients: [{ user: customer._id, type: "event_cook_assigned", message: "should never deliver" }] });
    await EventOutbox2.updateOne({ eventKey: deadKey }, { $set: { status: "dead", lastError: "superseded: test" } });
    const dSkip = await deliver2(await EventOutbox2.findOne({ eventKey: deadKey }));
    check("dead event skipped by delivery", dSkip && dSkip.skipped === true && dSkip.dead === true, JSON.stringify(dSkip));
    check("dead event delivered nothing", (await Notification.countDocuments({ eventKey: deadKey })) === 0);
    check("dead event stays dead after deliver attempt", (await EventOutbox2.findOne({ eventKey: deadKey })).status === "dead");

    // 15b. A failed delivery must NOT resurrect a voided event to pending.
    const deadFailKey = `${RUN}-OB:void-fail:1`;
    await enqueue2({ eventKey: deadFailKey, bookingPublicId: `${RUN}-OB`, action: "assign", recipients: [{ user: customer._id, type: "__bogus__", message: "x" }] });
    await EventOutbox2.updateOne({ eventKey: deadFailKey }, { $set: { status: "dead" } });
    await deliver2(await EventOutbox2.findOne({ eventKey: deadFailKey }));
    const deadFailDoc = await EventOutbox2.findOne({ eventKey: deadFailKey });
    check("failed delivery does not resurrect dead event", deadFailDoc.status === "dead", `status=${deadFailDoc.status}`);

    // 15c. Mid-flight void race: worker reads pending, a revert voids the
    // event (and its deleteMany lands) BEFORE the worker inserts, then the
    // worker inserts and tries to mark sent. The mark-sent must detect the
    // void, retract the just-inserted rows, and leave the event dead — so a
    // reverted assignment never leaves a success notice behind.
    const raceKey = `${RUN}-OB:void-race:1`;
    await enqueue2({ eventKey: raceKey, bookingPublicId: `${RUN}-OB`, action: "assign", recipients: [{ user: customer._id, type: "event_cook_assigned", message: "racing notice" }] });
    const origExists = Notification.exists;
    let existsCalls = 0;
    Notification.exists = async function (q) {
      existsCalls += 1;
      // First exists() call runs right after deliverOutboxEvent's status read:
      // simulate the revert's void (status → dead) landing in that window.
      if (existsCalls === 1) {
        await EventOutbox2.updateOne({ eventKey: raceKey }, { $set: { status: "dead", lastError: "superseded: race" } });
      }
      return origExists.call(Notification, q);
    };
    let raceRes;
    try {
      raceRes = await deliver2(await EventOutbox2.findOne({ eventKey: raceKey }));
    } finally {
      Notification.exists = origExists;
    }
    check("mid-flight void: worker reports not delivered", raceRes && raceRes.delivered === false, JSON.stringify(raceRes));
    check("mid-flight void: inserted notice retracted", (await Notification.countDocuments({ eventKey: raceKey })) === 0);
    check("mid-flight void: event stays dead", (await EventOutbox2.findOne({ eventKey: raceKey })).status === "dead");

    // ── 16. Notification recipients per state change ──
    const admin2 = await mkUser("admin2", "ADMIN");
    // 16a. Booking creation notifies every active admin.
    const nA = await callCreate(customer, { startTime: "06:00", duration: 1 });
    const adminsNotified = await Notification.find({ type: "event_booking_request" }).select("user");
    const adminIds = new Set(adminsNotified.map((n) => String(n.user)));
    check("creation notifies all active admins", adminIds.has(String(admin._id)) && adminIds.has(String(admin2._id)), JSON.stringify([...adminIds]));

    // 16b. Assignment notifies exactly the customer and the winning cook.
    const nB = await callCreate(customer, { startTime: "19:00", duration: 1 });
    const asg = await callAssign(nB.body._id, cookC._id, admin);
    check("assign notification setup ok", asg.statusCode === 200, `got ${asg.statusCode}`);
    const asgKey = `${nB.body.bookingId}:assign:1`;
    const asgNotices = await Notification.find({ eventKey: asgKey }).select("user type");
    const asgUsers = asgNotices.map((n) => `${String(n.user)}:${n.type}`).sort();
    check(
      "assign notifies customer+cook with right types",
      asgUsers.length === 2 &&
        asgUsers.some((u) => u === `${String(customer._id)}:event_cook_assigned`) &&
        asgUsers.some((u) => u === `${String(cookC._id)}:event_assignment`),
      JSON.stringify(asgUsers)
    );

    // 16c. Status transition notifies customer + assigned cook.
    await callStatus(nB.body._id, "confirmed", admin);
    const stKey = `${nB.body.bookingId}:status:2`;
    const stNotices = await Notification.find({ eventKey: stKey }).select("user type");
    check(
      "status change notifies customer+cook",
      stNotices.length === 2 &&
        stNotices.some((n) => String(n.user) === String(customer._id) && n.type === "event_status") &&
        stNotices.some((n) => String(n.user) === String(cookC._id) && n.type === "event_status"),
      JSON.stringify(stNotices.map((n) => `${String(n.user)}:${n.type}`))
    );

    // 16d. Admin cancel notifies customer + cook; customer cancel notifies cook only.
    const nC = await callCreate(customer, { startTime: "20:00", duration: 1 });
    await callAssign(nC.body._id, cookB._id, admin);
    const adminCancel = await callCancel(nC.body._id, admin, "ADMIN");
    check("admin cancel ok", adminCancel.statusCode === 200, `got ${adminCancel.statusCode}`);
    const cxKey = `${nC.body.bookingId}:cancel:2`;
    const cxNotices = await Notification.find({ eventKey: cxKey }).select("user type");
    check(
      "admin cancel notifies customer+cook",
      cxNotices.length === 2 &&
        cxNotices.some((n) => String(n.user) === String(customer._id) && n.type === "event_cancelled") &&
        cxNotices.some((n) => String(n.user) === String(cookB._id) && n.type === "event_cancelled"),
      JSON.stringify(cxNotices.map((n) => `${String(n.user)}:${n.type}`))
    );
    const nD = await callCreate(customer, { startTime: "21:00", duration: 1 });
    await callAssign(nD.body._id, cookB._id, admin);
    const custCancel = await callCancel(nD.body._id, customer, "CUSTOMER");
    check("customer cancel ok", custCancel.statusCode === 200, `got ${custCancel.statusCode}`);
    const ccKey = `${nD.body.bookingId}:cancel:2`;
    const ccNotices = await Notification.find({ eventKey: ccKey }).select("user type");
    const ccAdminIds = new Set((await User.find({ role: "ADMIN", status: "active" }).select("_id")).map((a) => String(a._id)));
    const ccUsers = new Set(ccNotices.map((n) => String(n.user)));
    check(
      "customer cancel notifies cook and every active admin",
      ccUsers.has(String(cookB._id)) &&
        [...ccAdminIds].every((id) => ccUsers.has(id)) &&
        !ccUsers.has(String(customer._id)) &&
        ccNotices.every((n) => n.type === "event_cancelled"),
      JSON.stringify(ccNotices.map((n) => `${String(n.user)}:${n.type}`))
    );

    // ── 17. Status transition cannot overwrite a newer state (stale → 409) ──
    // 16e. Audit trail records the authenticated actor for admin/customer actions.
    const ccDoc = await EventBooking.findById(nD.body._id);
    const ccLast = ccDoc.statusHistory[ccDoc.statusHistory.length - 1];
    check(
      "cancel history records customer actor",
      String(ccLast.actor) === String(customer._id) && ccLast.actorRole === "CUSTOMER",
      `${ccLast.actorRole}:${ccLast.actor}`
    );
    const nBAfterStatus = await EventBooking.findById(nB.body._id);
    const stLast = nBAfterStatus.statusHistory[nBAfterStatus.statusHistory.length - 1];
    check(
      "status history records admin actor",
      String(stLast.actor) === String(admin._id) && stLast.actorRole === "ADMIN",
      `${stLast.actorRole}:${stLast.actor}`
    );

    // 16f. Unsupported additional-cook fulfillment must not be sold.
    const acRes = await callCreate(customer, { startTime: "06:00", duration: 1, additionalCook: 1 });
    check(
      "additional cooks rejected until fulfillment exists",
      acRes.statusCode === 400 && /Additional cooks are not available/.test(acRes.body?.message || ""),
      `got ${acRes.statusCode}: ${acRes.body?.message}`
    );

    // 16g. Event assignment must respect regular CookMitra bookings.
    const regularCook = await mkCook("regularClash");
    const regEvent = await callCreate(customer, { startTime: "09:00", duration: 2 });
    const [ry, rm, rd] = DAY.split("-").map(Number);
    await Booking.create({
      customer: customer._id,
      cook: regularCook._id,
      serviceType: "cook_for_me",
      date: new Date(ry, rm - 1, rd, 12, 0, 0, 0),
      startTime: "09:30",
      endTime: "11:00",
      address: "1 Test St",
      status: "accepted",
    });
    const regAssign = await callAssign(regEvent.body._id, regularCook._id, admin);
    check(
      "event assignment blocked by overlapping regular booking",
      regAssign.statusCode === 409 && /regular booking/.test(regAssign.body?.message || ""),
      `got ${regAssign.statusCode}: ${regAssign.body?.message}`
    );

    // 16h. Blocked dates and configured weekly hours are enforced.
    const blockedCook = await mkCook("blockedDate");
    await CookProfile.updateOne({ user: blockedCook._id }, { $set: { "schedule.blockedDates": [DAY] } });
    const blockEvent = await callCreate(customer, { startTime: "12:00", duration: 1 });
    const blockAssign = await callAssign(blockEvent.body._id, blockedCook._id, admin);
    check(
      "event assignment respects blocked date",
      blockAssign.statusCode === 409 && /unavailable on that date/.test(blockAssign.body?.message || ""),
      `got ${blockAssign.statusCode}: ${blockAssign.body?.message}`
    );

    const hoursCook = await mkCook("weeklyHours");
    const weekday = new Date(ry, rm - 1, rd).getDay();
    await CookProfile.updateOne(
      { user: hoursCook._id },
      { $set: { "schedule.weekly": [{ day: weekday, startTime: "09:00", endTime: "12:00", enabled: true }] } }
    );
    const insideEvent = await callCreate(customer, { startTime: "10:00", duration: 1 });
    const insideAssign = await callAssign(insideEvent.body._id, hoursCook._id, admin);
    check("event inside configured weekly hours allowed", insideAssign.statusCode === 200, `got ${insideAssign.statusCode}`);
    const outsideEvent = await callCreate(customer, { startTime: "13:00", duration: 1 });
    const outsideAssign = await callAssign(outsideEvent.body._id, hoursCook._id, admin);
    check(
      "event outside configured weekly hours blocked",
      outsideAssign.statusCode === 409 && /working hours/.test(outsideAssign.body?.message || ""),
      `got ${outsideAssign.statusCode}: ${outsideAssign.body?.message}`
    );

    // 16i. Regular booking acceptance must respect assigned event bookings.
    const crossCook = await mkCook("crossModule");
    const crossEvent = await callCreate(customer, { startTime: "14:00", duration: 2 });
    const crossAssign = await callAssign(crossEvent.body._id, crossCook._id, admin);
    check("cross-module setup event assigned", crossAssign.statusCode === 200, `got ${crossAssign.statusCode}`);
    const regularRequest = await Booking.create({
      customer: customer._id,
      serviceType: "cook_for_me",
      date: new Date(ry, rm - 1, rd, 12, 0, 0, 0),
      startTime: "14:30",
      endTime: "15:30",
      address: "1 Test St",
      status: "requested",
      requestExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    const { acceptBookingForCook } = require("./services/bookingAcceptService");
    let crossErr = null;
    try {
      await acceptBookingForCook({ bookingId: regularRequest._id, cookId: crossCook._id, source: "website" });
    } catch (e) {
      crossErr = e;
    }
    const crossAfter = await Booking.findById(regularRequest._id).select("status");
    check(
      "regular acceptance blocked by assigned event",
      crossErr?.statusCode === 409 && /slot/i.test(crossErr.message || "") && crossAfter.status === "requested",
      `err=${crossErr?.statusCode}:${crossErr?.message} status=${crossAfter.status}`
    );

    const nE = await callCreate(customer, { startTime: "22:00", duration: 1 });
    await callAssign(nE.body._id, cookB._id, admin);
    // Snapshot the booking at cook_assigned, then move it forward, then attempt
    // a stale conditional update with the OLD version: must land nowhere and
    // must not clobber the newer state (the HTTP path maps this miss to 409).
    const snap = await EventBooking.findById(nE.body._id);
    await callStatus(nE.body._id, "confirmed", admin);
    const staleUpdate = await EventBooking.findOneAndUpdate(
      { _id: nE.body._id, __v: snap.__v, bookingStatus: "cook_assigned" },
      { $set: { bookingStatus: "cancelled" }, $inc: { __v: 1 } },
      { new: true }
    );
    check("stale version update lands nowhere", staleUpdate === null);
    const nEFinal = await EventBooking.findById(nE.body._id);
    check("newer state preserved after stale attempt", nEFinal.bookingStatus === "confirmed", `status=${nEFinal.bookingStatus}`);

    // ══════════════════════════════════════════════════════════════════════
    // TARGETED PASS (tasks 1–8): eligibility/catalogue guards, failed-revert
    // visibility, verify races, background worker, seed/backfill safety.
    // ══════════════════════════════════════════════════════════════════════

    const istDayNow = () => {
      const ist = new Date(Date.now() + (new Date().getTimezoneOffset() + 330) * 60000);
      const p = (n) => String(n).padStart(2, "0");
      return `${ist.getFullYear()}-${p(ist.getMonth() + 1)}-${p(ist.getDate())}`;
    };

    // ── 18. Eligibility flips between the pre-check and the guarded commit ──
    // The plain-read pre-check passes, then the cook's eligibility is revoked
    // before the in-transaction conditional guard runs. All three variants
    // must abort with 400 + the authoritative reason and leave NO side
    // effects: booking untouched, no cook_assigned history, no outbox event,
    // zero notifications.
    const flipVariants = [
      {
        label: "account deactivated",
        mk: () => mkCook("flipA"),
        flip: (u) => User.updateOne({ _id: u._id }, { $set: { status: "inactive" } }),
        msgRe: /not active/i,
      },
      {
        label: "approval revoked",
        mk: () => mkCook("flipB"),
        flip: (u) => CookProfile.updateOne({ user: u._id }, { $set: { approvalStatus: "rejected" } }),
        msgRe: /verified cooks/i,
      },
      {
        label: "toggled unavailable today",
        mk: () => mkCook("flipC"),
        flip: (u) =>
          CookProfile.updateOne(
            { user: u._id },
            { $set: { availabilityStatus: "unavailable", unavailableDate: istDayNow() } }
          ),
        msgRe: /unavailable/i,
      },
    ];
    let flipN = 0;
    for (const v of flipVariants) {
      flipN += 1;
      const flipCook = await v.mk();
      const fb = await callCreate(customer, { startTime: "07:00", duration: 1 });
      const origFlipFind = EventBooking.find.bind(EventBooking);
      let flipped = false;
      // findEventOverlap's find runs after checkCookEligible and before the
      // guarded commit — the exact window this guard must close.
      EventBooking.find = () => ({
        select: async () => {
          if (!flipped) {
            flipped = true;
            await v.flip(flipCook);
          }
          return [];
        },
      });
      let fres;
      try {
        fres = await callAssign(fb.body._id, flipCook._id, admin);
      } finally {
        EventBooking.find = origFlipFind;
      }
      const fdoc = await EventBooking.findById(fb.body._id);
      const fNotices = await Notification.countDocuments({ eventKey: { $regex: `^${fdoc.bookingId}:assign:` } });
      const fOutbox = await EventOutbox.countDocuments({ bookingPublicId: fdoc.bookingId, action: "assign" });
      const fHist = (fdoc.statusHistory || []).map((h) => h.status);
      check(
        `18.${flipN} eligibility flip (${v.label}) → 400`,
        fres.statusCode === 400,
        `got ${fres.statusCode} ${fres.body && fres.body.message}`
      );
      check(
        `18.${flipN} message reflects authoritative reason`,
        v.msgRe.test((fres.body && fres.body.message) || ""),
        fres.body && fres.body.message
      );
      check(
        `18.${flipN} booking untouched (pending, no cook)`,
        fdoc.bookingStatus === "pending" && fdoc.cookId == null,
        `status=${fdoc.bookingStatus} cook=${fdoc.cookId}`
      );
      check(`18.${flipN} no cook_assigned history entry`, !fHist.includes("cook_assigned"), fHist.join(">"));
      check(
        `18.${flipN} no assign outbox event and zero notices`,
        fOutbox === 0 && fNotices === 0,
        `outbox=${fOutbox} notices=${fNotices}`
      );
    }

    // ── 19. Failed revert (booking moved between assign commit and revert) ──
    // The post-update overlap re-check finds a clash, but the conditional
    // revert misses because the booking moved concurrently (stubbed). The
    // assignment IS the DB truth: its notices still go out, the conflict is
    // flagged durably (revert_failed outbox row + ACTION NEEDED admin
    // notice), and outboxSummary exposes it via `flagged`.
    {
      const revCook = await mkCook("revertF");
      const rbk = await callCreate(customer, { startTime: "20:00", duration: 2 });
      const origRevFind = EventBooking.find.bind(EventBooking);
      const origRevFOU = EventBooking.findOneAndUpdate.bind(EventBooking);
      let revFinds = 0;
      // Pre-check sees no clash (so the mutation runs); the post-update
      // re-check sees a synthetic overlapping booking that "appeared" in
      // between — the race this path exists for.
      EventBooking.find = () => ({
        select: async () => {
          revFinds += 1;
          if (revFinds >= 2) {
            const [y, m, d] = DAY.split("-").map(Number);
            return [
              {
                eventDate: new Date(y, m - 1, d, 12, 0, 0, 0),
                startTime: "20:30",
                duration: 1,
                extraHours: 0,
                bookingId: "EVT-SYNTH-CLASH",
              },
            ];
          }
          return [];
        },
      });
      // The revert's conditional update misses (the booking moved on).
      // Distinguish it from the assign commit: the revert filter carries an
      // exact string bookingStatus + cookId; the assign filter uses $in.
      EventBooking.findOneAndUpdate = (filter, ...rest) => {
        if (filter && typeof filter.bookingStatus === "string" && filter.cookId) {
          return Promise.resolve(null);
        }
        return origRevFOU(filter, ...rest);
      };
      let revRes;
      try {
        revRes = await callAssign(rbk.body._id, revCook._id, admin);
      } finally {
        EventBooking.find = origRevFind;
        EventBooking.findOneAndUpdate = origRevFOU;
      }
      const revDoc = await EventBooking.findById(rbk.body._id);
      check(
        "19 failed revert → 409 mentioning the public booking id",
        revRes.statusCode === 409 && String((revRes.body && revRes.body.message) || "").includes(revDoc.bookingId),
        `got ${revRes.statusCode}: ${revRes.body && revRes.body.message}`
      );
      check(
        "19 assignment stands (DB truth) after failed revert",
        revDoc.bookingStatus === "cook_assigned" && String(revDoc.cookId) === String(revCook._id),
        `status=${revDoc.bookingStatus} cook=${revDoc.cookId}`
      );
      const flagRow = await EventOutbox.findOne({ eventKey: `${revDoc.bookingId}:revert-failed` });
      check(
        "19 revert-failure outbox row persisted",
        !!flagRow && flagRow.action === "revert_failed",
        flagRow ? `status=${flagRow.status}` : "missing"
      );
      const actNotices = await Notification.countDocuments({
        type: "general",
        message: new RegExp(`ACTION NEEDED.*${revDoc.bookingId}`),
      });
      check("19 admins got ACTION NEEDED notice", actNotices >= 1, `count=${actNotices}`);
      const revAssignNotices = await Notification.countDocuments({
        eventKey: { $regex: `^${revDoc.bookingId}:assign:` },
      });
      check(
        "19 standing assignment still notified both sides",
        revAssignNotices === 2,
        `count=${revAssignNotices}`
      );
      const revSummary = await outboxSummary();
      check("19 outboxSummary exposes flagged ≥ 1", revSummary.flagged >= 1, JSON.stringify(revSummary));
    }

    // ── 20. Catalogue deactivation mid-create vs after the booking exists ──
    {
      const flipType = await EventType.create({ name: `${RUN}-Flippable`, active: true });
      const reqBefore = await EventOutbox.countDocuments({ action: "request" });
      const origEPF = EventPricing.findOne.bind(EventPricing);
      // calculateEventPrice's pricing fetch runs between the catalogue read
      // and the guarded commit — hook it to deactivate the type mid-flight.
      EventPricing.findOne = function (...args) {
        const q = origEPF(...args);
        const origLean = q.lean.bind(q);
        q.lean = async () => {
          await EventType.updateOne({ _id: flipType._id }, { $set: { active: false } });
          return origLean();
        };
        return q;
      };
      let cflRes;
      try {
        cflRes = await callCreate(customer, { eventType: `${RUN}-Flippable` });
      } finally {
        EventPricing.findOne = origEPF;
      }
      const reqAfter = await EventOutbox.countDocuments({ action: "request" });
      check(
        "20 mid-create catalogue flip → 400 (same honest message)",
        cflRes.statusCode === 400 && /no longer available/.test((cflRes.body && cflRes.body.message) || ""),
        `got ${cflRes.statusCode}: ${cflRes.body && cflRes.body.message}`
      );
      const leftover = await EventBooking.countDocuments({ eventType: `${RUN}-Flippable` });
      check("20 no booking created", leftover === 0, `count=${leftover}`);
      check("20 no request outbox enqueued", reqAfter === reqBefore, `${reqBefore}→${reqAfter}`);
      // Benign case by design: a type deactivated AFTER its booking exists
      // never invalidates history — the booking stays assignable. 12:30–13:30
      // is provably free for cookC (who may hold 10–12, 14–16 and 19–20).
      const histType = await EventType.create({ name: `${RUN}-Hist`, active: true });
      const hb = await callCreate(customer, { eventType: `${RUN}-Hist`, startTime: "12:30", duration: 1 });
      await EventType.updateOne({ _id: histType._id }, { $set: { active: false } });
      const ha = await callAssign(hb.body._id, cookC._id, admin);
      check(
        "20 post-creation deactivation does not invalidate history",
        hb.statusCode === 201 && ha.statusCode === 200,
        `create=${hb.statusCode} assign=${ha.statusCode}`
      );
    }

    // ── 21. Distance verification races: double-verify + verify-vs-status ──
    {
      const vb = await callCreate(customer, { startTime: "18:00", duration: 2, distanceKm: 7 });
      const [v1, v2] = await Promise.all([
        callVerify(vb.body._id, 7, admin),
        callVerify(vb.body._id, 7, admin),
      ]);
      const vCodes = [v1.statusCode, v2.statusCode];
      check(
        "21 double-verify: codes ⊆ {200,409}, no server errors",
        vCodes.every((c) => c === 200 || c === 409),
        JSON.stringify(vCodes)
      );
      const vfinal = await EventBooking.findById(vb.body._id);
      const vExp = Math.round(
        Number(vfinal.serviceAmount || 0) +
          Number(vfinal.additionalCookAmount || 0) +
          Number(vfinal.extraHourAmount || 0) +
          Number(vfinal.travelCharge || 0)
      );
      // Note: an earlier suite section customizes the travel slabs, so the
      // slab value itself is not pinned here — the invariant is: at least one
      // verify won, the booking is marked verified, and the stored breakdown
      // re-sums exactly to the stored total.
      check(
        "21 double-verify ends verified and consistent",
        vCodes.includes(200) && vfinal.distanceVerified === true && vfinal.totalAmount === vExp,
        `codes=${JSON.stringify(vCodes)} travel=${vfinal.travelCharge} total=${vfinal.totalAmount} re-sum=${vExp}`
      );
      // Verify racing a status transition: version conflicts serialize the
      // two writes; whichever loses must leave no inconsistent snapshot.
      const veriCook = await mkCook("veri");
      const vb2 = await callCreate(customer, { startTime: "21:00", duration: 2, distanceKm: 3 });
      await callAssign(vb2.body._id, veriCook._id, admin);
      const [sv, sc] = await Promise.all([
        callVerify(vb2.body._id, 12, admin),
        callStatus(vb2.body._id, "confirmed", admin),
      ]);
      check(
        "21 verify-vs-status race: no server errors",
        [sv.statusCode, sc.statusCode].every((c) => c >= 200 && c < 500),
        JSON.stringify([sv.statusCode, sc.statusCode])
      );
      const sfinal = await EventBooking.findById(vb2.body._id);
      const sExp = Math.round(
        Number(sfinal.serviceAmount || 0) +
          Number(sfinal.additionalCookAmount || 0) +
          Number(sfinal.extraHourAmount || 0) +
          Number(sfinal.travelCharge || 0)
      );
      check(
        "21 race loser left no inconsistent totals",
        sfinal.totalAmount === sExp,
        `total=${sfinal.totalAmount} re-sum=${sExp} status=${sfinal.bookingStatus}`
      );
      const sHist = (sfinal.statusHistory || []).map((h) => h.status);
      check(
        "21 history tail always matches final status",
        sHist.length >= 1 && sHist[sHist.length - 1] === sfinal.bookingStatus,
        sHist.join(">")
      );
    }

    // ── 22. Background outbox worker: start/stop + end-to-end replay ──
    {
      const wb = await callCreate(customer, { startTime: "08:00", duration: 1, distanceKm: 2 });
      const wkey = `${wb.body.bookingId}:request:0`;
      // Simulate an in-band delivery failure: the row is pending and due, and
      // the recipients' notifications do not exist yet.
      const wDeleted = await Notification.deleteMany({ eventKey: wkey });
      await EventOutbox.updateOne(
        { eventKey: wkey },
        {
          $set: {
            status: "pending",
            nextRetryAt: new Date(Date.now() - 1000),
            claimedBy: null,
            claimExpiresAt: null,
            attempts: 0,
            lastError: "simulated delivery failure",
          },
        }
      );
      const w = startOutboxWorker({ pollMs: 1000, workerId: `test-outbox-${RUN}` });
      const wAgain = startOutboxWorker({ pollMs: 5000 }); // idempotent while running
      try {
        await new Promise((r) => setTimeout(r, 2500));
      } finally {
        stopOutboxWorker();
      }
      const wRow = await EventOutbox.findOne({ eventKey: wkey });
      const wNotices = await Notification.countDocuments({ eventKey: wkey });
      check(
        "22 worker start/stop: pending event replayed to sent",
        wRow && wRow.status === "sent",
        wRow ? `status=${wRow.status} attempts=${wRow.attempts}` : "missing"
      );
      check(
        "22 worker replayed the missing notifications (no dupes)",
        wNotices === wDeleted.deletedCount && wNotices >= 1,
        `deleted=${wDeleted.deletedCount} now=${wNotices}`
      );
      check(
        "22 worker handle exposes stop + workerId; double-start is a no-op",
        typeof w.stop === "function" && !!w.workerId && wAgain.workerId === w.workerId,
        `${w.workerId} / ${wAgain.workerId}`
      );
      const wFresh = startOutboxWorker({ pollMs: 10000 });
      stopOutboxWorker();
      check("22 start after stop creates a fresh worker", wFresh.workerId !== w.workerId, `${wFresh.workerId}`);
    }

    // ── 23. Deployment safety: seed preserves admin pricing; backfill refuses ──
    {
      // seed:events against the ISOLATED test database: must not overwrite an
      // admin-customized price (child process, real script).
      await EventPricing.updateOne({ key: "default" }, { $set: { additionalCookPrice: 999 } });
      const seedRun = spawnSync("node", ["seeds/eventSeed.js"], {
        cwd: BACKEND_DIR,
        env: { ...process.env, MONGODB_URI: testUri },
        encoding: "utf8",
        timeout: 60000,
      });
      const seedOut = `${seedRun.stdout || ""}${seedRun.stderr || ""}`;
      check("23 seed:events exits 0 on the test DB", seedRun.status === 0, `status=${seedRun.status} ${seedOut.slice(0, 200)}`);
      check("23 seed reports pricing left untouched", /left untouched/i.test(seedOut), seedOut.split("\n").slice(-3).join(" | "));
      const priced = await EventPricing.findOne({ key: "default" });
      check(
        "23 admin-customized additionalCookPrice preserved by seed",
        Number(priced.additionalCookPrice) === 999,
        `value=${priced.additionalCookPrice}`
      );
      await EventPricing.updateOne({ key: "default" }, { $set: { additionalCookPrice: 400 } });

      // Backfill refuses to run without an explicit target db name (exit 1,
      // before connecting — nothing can be touched).
      const bfNoArg = spawnSync("node", ["seeds/backfill-distance-verified.js"], {
        cwd: BACKEND_DIR,
        env: { ...process.env, MONGODB_URI: "" },
        encoding: "utf8",
        timeout: 30000,
      });
      check(
        "23 backfill refuses without explicit db name",
        bfNoArg.status === 1 && /Refusing to run/.test(`${bfNoArg.stderr || ""}${bfNoArg.stdout || ""}`),
        `status=${bfNoArg.status}`
      );
      // Wrong db name → connects, compares, aborts WITHOUT touching anything.
      const bfWrong = spawnSync("node", ["seeds/backfill-distance-verified.js", "not_the_test_db"], {
        cwd: BACKEND_DIR,
        env: { ...process.env, MONGODB_URI: testUri },
        encoding: "utf8",
        timeout: 60000,
      });
      check(
        "23 backfill aborts on db-name mismatch",
        bfWrong.status === 1 && /Target mismatch/i.test(`${bfWrong.stderr || ""}${bfWrong.stdout || ""}`),
        `status=${bfWrong.status} ${(`${bfWrong.stderr || ""}`).slice(0, 160)}`
      );
    }
  } finally {
    try {
      await mongoose.connection.db.dropDatabase();
      console.log(`Isolated test database "${TEST_DB}" dropped`);
    } catch (e) {
      console.log(`Cleanup warning: ${(e.message || "").slice(0, 100)}`);
    }
    await mongoose.disconnect();
  }

  console.log(failures === 0 ? "ALL CONCURRENCY TESTS PASSED" : failures + " FAILURES");
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.log("FATAL", (e.message || "").slice(0, 200));
  process.exit(1);
});
