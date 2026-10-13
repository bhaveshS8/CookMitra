
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const mongoose = require("mongoose");
const {
  evaluateCancellation,
  computeRefund,
  deriveCategory,
  refundBaseOf,
  CUSTOMER_CANCELLATION_REASONS,
  CUSTOMER_COMPLAINT_REASONS,
  policyVersion,
} = require("./utils/cancellationPolicy");
const policyConfig = require("./config/cancellationPolicy");
const bookingController = require("./controllers/bookingController");
const complaintController = require("./controllers/complaintController");
const Booking = require("./models/Booking");
const Complaint = require("./models/Complaint");
const User = require("./models/User");
const Notification = require("./models/Notification");
const CancellationAudit = require("./models/CancellationAudit");

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes += 1;
  else failures += 1;
};

const H = 60 * 60 * 1000;
const mkBooking = (over = {}) => ({
  _id: "b1",
  customer: "cust1",
  cook: "cook1",
  serviceType: "cook_for_me",
  date: new Date("2026-11-20T00:00:00.000Z"),
  startTime: "12:00",
  endTime: "14:00",
  address: "12 MG Road",
  amount: 1000,
  status: "confirmed",
  cookArrived: false,
  serviceStartedAt: null,
  payment: { status: "paid", paidAmount: 1000, razorpayPaymentId: "pay_1", refundStatus: "none", testMode: false },
  statusHistory: [],
  payoutInfo: {},
  payout: { status: "pending" },
  ...over,
});
const startOf = (b) => {
  const { serviceStartInstant } = require("./utils/cancellationPolicy");
  return serviceStartInstant(b).getTime();
};

