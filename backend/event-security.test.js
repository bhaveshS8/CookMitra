// COOKMITRA EVENTS security regression tests (offline-safe, no DB required).
// Run: node backend/event-security.test.js — exits non-zero on failure.
//
// Covers Phase 10 pure-function cases: pricing ₹2099 example, every
// service/duration boundary, travel slabs, invalid numerics, strict time
// parsing, overlap boundaries, lifecycle transitions, and schema invariants
// (notification enum, catalogue enum removal, provisional distance flag).
// DB-backed concurrency cases are structural (atomic helper present) — live
// concurrency is verified manually against a test database (see report).

const {
  durationKeyForHours,
  travelChargeForDistance,
  calculateEventPrice,
  validatePricingTable,
  validateTravelSlabs,
} = require("./utils/eventPricing");
const EventPricing = require("./models/EventPricing");
const EventBooking = require("./models/EventBooking");
const Notification = require("./models/Notification");
const bookingCtrl = require("./controllers/eventBookingController");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) failures++;
};
const throwsSync = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

(async () => {
  // ── §9 worked example: preparation_cooking, 4h, 7km, 1 cook, 0 extra ──
  const ex = await calculateEventPrice({
    serviceType: "preparation_cooking",
    duration: 4,
    distanceKm: 7,
    additionalCook: 1,
    extraHours: 0,
  });
  check("₹2099 example service", ex.serviceAmount === 1599, JSON.stringify(ex));
  check("₹2099 example cook", ex.additionalCookAmount === 400);
  check("₹2099 example extra", ex.extraHourAmount === 0);
  check("₹2099 example travel", ex.travelCharge === 100);
  check("₹2099 example total", ex.totalAmount === 2099);

  // ── Every service/duration boundary (default table) ──
  const expected = EventPricing.DEFAULT_PRICING.servicePrices;
  const buckets = { 1: "upto2", 1.99: "upto2", 2: "slot_2_3", 2.5: "slot_2_3", 3: "slot_3_4", 4: "slot_4_5", 5: "slot_5_6", 6: "slot_6_7", 7: "slot_7_8", 8: "slot_7_8" };
  for (const svc of EventPricing.SERVICE_KEYS) {
    for (const [hrs, key] of Object.entries(buckets)) {
      const q = await calculateEventPrice({ serviceType: svc, duration: Number(hrs), distanceKm: 0 });
      check(`${svc} ${hrs}h → ${key} ₹${expected[svc][key]}`, q.serviceAmount === expected[svc][key] && q.durationKey === key);
    }
  }
  check("durationKey 8.01 → null", durationKeyForHours(8.01) === null);
  check("durationKey 0 → null", durationKeyForHours(0) === null);
  check("durationKey NaN → null", durationKeyForHours(NaN) === null);

  // ── Travel slabs (default table) ──
  const slabs = EventPricing.DEFAULT_PRICING.travelSlabs;
  const travelCases = [
    [0, 0], [3, 0], [3.1, 50], [5, 50], [5.1, 100], [8, 100],
    [8.1, 150], [10, 150], [10.1, 250], [15, 250], [15.1, 350],
    [20, 350], [20.1, 450], [100, 450], [1e6, 450], [1e9, 450],
  ];
  for (const [km, charge] of travelCases) {
    check(`travel ${km}km → ₹${charge}`, travelChargeForDistance(slabs, km) === charge);
  }

  // ── Invalid numerics rejected (not coerced to 0) ──
  const mustThrow = async (name, args) => {
    try {
      await calculateEventPrice(args);
      check(name, false, "did not throw");
    } catch {
      check(name, true);
    }
  };
  await mustThrow("reject bad service", { serviceType: "nope", duration: 4 });
  await mustThrow("reject duration 0", { serviceType: "cooking_only", duration: 0 });
  await mustThrow("reject duration 9", { serviceType: "cooking_only", duration: 9 });
  await mustThrow("reject NaN duration", { serviceType: "cooking_only", duration: NaN });
  await mustThrow("reject Infinity cooks", { serviceType: "cooking_only", duration: 2, additionalCook: Infinity });
  await mustThrow("reject fractional cooks", { serviceType: "cooking_only", duration: 2, additionalCook: 1.5 });
  await mustThrow("reject 11 cooks", { serviceType: "cooking_only", duration: 2, additionalCook: 11 });
  await mustThrow("reject negative extra", { serviceType: "cooking_only", duration: 2, extraHours: -1 });
  await mustThrow("reject 13 extra", { serviceType: "cooking_only", duration: 2, extraHours: 13 });
  await mustThrow("reject NaN extra", { serviceType: "cooking_only", duration: 2, extraHours: NaN });
  await mustThrow("reject negative distance", { serviceType: "cooking_only", duration: 2, distanceKm: -1 });
  await mustThrow("reject Infinity distance", { serviceType: "cooking_only", duration: 2, distanceKm: Infinity });
  await mustThrow("reject excessive distance", { serviceType: "cooking_only", duration: 2, distanceKm: 1e9 });
  // Boolean / empty-string coercion (Number(true) === 1) must never pass.
  await mustThrow("reject true distance", { serviceType: "cooking_only", duration: 2, distanceKm: true });
  await mustThrow("reject false distance", { serviceType: "cooking_only", duration: 2, distanceKm: false });
  await mustThrow("reject empty-string distance", { serviceType: "cooking_only", duration: 2, distanceKm: "" });
  await mustThrow("reject null distance", { serviceType: "cooking_only", duration: 2, distanceKm: null });
  await mustThrow("reject true duration", { serviceType: "cooking_only", duration: true });
  await mustThrow("reject true additional cook", { serviceType: "cooking_only", duration: 2, additionalCook: true });
  await mustThrow("reject true extra hours", { serviceType: "cooking_only", duration: 2, extraHours: true });
  // Undefined optional inputs still fall back to the documented defaults.
  const defaultsQ = await calculateEventPrice({ serviceType: "cooking_only", duration: 2 });
  check("undefined optionals use defaults", defaultsQ.totalAmount === 699, JSON.stringify(defaultsQ));

  // ── Pricing table validation ──
  check("default table validates", (() => { try { validatePricingTable({ servicePrices: expected, additionalCookPrice: 400, extraHourPrices: EventPricing.DEFAULT_PRICING.extraHourPrices, travelSlabs: slabs }); return true; } catch { return false; } })());
  check("corrupt service price rejected", throwsSync(() => validatePricingTable({ servicePrices: { cooking_only: { upto2: -5 } }, additionalCookPrice: 400, extraHourPrices: EventPricing.DEFAULT_PRICING.extraHourPrices, travelSlabs: slabs })));
  check("duplicate slabs rejected", throwsSync(() => validateTravelSlabs([{ maxKm: 5, charge: 10 }, { maxKm: 5, charge: 20 }, { maxKm: 1000000, charge: 30 }]))),
  check("string maxKm rejected", throwsSync(() => validateTravelSlabs([{ maxKm: "5", charge: 10 }, { maxKm: 1000000, charge: 30 }]))),
  check("missing unlimited rejected", throwsSync(() => validateTravelSlabs([{ maxKm: 5, charge: 10 }]))),
  check("negative charge rejected", throwsSync(() => validateTravelSlabs([{ maxKm: 5, charge: -1 }, { maxKm: 1000000, charge: 30 }]))),
  check("unlimited sentinel passes", (() => { try { validateTravelSlabs([{ maxKm: 3, charge: 0 }, { maxKm: 1000000, charge: 450 }]); return true; } catch { return false; } })());

  // ── Booking time helpers (strict) ──
  const T = bookingCtrl._test;
  check("strict time accepts 09:00", T.timeToMinutes("09:00") === 540);
  check("strict time accepts 23:59", T.timeToMinutes("23:59") === 1439);
  check("strict time rejects 9:00abc", T.timeToMinutes("9:00abc") === null);
  check("strict time rejects 12:34:56", T.timeToMinutes("12:34:56") === null);
  check("strict time rejects 24:00", T.timeToMinutes("24:00") === null);
  check("strict time rejects 9:0", T.timeToMinutes("9:0") === null);
  check("adjacent windows do not overlap", T.windowsOverlap({ start: 600, end: 720 }, { start: 720, end: 840 }) === false);
  check("overlapping windows detected", T.windowsOverlap({ start: 600, end: 721 }, { start: 720, end: 840 }) === true);
  check("window uses duration+extra", JSON.stringify(T.bookingWindow({ startTime: "18:00", duration: 4, extraHours: 1 })) === JSON.stringify({ start: 1080, end: 1380 }));

  // ── Lifecycle ──
  const AL = T.ALLOWED_TRANSITIONS;
  check("pending → cook_assigned allowed", AL.pending.includes("cook_assigned"));
  check("status route cannot cancel (dedicated endpoint only)", !AL.pending.includes("cancelled"));
  check("pending → confirmed rejected", !AL.pending.includes("confirmed"));
  check("skip cook_assigned→in_progress rejected", !AL.cook_assigned.includes("in_progress"));
  check("completed terminal", AL.completed.length === 0);
  check("cancelled terminal", AL.cancelled.length === 0);
  check("in_progress → completed allowed", AL.in_progress.includes("completed"));

  // ── Status query filter (anti operator-injection) ──
  const mkRes = () => ({ code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  let f1 = {}; let r1 = mkRes();
  check("status filter accepts valid status", T.applyStatusFilter(f1, "pending", r1) === true && f1.bookingStatus === "pending");
  f1 = {}; r1 = mkRes();
  check("status filter allows missing status", T.applyStatusFilter(f1, undefined, r1) === true && f1.bookingStatus === undefined);
  f1 = {}; r1 = mkRes();
  check("status filter rejects operator object", T.applyStatusFilter(f1, { $ne: null }, r1) === false && r1.code === 400 && f1.bookingStatus === undefined);
  f1 = {}; r1 = mkRes();
  check("status filter rejects unknown status", T.applyStatusFilter(f1, "bogus", r1) === false && r1.code === 400);

  // ── Schema invariants ──
  const notifEnum = Notification.schema.path("type").enumValues;
  for (const t of ["event_booking_request", "event_cook_assigned", "event_assignment", "event_status", "event_cancelled"]) {
    check(`notification enum has ${t}`, notifEnum.includes(t));
  }
  const evtEnum = EventBooking.schema.path("eventType").enumValues;
  check("eventType hardcoded enum removed", !evtEnum || evtEnum.length === 0, JSON.stringify(evtEnum));
  check("distanceVerified flag exists", EventBooking.schema.path("distanceVerified") != null);
  check("EVENT_TYPES export preserved for compat", Array.isArray(EventBooking.EVENT_TYPES) && EventBooking.EVENT_TYPES.length === 5);

  // ── Mass-assignment: controller must not read trusted fields from body ──
  const fs = require("fs");
  const src = fs.readFileSync(__dirname + "/controllers/eventBookingController.js", "utf8");
  check("no req.body.customerId trust", !/body\?\.\s*customerId|body\.\s*customerId|req\.body\.customerId/.test(src));
  check("customerId from auth", /customerId:\s*req\.user\.id/.test(src));
  check("no client amounts trusted", !/serviceAmount:\s*req\.body|totalAmount:\s*req\.body|travelCharge:\s*req\.body/.test(src));
  check("atomic updates used", /findOneAndUpdate/.test(src));
  check("409 conflict handling", /409/.test(src));
  check("availability check present", /availabilityStatus/.test(src));

  // ── Route gates: sensitive endpoints are role-gated at the router ──
  const routeSrc = fs.readFileSync(__dirname + "/routes/eventBookings.js", "utf8");
  check("create route is customer-gated", /router\.post\(\s*"\/"\s*,\s*auth\s*,\s*authorize\("customer"\)/.test(routeSrc));
  check("assign-cook route is admin-gated", /assign-cook"[\s\S]{0,160}?authorize\("admin"\)/.test(routeSrc));
  check("status route is admin-gated", /:id\/status"[\s\S]{0,160}?authorize\("admin"\)/.test(routeSrc));
  check("verify-distance route is admin-gated", /verify-distance"[\s\S]{0,160}?authorize\("admin"\)/.test(routeSrc));

  // ── Concurrency guards (tasks 2 & 4): conditional writes inside commits ──
  check("assignCook guards eligibility inside the mutation", /guardCookEligibilityForAssign\(cookId, session\)/.test(src));
  check("create guards catalogue inside the mutation", /EventType\.findOneAndUpdate\(\s*\{\s*_id: catalogueEntry\._id,\s*active:\s*true/.test(src));
  const outboxSrc = fs.readFileSync(__dirname + "/utils/eventOutbox.js", "utf8");
  check(
    "outbox summary exposes flagged reverts",
    /flagged/.test(outboxSrc) && /countDocuments\(\{\s*action:\s*"revert_failed"\s*\}\)/.test(outboxSrc)
  );
  check("in-process outbox worker start/stop present", /startOutboxWorker/.test(outboxSrc) && /stopOutboxWorker/.test(outboxSrc));

  // ── Old bookings keep snapshots: schema stores breakdown + total ──
  for (const p of ["serviceAmount", "additionalCookAmount", "extraHourAmount", "travelCharge", "totalAmount"]) {
    check(`snapshot field ${p} exists`, EventBooking.schema.path(p) != null);
  }

  console.log(failures === 0 ? "ALL EVENT TESTS PASSED" : failures + " FAILURES");
  process.exit(failures === 0 ? 0 : 1);
})();
