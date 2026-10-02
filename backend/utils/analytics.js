// Centralized Admin Analytics business rules — single source of truth for
// every booking/financial KPI shown in Admin → Analytics.
//
// Derived from the actual lifecycle (models/Booking.js, controllers/
// bookingController.js, paymentController.js, payoutController.js,
// refundController.js, utils/pricing.js, utils/finance.js):
//
// - Booking.status enum: requested, accepted, rejected, confirmed,
//   in_progress, completed, cancelled, expired, unattended.
// - Payment is embedded (payment.status pending|paid|failed, paidAmount,
//   refundStatus none|pending|processing|processed|failed|manual|rejected,
//   refundAmount, testMode). Amounts are integer rupees everywhere
//   (paise only at the Razorpay boundary).
// - Commission is always 15% / cook 85% of the final post-discount amount
//   (utils/pricing.js splitPayout), snapshotted per booking at creation.
// - Refunds never move money automatically; only refundStatus
//   processed|manual represent money actually returned.
// - Payouts: payout.status pending|settled|not_applicable; only completed +
//   hoursCompleted + paid + real-money bookings with no live refund are
//   payable (utils/finance.js payoutEligibility).
// - `date` = scheduled service date (IST midnight); `createdAt` = booking
//   creation date. Monthly trend groups by SERVICE date in Asia/Kolkata.
//
// Definitions (also rendered as UI tooltips):
// - total: every Booking row in scope (all statuses incl. unknown).
// - active = requested+accepted+confirmed+in_progress (non-terminal).
// - completed = completed. lost = cancelled+expired+rejected+unattended.
// - paidBookings = payment.status==paid && !testMode (real captured money).
// - grossCollected = Σ paidAmount (fallback amount) over paid real bookings.
// - discounts = Σ discount over paid real bookings.
// - refunds = Σ refundAmount where refundStatus in [processed, manual] &&
//   !testMode. Failed/pending/processing/rejected refunds move no money.
// - netCollected = grossCollected - refunds.
// - platformEarnings (net) / cookEarnings (net): gross commission/cookPayout
//   scaled pro-rata by net/gross so platform+cook == net exactly (refunded
//   money belongs to neither party). Rounding: platform rounds, cook is the
//   remainder — reconciliation is exact by construction.
// - cookPaid = Σ payout.amount where payout.status==settled && !testMode.
// - cookPending = net cook entitlement on completed, paid, real-money
//   bookings with payout.status==pending and refundStatus in [none,rejected].
// - avgBookingValue = round(netCollected / paidBookings) or 0.
// - scheduledHours = Σ valid durationHours (1..4) over all in-scope bookings.
// - completedHours = Σ valid durationHours where status==completed.
// - monthlyTrend groups by scheduled service date (Asia/Kolkata, %Y-%m).

const KNOWN_STATUSES = Object.freeze([
  "requested",
  "accepted",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "expired",
  "rejected",
  "unattended",
]);

const ACTIVE_STATUSES = Object.freeze([
  "requested",
  "accepted",
  "confirmed",
  "in_progress",
]);

const LOST_STATUSES = Object.freeze([
  "cancelled",
  "expired",
  "rejected",
  "unattended",
]);

const SUCCESSFUL_STATUSES = Object.freeze(["completed"]);

// Refund states that actually returned money to the customer.
const SETTLED_REFUND_STATUSES = Object.freeze(["processed", "manual"]);

// Refund states that block a cook payout (money may travel both directions).
const PAYOUT_BLOCKING_REFUND_EXCEPT = Object.freeze(["none", "rejected"]);

const TIMEZONE = "Asia/Kolkata";

const toInt = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
};

const classifyStatus = (s) => {
  const v = String(s || "");
  return KNOWN_STATUSES.includes(v) ? v : "unknown";
};

const isRealPayment = (b) => {
  const pay = b?.payment || {};
  return pay.status === "paid" && pay.testMode !== true;
};

// Actual captured rupees for a paid booking (paidAmount authoritative,
// amount fallback for legacy rows).
const paidFor = (b) => {
  if (!isRealPayment(b)) return 0;
  const v = b?.payment?.paidAmount ?? b?.amount ?? 0;
  return Math.max(0, toInt(v));
};

// Money actually returned for a booking (successful refunds only, never
// counted twice — single refundAmount field per booking).
const refundedFor = (b) => {
  const pay = b?.payment || {};
  if (pay.testMode === true) return 0;
  if (!SETTLED_REFUND_STATUSES.includes(pay.refundStatus)) return 0;
  return Math.max(0, toInt(pay.refundAmount || 0));
};