{
  const b = mkBooking({ cook: null, status: "requested" });
  const r = evaluateCancellation({ booking: b, currentTime: Date.now(), actorRole: "customer" });
  check("before assignment → 100%", r.allowed && r.cancellationCategory === "BEFORE_ASSIGNMENT" && r.finalRefund === 1000 && r.refundPercent === 100, JSON.stringify({ c: r.cancellationCategory, f: r.finalRefund }));
}
{
  const b = mkBooking({ cook: null, status: "requested", amount: 499, payment: { status: "pending", refundStatus: "none" } });
  const r = evaluateCancellation({ booking: b, currentTime: Date.now(), actorRole: "customer" });
  check("before assignment unpaid: allowed, 0 refund queued", r.allowed && r.finalRefund === 0 && r.refundPercent === 100);
}
{
  const b = mkBooking();
  const r = evaluateCancellation({ booking: b, currentTime: startOf(b) - 25 * H, actorRole: "customer" });
  check(">24h → 90% (1000 → 900)", r.cancellationCategory === "MORE_THAN_24_HOURS" && r.finalRefund === 900 && r.cancellationChargePercent === 10, JSON.stringify({ c: r.cancellationCategory, f: r.finalRefund }));
}
{
  const b = mkBooking();
  const r = evaluateCancellation({ booking: b, currentTime: startOf(b) - 24 * H, actorRole: "customer" });
  check("exactly 24h → WITHIN_24_HOURS (deterministic)", r.cancellationCategory === "WITHIN_24_HOURS" && r.finalRefund === 750, r.cancellationCategory);
}
{
  const b = mkBooking();
  const r = evaluateCancellation({ booking: b, currentTime: startOf(b) - 10 * H, actorRole: "customer" });
  check("<24h → 75% (1000 → 750)", r.cancellationCategory === "WITHIN_24_HOURS" && r.finalRefund === 750);
}
{
  const b = mkBooking();
  const r = evaluateCancellation({ booking: b, currentTime: startOf(b) - 6 * H, actorRole: "customer" });
  check("exactly 6h → WITHIN_6_HOURS (deterministic)", r.cancellationCategory === "WITHIN_6_HOURS" && r.finalRefund === 500, r.cancellationCategory);
}
{
  const b = mkBooking();
  const r = evaluateCancellation({ booking: b, currentTime: startOf(b) - 2 * H, actorRole: "customer" });
  check("<6h → 50% (1000 → 500)", r.cancellationCategory === "WITHIN_6_HOURS" && r.finalRefund === 500);
}
{
  const b = mkBooking({ cookArrived: true });
  const r = evaluateCancellation({ booking: b, currentTime: startOf(b) - 30 * H, actorRole: "customer" });
  check("cook arrived → customer blocked, 0%", !r.allowed && r.cancellationCategory === "COOK_ARRIVED" && r.finalRefund === 0, r.reasonCode);
}
{
  const free = () =>
    mkBooking({
      amount: 0,
      slabPrice: 349,
      discount: 349,
      couponCode: "FREE100",
      payment: { status: "paid", paidAmount: 0, razorpayPaymentId: "zero_free_b1", refundStatus: "none", testMode: false },
    });
  const r = evaluateCancellation({ booking: free(), currentTime: startOf(free()) - 2 * H, actorRole: "customer" });
  check(
    "100% coupon → 0% cancellation charge",
    r.allowed && r.cancellationChargePercent === 0 && r.finalRefund === 0 && r.fullyDiscounted === true,
    JSON.stringify({ charge: r.cancellationChargePercent, refund: r.finalRefund })
  );
  const r2 = evaluateCancellation({ booking: free(), currentTime: startOf(free()) - 30 * H, actorRole: "customer" });
  check(
    "100% coupon (>24h) → still 0% charge",
    r2.allowed && r2.cancellationChargePercent === 0 && r2.finalRefund === 0,
    JSON.stringify({ charge: r2.cancellationChargePercent })
  );
  const paid = mkBooking();
  const r3 = evaluateCancellation({ booking: paid, currentTime: startOf(paid) - 2 * H, actorRole: "customer" });
  check(
    "paid booking keeps slab charge (no regression)",
    r3.cancellationChargePercent === 50 && r3.fullyDiscounted !== true,
    JSON.stringify({ charge: r3.cancellationChargePercent })
  );
}
{
  const b = mkBooking({ cookArrived: true });
  const r = evaluateCancellation({ booking: b, currentTime: startOf(b) - 30 * H, actorRole: "admin" });
  check("cook arrived → admin records 0%", r.allowed && r.cancellationCategory === "COOK_ARRIVED" && r.finalRefund === 0);
}
{
  const b = mkBooking();
  const r = evaluateCancellation({ booking: b, currentTime: Date.now(), actorRole: "cook" });
  check("cook cancellation → 100%", r.cancellationCategory === "COOK_CANCELLED" && r.finalRefund === 1000 && r.refundPercent === 100);
}
{
  const b = mkBooking();
  const r = evaluateCancellation({ booking: b, currentTime: Date.now(), actorRole: "admin", cookFailed: true });
  check("cook failed service → 100%", r.cancellationCategory === "COOK_FAILED_SERVICE" && r.finalRefund === 1000);
}
{
  const b = mkBooking();
  const r = evaluateCancellation({ booking: b, currentTime: Date.now(), actorRole: "admin", noShow: true });
  check("customer no-show → 0%", r.cancellationCategory === "CUSTOMER_NO_SHOW" && r.finalRefund === 0);
}
{
  const b = mkBooking({ status: "completed" });
  check("completed not cancellable", !evaluateCancellation({ booking: b, currentTime: Date.now(), actorRole: "customer" }).allowed);
  const s = mkBooking({ serviceStartedAt: new Date(), status: "in_progress" });
  check("started service not self-cancellable", !evaluateCancellation({ booking: s, currentTime: Date.now(), actorRole: "customer" }).allowed);
}

