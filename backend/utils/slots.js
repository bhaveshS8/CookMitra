
const Availability = require("../models/Availability");
const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const {
  istMidnight,
  istDayRange,
  istDayString,
  istWeekday,
} = require("./time");

const BLOCKING_STATUSES = ["accepted", "confirmed", "in_progress"];

const activeSlotMatch = () => [
  { status: { $in: BLOCKING_STATUSES } },
  { status: "requested", requestExpiresAt: { $gt: new Date() } },
];

const STEP_MINUTES = 30;
const MAX_OPTIONS = 48;

const SERVICE_DAY_START_MIN = 8 * 60;
const SERVICE_DAY_END_MIN = 20 * 60;

const timeToMinutes = (t) => {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

const minutesToTime = (mins) => {
  const normalized = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

const dayBounds = (dateInput) => {
  return (
    istDayRange(dateInput) || { start: new Date(0), end: new Date(0) }
  );
};

const parseDay = (dateInput) => istMidnight(dateInput);

const intervalsOverlap = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

const localDayString = (d = new Date()) => istDayString(d);

const resolveCookAvailability = async (profile) => {
  if (!profile) return true;
  const status = profile.availabilityStatus;
  if (status === "unavailable") {
    const today = localDayString();
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
  return status == null || status === "available";
};

const serviceDayWindow = () => ({
  startTime: minutesToTime(SERVICE_DAY_START_MIN),
  endTime: minutesToTime(SERVICE_DAY_END_MIN),
  status: "available",
  derived: true,
});

const resolveCookWindows = (profile, dateStr) => {
  const schedule = profile?.schedule || null;
  const weekly = Array.isArray(schedule?.weekly) ? schedule.weekly : [];
  const enabled = weekly.filter((w) => w && w.enabled);
  if (enabled.length === 0) return [serviceDayWindow()];

  const day = parseDay(dateStr);
  if (!day || Number.isNaN(day.getTime())) return [serviceDayWindow()];
  const blocked = Array.isArray(schedule?.blockedDates) ? schedule.blockedDates : [];
  if (blocked.includes(localDayString(day))) return [];

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

const getDayWindows = async (cookId, dateStr) => {
  if (!cookId) return [serviceDayWindow()];
  let profile = null;
  try {
    const CookProfile = require("../models/CookProfile");
    profile = await CookProfile.findOne({ user: cookId }).select("schedule").lean();
  } catch {
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
  }).select("startTime endTime status").lean();
};

const computeStartOptions = (windows, bookings, durationHours) => {
  const durMin = Math.round(Number(durationHours) * 60);
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

const suggestDurations = (windows, bookings, requested, max = 3) => {
  const out = [];
  const top = Math.floor(Number(requested));
  if (!Number.isFinite(top) || top <= 1) return out;
  for (let d = top - 1; d >= 1 && out.length < max; d -= 1) {
    if (computeStartOptions(windows, bookings, d).length > 0) out.push(d);
  }
  return out;
};

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
