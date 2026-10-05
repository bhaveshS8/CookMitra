//  4. Security: route is auth+authorize("admin"); unauthenticated,
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const jwt = require("jsonwebtoken");
const Booking = require("./models/Booking");
const User = require("./models/User");
const analyticsRouter = require("./routes/analytics");
const { auth } = require("./middleware/auth");
const A = require("./utils/analytics");

let failures = 0;
let passes = 0;
const check = (n, ok, d) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`);
  ok ? passes++ : failures++;
};
const eq = (a, b) => a === b;

console.log("═══ analytics utils: classification ═══");
check("all 9 lifecycle statuses known", A.KNOWN_STATUSES.length === 9);
for (const s of ["requested", "accepted", "confirmed", "in_progress", "completed", "cancelled", "expired", "rejected", "unattended"]) {
  check(`classify ${s}`, A.classifyStatus(s) === s);
}
check("unknown status -> unknown", A.classifyStatus("flying") === "unknown");
check("missing status -> unknown", A.classifyStatus(null) === "unknown");
check("active set excludes terminal", eq(A.ACTIVE_STATUSES.join(","), "requested,accepted,confirmed,in_progress"));
check("lost includes unattended", A.LOST_STATUSES.includes("unattended") && A.LOST_STATUSES.includes("cancelled") && A.LOST_STATUSES.includes("expired") && A.LOST_STATUSES.includes("rejected"));

console.log("\n═══ analytics utils: money primitives ═══");
const paidDoc = (over = {}) => ({
  amount: 349, commission: 87, cookPayout: 262,
  payment: { status: "paid", paidAmount: 349, refundStatus: "none", testMode: false },
  payout: { status: "pending" },
  ...over,
});
check("real payment recognized", A.isRealPayment(paidDoc()) === true);
check("testMode is not real money", A.isRealPayment(paidDoc({ payment: { status: "paid", paidAmount: 349, refundStatus: "none", testMode: true } })) === false);
check("unpaid is not real", A.isRealPayment(paidDoc({ payment: { status: "pending", testMode: false } })) === false);
check("paidFor uses paidAmount", A.paidFor(paidDoc()) === 349);
check("paidFor falls back to amount", A.paidFor({ amount: 199, payment: { status: "paid", testMode: false } }) === 199);
check("paidFor unpaid = 0", A.paidFor({ amount: 199, payment: { status: "pending" } }) === 0);
check("refunded processed counts", A.refundedFor(paidDoc({ payment: { status: "paid", paidAmount: 349, refundStatus: "processed", refundAmount: 349 } })) === 349);
check("refunded manual counts", A.refundedFor(paidDoc({ payment: { status: "paid", paidAmount: 349, refundStatus: "manual", refundAmount: 100 } })) === 100);
check("refunded pending moves no money", A.refundedFor(paidDoc({ payment: { status: "paid", paidAmount: 349, refundStatus: "pending", refundAmount: 349 } })) === 0);
check("refunded failed moves no money", A.refundedFor(paidDoc({ payment: { status: "paid", paidAmount: 349, refundStatus: "failed", refundAmount: 349 } })) === 0);
check("refunded rejected moves no money", A.refundedFor(paidDoc({ payment: { status: "paid", paidAmount: 349, refundStatus: "rejected", refundAmount: 349 } })) === 0);
check("refunded testMode = 0", A.refundedFor(paidDoc({ payment: { status: "paid", paidAmount: 349, refundStatus: "processed", refundAmount: 349, testMode: true } })) === 0);

console.log("\n═══ analytics utils: city + IST month ═══");
check("normalize Pune variants", A.normalizeCity("Pune") === "pune" && A.normalizeCity(" pune ") === "pune" && A.normalizeCity("PUNE") === "pune" && A.normalizeCity(" Pune") === "pune");
check("normalize null -> empty", A.normalizeCity(null) === "" && A.normalizeCity(undefined) === "");
check("display city title-cases", A.displayCity("pune") === "Pune");
check("IST month boundary late Sep", A.monthKeyIST(new Date("2026-09-30T18:29:00Z")) === "2026-09");
check("IST month boundary Oct 00:00", A.monthKeyIST(new Date("2026-09-30T18:30:00Z")) === "2026-10");
check("IST year boundary", A.monthKeyIST(new Date("2025-12-31T18:30:00Z")) === "2026-01");
check("invalid date -> null", A.monthKeyIST(new Date("nope")) === null);
check("enumerate months fills gaps", eq(A.enumerateMonths("2026-09", "2026-11").join(","), "2026-09,2026-10,2026-11"));
check("enumerate months year roll", eq(A.enumerateMonths("2026-12", "2027-02").join(","), "2026-12,2027-01,2027-02"));

console.log("\n═══ analytics utils: query validation ═══");
check("empty query -> null (all time)", A.validateAnalyticsQuery({}) === null);
let threw = null;
try { A.validateAnalyticsQuery({ dateField: "hack" }); } catch (e) { threw = e.status; }
check("bad dateField rejected", threw === 400);
threw = null;
try { A.validateAnalyticsQuery({ from: "2026-09-01" }); } catch (e) { threw = e.status; }
check("half range rejected", threw === 400);
threw = null;
try { A.validateAnalyticsQuery({ from: "2026-10-01", to: "2026-09-01" }); } catch (e) { threw = e.status; }
check("from>to rejected", threw === 400);
threw = null;
try { A.validateAnalyticsQuery({ from: { $gt: "" }, to: "2026-09-01" }); } catch (e) { threw = e.status; }
check("NoSQL operator injection rejected", threw === 400);
threw = null;
try { A.validateAnalyticsQuery({ from: "2026-09-01", to: "2036-09-01" }); } catch (e) { threw = e.status; }
check("5yr cap enforced", threw === 400);
const okRange = A.validateAnalyticsQuery({ from: "2026-09-01", to: "2026-09-30", dateField: "service" });
check("valid range parses", okRange && okRange.dateField === "service" && okRange.from instanceof Date);

console.log("\n═══ analytics handler: fixture correctness ═══");

const OID = (n) => `0000000000000000000000${String(n).padStart(2, "0")}`.slice(-24);
const FIXTURES = [
  { _id: "f01", status: "completed", durationHours: 2, amount: 349, commission: 87, cookPayout: 262, discount: 0, date: new Date("2026-09-15T00:00:00Z"), payment: { status: "paid", paidAmount: 349, refundStatus: "none", testMode: false }, payout: { status: "settled", amount: 262 }, addressDetails: { city: "Pune" }, cook: OID(11), customer: OID(21) },
  { _id: "f02", status: "confirmed", durationHours: 3, amount: 499, commission: 125, cookPayout: 374, discount: 50, date: new Date("2026-09-16T00:00:00Z"), payment: { status: "paid", paidAmount: 499, refundStatus: "none", testMode: false }, payout: { status: "pending", amount: 0 }, addressDetails: { city: "pune " }, cook: OID(11), customer: OID(22) },
  { _id: "f03", status: "cancelled", durationHours: 1, amount: 199, commission: 50, cookPayout: 149, discount: 0, date: new Date("2026-09-10T00:00:00Z"), payment: { status: "paid", paidAmount: 199, refundStatus: "processed", refundAmount: 199, testMode: false }, payout: { status: "pending", amount: 0 }, addressDetails: { city: "Mumbai" }, cook: OID(12), customer: OID(21) },
  { _id: "f04", status: "expired", durationHours: 2, amount: 349, commission: 0, cookPayout: 0, discount: 0, date: new Date("2026-09-11T00:00:00Z"), payment: { status: "pending", testMode: false }, payout: { status: "pending", amount: 0 }, addressDetails: { city: "" }, cook: OID(12), customer: OID(23) },
  { _id: "f05", status: "unattended", durationHours: 2, amount: 349, commission: 87, cookPayout: 262, discount: 0, date: new Date("2026-09-12T00:00:00Z"), payment: { status: "paid", paidAmount: 349, refundStatus: "pending", refundAmount: 349, testMode: false }, payout: { status: "pending", amount: 0 }, addressDetails: { city: "Pune" }, cook: OID(11), customer: OID(24) },
  { _id: "f06", status: "requested", durationHours: 4, amount: 649, commission: 0, cookPayout: 0, discount: 0, date: new Date("2026-09-13T00:00:00Z"), payment: { status: "pending", testMode: false }, payout: { status: "pending", amount: 0 }, addressDetails: { city: null }, cook: OID(13), customer: OID(25) },
  { _id: "f07", status: "accepted", durationHours: 1, amount: 199, commission: 0, cookPayout: 0, discount: 0, date: new Date("2026-09-14T00:00:00Z"), payment: { status: "pending", testMode: false }, payout: { status: "pending", amount: 0 }, addressDetails: { city: " PUNE" }, cook: OID(13), customer: OID(25) },
  { _id: "f08", status: "in_progress", durationHours: 4, amount: 649, commission: 162, cookPayout: 487, discount: 0, date: new Date("2026-09-17T00:00:00Z"), payment: { status: "paid", paidAmount: 649, refundStatus: "none", testMode: false }, payout: { status: "pending", amount: 0 }, addressDetails: { city: "Nashik" }, cook: OID(12), customer: OID(26) },
  { _id: "f09", status: "rejected", durationHours: 2, amount: 349, commission: 0, cookPayout: 0, discount: 0, date: new Date("2026-09-18T00:00:00Z"), payment: { status: "pending", testMode: false }, payout: { status: "pending", amount: 0 }, addressDetails: { city: "Pune" }, cook: OID(14), customer: OID(27) },
  { _id: "f10", status: "completed", durationHours: 1, amount: 199, commission: 50, cookPayout: 149, discount: 0, date: new Date("2026-09-19T00:00:00Z"), payment: { status: "paid", paidAmount: 199, refundStatus: "processed", refundAmount: 50, testMode: false }, payout: { status: "settled", amount: 149 }, addressDetails: { city: "Mumbai" }, cook: OID(12), customer: OID(22) },
  { _id: "f11", status: "completed", durationHours: 2, amount: 349, commission: 87, cookPayout: 262, discount: 0, date: new Date("2026-09-20T00:00:00Z"), payment: { status: "paid", paidAmount: 349, refundStatus: "none", testMode: true }, payout: { status: "pending", amount: 0 }, addressDetails: { city: "Pune" }, cook: OID(11), customer: OID(28) },
  { _id: "f12", status: "cancelled", durationHours: 2, amount: 349, commission: 87, cookPayout: 262, discount: 0, date: new Date("2026-09-21T00:00:00Z"), payment: { status: "paid", paidAmount: 349, refundStatus: "failed", refundAmount: 349, testMode: false }, payout: { status: "pending", amount: 0 }, addressDetails: { city: "Pune" }, cook: OID(14), customer: OID(29) },
  { _id: "f13", status: "completed", durationHours: 2, amount: 349, commission: 87, cookPayout: 262, discount: 0, date: new Date("2026-09-22T00:00:00Z"), payment: { status: "paid", paidAmount: 349, refundStatus: "none", testMode: false }, payout: { status: "pending", amount: 0 }, addressDetails: { city: "Pune" }, cook: OID(11), customer: OID(21) },
];

const realPaid = FIXTURES.filter((b) => b.payment.status === "paid" && b.payment.testMode !== true);
const EXP = {
  total: 13,
  requested: 1, accepted: 1, confirmed: 1, in_progress: 1, completed: 4,
  cancelled: 2, expired: 1, rejected: 1, unattended: 1, unknown: 0,
  active: 4, lost: 5,
  paidBookings: 8,
  gross: 349 + 499 + 199 + 349 + 649 + 199 + 349 + 349, // f01,f02,f03,f05,f08,f10,f12,f13
  refunds: 199 + 50, // f03 full + f10 partial (f05 pending + f12 failed excluded)
  discounts: 50,
};
EXP.net = EXP.gross - EXP.refunds; // 2942 - 249 = 2693
const commGross = 87 + 125 + 50 + 87 + 162 + 50 + 87 + 87; // = 735
EXP.platform = Math.round((commGross * EXP.net) / EXP.gross); // 673
EXP.cook = EXP.net - EXP.platform; // 2020
EXP.avg = Math.round(EXP.net / EXP.paidBookings); // 337
EXP.cookPaid = 262 + 149; // f01 + f10 settled
EXP.cookPending = 262; // f13 only (completed + paid-real + pending + refund none)
EXP.schedHours = 2 + 3 + 1 + 2 + 2 + 4 + 1 + 4 + 2 + 1 + 2 + 2 + 2; // 28
EXP.compHours = 2 + 1 + 2 + 2; // f01,f10,f11,f13 = 7
EXP.pune = 8; EXP.mumbai = 2; EXP.nashik = 1;

check("fixture sanity: paid count", realPaid.length === EXP.paidBookings, `got ${realPaid.length}`);
check("fixture sanity: gross", realPaid.reduce((a, b) => a + b.payment.paidAmount, 0) === EXP.gross);
check("hard-coded gross", EXP.gross === 2942, `got ${EXP.gross}`);
check("hard-coded net", EXP.net === 2693, `got ${EXP.net}`);
check("hard-coded platform", EXP.platform === 673, `got ${EXP.platform}`);
check("hard-coded cook", EXP.cook === 2020, `got ${EXP.cook}`);

const settledRefunds = ["processed", "manual"];
function buildTestFacet(rows) {
  const statusMap = new Map();
  for (const b of rows) statusMap.set(b.status, (statusMap.get(b.status) || 0) + 1);
  const statusCounts = [...statusMap.entries()].map(([status, count]) => ({ status, count }));
  const paid = rows.filter((b) => b.payment.status === "paid" && b.payment.testMode !== true);
  const money = paid.length
    ? [{
        paidBookings: paid.length,
        grossCollected: paid.reduce((a, b) => a + (b.payment.paidAmount ?? b.amount ?? 0), 0),
        discounts: paid.reduce((a, b) => a + (b.discount || 0), 0),
        commissionGross: paid.reduce((a, b) => a + (b.commission || 0), 0),
        cookGross: paid.reduce((a, b) => a + (b.cookPayout || 0), 0),
        refunded: paid.reduce((a, b) => a + (settledRefunds.includes(b.payment.refundStatus) ? b.payment.refundAmount || 0 : 0), 0),
      }]
    : [];
  const settled = paid.filter((b) => b.payout.status === "settled");
  const paidPayouts = settled.length
    ? [{ cookPaid: settled.reduce((a, b) => a + (b.payout.amount || 0), 0), settledCount: settled.length }]
    : [];
  const pendElig = rows.filter((b) => b.status === "completed" && b.payment.status === "paid" && b.payment.testMode !== true && b.payout.status === "pending" && ["none", "rejected"].includes(b.payment.refundStatus || "none"));
  const pendingPayoutEntitlement = pendElig.length
    ? [{ pendingGross: pendElig.reduce((a, b) => a + (b.payment.paidAmount ?? b.amount ?? 0), 0), pendingCookGross: pendElig.reduce((a, b) => a + (b.cookPayout || 0), 0), pendingCommissionGross: pendElig.reduce((a, b) => a + (b.commission || 0), 0), pendingCount: pendElig.length }]
    : [];
  const validDur = (h) => Number(h) >= 1 && Number(h) <= 4;
  const hours = [{
    scheduledHours: rows.reduce((a, b) => a + (validDur(b.durationHours) ? b.durationHours : 0), 0),
    scheduledCount: rows.filter((b) => validDur(b.durationHours)).length,
    completedHours: rows.filter((b) => b.status === "completed").reduce((a, b) => a + (validDur(b.durationHours) ? b.durationHours : 0), 0),
  }];
  const areaMap = new Map();
  for (const b of rows) {
    const k = String(b.addressDetails?.city || "").trim().toLowerCase();
    if (!k) continue;
    const e = areaMap.get(k) || { key: k, bookings: 0, gross: 0 };
    e.bookings += 1; e.gross += b.amount || 0;
    areaMap.set(k, e);
  }
  const areas = [...areaMap.values()].sort((x, y) => y.bookings - x.bookings).slice(0, 8);
  const cookMap = new Map();
  for (const b of rows) {
    if (b.cook == null) continue;
    const k = String(b.cook);
    const e = cookMap.get(k) || { cookId: k, bookings: 0, hours: 0, gross: 0, refunded: 0, paidGross: 0, name: null, photoUrl: "" };
    e.bookings += 1;
    if (validDur(b.durationHours)) e.hours += b.durationHours;
    e.gross += b.amount || 0;
    if (settledRefunds.includes(b.payment.refundStatus) && b.payment.testMode !== true) e.refunded += b.payment.refundAmount || 0;
    if (b.payment.status === "paid" && b.payment.testMode !== true) e.paidGross += b.payment.paidAmount ?? b.amount ?? 0;
    cookMap.set(k, e);
  }
  const cooks = [...cookMap.values()].sort((x, y) => y.bookings - x.bookings).slice(0, 8);
  const custMap = new Map();
  for (const b of rows) {
    if (b.customer == null) continue;
    const k = String(b.customer);
    const e = custMap.get(k) || { customerId: k, bookings: 0, gross: 0, paidGross: 0, refunded: 0, name: null };
    e.bookings += 1; e.gross += b.amount || 0;
    if (b.payment.status === "paid" && b.payment.testMode !== true) e.paidGross += b.payment.paidAmount ?? b.amount ?? 0;
    if (settledRefunds.includes(b.payment.refundStatus) && b.payment.testMode !== true) e.refunded += b.payment.refundAmount || 0;
    custMap.set(k, e);
  }
  const customers = [...custMap.values()].sort((x, y) => y.bookings - x.bookings).slice(0, 8);
  const durMap = new Map();
  for (const b of rows) {
    if (!validDur(b.durationHours)) continue;
    durMap.set(b.durationHours, (durMap.get(b.durationHours) || 0) + 1);
  }
  const durations = [...durMap.entries()].sort((a, b) => a[0] - b[0]).map(([hours2, bookings]) => ({ hours: hours2, bookings }));
  const monMap = new Map();
  for (const b of rows) {
    const k = A.monthKeyIST(b.date);
    if (!k) continue;
    const e = monMap.get(k) || { month: k, bookings: 0, gross: 0, refunded: 0 };
    e.bookings += 1;
    if (b.payment.status === "paid" && b.payment.testMode !== true) e.gross += b.payment.paidAmount ?? b.amount ?? 0;
    if (settledRefunds.includes(b.payment.refundStatus) && b.payment.testMode !== true) e.refunded += b.payment.refundAmount || 0;
    monMap.set(k, e);
  }
  const months = [...monMap.values()].sort((x, y) => (x.month < y.month ? -1 : 1));
  return { statusCounts, money, paidPayouts, pendingPayoutEntitlement, hours, areas, cooks, customers, durations, months };
}

function findHandler() {
  const layer = analyticsRouter.stack.find(
    (l) => l.route && l.route.path === "/bookings" && l.route.methods.get
  );
  if (!layer) throw new Error("GET /bookings route not found");
  const handlers = layer.route.stack.map((s) => s.handle);
  return handlers[handlers.length - 1]; // final handler (after auth+authorize)
}

async function runHandler(query = {}) {
  const handler = findHandler();
  const req = { query, user: { id: "admin1", role: "admin" } };
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; return res; };
  await handler(req, res, (e) => { if (e) throw e; });
  return res;
}

(async () => {
  const realAggregate = Booking.aggregate;
  Booking.aggregate = async () => [buildTestFacet(FIXTURES)];

  const res = await runHandler({});
  Booking.aggregate = realAggregate;
  const body = res.body;
  check("handler 200 + totals", res.statusCode === 200 && !!body?.totals, `status=${res.statusCode}`);

  const bk = body.totals.bookings;
  check("total = all statuses", bk.total === EXP.total, `got ${bk.total}`);
  check("requested", bk.byStatus.requested === 1);
  check("accepted", bk.byStatus.accepted === 1);
  check("confirmed", bk.byStatus.confirmed === 1);
  check("in_progress", bk.byStatus.in_progress === 1);
  check("completed", bk.total !== undefined && bk.completed === 4, `got ${bk.completed}`);
  check("cancelled", bk.byStatus.cancelled === 2);
  check("expired", bk.byStatus.expired === 1);
  check("rejected", bk.byStatus.rejected === 1);
  check("unattended present (no disappearance)", bk.byStatus.unattended === 1 && bk.unattended === 1);
  check("active = req+acc+conf+prog", bk.active === EXP.active, `got ${bk.active}`);
  check("lost = canc+exp+rej+unatt", bk.lost === EXP.lost, `got ${bk.lost}`);

  const fin = body.totals.financial;
  check("paidBookings excludes testMode", fin.paidBookings === EXP.paidBookings, `got ${fin.paidBookings}`);
  check("grossCollected", fin.grossCollected === EXP.gross, `got ${fin.grossCollected}`);
  check("discounts", fin.discounts === EXP.discounts, `got ${fin.discounts}`);
  check("refunds = processed+manual only", fin.refunds === EXP.refunds, `got ${fin.refunds}`);
  check("netCollected", fin.netCollected === EXP.net, `got ${fin.netCollected}`);
  check("platformEarnings pro-rata", fin.platformEarnings === EXP.platform, `got ${fin.platformEarnings}`);
  check("cookEarnings remainder", fin.cookEarnings === EXP.cook, `got ${fin.cookEarnings}`);
  check("avgBookingValue", fin.avgBookingValue === EXP.avg, `got ${fin.avgBookingValue}`);
  check("cookPaid settled only", fin.cookPaid === EXP.cookPaid, `got ${fin.cookPaid}`);
  check("cookPending eligible only", fin.cookPending === EXP.cookPending, `got ${fin.cookPending}`);

  const svc = body.totals.service;
  check("scheduledHours", svc.scheduledHours === EXP.schedHours, `got ${svc.scheduledHours}`);
  check("completedHours", svc.completedHours === EXP.compHours, `got ${svc.completedHours}`);

  const sumStatuses =
    bk.byStatus.requested + bk.byStatus.accepted + bk.byStatus.confirmed +
    bk.byStatus.in_progress + bk.byStatus.completed + bk.byStatus.cancelled +
    bk.byStatus.expired + bk.byStatus.rejected + bk.byStatus.unattended + bk.byStatus.unknown;
  check("RECON: status sum == total", sumStatuses === bk.total, `${sumStatuses} vs ${bk.total}`);
  check("RECON: gross - refunds == net", fin.grossCollected - fin.refunds === fin.netCollected);
  check("RECON: platform + cook == net", fin.platformEarnings + fin.cookEarnings === fin.netCollected, `${fin.platformEarnings}+${fin.cookEarnings} vs ${fin.netCollected}`);
  check("RECON: active+completed+lost == total", bk.active + bk.completed + bk.lost === bk.total, `${bk.active}+${bk.completed}+${bk.lost} vs ${bk.total}`);
  const durSum = (body.byHours || []).reduce((a, r) => a + r.bookings, 0);
  check("RECON: duration buckets == valid-duration rows", durSum === FIXTURES.filter((b) => b.durationHours >= 1 && b.durationHours <= 4).length, `got ${durSum}`);
  const trendSum = (body.monthlyTrend || []).reduce((a, r) => a + r.bookings, 0);
  check("RECON: monthly bookings == total (unfiltered)", trendSum === bk.total, `got ${trendSum}`);
  const puneRow = (body.topAreas || []).find((r) => r.key === "pune");
  check("areas normalize Pune variants", puneRow && puneRow.bookings === EXP.pune, `got ${JSON.stringify(puneRow)}`);
  const cookIds = new Set((body.topCooks || []).map((r) => r.cookId));
  check("cooks grouped by immutable id", cookIds.size >= 3, `got ${cookIds.size}`);
  check("unknown statuses exposed", Array.isArray(body.meta?.unknownStatuses));
  check("meta states service-date dimension", /service date/i.test(body.meta?.dateDimensionMeaning || ""));
  check("no NaN in financials", Object.values(fin).every((v) => typeof v !== "number" || Number.isFinite(v)));

  check("legacy revenue alias == net", body.totals.revenue === fin.netCollected);
  check("legacy commission alias == platform", body.totals.commission === fin.platformEarnings);
  check("legacy cookPayouts alias == cook net", body.totals.cookPayouts === fin.cookEarnings);

  Booking.aggregate = async () => [buildTestFacet([])];
  const bad1 = await runHandler({ from: "2026-10-01", to: "2026-09-01" });
  check("from>to -> 400", bad1.statusCode === 400, `got ${bad1.statusCode}`);
  const bad2 = await runHandler({ dateField: "$where" });
  check("operator dateField -> 400", bad2.statusCode === 400, `got ${bad2.statusCode}`);
  const empty = await runHandler({});
  check("empty DB -> zeros not NaN", empty.body.totals.bookings.total === 0 && empty.body.totals.financial.netCollected === 0 && empty.body.monthlyTrend.length === 0);
  Booking.aggregate = realAggregate;

  // ── 4. security ──
  console.log("\n═══ analytics security ═══");
  const layer = analyticsRouter.stack.find((l) => l.route && l.route.path === "/bookings");
  const mwNames = layer.route.stack.map((s) => s.handle.name || "anon");
  check("route has 3 layers (auth, authorize, handler)", layer.route.stack.length === 3, mwNames.join(","));
  const runAuth = (headers, account) =>
    new Promise((resolve) => {
      User.findById = () => ({ select: () => ({ lean: async () => account }) });
      const h = {};
      for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = v;
      const req = {
        headers: h,
        cookies: {},
        method: "GET",
        header: (n) => h[String(n).toLowerCase()] || "",
      };
      const res = { statusCode: 200, body: null };
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (p) => { res.body = p; resolve(res); return res; };
      let nextCalled = false;
      auth(req, res, () => { nextCalled = true; resolve({ statusCode: 200, next: true, req }); });
      setTimeout(() => { if (!nextCalled && !res.body) resolve(res); }, 50);
    });
  const adminToken = jwt.sign({ id: "a1" }, process.env.JWT_SECRET);
  const mkAuth = (t) => ({ authorization: `Bearer ${t}` });
  let r = await runAuth({}, { _id: "a1", role: "admin", status: "active", tokenVersion: 0 });
  check("unauthenticated -> 401", r.statusCode === 401, `got ${r.statusCode}`);
  r = await runAuth({ authorization: "Bearer invalid.token.here" }, { _id: "a1", role: "admin", status: "active", tokenVersion: 0 });
  check("invalid JWT -> 401", r.statusCode === 401, `got ${r.statusCode}`);
  const expired = jwt.sign({ id: "a1", exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
  r = await runAuth(mkAuth(expired), { _id: "a1", role: "admin", status: "active", tokenVersion: 0 });
  check("expired JWT -> 401", r.statusCode === 401, `got ${r.statusCode}`);
  r = await runAuth(mkAuth(adminToken), null);
  check("deleted account -> 401", r.statusCode === 401, `got ${r.statusCode}`);
  r = await runAuth(mkAuth(adminToken), { _id: "a1", role: "admin", status: "suspended", tokenVersion: 0 });
  check("suspended admin -> 403", r.statusCode === 403, `got ${r.statusCode}`);
  const stale = jwt.sign({ id: "a1" }, process.env.JWT_SECRET); // no tv claim
  r = await runAuth(mkAuth(stale), { _id: "a1", role: "admin", status: "active", tokenVersion: 3 });
  check("tokenVersion mismatch -> 401", r.statusCode === 401, `got ${r.statusCode}`);
  r = await runAuth(mkAuth(adminToken), { _id: "a1", role: "admin", status: "active", tokenVersion: 0 });
  check("admin -> allowed", r.next === true && r.req.user.role === "admin");

  const { authorize } = require("./middleware/auth");
  const runAuthorize = (role) =>
    new Promise((resolve) => {
      const req = { user: role ? { id: "x", role } : undefined };
      const res = { statusCode: 200, body: null };
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (p) => { res.body = p; resolve(res); return res; };
      authorize("admin")(req, res, () => resolve({ statusCode: 200, next: true }));
    });
  r = await runAuthorize("customer");
  check("customer -> 403", r.statusCode === 403, `got ${r.statusCode}`);
  r = await runAuthorize("cook");
  check("cook -> 403", r.statusCode === 403, `got ${r.statusCode}`);
  r = await runAuthorize("admin");
  check("admin role -> authorize passes", r.next === true);
  r = await runAuthorize(undefined);
  check("missing user -> 403 (fail closed)", r.statusCode === 403, `got ${r.statusCode}`);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
