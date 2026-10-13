
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

const SETTLED_REFUND_STATUSES = Object.freeze(["processed", "manual"]);

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

const paidFor = (b) => {
  if (!isRealPayment(b)) return 0;
  const v = b?.payment?.paidAmount ?? b?.amount ?? 0;
  return Math.max(0, toInt(v));
};

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

const normalizeCity = (city) => String(city || "").trim().toLowerCase();

const displayCity = (key) => {
  if (!key) return "Unknown";
  return key
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
};

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
  const from = new Date(fromD.getTime() - 5.5 * 3600 * 1000);
  const toExclusive = new Date(toD.getTime() + 86400000 - 5.5 * 3600 * 1000);
  return { from, toExclusive, dateField: rawField, fromStr: String(query.from).trim(), toStr: String(query.to).trim() };
};

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
