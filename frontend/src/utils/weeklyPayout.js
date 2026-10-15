// Client-side mirror of the server's IST Monday–Sunday business week
// (backend/utils/weeklyPayouts.js). Used by the admin weekly payout tabs to
// normalize any picked date to its earning-week Monday.
export const BUSINESS_TZ = "Asia/Kolkata";
export const DAY_MS = 24 * 60 * 60 * 1000;

const istParts = (d) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { y: Number(get("year")), mo: Number(get("month")), d: Number(get("day")) };
};

// Monday 00:00 IST of the week containing `input`, as a Date instant.
export const mondayOfWeekIST = (input) => {
  const probe = input ? new Date(input) : new Date();
  if (Number.isNaN(probe.getTime())) return null;
  const { y, mo, d } = istParts(probe);
  // IST midnight of the probe's calendar day, as an instant.
  const midnightUTC = Date.UTC(y, mo - 1, d) - 5.5 * 60 * 60 * 1000;
  // IST weekday via a noon-UTC probe (always the same IST calendar day).
  const weekday = new Date(Date.UTC(y, mo - 1, d, 12, 0) - 5.5 * 60 * 60 * 1000).getUTCDay();
  const daysBack = (weekday + 6) % 7; // Monday=0
  return new Date(midnightUTC - daysBack * DAY_MS);
};

export const weekRangeOfIST = (input) => {
  const start = mondayOfWeekIST(input);
  if (!start) return null;
  return { start, end: new Date(start.getTime() + 7 * DAY_MS - 1) };
};

// "2026-10-05" IST calendar key for API queries.
export const weekKeyIST = (input) => {
  const start = mondayOfWeekIST(input);
  if (!start) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(start);
};

export const formatWeekLabel = (monday) => {
  try {
    const fmt = (d) =>
      new Intl.DateTimeFormat("en-IN", {
        timeZone: BUSINESS_TZ,
        day: "numeric",
        month: "short",
      }).format(d);
    return `${fmt(monday)} – ${fmt(new Date(new Date(monday).getTime() + 7 * DAY_MS - 1))}`;
  } catch {
    return "";
  }
};

export const toDateInputValue = (d) => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: BUSINESS_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return "";
  }
};
