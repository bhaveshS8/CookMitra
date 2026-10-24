// Weekly payout boundaries: Monday–Sunday in the configured business
// timezone (Asia/Kolkata), never server-local midnight. Single source of
// truth for every weekly payout query, so the admin Pending/Completed tabs,
// cycle construction, and the cook earnings overview all slice weeks on the
// same boundary.
const { istMidnight, istWeekday, BUSINESS_TZ } = require("./time");

const DAY_MS = 24 * 60 * 60 * 1000;

// Monday 00:00:00.000 IST containing `input`, as an instant.
const parseWeekStartIST = (input) => {
  let probe;
  if (input === undefined || input === null || String(input).trim() === "") {
    probe = new Date();
  } else if (input instanceof Date) {
    probe = input;
  } else {
    probe = new Date(input);
  }
  if (!(probe instanceof Date) || Number.isNaN(probe.getTime())) return null;
  const midnight = istMidnight(probe);
  if (!midnight) return null;
  const weekday = istWeekday(probe);
  if (weekday === null || weekday === undefined) return null;
  const daysBack = (Number(weekday) + 6) % 7; // Monday=0 … Sunday=6
  return new Date(midnight.getTime() - daysBack * DAY_MS);
};

// { weekStart, weekEnd } for the business week containing `input`:
// Monday 00:00:00.000 IST through Sunday 23:59:59.999 IST, as instants.
const weekRangeIST = (input) => {
  const weekStart = parseWeekStartIST(input);
  if (!weekStart) return null;
  return { weekStart, weekEnd: new Date(weekStart.getTime() + 7 * DAY_MS - 1) };
};

// "2026-10-05" (the IST calendar date of the Monday) — stable for URLs.
const weekKeyIST = (input) => {
  const start = parseWeekStartIST(input);
  if (!start) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: BUSINESS_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(start);
    return parts; // YYYY-MM-DD
  } catch {
    return null;
  }
};

const formatWeekLabel = (weekStart) => {
  try {
    const fmt = (d) =>
      new Intl.DateTimeFormat("en-IN", {
        timeZone: BUSINESS_TZ,
        day: "numeric",
        month: "short",
      }).format(d);
    const end = new Date(new Date(weekStart).getTime() + 7 * DAY_MS - 1);
    return `${fmt(weekStart)} – ${fmt(end)}`;
  } catch {
    return "";
  }
};

module.exports = {
  BUSINESS_TZ,
  parseWeekStartIST,
  weekRangeIST,
  weekKeyIST,
  formatWeekLabel,
};
