const Booking = require("../models/Booking");
const EventBooking = require("../models/EventBooking");
const { dayBounds, timeToMinutes, minutesToTime, intervalsOverlap } = require("../utils/slots");

const REGULAR_BLOCKING_STATUSES = ["accepted", "confirmed", "in_progress"];
const EVENT_BLOCKING_STATUSES = ["pending", "cook_assigned", "confirmed", "in_progress"];

const hasLiveDb = (model) => Boolean(model && model.db && model.db.client);

const regularWindow = (booking) => {
  const start = timeToMinutes(booking?.startTime);
  const end = timeToMinutes(booking?.endTime);
  if (start == null || end == null || end <= start) return null;
  return { start, end };
};

const eventWindow = (booking) => {
  const start = timeToMinutes(booking?.startTime);
  if (start == null) return null;
  const span = (Number(booking?.duration) || 0) * 60 + (Number(booking?.extraHours) || 0) * 60;
  if (!Number.isFinite(span) || span <= 0) return null;
  return { start, end: start + span };
};

const overlaps = (a, b) => Boolean(a && b && intervalsOverlap(a.start, a.end, b.start, b.end));

const findRegularConflict = async ({
  cookId,
  date,
  startTime,
  endTime,
  window = null,
  excludeBookingId = null,
} = {}) => {
  if (!cookId || !hasLiveDb(Booking)) return null;
  const mine = window || regularWindow({ startTime, endTime });
  if (!mine) return null;
  const { start: dayStart, end: dayEnd } = dayBounds(date);
  if (!dayStart || !dayEnd) return null;
  const query = {
    cook: cookId,
    date: { $gte: dayStart, $lte: dayEnd },
    status: { $in: REGULAR_BLOCKING_STATUSES },
  };
  if (excludeBookingId) query._id = { $ne: excludeBookingId };
  const rivals = await Booking.find(query).select("startTime endTime status bookingId");
  const clash = (rivals || []).find((rival) => overlaps(mine, regularWindow(rival)));
  if (!clash) return null;
  return {
    kind: "regular",
    id: String(clash._id),
    bookingId: clash.bookingId || String(clash._id),
    status: clash.status,
    window: regularWindow(clash),
    message: `This cook already has a regular booking (${clash.bookingId || "another booking"}) overlapping those hours`,
  };
};

const findEventConflict = async ({
  cookId,
  date,
  startTime,
  endTime,
  window = null,
  excludeEventId = null,
} = {}) => {
  if (!cookId || !hasLiveDb(EventBooking)) return null;
  const mine = window || regularWindow({ startTime, endTime });
  if (!mine) return null;
  const { start: dayStart, end: dayEnd } = dayBounds(date);
  if (!dayStart || !dayEnd) return null;
  const query = {
    cookId,
    eventDate: { $gte: dayStart, $lte: dayEnd },
    bookingStatus: { $in: EVENT_BLOCKING_STATUSES },
  };
  if (excludeEventId) query._id = { $ne: excludeEventId };
  const rivals = await EventBooking.find(query).select("startTime duration extraHours bookingStatus bookingId");
  const clash = (rivals || []).find((rival) => overlaps(mine, eventWindow(rival)));
  if (!clash) return null;
  return {
    kind: "event",
    id: String(clash._id),
    bookingId: clash.bookingId || String(clash._id),
    status: clash.bookingStatus,
    window: eventWindow(clash),
    message: `This cook already has an event booking (${clash.bookingId || "another event"}) overlapping those hours`,
  };
};

const findEventBusyWindows = async ({ cookId, date } = {}) => {
  if (!cookId || !hasLiveDb(EventBooking)) return [];
  const { start: dayStart, end: dayEnd } = dayBounds(date);
  if (!dayStart || !dayEnd) return [];
  const rivals = await EventBooking.find({
    cookId,
    eventDate: { $gte: dayStart, $lte: dayEnd },
    bookingStatus: { $in: EVENT_BLOCKING_STATUSES },
  }).select("startTime duration extraHours bookingStatus bookingId");
  return (rivals || []).map((rival) => {
    const window = eventWindow(rival);
    if (!window) return null;
    return {
      startTime: minutesToTime(window.start),
      endTime: minutesToTime(window.end),
      window,
      status: rival.bookingStatus,
      bookingId: rival.bookingId || String(rival._id),
    };
  }).filter(Boolean);
};

const findEventBusyWindowsMap = async ({ cookIds = [], date } = {}) => {
  const map = new Map();
  if (!Array.isArray(cookIds) || cookIds.length === 0 || !hasLiveDb(EventBooking)) return map;
  const { start: dayStart, end: dayEnd } = dayBounds(date);
  if (!dayStart || !dayEnd) return map;
  const rivals = await EventBooking.find({
    cookId: { $in: cookIds },
    eventDate: { $gte: dayStart, $lte: dayEnd },
    bookingStatus: { $in: EVENT_BLOCKING_STATUSES },
  }).select("cookId startTime duration extraHours bookingStatus bookingId");
  for (const rival of rivals || []) {
    const window = eventWindow(rival);
    if (!window) continue;
    const key = String(rival.cookId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      startTime: minutesToTime(window.start),
      endTime: minutesToTime(window.end),
      window,
      status: rival.bookingStatus,
      bookingId: rival.bookingId || String(rival._id),
    });
  }
  return map;
};

const findEventConflictMap = async ({
  cookIds = [],
  date,
  startTime,
  endTime,
  excludeEventId = null,
} = {}) => {
  const map = new Map();
  if (!Array.isArray(cookIds) || cookIds.length === 0 || !hasLiveDb(EventBooking)) return map;
  const mine = regularWindow({ startTime, endTime });
  if (!mine) return map;
  const { start: dayStart, end: dayEnd } = dayBounds(date);
  if (!dayStart || !dayEnd) return map;
  const query = {
    cookId: { $in: cookIds },
    eventDate: { $gte: dayStart, $lte: dayEnd },
    bookingStatus: { $in: EVENT_BLOCKING_STATUSES },
  };
  if (excludeEventId) query._id = { $ne: excludeEventId };
  const rivals = await EventBooking.find(query).select("cookId startTime duration extraHours bookingStatus bookingId");
  for (const rival of rivals || []) {
    if (!overlaps(mine, eventWindow(rival))) continue;
    const key = String(rival.cookId);
    if (map.has(key)) continue;
    map.set(key, {
      kind: "event",
      id: String(rival._id),
      bookingId: rival.bookingId || String(rival._id),
      status: rival.bookingStatus,
      window: eventWindow(rival),
      message: `This cook already has an event booking (${rival.bookingId || "another event"}) overlapping those hours`,
    });
  }
  return map;
};

const findCrossModuleConflict = async (params = {}) => {
  const eventConflict = await findEventConflict(params);
  if (eventConflict) return eventConflict;
  return findRegularConflict(params);
};

module.exports = {
  REGULAR_BLOCKING_STATUSES,
  EVENT_BLOCKING_STATUSES,
  regularWindow,
  eventWindow,
  findRegularConflict,
  findEventConflict,
  findEventConflictMap,
  findEventBusyWindows,
  findEventBusyWindowsMap,
  findCrossModuleConflict,
};
