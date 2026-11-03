const Booking = require("../models/Booking");
const EventBooking = require("../models/EventBooking");
const { dayBounds, timeToMinutes, minutesToTime, intervalsOverlap } = require("../utils/slots");

const REGULAR_BLOCKING_STATUSES = ["accepted", "confirmed", "in_progress"];
const EVENT_BLOCKING_STATUSES = ["pending", "cook_assigned", "confirmed", "in_progress"];

// An event can have several assigned cooks (cookIds). A cook is busy when they
// appear in either the legacy primary field or the multi-cook array.
const eventCooksFilter = (condition) => ({
  $or: [{ cookId: condition }, { cookIds: condition }],
});

// All cook ids attached to an event booking (deduped, primary included).
const assignedCookIds = (booking) => {
  const ids = [];
  const push = (id) => {
    if (!id) return;
    const key = String(id);
    if (!ids.some((existing) => String(existing) === key)) ids.push(id);
  };
  if (Array.isArray(booking?.cookIds)) booking.cookIds.forEach(push);
  push(booking?.cookId);
  return ids;
};

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
    ...eventCooksFilter(cookId),
    eventDate: { $gte: dayStart, $lte: dayEnd },
    bookingStatus: { $in: EVENT_BLOCKING_STATUSES },
  };
  if (excludeEventId) query._id = { $ne: excludeEventId };
  const rivals = await EventBooking.find(query).select("startTime duration extraHours bookingStatus bookingId cookId cookIds");
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
    ...eventCooksFilter(cookId),
    eventDate: { $gte: dayStart, $lte: dayEnd },
    bookingStatus: { $in: EVENT_BLOCKING_STATUSES },
  }).select("startTime duration extraHours bookingStatus bookingId cookId cookIds");
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
    ...eventCooksFilter({ $in: cookIds }),
    eventDate: { $gte: dayStart, $lte: dayEnd },
    bookingStatus: { $in: EVENT_BLOCKING_STATUSES },
  }).select("cookId cookIds startTime duration extraHours bookingStatus bookingId");
  const requested = new Set(cookIds.map((id) => String(id)));
  for (const rival of rivals || []) {
    const window = eventWindow(rival);
    if (!window) continue;
    for (const assigned of assignedCookIds(rival)) {
      const key = String(assigned);
      if (!requested.has(key)) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({
        startTime: minutesToTime(window.start),
        endTime: minutesToTime(window.end),
        window,
        status: rival.bookingStatus,
        bookingId: rival.bookingId || String(rival._id),
      });
    }
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
    ...eventCooksFilter({ $in: cookIds }),
    eventDate: { $gte: dayStart, $lte: dayEnd },
    bookingStatus: { $in: EVENT_BLOCKING_STATUSES },
  };
  if (excludeEventId) query._id = { $ne: excludeEventId };
  const rivals = await EventBooking.find(query).select("cookId cookIds startTime duration extraHours bookingStatus bookingId");
  const requested = new Set(cookIds.map((id) => String(id)));
  for (const rival of rivals || []) {
    if (!overlaps(mine, eventWindow(rival))) continue;
    for (const assigned of assignedCookIds(rival)) {
      const key = String(assigned);
      if (!requested.has(key) || map.has(key)) continue;
      map.set(key, {
        kind: "event",
        id: String(rival._id),
        bookingId: rival.bookingId || String(rival._id),
        status: rival.bookingStatus,
        window: eventWindow(rival),
        message: `This cook already has an event booking (${rival.bookingId || "another event"}) overlapping those hours`,
      });
    }
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
  assignedCookIds,
};
