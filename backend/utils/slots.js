// Time-slot engine: derive bookable start times for a cook's service day
// minus already-booked intervals, sized to the customer's input service hours.
//
// Availability model: EVERY cook is bookable across the whole service day
// (08:00–20:00) by default. The only things that block a slot are existing
// bookings (accepted/confirmed/in_progress + live 5-minute "requested" holds)
// and the cook's whole-day "unavailable" toggle (enforced by callers via
// resolveCookAvailability). Published Availability windows, if any, are
// informational only and no longer restrict bookability.

const Availability = require("../models/Availability");
const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const {
  istMidnight,
  istDayRange,
  istDayString,
  istWeekday,
} = require("./time");

// Booking statuses that PERMANENTLY block overlapping re-booking.
// Verdicts that free the slot (cancelled/rejected/completed/expired) never
// appear here — including them would block re-booking freed windows forever.
// NOTE: "requested" is intentionally NOT in this list: pending requests only
// hold a slot for 5 minutes (second clause of activeSlotMatch). Including it
// here would let expired requests block the calendar forever.
const BLOCKING_STATUSES = ["accepted", "confirmed", "in_progress"];

// Mongo $or fragment matching every booking that currently occupies the
// calendar: permanent blocks (accepted/confirmed/in_progress) plus pending
// "requested" ones inside their 5-minute hold. When a customer sends a
// request they land on a waiting page while the cook decides, and during
// that window the slot must be invisible/unbookable for everyone else. The
// hold is expiry-aware — a request whose requestExpiresAt has passed no
// longer blocks anything, so stale requests can never lock the calendar.
// (Legacy "requested" docs without requestExpiresAt don't match either —
// they can't hold forever.) NOTE: callers MUST use getDayBookings (or
// activeSlotMatch) rather than BLOCKING_STATUSES alone: a bare
// `status: { $in: BLOCKING_STATUSES }` check misses live "requested" holds,
// so two "requested" bookings could double-book the same window.
const activeSlotMatch = () => [
  { status: { $in: BLOCKING_STATUSES } },
  { status: "requested", requestExpiresAt: { $gt: new Date() } },
];

const STEP_MINUTES = 30;
// Full-day default windows can yield up to 48 starts (00:00–23:30 for 30-min
// sessions) — the cap must cover the whole day, not just the morning.
const MAX_OPTIONS = 48;

// Service day for every cook: bookable slots run 08:00–20:00 only. Windows
// are intersected with this range wherever slots are derived or validated.
const SERVICE_DAY_START_MIN = 8 * 60;
const SERVICE_DAY_END_MIN = 20 * 60;