check("449 × 75% = 336.75 exactly", computeRefund(449, 75) === 336.75, String(computeRefund(449, 75)));
check("1000 × 90% = 900", computeRefund(1000, 90) === 900);
check("999 × 75% = 749.25", computeRefund(999, 75) === 749.25);
check("no float drift on thirds", computeRefund(100, 33.33) === 33.33);
{
  policyConfig.gatewayFixedFee = 20;
  const b = mkBooking({ amount: 1000, payment: { status: "paid", paidAmount: 1000, razorpayPaymentId: "pay_1", refundStatus: "none", testMode: false } });
  const r = evaluateCancellation({ booking: b, currentTime: startOf(b) - 10 * H, actorRole: "customer" });
  check("gateway fee: 750 − 20 = 730 breakdown", r.grossRefund === 750 && r.nonRefundableCharges === 20 && r.finalRefund === 730, JSON.stringify({ g: r.grossRefund, n: r.nonRefundableCharges, f: r.finalRefund }));
  const t = mkBooking({ amount: 1000, payment: { status: "paid", paidAmount: 1000, razorpayPaymentId: "pay_test", refundStatus: "none", testMode: true } });
  const rt = evaluateCancellation({ booking: t, currentTime: startOf(t) - 10 * H, actorRole: "customer" });
  check("no fee invented on test money", rt.nonRefundableCharges === 0 && rt.finalRefund === 0);
  policyConfig.gatewayFixedFee = 0;
  const z = evaluateCancellation({ booking: b, currentTime: startOf(b) - 10 * H, actorRole: "customer" });
  check("no fee when unconfigured", z.nonRefundableCharges === 0 && z.finalRefund === 750);
}
{
  const b = mkBooking({ amount: 449, slabPrice: 499, discount: 50, cookPayout: 382, commission: 67, payment: { status: "paid", paidAmount: 449, refundStatus: "none" } });
  check("base is paidAmount (449), not slab/cook share", refundBaseOf(b) === 449);
  const r = evaluateCancellation({ booking: b, currentTime: startOf(b) - 10 * H, actorRole: "customer" });
  check("449 × 75% = 336.75 on coupon-adjusted base", r.finalRefund === 336.75, String(r.finalRefund));
}
check("config slabs exact", JSON.stringify(Object.values(policyConfig.slabs).map((s) => [s.cancellationChargePercent, s.refundPercent])) === JSON.stringify([[0, 100], [10, 90], [25, 75], [50, 50], [100, 0], [100, 0], [0, 100], [0, 100]]));
check("policy versioned", typeof policyVersion === "string" && policyVersion.length > 0);
check("customer reasons structured", CUSTOMER_CANCELLATION_REASONS.join() === "CHANGE_OF_PLANS,WRONG_BOOKING_DETAILS,WRONG_ADDRESS,SERVICE_NO_LONGER_REQUIRED,OTHER");
check("complaint reasons per spec", CUSTOMER_COMPLAINT_REASONS.join() === "COOK_DID_NOT_ARRIVE,MAJOR_SERVICE_DEVIATION,SERVICE_QUALITY_ISSUE,UNPROFESSIONAL_BEHAVIOR,OTHER");

{
  const q = bookingController.queueRefundForApproval;
  const b = () => ({ status: "cancelled", amount: 1000, payment: { status: "paid", paidAmount: 1000, refundStatus: "none", testMode: false }, statusHistory: [] });
  const d1 = b();
  check("policy override queued (900, not full 1000)", q(d1, "booking_cancelled:MORE_THAN_24_HOURS", 900) === 900 && d1.payment.refundAmount === 900);
  const d2 = b();
  d2.payment.refundStatus = "pending";
  check("duplicate refund request → 0", q(d2, "x", 500) === 0);
  const d3 = b();
  d3.payment.testMode = true;
  check("test payment queues nothing", q(d3, "x", 500) === 0);
  const d4 = b();
  check("zero policy refund queues nothing", q(d4, "x", 0) === 0 && d4.payment.refundStatus === "none");
}

const realReadyState = mongoose.connection.readyState;
mongoose.connection.readyState = 1; // run atomic-claim paths against fakes

let storeDoc = null;
let claimImpl = null;
const notifications = [];
const audits = [];

