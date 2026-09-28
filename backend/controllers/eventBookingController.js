const EventBooking = require("../models/EventBooking");
const User = require("../models/User");
const CookProfile = require("../models/CookProfile");
const Notification = require("../models/Notification");
const { calculateEventPrice } = require("../utils/eventPricing");
const { paginationParams, applyPagination, sendList, HARD_CAP } = require("../utils/pagination");

// Human-readable id: EVT-XXXXXX (unique).
const generateBookingId = () =>
  `EVT-${Date.now().toString(36).toUpperCase()}${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;

// Allowed status moves (§15). Assignment goes through assignCook().
const ALLOWED_TRANSITIONS = {
  pending: ["cook_assigned", "cancelled"],
  cook_assigned: ["confirmed", "cancelled"],
  confirmed: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

// "HH:MM" → minutes since midnight (null when unparsable).
const timeToMinutes = (t) => {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

const sameDay = (a, b) => {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
};

// Session window a booking occupies: start → start + duration + extraHours.
const bookingWindow = (b) => {
  const s = timeToMinutes(b.startTime);
  if (s == null) return null;
  const span = (Number(b.duration) || 0) * 60 + (Number(b.extraHours) || 0) * 60;
  return { start: s, end: s + span };
};

const windowsOverlap = (a, b) => a.start < b.end && b.start < a.end;

// §20 rule 5 — a cook cannot have overlapping bookings. Checks the cook's
// other live event bookings on the same day for an overlapping window.
const findEventOverlap = async (cookId, eventDate, window, excludeId = null) => {
  const live = ["cook_assigned", "confirmed", "in_progress", "pending"];
  const q = { cookId, bookingStatus: { $in: live } };
  if (excludeId) q._id = { $ne: excludeId };
  const others = await EventBooking.find(q).select("eventDate startTime duration extraHours");
  return (others || []).find((o) => {
    if (!sameDay(o.eventDate, eventDate)) return false;
    const w = bookingWindow(o);
    return w && windowsOverlap(w, window);
  });
};

// Customer creates a booking request — status starts at PENDING (§10).
// No cook is chosen here; price is recomputed server-side (§20 rule 10).
exports.createEventBooking = async (req, res, next) => {
  try {
    const {
      eventType,
      eventDate,
      startTime,
      duration,
      guestCount,
      address,
      area = "",
      landmark = "",
      foodType = "Full Meal",
      menu,
      serviceType,
      additionalCook = 0,
      extraHours = 0,
      distanceKm = 0,
      distance,
      customerNotes = "",
    } = req.body || {};

    if (!eventType) return res.status(400).json({ message: "Event type is required" });
    if (!EventBooking.EVENT_TYPES.includes(eventType)) {
      return res.status(400).json({ message: "Invalid event type" });
    }
    if (!EventBooking.EVENT_SERVICES.includes(serviceType)) {
      return res.status(400).json({ message: "Valid service type is required" });
    }
    if (!EventBooking.EVENT_FOOD_TYPES.includes(foodType)) {
      return res.status(400).json({ message: "Invalid food type" });
    }
    const day = new Date(eventDate);
    if (Number.isNaN(day.getTime())) {
      return res.status(400).json({ message: "Valid event date is required" });
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (day < today) {
      return res.status(400).json({ message: "Event date cannot be in the past" });
    }
    if (timeToMinutes(startTime) == null) {
      return res.status(400).json({ message: "Valid start time (HH:MM) is required" });
    }
    const dur = Number(duration);
    if (!Number.isFinite(dur) || dur < 1 || dur > 8) {
      return res.status(400).json({ message: "Duration must be between 1 and 8 hours" });
    }
    const guests = Number(guestCount);
    if (!Number.isFinite(guests) || guests < 1 || guests > 1000) {
      return res.status(400).json({ message: "Guest count must be between 1 and 1000" });
    }
    if (!address || !String(address).trim()) {
      return res.status(400).json({ message: "Address is required" });
    }
    if (!menu || !String(menu).trim()) {
      return res.status(400).json({ message: "Please enter your menu requirements" });
    }

    const quote = await calculateEventPrice({
      serviceType,
      duration: dur,
      distanceKm: distanceKm ?? distance ?? 0,
      additionalCook,
      extraHours,
    });

    const booking = await EventBooking.create({
      bookingId: generateBookingId(),
      customerId: req.user.id,
      eventType,
      eventDate: day,
      startTime,
      duration: dur,
      guestCount: guests,
      address: String(address).trim(),
      area: String(area || "").trim(),
      landmark: String(landmark || "").trim(),
      foodType,
      menu: String(menu).trim(),
      serviceType,
      additionalCook: Math.max(0, Math.floor(Number(additionalCook) || 0)),
      extraHours: Math.max(0, Number(extraHours) || 0),
      distanceKm: Math.max(0, Number(distanceKm ?? distance ?? 0) || 0),
      serviceAmount: quote.serviceAmount,
      additionalCookAmount: quote.additionalCookAmount,
      extraHourAmount: quote.extraHourAmount,
      travelCharge: quote.travelCharge,
      totalAmount: quote.totalAmount,
      bookingStatus: "pending",
      customerNotes: String(customerNotes || ""),
      statusHistory: [{ status: "pending", note: "Booking request received" }],
    });

    try {
      const admins = await User.find({ role: "ADMIN", status: "active" }).select("_id");
      await Notification.insertMany(
        (admins || []).map((a) => ({
          user: a._id,
          type: "event_booking_request",
          message: `New event booking ${booking.bookingId}: ${eventType} on ${day.toLocaleDateString("en-IN")} — please assign a cook.`,
        }))
      );
    } catch {
      // non-fatal: booking already created
    }

    res.status(201).json(booking);
  } catch (error) {
    next(error);
  }
};

const populateBooking = (q) =>
  q
    .populate("customerId", "name email phone mobile")
    .populate("cookId", "name email phone mobile avatar");

exports.getMyEventBookings = async (req, res, next) => {
  try {
    const filter = { customerId: req.user.id };
    if (req.query.status) filter.bookingStatus = req.query.status;
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      populateBooking(EventBooking.find(filter)).sort({ eventDate: 1 }).limit(HARD_CAP),
      pg
    );
    return sendList(res, bookings, pg, () => EventBooking.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

exports.getCookEventBookings = async (req, res, next) => {
  try {
    const filter = { cookId: req.user.id };
    if (req.query.status) filter.bookingStatus = req.query.status;
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      populateBooking(EventBooking.find(filter)).sort({ eventDate: 1 }).limit(HARD_CAP),
      pg
    );
    return sendList(res, bookings, pg, () => EventBooking.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

exports.getAdminEventBookings = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status) filter.bookingStatus = req.query.status;
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      populateBooking(EventBooking.find(filter)).sort({ createdAt: -1 }).limit(HARD_CAP),
      pg
    );
    return sendList(res, bookings, pg, () => EventBooking.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

exports.getEventBookingById = async (req, res, next) => {
  try {
    const booking = await populateBooking(EventBooking.findById(req.params.id));
    if (!booking) return res.status(404).json({ message: "Event booking not found" });
    const role = String(req.user.role).toUpperCase();
    const mine =
      String(booking.customerId?._id || booking.customerId) === req.user.id ||
      (booking.cookId && String(booking.cookId?._id || booking.cookId) === req.user.id);
    if (role !== "ADMIN" && !mine) {
      return res.status(403).json({ message: "Not authorized for this action" });
    }
    res.json(booking);
  } catch (error) {
    next(error);
  }
};

// Admin assigns a verified, available cook (§11). Only verified cooks, no
// overlapping bookings (§20 rules 3–5).
exports.assignCook = async (req, res, next) => {
  try {
    const booking = await EventBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Event booking not found" });
    if (!["pending", "cook_assigned"].includes(booking.bookingStatus)) {
      return res.status(400).json({ message: "Only pending bookings can be assigned a cook" });
    }
    const { cookId } = req.body || {};
    if (!cookId) return res.status(400).json({ message: "cookId is required" });

    const cookUser = await User.findById(cookId).select("role status name");
    if (!cookUser || String(cookUser.role).toUpperCase() !== "COOK") {
      return res.status(400).json({ message: "Selected user is not a cook" });
    }
    if (cookUser.status !== "active") {
      return res.status(400).json({ message: "This cook's account is not active" });
    }
    const profile = await CookProfile.findOne({ user: cookId });
    if (!profile || profile.approvalStatus !== "approved") {
      return res.status(400).json({ message: "Only verified cooks can be assigned (§20 rule 3)" });
    }

    const window = bookingWindow(booking);
    if (window) {
      const clash = await findEventOverlap(cookId, booking.eventDate, window, booking._id);
      if (clash) {
        return res.status(409).json({
          message: `This cook already has an event booking (${clash.bookingId || "another event"}) overlapping those hours`,
        });
      }
    }

    booking.cookId = cookId;
    booking.bookingStatus = "cook_assigned";
    booking.statusHistory.push({ status: "cook_assigned", note: `Cook assigned by admin` });
    await booking.save();

    try {
      await Notification.create({
        user: booking.customerId,
        type: "event_cook_assigned",
        message: `Good news! ${cookUser.name || "A cook"} has been assigned to your ${booking.eventType} on ${new Date(booking.eventDate).toLocaleDateString("en-IN")}.`,
      });
      await Notification.create({
        user: cookId,
        type: "event_assignment",
        message: `New event assignment: ${booking.eventType} on ${new Date(booking.eventDate).toLocaleDateString("en-IN")}, ${booking.startTime} — ${booking.guestCount} guests.`,
      });
    } catch {
      // non-fatal
    }

    const populated = await populateBooking(EventBooking.findById(booking._id));
    res.json(populated);
  } catch (error) {
    next(error);
  }
};

// Admin status moves (§15): cook_assigned → confirmed → in_progress → completed.
exports.updateEventBookingStatus = async (req, res, next) => {
  try {
    const booking = await EventBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Event booking not found" });
    const { status, note = "" } = req.body || {};
    const allowed = ALLOWED_TRANSITIONS[booking.bookingStatus] || [];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({
        message: `Cannot move from ${booking.bookingStatus} to ${status || "(none)"}`,
      });
    }
    if (["confirmed", "in_progress", "completed"].includes(status) && !booking.cookId) {
      return res.status(400).json({ message: "Assign a cook before confirming this booking" });
    }
    booking.bookingStatus = status;
    booking.statusHistory.push({ status, note: String(note || "") });
    await booking.save();

    try {
      await Notification.create({
        user: booking.customerId,
        type: "event_status",
        message: `Your event booking ${booking.bookingId} is now ${status.replace(/_/g, " ").toUpperCase()}.`,
      });
      if (booking.cookId) {
        await Notification.create({
          user: booking.cookId,
          type: "event_status",
          message: `Event booking ${booking.bookingId} is now ${status.replace(/_/g, " ").toUpperCase()}.`,
        });
      }
    } catch {
      // non-fatal
    }

    const populated = await populateBooking(EventBooking.findById(booking._id));
    res.json(populated);
  } catch (error) {
    next(error);
  }
};

// Customer (own booking) or admin can cancel a live booking.
exports.cancelEventBooking = async (req, res, next) => {
  try {
    const booking = await EventBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Event booking not found" });
    const role = String(req.user.role).toUpperCase();
    const isOwner = String(booking.customerId) === req.user.id;
    if (role !== "ADMIN" && !isOwner) {
      return res.status(403).json({ message: "Not authorized for this action" });
    }
    if (["completed", "cancelled"].includes(booking.bookingStatus)) {
      return res.status(400).json({ message: "This booking cannot be cancelled" });
    }
    booking.bookingStatus = "cancelled";
    booking.statusHistory.push({ status: "cancelled", note: role === "ADMIN" ? "Cancelled by admin" : "Cancelled by customer" });
    await booking.save();

    try {
      const other = role === "ADMIN" ? booking.customerId : null;
      if (other) {
        await Notification.create({
          user: other,
          type: "event_cancelled",
          message: `Your event booking ${booking.bookingId} has been cancelled by CookMitra.`,
        });
      }
      if (booking.cookId) {
        await Notification.create({
          user: booking.cookId,
          type: "event_cancelled",
          message: `Event booking ${booking.bookingId} has been cancelled.`,
        });
      }
    } catch {
      // non-fatal
    }

    res.json(booking);
  } catch (error) {
    next(error);
  }
};

// Admin dashboard counts (§16): totals by status + revenue from live bookings.
exports.getEventStats = async (req, res, next) => {
  try {
    const groups = await EventBooking.aggregate([
      { $group: { _id: "$bookingStatus", count: { $sum: 1 }, revenue: { $sum: "$totalAmount" } } },
    ]);
    const byStatus = {};
    let totalBookings = 0;
    let totalRevenue = 0;
    for (const g of groups) {
      byStatus[g._id] = { count: g.count, revenue: g.revenue };
      totalBookings += g.count;
      if (!["cancelled"].includes(g._id)) totalRevenue += g.revenue;
    }
    res.json({ totalBookings, totalRevenue, byStatus });
  } catch (error) {
    next(error);
  }
};