const timeToMinutes = (t) => {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  // Reject out-of-range clocks ("24:99", "99:99") — previously any digits
  // parsed, so malformed times could slip past prefix-only matching.
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

const minutesToTime = (mins) => {
  const normalized = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

// IST business-day range for rival lookups (F-08): { start, end } UTC
// instants covering the IST calendar day of `dateInput` ("YYYY-MM-DD" or a
// stored Date). Identical to the old local-midnight range on IST-pinned
// hosts; correct everywhere else.
const dayBounds = (dateInput) => {
  // Never return null: callers destructure { start, end } directly, and an
  // unparseable day must yield "no rivals" (epoch range matches nothing),
  // never a TypeError 500.
  return (
    istDayRange(dateInput) || { start: new Date(0), end: new Date(0) }
  );
};

// Normalize a "YYYY-MM-DD" (or stored Date) to the UTC instant of IST
// midnight starting that business day. Booking/Availability `date` fields are
// stored in this form, so rival range queries always contain them regardless
// of server timezone. Identical instants to the old local-midnight values on
// IST-pinned hosts.
const parseDay = (dateInput) => istMidnight(dateInput);

const intervalsOverlap = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

// IST "YYYY-MM-DD" day string for the given Date (F-08): business-day
// comparisons (unavailable auto-reset, blocked dates) run on the business
// clock, not the server clock. Identical values to the old local version on
// IST-pinned hosts.
const localDayString = (d = new Date()) => istDayString(d);

// A cook who toggled "unavailable" becomes available again automatically on the
// next day. If the stored unavailableDate is before today, reset the flag in
// the DB and return true so the cook is treated as available right now.
// Canonical copy — controllers must import this instead of duplicating it.
const resolveCookAvailability = async (profile) => {
  if (!profile) return true;
  const status = profile.availabilityStatus;
  if (status === "unavailable") {
    const today = localDayString();
    // Treat as timeless if no date was recorded — availabilityStatus was raised
    // before tracking dates, so keep them unavailable until manually changed.
    if (profile.unavailableDate && profile.unavailableDate < today) {
      try {
        await CookProfile.findByIdAndUpdate(profile._id, {
          availabilityStatus: "available",
          unavailableDate: "",
        });
      } catch {}
      return true;
    }
  }
  // Field COULD be absent on legacy profiles (and controllers that only select
  // a subset). The schema default is "available" — treat an unset status the
  // same way so cooks are never silently rendered unbookable.
  return status == null || status === "available";
};

// ── Cook working hours ─────────────────────────────────────────────────────
// The universal service day every cook starts from (08:00–20:00).
const serviceDayWindow = () => ({
  startTime: minutesToTime(SERVICE_DAY_START_MIN),
  endTime: minutesToTime(SERVICE_DAY_END_MIN),
  status: "available",
  derived: true,
});

// Windows a cook has actually agreed to work on `dateStr`, derived from the
// weekly schedule published on their profile:
//   - no schedule configured → the universal 08:00–20:00 day (back-compat:
//     cooks who never opened the schedule editor stay bookable as before);
//   - the date is in `blockedDates` → nothing at all;
//   - otherwise → that weekday's enabled windows, clamped to the service day.
// Pure and in-memory: callers pass a profile whose `schedule` is loaded, or a
// lean profile object straight out of a find().
const resolveCookWindows = (profile, dateStr) => {
  const schedule = profile?.schedule || null;
  const weekly = Array.isArray(schedule?.weekly) ? schedule.weekly : [];
  const enabled = weekly.filter((w) => w && w.enabled);
  if (enabled.length === 0) return [serviceDayWindow()];

  const day = parseDay(dateStr);
  if (!day || Number.isNaN(day.getTime())) return [serviceDayWindow()];
  const blocked = Array.isArray(schedule?.blockedDates) ? schedule.blockedDates : [];
  if (blocked.includes(localDayString(day))) return [];

  // IST weekday (F-08): Date#getDay is server-local and picks the wrong
  // weekday on non-IST hosts.
  const weekday = istWeekday(day);
  if (weekday == null) return [serviceDayWindow()];
  const windows = [];
  for (const w of enabled) {
    if (Number(w.day) !== weekday) continue;
    const s = timeToMinutes(w.startTime);
    const e = timeToMinutes(w.endTime);
    if (s == null || e == null || e <= s) continue;
    const start = Math.max(s, SERVICE_DAY_START_MIN);
    const end = Math.min(e, SERVICE_DAY_END_MIN);
    if (end <= start) continue;
    windows.push({
      startTime: minutesToTime(start),
      endTime: minutesToTime(end),
      status: "available",
      derived: true,
    });
  }
  return windows;
};

// Windows for a cook on a date. Cooks publish their own working hours; the
// fallback is the universal service day. `cookId` is a USER id (the id stored
// on Booking.cook), and a missing cook / unreadable profile keeps the old
// full-day behaviour so a schedule lookup can never make a cook unbookable.
const getDayWindows = async (cookId, dateStr) => {
  if (!cookId) return [serviceDayWindow()];
  let profile = null;
  try {
    const CookProfile = require("../models/CookProfile");
    profile = await CookProfile.findOne({ user: cookId }).select("schedule").lean();
  } catch {
    // No DB (unit tests) or the profile is missing — fall back to full day.
    profile = null;
  }
  if (!profile) return [serviceDayWindow()];
  return resolveCookWindows(profile, dateStr);
};

const getDayBookings = (cookId, dateStr) => {
  const { start, end } = dayBounds(dateStr);
  return Booking.find({
    cook: cookId,
    date: { $gte: start, $lte: end },
    $or: activeSlotMatch(),
  }).select("startTime endTime status");
};

// Every viable {startTime, endTime} of length durationHours inside the open
// windows, skipping anything overlapping an existing booking.
const computeStartOptions = (windows, bookings, durationHours) => {
  const durMin = Math.round(Number(durationHours) * 60);
  // Minimum 30 min — matches the 0.5h floor used by the booking route,
  // availability endpoint and payment flow (short sessions are bookable).
  if (!Number.isFinite(durMin) || durMin < 30 || durMin > 12 * 60) return [];

  const busy = (bookings || [])
    .map((b) => ({ s: timeToMinutes(b.startTime), e: timeToMinutes(b.endTime) }))
    .filter((b) => b.s != null && b.e != null);

  const options = [];
  const seen = new Set();
  for (const w of windows || []) {
    let wStart = timeToMinutes(w.startTime);
    let wEnd = timeToMinutes(w.endTime);
    if (wStart == null || wEnd == null) continue;
    // Clamp to the 08:00–20:00 service day (covers raw Availability docs
    // passed in directly, not only getDayWindows output).
    wStart = Math.max(wStart, SERVICE_DAY_START_MIN);
    wEnd = Math.min(wEnd, SERVICE_DAY_END_MIN);
    if (wEnd - wStart < durMin) continue;
    for (let s = wStart; s + durMin <= wEnd && options.length < MAX_OPTIONS; s += STEP_MINUTES) {
      const e = s + durMin;
      if (busy.some((b) => intervalsOverlap(s, e, b.s, b.e))) continue;
      const key = `${s}-${e}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ startTime: minutesToTime(s), endTime: minutesToTime(e) });
    }
    if (options.length >= MAX_OPTIONS) break;
  }
  return options.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
};

// Session lengths (whole launch hours) strictly below `requested` that still
// fit at least one start option inside the open windows — largest first,
// capped at `max`. Pure in-memory recovery hint so "no 3-hour slots" can
// become a one-tap "try 2 hours" instead of a dead end.
const suggestDurations = (windows, bookings, requested, max = 3) => {
  const out = [];
  const top = Math.floor(Number(requested));
  if (!Number.isFinite(top) || top <= 1) return out;
  for (let d = top - 1; d >= 1 && out.length < max; d -= 1) {
    if (computeStartOptions(windows, bookings, d).length > 0) out.push(d);
  }
  return out;
};

// Is the requested [startTime, endTime] fully inside one open window?
const findContainingWindow = (windows, startTime, endTime) => {
  const s = timeToMinutes(startTime);
  const e = timeToMinutes(endTime);
  if (s == null || e == null || e <= s) return null;
  return (windows || []).find((w) => {
    const ws = timeToMinutes(w.startTime);
    const we = timeToMinutes(w.endTime);
    return ws != null && we != null && ws <= s && e <= we;
  });
};

// First existing booking overlapping [startTime, endTime], if any.
const findOverlapBooking = (bookings, startTime, endTime) => {
  const s = timeToMinutes(startTime);
  const e = timeToMinutes(endTime);
  if (s == null || e == null || e <= s) return null;
  return (bookings || []).find((b) => {
    const bs = timeToMinutes(b.startTime);
    const be = timeToMinutes(b.endTime);
    return bs != null && be != null && intervalsOverlap(s, e, bs, be);
  });
};

module.exports = {
  BLOCKING_STATUSES,
  activeSlotMatch,
  timeToMinutes,
  minutesToTime,
  dayBounds,
  parseDay,
  localDayString,
  resolveCookAvailability,
  intervalsOverlap,
  getDayWindows,
  resolveCookWindows,
  serviceDayWindow,
  getDayBookings,
  computeStartOptions,
  suggestDurations,
  findContainingWindow,
  findOverlapBooking,
};