const installFakes = () => {
  Booking.findById = async () => storeDoc;
  Booking.updateOne = async (filter, update) => {
    if (claimImpl) return claimImpl(filter, update);
    return { modifiedCount: 0 };
  };
  Notification.create = async (doc) => {
    notifications.push(doc);
    return doc;
  };
  CancellationAudit.create = async (doc) => {
    (Array.isArray(doc) ? audits.push(...doc) : audits.push(doc));
    return doc;
  };
  try {
    const Coupon = require("./models/Coupon");
    Coupon.updateOne = async () => ({ modifiedCount: 0 });
  } catch { /* ignore */ }
  try {
    const CookProfile = require("./models/CookProfile");
    CookProfile.updateOne = async () => ({ modifiedCount: 0 });
  } catch { /* ignore */ }
};

const mkDoc = (over = {}) => {
  const b = mkBooking(over);
  b.date = new Date(Date.now() + 72 * H); // far future: clear of cutoffs
  b.startTime = "12:00";
  b.endTime = "14:00";
  b.requestExpiresAt = new Date(Date.now() + 4 * 60 * 1000);
  b.couponCode = "";
  b.couponReleased = false;
  b.saveCalls = 0;
  b.save = async function () {
    this.saveCalls += 1;
    return this;
  };
  return b;
};
const applySet = (doc, set = {}) => {
  for (const [k, v] of Object.entries(set)) {
    const parts = k.split(".");
    let node = doc;
    for (let i = 0; i < parts.length - 1; i++) {
      if (node[parts[i]] == null || typeof node[parts[i]] !== "object") node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = v;
  }
};
const defaultClaim = (filter, update) => {
  const live = ["requested", "accepted", "confirmed", "in_progress"].includes(storeDoc.status);
  const unstarted = !storeDoc.serviceStartedAt;
  const filterOk = !filter.status || (filter.status.$in ? filter.status.$in.includes(storeDoc.status) : true);
  if (live && unstarted && filterOk && (!filter["payment.refundStatus"] || true)) {
    applySet(storeDoc, update.$set);
    if (update.$push?.statusHistory) storeDoc.statusHistory.push(update.$push.statusHistory);
    return { modifiedCount: 1 };
  }
  return { modifiedCount: 0 };
};

const req = (user, body = {}, params = { id: "b1" }) => ({ user, body, params });
const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => {
    r.statusCode = c;
    return r;
  };
  r.json = (b) => {
    r.body = b;
    return r;
  };
  return r;
};
const CUSTOMER = { id: "cust1", role: "CUSTOMER" };
const STRANGER = { id: "cust9", role: "CUSTOMER" };
const COOK = { id: "cook1", role: "COOK" };
const ADMIN = { id: "admin1", role: "ADMIN" };

const runCancel = async (user, body) => {
  const r = res();
  await bookingController.cancelBooking(req(user, body), r, (e) => {
    if (e) throw e;
  });
  return r;
};