const isValidDuration = (h) => {
  const n = Number(h);
  return Number.isFinite(n) && n >= 1 && n <= 4;
};

// "Pune", " pune ", "PUNE" -> "pune" (grouping key). Display title-cased
// separately so spelling variants never split into separate rows.
const normalizeCity = (city) => String(city || "").trim().toLowerCase();

// Title-case a normalized key for display ("pune" -> "Pune") without
// pretending to resolve locality vs city (we aggregate addressDetails.city).
const displayCity = (key) => {
  if (!key) return "Unknown";
  return key
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
};

// YYYY-MM-DD strict (no Date.parse leniency, no prototype pollution via
// __proto__/constructor keys — callers pass primitives only).
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const parseStrictDate = (s) => {
  const v = String(s || "").trim();
  if (!DATE_RE.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  )
    return null;
  return dt;
};

// Validate ?from & ?to & ?dateField. Throws {status,message} on invalid.
// dateField: "service" (Booking.date, default) or "created" (createdAt).
// Range cap: 5 years to bound aggregation cost. Returns null when no filter.
const validateAnalyticsQuery = (query = {}) => {
  const rawField = String(query.dateField || "service").trim().toLowerCase();
  if (rawField !== "service" && rawField !== "created") {
    const err = new Error("dateField must be 'service' or 'created'");
    err.status = 400;
    throw err;
  }
  const hasFrom = query.from != null && String(query.from).trim() !== "";
  const hasTo = query.to != null && String(query.to).trim() !== "";
  if (!hasFrom && !hasTo) return null;
  if (!hasFrom || !hasTo) {
    const err = new Error("Both 'from' and 'to' (YYYY-MM-DD) are required together");
    err.status = 400;
    throw err;
  }
  const fromD = parseStrictDate(query.from);
  const toD = parseStrictDate(query.to);
  if (!fromD || !toD) {
    const err = new Error("'from' and 'to' must be valid YYYY-MM-DD dates");
    err.status = 400;
    throw err;
  }
  if (fromD > toD) {
    const err = new Error("'from' must not be after 'to'");
    err.status = 400;
    throw err;
  }
  const days = (toD - fromD) / 86400000;
  if (days > 366 * 5) {
    const err = new Error("Date range must not exceed 5 years");
    err.status = 400;
    throw err;
  }
  // Day bounds in IST: from 00:00 IST to to 23:59:59.999 IST.
  // IST = UTC+5:30, so from = fromD 00:00 IST = fromD-5:30Z,
  // to-exclusive = (toD+1day) 00:00 IST.
  const from = new Date(fromD.getTime() - 5.5 * 3600 * 1000);
  const toExclusive = new Date(toD.getTime() + 86400000 - 5.5 * 3600 * 1000);
  return { from, toExclusive, dateField: rawField, fromStr: String(query.from).trim(), toStr: String(query.to).trim() };
};

// Month key in Asia/Kolkata (YYYY-MM) for a Date. Uses en-CA parts (which
// are YYYY-MM-DD ordered) with the target timeZone — no UTC drift at
// IST midnights / month boundaries.
const monthKeyIST = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(dt);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    const y = get("year");
    const m = get("month");
    if (!y || !m) return null;
    return `${y}-${m}`;
  } catch {
    return null;
  }
};

// Enumerate month keys from start (inclusive) to end (inclusive) for
// continuous trend series (zero-filled months preserved).
const enumerateMonths = (startKey, endKey) => {
  if (!startKey || !endKey) return [];
  const out = [];
  let [y, m] = startKey.split("-").map(Number);
  const [ey, em] = endKey.split("-").map(Number);
  if (!y || !m || !ey || !em) return [];
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard < 120) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    guard += 1;
  }
  return out;
};

module.exports = {
  KNOWN_STATUSES,
  ACTIVE_STATUSES,
  LOST_STATUSES,
  SUCCESSFUL_STATUSES,
  SETTLED_REFUND_STATUSES,
  PAYOUT_BLOCKING_REFUND_EXCEPT,
  TIMEZONE,
  toInt,
  classifyStatus,
  isRealPayment,
  paidFor,
  refundedFor,
  isValidDuration,
  normalizeCity,
  displayCity,
  parseStrictDate,
  validateAnalyticsQuery,
  monthKeyIST,
  enumerateMonths,
};
