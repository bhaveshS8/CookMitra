const BUSINESS_TZ = "Asia/Kolkata";
const MAX_BOOKING_HORIZON_DAYS = 180;
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

// Display helper: "15:30" -> "3:30 PM", "10:00" -> "10:00 AM".
// Used by every user-visible message (WhatsApp builders, template params).
// Unparseable input passes through unchanged so nothing ever blanks.
const to12h = (hm) => {
  const m = String(hm || "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return String(hm || "");
  const h24 = Number(m[1]);
  const min = m[2];
  if (!Number.isInteger(h24) || h24 < 0 || h24 > 23) return String(hm || "");
  const suffix = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${min} ${suffix}`;
};

// "15:30"+"16:30" -> "3:30 PM - 4:30 PM". Empty sides collapse gracefully.
const slotRange = (start, end) => {
  const s = to12h(start);
  const e = to12h(end);
  if (s && e) return `${s} - ${e}`;
  return s || e || "";
};

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

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

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

const istDayRange = (input) => {
  const start = istMidnight(input);
  if (!start) return null;
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1) };
};

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
  return new Date(Date.UTC(y, mo - 1, d, 12, 0) - IST_OFFSET_MS).getUTCDay();
};

module.exports = {
  BUSINESS_TZ,
  IST_OFFSET_MS,
  MAX_BOOKING_HORIZON_DAYS,
  OTP_VALIDITY_AFTER_END_MS,
  parseTimeStrict,
  isOnGrid,
  to12h,
  slotRange,
  parseDayStrict,
  istDayString,
  istNowMinutes,
  istPartsOf,
  istMidnight,
  istDayRange,
  istEventInstant,
  istWeekday,
};