(async () => {
  installFakes();

  storeDoc = mkDoc();
  claimImpl = defaultClaim;
  notifications.length = 0;
  audits.length = 0;
  {
    const r = await runCancel(CUSTOMER, { reason: "CHANGE_OF_PLANS" });
    check("cancel >24h → 200 cancelled", r.statusCode === 200 && r.body.status === "cancelled", `s=${r.statusCode}`);
    const ci = r.body.cancellationInfo || {};
    check("snapshot MORE_THAN_24_HOURS 90%", ci.cancellationCategory === "MORE_THAN_24_HOURS" && ci.refundPercentage === 90 && ci.finalRefundAmount === 900, JSON.stringify({ c: ci.cancellationCategory, f: ci.finalRefundAmount }));
    check("snapshot immutable fields pinned", ci.policyVersion === policyVersion && ci.bookingAmount === 1000 && ci.grossRefundAmount === 900 && ci.refundStatus === "PENDING");
    check("queued policy amount (900, not 1000)", r.body.payment.refundAmount === 900 && r.body.payment.refundStatus === "pending");
    check("audit CANCELLATION_REQUESTED + REFUND_CALCULATED", audits.some((a) => a.event === "CANCELLATION_REQUESTED") && audits.some((a) => a.event === "REFUND_CALCULATED"));
    check("customer notified with refund figure", notifications.some((n) => String(n.message || "").includes("₹900")));
  }

  {
    const n0 = notifications.length;
    const a0 = audits.length;
    const r = await runCancel(CUSTOMER, { reason: "CHANGE_OF_PLANS" });
    check("repeat cancel idempotent", r.statusCode === 200 && r.body.alreadyCancelled === true);
    check("no duplicate refund/audit on repeat", notifications.length === n0 && audits.length === a0);
  }

  storeDoc = mkDoc();
  {
    const r = await runCancel(CUSTOMER, { reason: "CHANGE_OF_PLANS", refundPercent: 100, refundAmount: 99999, cancellationCharge: 0, refundStatus: "PROCESSED", refundReference: "HAX" });
    const ci = r.body.cancellationInfo || {};
    check("client money fields ignored", ci.refundPercentage === 90 && ci.finalRefundAmount === 900 && !r.body.payment.refundReference && !ci.refundReference);
  }

  storeDoc = mkDoc();
  {
    const r = await runCancel(STRANGER, { reason: "CHANGE_OF_PLANS" });
    check("cannot cancel another customer's booking", r.statusCode === 403);
  }

  storeDoc = mkDoc();
  {
    const r = await runCancel(CUSTOMER, { reason: "BOGUS" });
    check("invalid reason refused", r.statusCode === 400);
  }
  {
    const r = await runCancel(CUSTOMER, { reason: "OTHER" });
    check("OTHER without description refused", r.statusCode === 400);
  }
  storeDoc = mkDoc();
  {
    const r = await runCancel(CUSTOMER, { reason: "OTHER", reasonNote: "Family emergency" });
    check("OTHER with description accepted", r.statusCode === 200 && r.body.cancellationInfo.cancellationReasonNote === "Family emergency");
  }

  // "Finding a cook" page: customer withdraws a still-unassigned
  // (`requested`) booking — one tap, no reason, no cutoff.
  storeDoc = mkDoc({ cook: null, status: "requested", payment: { status: "pending", paidAmount: 0, refundStatus: "none" } });
  {
    const n0 = notifications.length;
    const a0 = audits.length;
    const r = await runCancel(CUSTOMER, {});
    check("requested withdrawal (unpaid) deleted, not tracked", r.statusCode === 200 && r.body.deleted === true, `s=${r.statusCode}`);
    check("unpaid withdrawal writes no audit/notify", audits.length === a0 && notifications.length === n0, `a=${audits.length - a0} n=${notifications.length - n0}`);
  }
  storeDoc = mkDoc({ cook: null, status: "requested", payment: { status: "pending", paidAmount: 0, refundStatus: "none" } });
  {
    // Service starts in ~15 min (inside the 30-min cutoff) — withdrawal still allowed.
    const istWall = new Date(Date.now() + (5.5 * 60 + 15) * 60 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    storeDoc.date = new Date();
    storeDoc.startTime = `${p(istWall.getUTCHours())}:${p(istWall.getUTCMinutes())}`;
    const { isWithin30MinCutoff } = require("./utils/cancellationPolicy");
    const insideCutoff = isWithin30MinCutoff(storeDoc, Date.now());
    const r = await runCancel(CUSTOMER, {});
    check("requested withdrawal (unpaid) ignores cutoff + deleted", insideCutoff && r.statusCode === 200 && r.body.deleted === true, `cutoff=${insideCutoff} s=${r.statusCode}`);
  }
  storeDoc = mkDoc({ cook: "cook1", status: "confirmed" });
  {
    // Guard: the exemption is requested-only — confirmed bookings still need a reason.
    const r = await runCancel(CUSTOMER, { reason: "OTHER" });
    check("confirmed OTHER without description still refused", r.statusCode === 400);
  }

  storeDoc = mkDoc({ payment: { status: "pending", paidAmount: 0, refundStatus: "none" } });
  {
    const n0 = notifications.length;
    const a0 = audits.length;
    const r = await runCancel(CUSTOMER, { reason: "CHANGE_OF_PLANS" });
    check("unpaid cancel deleted, not tracked", r.statusCode === 200 && r.body.deleted === true, `s=${r.statusCode}`);
    check("unpaid cancel writes no audit/notify", audits.length === a0 && notifications.length === n0, `a=${audits.length - a0} n=${notifications.length - n0}`);
  }

  storeDoc = mkDoc({ cookArrived: true, serviceStartedAt: new Date() });
  {
    const r = await runCancel(CUSTOMER, { reason: "CHANGE_OF_PLANS" });
    check("arrived service blocks customer cancel", r.statusCode === 400);
    check("blocked cancel flips nothing", storeDoc.status === "confirmed");
  }

  storeDoc = mkDoc();
  {
    const r = await runCancel(COOK, {});
    const ci = r.body.cancellationInfo || {};
    check("cook cancel → COOK_CANCELLED 100%", r.statusCode === 200 && ci.cancellationCategory === "COOK_CANCELLED" && ci.finalRefundAmount === 1000, ci.cancellationCategory);
    check("COOK_CANCELLED audited", audits.some((a) => a.event === "COOK_CANCELLED"));
    check("customer told a replacement is attempted", notifications.some((n) => /alternative cook/i.test(n.message || "")));
  }

  storeDoc = mkDoc();
  {
    let calls = 0;
    claimImpl = (f, u) => {
      calls += 1;
      if (calls === 1) return defaultClaim(f, u);
      return { modifiedCount: 0 };
    };
    const r1 = await runCancel(CUSTOMER, { reason: "CHANGE_OF_PLANS" });
    const r2 = await runCancel(CUSTOMER, { reason: "CHANGE_OF_PLANS" });
    check("concurrent cancels: first wins", r1.statusCode === 200 && !r1.body.alreadyCancelled);
    check("concurrent cancels: loser idempotent", r2.statusCode === 200 && r2.body.alreadyCancelled === true);
    check("single queued refund", storeDoc.payment.refundAmount === 900);
    claimImpl = defaultClaim;
  }

  storeDoc = mkDoc();
  {
    claimImpl = () => ({ modifiedCount: 0 });
    storeDoc.serviceStartedAt = new Date();
    storeDoc.status = "in_progress";
    const r = await runCancel(CUSTOMER, { reason: "CHANGE_OF_PLANS" });
    check("cancel vs start: started booking refuses", r.statusCode === 400, `s=${r.statusCode}`);
    claimImpl = defaultClaim;
  }

  storeDoc = mkDoc();
  {
    const r = res();
    await bookingController.getCancellationPreview(req(CUSTOMER), r, (e) => {
      if (e) throw e;
    });
    check("preview returns backend-computed figures", r.body?.canCancel === true && r.body.finalRefund === 900 && r.body.refundPercent === 90 && r.body.category === "MORE_THAN_24_HOURS", JSON.stringify(r.body));
  }
  {
    storeDoc = mkDoc({ serviceStartedAt: new Date(), status: "in_progress" });
    const r = res();
    await bookingController.getCancellationPreview(req(CUSTOMER), r, (e) => {
      if (e) throw e;
    });
    check("preview unavailable after start", r.body?.canCancel === false && /started/i.test(r.body?.message || ""));
  }

  storeDoc = mkDoc({ cookArrived: true });
  {
    const r = res();
    await bookingController.markNoShow(req(COOK, { reason: "Reached venue, no answer for 20 minutes" }), r, (e) => {
      if (e) throw e;
    });
    check("no-show → cancelled 0% NOT_APPLICABLE", r.statusCode === 200 && r.body.cancellationInfo.cancellationCategory === "CUSTOMER_NO_SHOW" && r.body.cancellationInfo.finalRefundAmount === 0 && r.body.payment.refundStatus === "none", `s=${r.statusCode}`);
    check("no-show flagged + audited", r.body.noShow?.marked === true && audits.some((a) => a.event === "NO_SHOW_MARKED"));
  }
  storeDoc = mkDoc({ cookArrived: true });
  {
    const r = res();
    await bookingController.markNoShow(req(CUSTOMER, { reason: "x" }), r, (e) => {
      if (e) throw e;
    });
    check("customer can never mark no-show", r.statusCode === 403);
  }
  {
    const r = res();
    await bookingController.markNoShow(req({ id: "cook9", role: "COOK" }, { reason: "x" }), r, (e) => {
      if (e) throw e;
    });
    check("stranger cook cannot mark no-show", r.statusCode === 403);
  }

  const cBookings = {};
  const cComplaints = [];
  Complaint.findOne = () => ({ select: async () => null });
  Complaint.create = async (d) => {
    const c = { _id: `c${cComplaints.length}`, ...d };
    cComplaints.push(c);
    return c;
  };
  Booking.findById = async (id) => cBookings[id] || null;
  User.find = async () => [{ _id: "admin1" }];
  User.findById = async () => ({ name: "Filer" });

  const fileComplaint = async (user, body, bookingId) => {
    const r = res();
    await complaintController.createComplaint({ user, body: { booking: bookingId, ...body } }, r, (e) => {
      if (e) throw e;
    });
    return r;
  };
  const custBooking = {
    _id: "cb1", customer: "cust1", cook: "cook1", status: "completed",
    serviceEndsAt: new Date(Date.now() - 2 * 60 * 60 * 1000), updatedAt: new Date(),
  };
  cBookings.cb1 = custBooking;
  {
    const r = await fileComplaint({ id: "cust1", role: "CUSTOMER" }, { category: "COOK_DID_NOT_ARRIVE", message: "The cook never arrived at the venue today" }, "cb1");
    check("valid service complaint accepted + mapped", r.statusCode === 201 && r.body.category === "cook_did_not_arrive" && r.body.reportedLate === false, `s=${r.statusCode} cat=${r.body?.category}`);
    check("complaint audited + cook notified", audits.some((a) => a.event === "COMPLAINT_SUBMITTED") && notifications.some((n) => /complaint/i.test(n.message || "")));
  }
  {
    const r = await fileComplaint({ id: "cust1", role: "CUSTOMER" }, { category: "BOGUS_REASON", message: "This reason does not exist at all here" }, "cb1");
    check("unsupported complaint refused (never auto-refund)", r.statusCode === 400 || r.statusCode === 409, `s=${r.statusCode}`);
  }
  {
    Complaint.findOne = () => ({ select: async () => ({ _id: "c0" }) });
    const r = await fileComplaint({ id: "cust1", role: "CUSTOMER" }, { category: "OTHER", message: "Filing again on the same booking today" }, "cb1");
    check("duplicate complaint → 409", r.statusCode === 409, `s=${r.statusCode}`);
    Complaint.findOne = () => ({ select: async () => null });
  }
  {
    cBookings.cb2 = { _id: "cb2", customer: "cust1", cook: "cook1", status: "completed", serviceEndsAt: new Date(Date.now() - 30 * 60 * 60 * 1000), updatedAt: new Date(Date.now() - 30 * 60 * 60 * 1000) };
    const r = await fileComplaint({ id: "cust1", role: "CUSTOMER" }, { category: "SERVICE_QUALITY_ISSUE", message: "Food quality was very poor last week" }, "cb2");
    check("late report flagged, still accepted", r.statusCode === 201 && r.body.reportedLate === true);
  }

  mongoose.connection.readyState = realReadyState;
  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " FAILURES");
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
