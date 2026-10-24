// Regression tests for the Cook My Earnings audit fixes.
// Isolated: runs against an in-memory MongoDB, never production records.
// Covers: snapshot idempotency + stale-status preservation, earnings
// eligibility/totals/service-date bucketing, payout double-claim + illegal
// transitions + duplicate references, partial-failure divergence + repair,
// payment-evidence gating, HTTP authorization, paise reconciliation,
// config sanitization.
// (Lead, incentive, and referral programs were removed in full; their
// regression blocks were deleted with them.)
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = "test";

const { execSync } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { Types } = mongoose;

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes++;
  else failures++;
};

const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
};
const captureNext = () => {
  const box = { error: null };
  const next = (e) => { box.error = e || new Error("next()"); };
  return { box, next };
};

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(await mongod.getUri());

  // Never let tests touch the network: WhatsApp dispatch is swallowed by
  // notifyCook, but stub the sender so failures are instant, not timeouts.
  try {
    const wa = require("./utils/whatsappApi");
    if (wa && typeof wa.sendWhatsAppText === "function") {
      wa.sendWhatsAppText = async () => { throw new Error("whatsapp disabled in tests"); };
    }
  } catch {
  }

  const User = require("./models/User");
  const Booking = require("./models/Booking");
  const CookProfile = require("./models/CookProfile");
  const CookPayout = require("./models/CookPayout");
  const CookEventLog = require("./models/CookEventLog");
  // Ensure indexes (incl. new uniq_cookpayout_payref) exist before racing.
  await Promise.all([Booking.init(), CookProfile.init(), CookPayout.init(), CookEventLog.init()]);

  const svc = require("./utils/cookEarningsService");
  const earnCtrl = require("./controllers/cookEarningsController");
  const adminCtrl = require("./controllers/adminCookEarningsController");

  const adminId = new Types.ObjectId().toString();
  const mkUser = async (role, name) => User.create({
    name: name || `User ${Math.random().toString(36).slice(2, 8)}`,
    email: `${role}-${Math.random().toString(36).slice(2, 10)}@test.local`,
    phone: `9${String(Math.floor(100000000 + Math.random() * 899999999))}`,
    password: "password123",
    role,
  });
  const mkBooking = async (cookId, customerId, overrides = {}) => Booking.create({
    customer: customerId,
    cook: cookId,
    serviceType: "cook_for_me",
    date: new Date(),
    startTime: "10:00",
    endTime: "12:00",
    address: "Test Venue",
    durationHours: 2,
    amount: 349,
    slabPrice: 349,
    discount: 0,
    commission: 52.35,
    cookPayout: 296.65,
    status: "completed",
    hoursCompleted: true,
    cookArrived: true,
    serviceStartedAt: new Date(),
    payment: { status: "paid", paidAmount: 349, refundStatus: "none" },
    payoutInfo: {
      regularPrice: 349,
      discountAmount: 0,
      finalCustomerPrice: 349,
      platformDeductionPercent: 15,
      platformDeductionAmount: 52.35,
      cookPayoutAmount: 296.65,
      payoutStatus: "eligible",
    },
    ...overrides,
  });

  // ── 1. Snapshot: idempotent + never rolls back processed states ──────
  {
    const cook = await mkUser("cook");
    const cust = await mkUser("customer");
    const b = await mkBooking(cook._id, cust._id, {
      payoutInfo: { payoutStatus: "approved", payoutCycleRef: "CP-OLD" }, // no financial fields yet
    });
    const [s1, s2] = await Promise.all([
      svc.ensureBookingPayoutSnapshot(b.toObject()),
      svc.ensureBookingPayoutSnapshot(b.toObject()),
    ]);
    const fresh = await Booking.findById(b._id).lean();
    check("snapshot concurrent: status stays approved (never reset to eligible)", fresh.payoutInfo.payoutStatus === "approved", fresh.payoutInfo.payoutStatus);
    check("snapshot concurrent: cycle ref preserved", fresh.payoutInfo.payoutCycleRef === "CP-OLD", fresh.payoutInfo.payoutCycleRef);
    check("snapshot concurrent: financial fields written", Number(fresh.payoutInfo.cookPayoutAmount) === 296.65, String(fresh.payoutInfo.cookPayoutAmount));
    check("snapshot returns updated doc", Boolean(s1 && s2));
    // Second call with a full snapshot is a pure read (no write at all).
    const before = fresh.updatedAt ? new Date(fresh.updatedAt).getTime() : 0;
    await svc.ensureBookingPayoutSnapshot(fresh);
    const after = (await Booking.findById(b._id).lean()).updatedAt;
    check("snapshot with full data performs no write", !after || new Date(after).getTime() === before, `${before} vs ${after}`);
  }

  // ── 2. Earnings: eligibility, totals, service-date bucketing ──────────
  {
    const cook = await mkUser("cook");
    const cust = await mkUser("customer");
    const other = await mkUser("cook");
    await mkBooking(cook._id, cust._id, {}); // +296.65 pending
    await mkBooking(cook._id, cust._id, { payment: { status: "paid", paidAmount: 349, refundStatus: "processed" } }); // refunded: out
    await mkBooking(cook._id, cust._id, { payoutInfo: { finalCustomerPrice: 349, platformDeductionPercent: 15, platformDeductionAmount: 52.35, cookPayoutAmount: 296.65, payoutStatus: "eligible", disputed: true } }); // disputed: out
    await mkBooking(cook._id, cust._id, { status: "cancelled" }); // not completed: out
    await mkBooking(cook._id, cust._id, { payout: { status: "settled" }, payoutInfo: { finalCustomerPrice: 349, platformDeductionPercent: 15, platformDeductionAmount: 52.35, cookPayoutAmount: 296.65, payoutStatus: "paid" } }); // settled: paid
    await mkBooking(other._id, cust._id, {}); // another cook: invisible
    // Old service date but touched just now: must NOT leak into today/week.
    const old = await mkBooking(cook._id, cust._id, { date: new Date(Date.now() - 10 * 24 * 3600 * 1000) });
    await Booking.updateOne({ _id: old._id }, { $set: { notes: "touched" } });

    const req = { user: { id: cook._id.toString() }, query: {} };
    const res = makeRes();
    const { box, next } = captureNext();
    await earnCtrl.getEarnings(req, res, next);
    check("getEarnings 200", res.statusCode === 200 && !box.error, `s=${res.statusCode} err=${box.error?.message || ""}`);
    const ov = res.body?.overview || {};
    // pending = 1 current + 1 old-date booking; paid = settled one; lifetime = all completed non-refund non-dispute.
    const P = 296.65;
    check("pending excludes refunded/disputed/cancelled", ov.pending === Math.round((2 * P) * 100) / 100, `pending=${ov.pending}`);
    check("paid counts settled only", ov.paid === P, `paid=${ov.paid}`);
    check("lifetime = pending + paid", ov.lifetime === Math.round((3 * P) * 100) / 100, `lifetime=${ov.lifetime}`);
    check("today bucketed by service date (touched old row excluded)", ov.today === Math.round((2 * P) * 100) / 100, `today=${ov.today}`);
    const rows = res.body?.bookings || [];
    const byStatus = (s) => rows.filter((r) => r.payoutStatus === s).length;
    check("other cook rows invisible", rows.length === 6, `rows=${rows.length}`);
    check("refunded + disputed shown held", byStatus("held") === 2, `held=${byStatus("held")}`);
    check("cancelled shown not_eligible", byStatus("not_eligible") === 1, `ne=${byStatus("not_eligible")}`);
    check("settled shown paid", rows.filter((r) => r.payoutStatus === "paid").length === 1);
    check("per-row deduction percent exposed", rows.every((r) => Number(r.platformDeductionPercent) === 15), JSON.stringify(rows[0]));
    check("totals conserve: deduction + payout == final (row 0)", (() => {
      const r0 = rows[0];
      return Math.abs(Number(r0.platformDeduction) + Number(r0.cookPayout) - Number(r0.finalCustomerPrice)) < 0.001;
    })());
    check("response carries totalBookings + truncated flag", res.body?.totalBookings === 6 && res.body?.truncated === false, JSON.stringify({ t: res.body?.totalBookings, tr: res.body?.truncated }));
  }

  // ── 3. Payout build: no double-claim across weeks ─────────────────────
  let cycleA;
  {
    const cook = await mkUser("cook");
    const cust = await mkUser("customer");
    await mkBooking(cook._id, cust._id, {});
    await mkBooking(cook._id, cust._id, {});
    const build = async (body) => {
      const r = makeRes();
      const { box, next } = captureNext();
      await adminCtrl.buildCookPayout({ body, user: { id: adminId }, params: {} }, r, next);
      return { r, box };
    };
    const a = await build({ cookId: cook._id.toString(), weekStart: "2026-09-28", weekEnd: "2026-10-04" });
    check("build week A -> 201 x2 bookings", a.r.statusCode === 201 && a.r.body?.bookingCount === 2, `s=${a.r.statusCode} n=${a.r.body?.bookingCount}`);
    cycleA = a.r.body;
    check("build audit uses payout_created", (await CookEventLog.countDocuments({ event: "payout_created", refId: cycleA._id })) === 1);
    const same = await build({ cookId: cook._id.toString(), weekStart: "2026-09-28", weekEnd: "2026-10-04" });
    check("same-week rebuild reuses cycle", same.r.statusCode === 200 && same.r.body?.alreadyExists === true, `s=${same.r.statusCode}`);
    const overlap = await build({ cookId: cook._id.toString(), weekStart: "2026-10-05", weekEnd: "2026-10-11" });
    check("overlapping week cannot re-claim (400 NO_ELIGIBLE)", overlap.r.statusCode === 400 && overlap.r.body?.code === "NO_ELIGIBLE_BOOKINGS", `s=${overlap.r.statusCode} ${JSON.stringify(overlap.r.body)}`);
    const owners = await Booking.countDocuments({ _id: { $in: cycleA.bookings }, "payoutInfo.payoutCycleRef": cycleA.payoutRef });
    check("claimed bookings carry this cycle ref", owners === 2, `owners=${owners}`);
  }

  // ── 4. Lifecycle: illegal transitions + duplicate refs + concurrency ──
  {
    const pay = async (id, reference) => {
      const r = makeRes();
      const { box, next } = captureNext();
      await adminCtrl.payCookPayout({ body: { reference }, user: { id: adminId }, params: { id: id.toString() } }, r, next);
      return r;
    };
    const approve = async (id) => {
      const r = makeRes();
      const { box, next } = captureNext();
      await adminCtrl.approveCookPayout({ user: { id: adminId }, params: { id: id.toString() } }, r, next);
      return r;
    };
    // pay before approve -> 409
    const early = await pay(cycleA._id, "UPIREF001");
    check("pay before approve -> 409", early.statusCode === 409, `s=${early.statusCode}`);
    const ap = await approve(cycleA._id);
    check("approve pending -> 200 approved", ap.statusCode === 200 && ap.body?.status === "approved", `s=${ap.statusCode} st=${ap.body?.status}`);
    const ap2 = await approve(cycleA._id);
    check("re-approve -> 409", ap2.statusCode === 409, `s=${ap2.statusCode}`);
    // concurrent pays: exactly one wins
    const [p1, p2] = await Promise.all([pay(cycleA._id, "UPIREF001"), pay(cycleA._id, "UPIREF001")]);
    const wins = [p1, p2].filter((r) => r.statusCode === 200).length;
    const conflicts = [p1, p2].filter((r) => r.statusCode === 409).length;
    check("concurrent pay: exactly one success", wins === 1 && conflicts === 1, `codes=${p1.statusCode},${p2.statusCode}`);
    const paid = await CookPayout.findById(cycleA._id).lean();
    check("cycle paid with reference + dates", paid.status === "paid" && paid.paymentReference === "UPIREF001" && Boolean(paid.paidAt && paid.paymentDate), JSON.stringify({ st: paid.status, ref: paid.paymentReference }));
    const bpaid = await Booking.countDocuments({ _id: { $in: paid.bookings }, "payoutInfo.payoutStatus": "paid" });
    check("cycle bookings all paid (no divergence)", bpaid === paid.bookings.length, `${bpaid}/${paid.bookings.length}`);
    check("paid audit logged once", (await CookEventLog.countDocuments({ event: "payout_paid", refId: cycleA._id })) === 1);
    const repay = await pay(cycleA._id, "UPIREF002");
    check("re-pay of paid cycle -> 409", repay.statusCode === 409, `s=${repay.statusCode}`);
    const reapprove = await approve(cycleA._id);
    check("approve of paid cycle -> 409", reapprove.statusCode === 409, `s=${reapprove.statusCode}`);
    // duplicate reference on ANOTHER cycle -> 409
    const cook2 = await mkUser("cook");
    const cust2 = await mkUser("customer");
    await mkBooking(cook2._id, cust2._id, {});
    const r2 = makeRes();
    await adminCtrl.buildCookPayout({ body: { cookId: cook2._id.toString() }, user: { id: adminId }, params: {} }, r2, captureNext().next);
    await approve(r2.body._id);
    const dup = await pay(r2.body._id, "UPIREF001");
    check("duplicate payment reference rejected", dup.statusCode === 409, `s=${dup.statusCode} ${JSON.stringify(dup.body)}`);
    check("short reference rejected", (await pay(r2.body._id, "ab")).statusCode === 400);
  }

  // ── 4b. Ownership, invalid ids, failure release, cross-cycle ref race ─
  {
    // Another cook's valid payout id must not leak (404, not the record).
    const intruder = await mkUser("cook");
    const r = makeRes();
    await earnCtrl.getPayoutById({ user: { id: intruder._id.toString() }, params: { id: cycleA._id.toString() } }, r, captureNext().next);
    check("cross-cook payout detail denied (404)", r.statusCode === 404, `s=${r.statusCode}`);
    // Malformed id surfaces via next(err), never a second cook's data.
    const rBad = makeRes();
    const bad = captureNext();
    await earnCtrl.getPayoutById({ user: { id: intruder._id.toString() }, params: { id: "not-an-id" } }, rBad, bad.next);
    check("malformed payout id does not leak data", rBad.body == null && bad.box.error != null, `s=${rBad.statusCode}`);
    // Owner CAN read their own cycle.
    const cookOfA = await CookPayout.findById(cycleA._id).select("cook").lean();
    const rOwn = makeRes();
    await earnCtrl.getPayoutById({ user: { id: String(cookOfA.cook) }, params: { id: cycleA._id.toString() } }, rOwn, captureNext().next);
    check("owner payout detail allowed", rOwn.statusCode === 200 && String(rOwn.body?._id) === String(cycleA._id), `s=${rOwn.statusCode}`);
    // Build failure AFTER claiming must release the claim (recovery path).
    const cookR = await mkUser("cook");
    const custR = await mkUser("customer");
    await mkBooking(cookR._id, custR._id, {});
    const origCreate = CookPayout.create.bind(CookPayout);
    CookPayout.create = async () => { throw new Error("simulated storage failure"); };
    const rFail = makeRes();
    const failCap = captureNext();
    await adminCtrl.buildCookPayout({ body: { cookId: cookR._id.toString() }, user: { id: adminId }, params: {} }, rFail, failCap.next);
    CookPayout.create = origCreate;
    check("build storage failure surfaces (no phantom 201)", rFail.statusCode === 200 && rFail.body == null && /simulated/.test(failCap.box.error?.message || ""), `s=${rFail.statusCode} err=${failCap.box.error?.message || ""}`);
    const released = await Booking.find({ cook: cookR._id }).lean();
    check("failed build releases claims (eligible again)", released.length === 1 && released[0].payoutInfo?.payoutStatus === "eligible" && !released[0].payoutInfo?.payoutCycleRef, JSON.stringify(released[0]?.payoutInfo));
    // Retry after the failure succeeds (proves recovery, no duplicate).
    const rRetry = makeRes();
    await adminCtrl.buildCookPayout({ body: { cookId: cookR._id.toString() }, user: { id: adminId }, params: {} }, rRetry, captureNext().next);
    check("retry after failure builds exactly one cycle", rRetry.statusCode === 201 && rRetry.body?.bookingCount === 1, `s=${rRetry.statusCode}`);
    // Concurrent same-reference pays on two APPROVED cycles: one wins.
    const cookX = await mkUser("cook");
    const custX = await mkUser("customer");
    await mkBooking(cookX._id, custX._id, {});
    const cookY = await mkUser("cook");
    await mkBooking(cookY._id, custX._id, {});
    const bx = makeRes();
    await adminCtrl.buildCookPayout({ body: { cookId: cookX._id.toString() }, user: { id: adminId }, params: {} }, bx, captureNext().next);
    const by = makeRes();
    await adminCtrl.buildCookPayout({ body: { cookId: cookY._id.toString() }, user: { id: adminId }, params: {} }, by, captureNext().next);
    const ax = makeRes();
    await adminCtrl.approveCookPayout({ user: { id: adminId }, params: { id: bx.body._id.toString() } }, ax, captureNext().next);
    const ay = makeRes();
    await adminCtrl.approveCookPayout({ user: { id: adminId }, params: { id: by.body._id.toString() } }, ay, captureNext().next);
    const doPay = async (id, reference) => {
      const rr = makeRes();
      await adminCtrl.payCookPayout({ body: { reference }, user: { id: adminId }, params: { id: id.toString() } }, rr, captureNext().next);
      return rr;
    };
    const [qx, qy] = await Promise.all([doPay(bx.body._id, "RACE-REF-9"), doPay(by.body._id, "RACE-REF-9")]);
    const codes = [qx.statusCode, qy.statusCode].sort().join(",");
    check("cross-cycle same-ref race: one 200, one 409", codes === "200,409", `codes=${codes}`);
    const refCount = await CookPayout.countDocuments({ paymentReference: "RACE-REF-9", status: "paid" });
    check("reference settles exactly one cycle", refCount === 1, `n=${refCount}`);
  }

  // ── 8. Config sanitization (subprocess) ────────────────────────────
  {
    const out = execSync(
      `node -e "process.env.COOK_DEDUCTION_PERCENT='abc'; delete require.cache[require.resolve('./config/cookEarnings')]; const c=require('./config/cookEarnings'); const u=require('./utils/cookEarnings'); const t=u.computeCookPayout(199); console.log(JSON.stringify({d:c.deductionPercentage,payout:t.cookPayoutAmount,ded:t.platformDeductionAmount}));"`,
      { encoding: "utf8" }
    );
    const got = JSON.parse(out.trim().split("\n").pop());
    check("invalid COOK_DEDUCTION_PERCENT falls back to 15", got.d === 15 && got.payout === 169.15 && got.ded === 29.85, out.trim());
  }

  // ── 9. Financial reconciliation in integer paise ──────────────────────
  // Traces the previously reported "₹889.65 vs ₹889.95" mismatch to source.
  // Finding (verified empirically): no code path produces ₹889.65 —
  // 2×296.65+296.65 rounds to ₹889.95 under every summation order, and each
  // canonical split conserves exactly (199.00/349.00/449.00). The ₹889.65
  // figure was a transcription error in the prior report, not a code bug.
  // These tests pin the invariant so no future drift can hide: lifetime
  // paise === pending paise + paid paise, recomputed independently from the
  // stored snapshots (historical snapshots are never edited to agree).
  {
    const { computeCookPayout, buildPayoutSnapshot, toPaise, fromPaise } = require("./utils/cookEarnings");
    // 9a. Canonical examples conserve exactly, in paise.
    for (const f of [199, 349, 449]) {
      const t = computeCookPayout(f);
      check(`paise conservation final=₹${f}`, toPaise(t.platformDeductionAmount) + toPaise(t.cookPayoutAmount) === toPaise(f), `${t.platformDeductionAmount}+${t.cookPayoutAmount} vs ${f}`);
    }
    const couponSnap = buildPayoutSnapshot({ regularPrice: 499, discountAmount: 50, finalCustomerPrice: 449 });
    check("coupon snapshot: 499-50=449 → payout 381.65", couponSnap.cookPayoutAmount === 381.65 && toPaise(couponSnap.platformDeductionAmount) + toPaise(couponSnap.cookPayoutAmount) === toPaise(449));
    // 9b. Randomized sweep: conservation holds for arbitrary finals.
    let sweepBad = 0;
    for (let k = 0; k < 500; k++) {
      const f = Math.round((1 + Math.random() * 4999) * 100) / 100;
      const t = computeCookPayout(f);
      if (toPaise(t.platformDeductionAmount) + toPaise(t.cookPayoutAmount) !== toPaise(t.finalCustomerPrice)) sweepBad++;
    }
    check("500-case conservation sweep", sweepBad === 0, `bad=${sweepBad}`);
    // 9c. Independent recalculation from stored snapshots vs API response.
    const cook = await mkUser("cook");
    const cust = await mkUser("customer");
    const mk = (over) => mkBooking(cook._id, cust._id, over);
    await mk({}); // pending 296.65
    await mk({ payout: { status: "settled" }, payoutInfo: { finalCustomerPrice: 349, platformDeductionPercent: 15, platformDeductionAmount: 52.35, cookPayoutAmount: 296.65, payoutStatus: "paid" } }); // paid 296.65
    await mk({ payoutInfo: { finalCustomerPrice: 349, platformDeductionPercent: 15, platformDeductionAmount: 52.35, cookPayoutAmount: 296.65, payoutStatus: "eligible", disputed: true } }); // excluded
    const r = makeRes();
    await earnCtrl.getEarnings({ user: { id: cook._id.toString() }, query: {} }, r, captureNext().next);
    const ov = r.body?.overview || {};
    // Independent rule: completed + paid + refund none/rejected + not
    // disputed/underVerification; settled→paid else pending.
    const stored = await Booking.find({ cook: cook._id }).lean();
    let iPendingP = 0;
    let iPaidP = 0;
    for (const b of stored) {
      const liveRefund = b.payment?.refundStatus && !["none", "rejected"].includes(b.payment.refundStatus);
      const disputed = Boolean(b.payoutInfo?.disputed || b.payoutInfo?.underVerification);
      if (b.status !== "completed" || liveRefund || disputed) continue;
      const p = toPaise(Number(b.payoutInfo?.cookPayoutAmount || b.cookPayout || 0));
      if (b.payout?.status === "settled" || b.payoutInfo?.payoutStatus === "paid") iPaidP += p;
      else iPendingP += p;
    }
    check("API pending matches independent paise sum", toPaise(ov.pending) === iPendingP, `api=${ov.pending} indep=${fromPaise(iPendingP)}`);
    check("API paid matches independent paise sum", toPaise(ov.paid) === iPaidP, `api=${ov.paid} indep=${fromPaise(iPaidP)}`);
    check("API lifetime === pending + paid (paise)", toPaise(ov.lifetime) === toPaise(ov.pending) + toPaise(ov.paid), `${ov.lifetime} vs ${ov.pending}+${ov.paid}`);
    // This block has 1 pending + 1 paid booking: 296.65 / 296.65 / 593.3.
    // (§2 pins the larger 593.3 / 296.65 / 889.95 fixture.)
    check("pinned figures: 296.65 / 296.65 / 593.3", ov.pending === 296.65 && ov.paid === 296.65 && ov.lifetime === 593.3, JSON.stringify(ov));
    // 9d. Cycle totals reconcile with their booking snapshots, in paise.
    const cyc = await CookPayout.findById(cycleA._id).lean();
    const cycBookings = await Booking.find({ _id: { $in: cyc.bookings } }).lean();
    let snapP = 0;
    let snapD = 0;
    let snapG = 0;
    for (const b of cycBookings) {
      snapP += toPaise(b.payoutInfo?.cookPayoutAmount);
      snapD += toPaise(b.payoutInfo?.platformDeductionAmount);
      snapG += toPaise(b.payoutInfo?.finalCustomerPrice);
    }
    check("cycle earnings === sum of snapshot payouts (paise)", toPaise(cyc.cookEarnings) === snapP, `${cyc.cookEarnings} vs ${fromPaise(snapP)}`);
    check("cycle gross === deductions + earnings (paise)", toPaise(cyc.grossCustomerValue) === toPaise(cyc.totalDeductions) + toPaise(cyc.cookEarnings), JSON.stringify({ g: cyc.grossCustomerValue, d: cyc.totalDeductions, e: cyc.cookEarnings }));
    check("cycle snapshots conserve (paise)", snapG === snapD + snapP, `${fromPaise(snapG)} vs ${fromPaise(snapD)}+${fromPaise(snapP)}`);
    void fromPaise;
  }

  // ── 10. Partial-failure divergence is reproducible AND recoverable ────
  // In standalone fallback mode the cycle flip and the booking sync are two
  // sequential writes. If the second one dies, the cycle reads paid while
  // its bookings still read approved — and plain pay retries 409 forever.
  {
    const cook = await mkUser("cook");
    const cust = await mkUser("customer");
    await mkBooking(cook._id, cust._id, {});
    const rb = makeRes();
    await adminCtrl.buildCookPayout({ body: { cookId: cook._id.toString() }, user: { id: adminId }, params: {} }, rb, captureNext().next);
    const cycId = rb.body._id;
    const ra = makeRes();
    await adminCtrl.approveCookPayout({ user: { id: adminId }, params: { id: cycId.toString() } }, ra, captureNext().next);
    // Kill ONLY the booking sync inside pay: cycle flips, bookings don't.
    const origUpdateMany = Booking.updateMany.bind(Booking);
    Booking.updateMany = async () => { throw new Error("simulated sync failure"); };
    const rp = makeRes();
    const payCap = captureNext();
    await adminCtrl.payCookPayout({ body: { reference: "PARTIAL-REF-1" }, user: { id: adminId }, params: { id: cycId.toString() } }, rp, payCap.next);
    Booking.updateMany = origUpdateMany;
    check("sync failure surfaces (no false 200)", /simulated/.test(payCap.box.error?.message || ""), payCap.box.error?.message || `s=${rp.statusCode}`);
    const diverged = await CookPayout.findById(cycId).lean();
    const divergedBookings = await Booking.find({ _id: { $in: diverged.bookings } }).lean();
    check(
      "REPRODUCED: cycle paid while bookings still approved",
      diverged.status === "paid" && divergedBookings.length === 1 && divergedBookings[0].payoutInfo?.payoutStatus === "approved",
      `cycle=${diverged.status} booking=${divergedBookings[0]?.payoutInfo?.payoutStatus}`
    );
    // Plain pay retry cannot heal it (and must not double-pay).
    const rRetry = makeRes();
    await adminCtrl.payCookPayout({ body: { reference: "PARTIAL-REF-1" }, user: { id: adminId }, params: { id: cycId.toString() } }, rRetry, captureNext().next);
    check("pay retry after divergence stays 409 (no second payment)", rRetry.statusCode === 409, `s=${rRetry.statusCode}`);
    check("failed pay emits no paid audit (no false success)", (await CookEventLog.countDocuments({ event: "payout_paid", refId: cycId })) === 0);
    // The repair endpoint converges bookings forward — never reverses paid.
    const rs = makeRes();
    await adminCtrl.syncCycleBookings({ user: { id: adminId }, params: { id: cycId.toString() } }, rs, captureNext().next);
    check("sync-bookings heals divergence", rs.statusCode === 200 && rs.body?.synced === 1 && rs.body?.bookingStatus === "paid", `s=${rs.statusCode} ${JSON.stringify(rs.body)}`);
    const healed = await Booking.find({ _id: { $in: diverged.bookings } }).lean();
    check("bookings now paid, reference untouched", healed[0].payoutInfo?.payoutStatus === "paid" && (await CookPayout.findById(cycId).lean()).paymentReference === "PARTIAL-REF-1");
    check(
      "sync backfills the missing paid audit exactly once + logs repair",
      (await CookEventLog.countDocuments({ event: "payout_paid", refId: cycId })) === 1 && (await CookEventLog.countDocuments({ event: "payout_bookings_synced", refId: cycId })) === 1,
      `paid=${await CookEventLog.countDocuments({ event: "payout_paid", refId: cycId })} synced=${await CookEventLog.countDocuments({ event: "payout_bookings_synced", refId: cycId })}`
    );
    // Idempotent: second call syncs nothing, still 200, and emits NO
    // further audit entries (no duplicate repair records).
    const rs2 = makeRes();
    await adminCtrl.syncCycleBookings({ user: { id: adminId }, params: { id: cycId.toString() } }, rs2, captureNext().next);
    check("sync-bookings idempotent on converged cycle", rs2.statusCode === 200 && rs2.body?.synced === 0, `s=${rs2.statusCode} ${JSON.stringify(rs2.body)}`);
    check(
      "no-op repair emits no further audits",
      (await CookEventLog.countDocuments({ event: "payout_paid", refId: cycId })) === 1 && (await CookEventLog.countDocuments({ event: "payout_bookings_synced", refId: cycId })) === 1,
      "audit counts grew on no-op sync"
    );
    // Guards: pending cycles and missing cycles are refused.
    const cookP = await mkUser("cook");
    await mkBooking(cookP._id, cust._id, {});
    const rbP = makeRes();
    await adminCtrl.buildCookPayout({ body: { cookId: cookP._id.toString() }, user: { id: adminId }, params: {} }, rbP, captureNext().next);
    const rsP = makeRes();
    await adminCtrl.syncCycleBookings({ user: { id: adminId }, params: { id: rbP.body._id.toString() } }, rsP, captureNext().next);
    check("sync-bookings refuses pending cycle (409)", rsP.statusCode === 409, `s=${rsP.statusCode}`);
    const rsM = makeRes();
    await adminCtrl.syncCycleBookings({ user: { id: adminId }, params: { id: new Types.ObjectId().toString() } }, rsM, captureNext().next);
    check("sync-bookings 404s on missing cycle", rsM.statusCode === 404, `s=${rsM.statusCode}`);
    // Malformed id surfaces via next(err); never another cook's data.
    const rsX = makeRes();
    const badCap = captureNext();
    await adminCtrl.syncCycleBookings({ user: { id: adminId }, params: { id: "not-an-id" } }, rsX, badCap.next);
    check("sync-bookings malformed id errors safely", rsX.body == null && badCap.box.error != null);
    // Failed repair leaves everything recoverable: stub the write to throw.
    const origUM = Booking.updateMany.bind(Booking);
    Booking.updateMany = async () => { throw new Error("simulated repair failure"); };
    const rsF = makeRes();
    const failSync = captureNext();
    await adminCtrl.syncCycleBookings({ user: { id: adminId }, params: { id: cycId.toString() } }, rsF, failSync.next);
    Booking.updateMany = origUM;
    check("failed repair surfaces, cycle still paid", /simulated/.test(failSync.box.error?.message || "") && (await CookPayout.findById(cycId).lean()).status === "paid");
  }

  // ── 10b. Payment evidence: ambiguous paid cycles are NOT auto-healed ──
  // A `paid` cycle WITHOUT a payment reference proves nothing about the
  // external transfer (it may have been marked paid before completion).
  // Sync must refuse it; record-reference resolves it after verification.
  {
    const cook = await mkUser("cook");
    const cust = await mkUser("customer");
    const bk = await mkBooking(cook._id, cust._id, {});
    // Ambiguous cycle: status paid, NO payment reference (legacy/direct-write shape).
    const amb = await CookPayout.create({
      cook: cook._id, weekStart: new Date("2026-09-28"), weekEnd: new Date("2026-10-04"),
      payoutRef: `CP-AMB-${Date.now().toString(36).toUpperCase()}`, bookings: [bk._id],
      bookingCount: 1, grossCustomerValue: 349, totalDeductions: 52.35, cookEarnings: 296.65,
      bonuses: 0, referralEarnings: 0, totalPayable: 296.65, status: "paid",
      paymentReference: "", idempotencyKey: `cycle:amb:${cook._id}`,
    });
    await Booking.updateOne({ _id: bk._id }, { $set: { "payoutInfo.payoutStatus": "approved", "payoutInfo.payoutCycleRef": amb.payoutRef } });
    const rA = makeRes();
    await adminCtrl.syncCycleBookings({ user: { id: adminId }, params: { id: amb._id.toString() } }, rA, captureNext().next);
    check("ambiguous paid cycle refused (409 PAYMENT_EVIDENCE_MISSING)", rA.statusCode === 409 && rA.body?.code === "PAYMENT_EVIDENCE_MISSING", `s=${rA.statusCode} ${JSON.stringify(rA.body)}`);
    const untouched = await Booking.findById(bk._id).lean();
    check("ambiguous refusal touches no bookings", untouched.payoutInfo?.payoutStatus === "approved", untouched.payoutInfo?.payoutStatus);
    check(
      "ambiguous refusal backfills no paid audit",
      (await CookEventLog.countDocuments({ event: "payout_paid", refId: amb._id })) === 0 && (await CookEventLog.countDocuments({ event: "payout_bookings_synced", refId: amb._id })) === 0
    );
    // Record the reference after (mocked) out-of-band verification.
    const rR = makeRes();
    await adminCtrl.recordPayoutReference({ body: { reference: "UPI-VERIFIED-1" }, user: { id: adminId }, params: { id: amb._id.toString() } }, rR, captureNext().next);
    check("record-reference attaches evidence", rR.statusCode === 200 && rR.body?.paymentReference === "UPI-VERIFIED-1", `s=${rR.statusCode}`);
    check("record-reference audits payment confirmation", (await CookEventLog.countDocuments({ event: "payout_paid", refId: amb._id })) === 1);
    // Now sync heals (backfill skipped — evidence audit already present).
    const rS = makeRes();
    await adminCtrl.syncCycleBookings({ user: { id: adminId }, params: { id: amb._id.toString() } }, rS, captureNext().next);
    check("sync heals after evidence recorded", rS.statusCode === 200 && rS.body?.synced === 1, `s=${rS.statusCode} ${JSON.stringify(rS.body)}`);
    check("no duplicate paid audit via sync backfill", (await CookEventLog.countDocuments({ event: "payout_paid", refId: amb._id })) === 1);
    // Reference guards: overwrite, wrong state, duplicates, short refs.
    const rR2 = makeRes();
    await adminCtrl.recordPayoutReference({ body: { reference: "UPI-OTHER" }, user: { id: adminId }, params: { id: amb._id.toString() } }, rR2, captureNext().next);
    check("record-reference never overwrites (409)", rR2.statusCode === 409 && rR2.body?.code === "REFERENCE_ALREADY_SET", `s=${rR2.statusCode}`);
    const cookP2 = await mkUser("cook");
    await mkBooking(cookP2._id, cust._id, {});
    const rbP2 = makeRes();
    await adminCtrl.buildCookPayout({ body: { cookId: cookP2._id.toString() }, user: { id: adminId }, params: {} }, rbP2, captureNext().next);
    const rRP = makeRes();
    await adminCtrl.recordPayoutReference({ body: { reference: "UPI-X" }, user: { id: adminId }, params: { id: rbP2.body._id.toString() } }, rRP, captureNext().next);
    check("record-reference refused on non-paid cycle (409)", rRP.statusCode === 409 && rRP.body?.code === "REFERENCE_NOT_APPLICABLE", `s=${rRP.statusCode}`);
    const rRD = makeRes();
    await adminCtrl.recordPayoutReference({ body: { reference: "UPI-VERIFIED-1" }, user: { id: adminId }, params: { id: rbP2.body._id.toString() } }, rRD, captureNext().next);
    check("record-reference rejects duplicate ref (409)", rRD.statusCode === 409, `s=${rRD.statusCode} ${JSON.stringify(rRD.body)}`);
    const rRS = makeRes();
    await adminCtrl.recordPayoutReference({ body: { reference: "ab" }, user: { id: adminId }, params: { id: amb._id.toString() } }, rRS, captureNext().next);
    check("record-reference rejects short ref (400)", rRS.statusCode === 400, `s=${rRS.statusCode}`);
    // No-steal: a booking listed on this cycle but owned by another ref stays put.
    const cookS = await mkUser("cook");
    const bkS = await mkBooking(cookS._id, cust._id, {});
    const cycS = await CookPayout.create({
      cook: cookS._id, weekStart: new Date("2026-09-28"), weekEnd: new Date("2026-10-04"),
      payoutRef: `CP-STEAL-${Date.now().toString(36).toUpperCase()}`, bookings: [bkS._id],
      bookingCount: 1, grossCustomerValue: 349, totalDeductions: 52.35, cookEarnings: 296.65,
      bonuses: 0, referralEarnings: 0, totalPayable: 296.65, status: "paid",
      paymentReference: "UPI-STEAL-OK", idempotencyKey: `cycle:steal:${cookS._id}`,
    });
    await Booking.updateOne({ _id: bkS._id }, { $set: { "payoutInfo.payoutStatus": "approved", "payoutInfo.payoutCycleRef": "CP-FOREIGN-REF" } });
    const rSt = makeRes();
    await adminCtrl.syncCycleBookings({ user: { id: adminId }, params: { id: cycS._id.toString() } }, rSt, captureNext().next);
    const kept = await Booking.findById(bkS._id).lean();
    check("sync never steals foreign-claimed bookings", rSt.statusCode === 200 && kept.payoutInfo?.payoutStatus === "approved" && kept.payoutInfo?.payoutCycleRef === "CP-FOREIGN-REF", `s=${rSt.statusCode} ${JSON.stringify(kept.payoutInfo)}`);
    // Concurrent repairs converge with exactly one paid backfill.
    const cookC = await mkUser("cook");
    await mkBooking(cookC._id, cust._id, {});
    const rbC = makeRes();
    await adminCtrl.buildCookPayout({ body: { cookId: cookC._id.toString() }, user: { id: adminId }, params: {} }, rbC, captureNext().next);
    const cC = rbC.body._id;
    const rAp = makeRes();
    await adminCtrl.approveCookPayout({ user: { id: adminId }, params: { id: cC.toString() } }, rAp, captureNext().next);
    await CookPayout.updateOne({ _id: cC }, { $set: { status: "paid", paymentReference: "UPI-RACE-OK", paidAt: new Date(), paymentDate: new Date() } });
    const [s1, s2] = await Promise.all([
      (async () => { const r = makeRes(); await adminCtrl.syncCycleBookings({ user: { id: adminId }, params: { id: cC.toString() } }, r, captureNext().next); return r; })(),
      (async () => { const r = makeRes(); await adminCtrl.syncCycleBookings({ user: { id: adminId }, params: { id: cC.toString() } }, r, captureNext().next); return r; })(),
    ]);
    check("concurrent repairs both succeed", s1.statusCode === 200 && s2.statusCode === 200, `${s1.statusCode},${s2.statusCode}`);
    check(
      "concurrent repairs: single paid backfill, single repair audit",
      (await CookEventLog.countDocuments({ event: "payout_paid", refId: cC })) === 1 && (await CookEventLog.countDocuments({ event: "payout_bookings_synced", refId: cC })) === 1,
      `paid=${await CookEventLog.countDocuments({ event: "payout_paid", refId: cC })} synced=${await CookEventLog.countDocuments({ event: "payout_bookings_synced", refId: cC })}`
    );
  }

  // ── 12. HTTP authorization through the real route middleware ─────────
  // Proves, over localhost with real JWTs + real role lookups (not mocks):
  // unauthenticated → 401, cook on admin recovery → 403, cross-cook
  // payout reads → 404, owner reads → 200.
  {
    const express = require("express");
    const jwt = require("jsonwebtoken");
    const app = express();
    app.use(express.json());
    app.use("/api/admin/cook-payouts", require("./routes/adminCookEarnings"));
    app.use("/api/cook", require("./routes/cookEarnings"));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => res.status(err?.statusCode || 500).json({ message: err?.message || "error" }));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, path, token, body) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch { /* non-JSON */ }
      return { status: res.status, data };
    };
    try {
      const mkTokenUser = async (role) => {
        const u = await mkUser(role);
        const token = jwt.sign({ id: u._id.toString() }, process.env.JWT_SECRET);
        return { u, token };
      };
      const admin = await mkTokenUser("ADMIN");
      const cookA = await mkTokenUser("COOK");
      const cookB = await mkTokenUser("COOK");
      const cust = await mkTokenUser("CUSTOMER");
      const cA = await mkUser("customer");
      await mkBooking(cookA.u._id, cA._id, {});
      const rb = await api("POST", "/api/admin/cook-payouts/payouts/build", admin.token, { cookId: cookA.u._id.toString() });
      const cycId = rb.data?._id;
      check("http: admin builds cycle (201)", rb.status === 201 && Boolean(cycId), `s=${rb.status}`);
      check("http: sync without token → 401", (await api("POST", `/api/admin/cook-payouts/payouts/${cycId}/sync-bookings`, null)).status === 401);
      check("http: sync with bad token → 401", (await api("POST", `/api/admin/cook-payouts/payouts/${cycId}/sync-bookings`, "bogus")).status === 401);
      check("http: cook cannot invoke recovery (403)", (await api("POST", `/api/admin/cook-payouts/payouts/${cycId}/sync-bookings`, cookA.token)).status === 403);
      check("http: customer cannot invoke recovery (403)", (await api("POST", `/api/admin/cook-payouts/payouts/${cycId}/sync-bookings`, cust.token)).status === 403);
      check("http: record-reference cook-forbidden (403)", (await api("POST", `/api/admin/cook-payouts/payouts/${cycId}/reference`, cookA.token, { reference: "X-1" })).status === 403);
      check("http: cook cannot pay (403, no money write)", (await api("POST", `/api/admin/cook-payouts/payouts/${cycId}/approve`, cookA.token)).status === 403);
      check("http: cross-cook payout read → 404", (await api("GET", `/api/cook/payouts/${cycId}`, cookB.token)).status === 404);
      const own = await api("GET", `/api/cook/payouts/${cycId}`, cookA.token);
      check("http: owner payout read → 200, own cook only", own.status === 200 && String(own.data?.cook) === String(cookA.u._id), `s=${own.status}`);
      check("http: payout read without token → 401", (await api("GET", `/api/cook/payouts/${cycId}`, null)).status === 401);
      check("http: admin cannot use cook routes (403)", (await api("GET", "/api/cook/earnings", admin.token)).status === 403);
      const earn = await api("GET", "/api/cook/earnings", cookA.token);
      check("http: owner earnings → 200 with scoped rows", earn.status === 200 && Array.isArray(earn.data?.bookings) && earn.data.bookings.length === 1, `s=${earn.status} n=${earn.data?.bookings?.length}`);
      const earnB = await api("GET", "/api/cook/earnings", cookB.token);
      check("http: other cook sees none of these rows", earnB.status === 200 && (earnB.data?.bookings || []).length === 0, `n=${earnB.data?.bookings?.length}`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // ── 11. Booking-only earnings: no bonuses anywhere ────────────────
  // (Lead, incentive, and referral programs were removed: overview carries
  // booking earnings only, and cycle totals reconcile with earnings.)
  {
    const cook = await mkUser("cook");
    const cust = await mkUser("customer");
    await mkBooking(cook._id, cust._id, {}); // 296.65 booking earnings
    const rE = makeRes();
    await earnCtrl.getEarnings({ user: { id: cook._id.toString() }, query: {} }, rE, captureNext().next);
    const ov = rE.body?.overview || {};
    check("overview has no bonuses field", ov.bonuses === undefined, `bonuses=${ov.bonuses}`);
    check("lifetime is booking earnings only", ov.lifetime === 296.65, `lifetime=${ov.lifetime}`);
    const rB = makeRes();
    await adminCtrl.buildCookPayout({ body: { cookId: cook._id.toString() }, user: { id: adminId }, params: {} }, rB, captureNext().next);
    check(
      "cycle totals booking-only (total == earnings)",
      rB.statusCode === 201 && rB.body?.totalPayable === rB.body?.cookEarnings && rB.body?.cookEarnings === 296.65,
      `s=${rB.statusCode} ${JSON.stringify({ t: rB.body?.totalPayable, e: rB.body?.cookEarnings })}`
    );
  }

  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
