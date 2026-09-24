// Business-time utilities — single source of truth for date/time validation.
//
// Official business timezone: Asia/Kolkata. Server-local getHours()/getDate()
// MUST NOT drive booking decisions (a UTC host shifts "today" by 5.5h).
// All user-facing slot math uses IST derived via Intl; stored event
// timestamps remain UTC Date instants.
const BUSINESS_TZ = "Asia/Kolkata";
// Bookings may not be placed more than this far ahead (slot-squat guard).
const MAX_BOOKING_HORIZON_DAYS = 180;
// OTP validity window after the session end (startService refuses older).
const OTP_VALIDITY_AFTER_END_MS = 24 * 60 * 60 * 1000;

const FULL_TIME_RE = /^(\d{1,2}):(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const parseTimeStrict = (t) => {
  const m = String(t || "").match(FULL_TIME_RE);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
};

const isOnGrid = (minutes, step = 30) =>
  Number.isInteger(minutes) && minutes % step === 0;

// Strict YYYY-MM-DD with real calendar validation (rejects 2026-02-30 etc.).
const parseDayStrict = (s) => {
  const m = String(s || "").match(DAY_RE);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== mo - 1 ||
    dt.getDate() !== d
  ) {
    return null;
  }
  dt.setHours(0, 0, 0, 0);
  return dt;
};

const partsInTz = (date, tz) => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
};

const istDayString = (d = new Date()) => partsInTz(d, BUSINESS_TZ).day;
const istNowMinutes = (d = new Date()) => partsInTz(d, BUSINESS_TZ).minutes;

// ── IST-anchored instants (F-08) ──────────────────────────────────────────
// Asia/Kolkata has never observed DST, so +05:30 is exact — not an
// approximation. These helpers build UTC Date instants from IST wall times so
// booking math is identical on EVERY host timezone (a UTC host previously
// shifted cutoffs, expiry, and rival-day queries by 5.5h via server-local
// setHours/getHours). On an IST-pinned host they produce exactly the same
// instants the old local-time code did.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// IST calendar parts of any instant (or null when unparsable).
const istPartsOf = (input) => {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const y = Number(get("year"));
  const mo = Number(get("month"));
  const day = Number(get("day"));
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(day)) return null;
  return { y, mo, d: day };
};

// UTC instant of IST midnight starting the business day of `input`.
// Accepts "YYYY-MM-DD" (taken as the IST day itself) or a Date (IST day of
// that instant — recovers the intended day for rows written as local-midnight
// on either IST or UTC hosts).
const istMidnight = (input) => {
  if (typeof input === "string") {
    const m = String(input).match(DAY_RE);
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS);
  }
  const p = istPartsOf(input);
  if (!p) return null;
  return new Date(Date.UTC(p.y, p.mo - 1, p.d) - IST_OFFSET_MS);
};

// { start, end } UTC instants covering that IST business day (end inclusive).
const istDayRange = (input) => {
  const start = istMidnight(input);
  if (!start) return null;
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1) };
};

// UTC instant of an IST wall time ("HH:MM") on the business day of
// `dateInput` ("YYYY-MM-DD" or Date). Null on any malformed input.
const istEventInstant = (dateInput, hm) => {
  const m = String(hm || "").match(FULL_TIME_RE);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  let y;
  let mo;
  let d;
  if (typeof dateInput === "string" && DAY_RE.test(String(dateInput))) {
    const dm = String(dateInput).match(DAY_RE);
    y = Number(dm[1]);
    mo = Number(dm[2]);
    d = Number(dm[3]);
  } else {
    const p = istPartsOf(dateInput);
    if (!p) return null;
    y = p.y;
    mo = p.mo;
    d = p.d;
  }
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS);
};

// IST weekday (0=Sunday..6=Saturday) of an instant or "YYYY-MM-DD".
const istWeekday = (input) => {
  let y;
  let mo;
  let d;
  if (typeof input === "string" && DAY_RE.test(String(input))) {
    const m = String(input).match(DAY_RE);
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  } else {
    const p = istPartsOf(input);
    if (!p) return null;
    y = p.y;
    mo = p.mo;
    d = p.d;
  }
  // Weekday from the UTC instant of that IST noon (noon avoids any edge).
  return new Date(Date.UTC(y, mo - 1, d, 12, 0) - IST_OFFSET_MS).getUTCDay();
};

module.exports = {
  BUSINESS_TZ,
  IST_OFFSET_MS,
  MAX_BOOKING_HORIZON_DAYS,
  OTP_VALIDITY_AFTER_END_MS,
  parseTimeStrict,
  isOnGrid,
  parseDayStrict,
  istDayString,
  istNowMinutes,
  istPartsOf,
  istMidnight,
  istDayRange,
  istEventInstant,
  istWeekday,
};
