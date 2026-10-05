const Availability = require("../models/Availability");
const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const { getDayWindows, getDayBookings, computeStartOptions, suggestDurations, parseDay, resolveCookAvailability, timeToMinutes, findContainingWindow, findOverlapBooking, dayBounds, activeSlotMatch, resolveCookWindows } = require("../utils/slots");

exports.searchAvailability = async (req, res, next) => {
  try {
    const { date, durationHours } = req.query;
    const strictDay = (() => {
      try {
        const { parseDayStrict } = require("../utils/time");
        return parseDayStrict(date);
      } catch {
        return null;
      }
    })();
    if (!strictDay) {
      return res.status(400).json({ message: "Valid date (YYYY-MM-DD) is required" });
    }
    const { istDayString } = require("../utils/time");
    if (istDayString(strictDay) < istDayString()) {
      return res.status(400).json({ message: "That date already passed — please pick today or a future date." });
    }
    const start = strictDay;
    const dur = Number(durationHours);
    if (!Number.isFinite(dur) || dur < 0.5 || dur > 12) {
      return res.status(400).json({ message: "durationHours must be between 0.5 and 12" });
    }

    let cooks = await CookProfile.find({ approvalStatus: "approved" })
      .populate("user", "name status")
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    const totalCooks = cooks.length;
    const flags = await Promise.all(
      cooks.map(async (cook) => {
        if (!cook.user || cook.user.status === "suspended") return false;
        return resolveCookAvailability(cook);
      })
    );
    cooks = cooks.filter((_, i) => flags[i]);

    const { start: dayStart, end: dayEnd } = dayBounds(date);
    const cookUserIds = cooks.map((c) => c.user?._id || c.user);
    const allBookings = await Booking.find({
      cook: { $in: cookUserIds },
      date: { $gte: dayStart, $lte: dayEnd },
      $or: activeSlotMatch(),
    })
      .select("cook startTime endTime status")
      .lean();
    const byCook = new Map();
    for (const b of allBookings || []) {
      const key = String(b.cook);
      if (!byCook.has(key)) byCook.set(key, []);
      byCook.get(key).push(b);
    }

    const withSlots = cooks.map((cook) => {
      try {
        const id = String(cook.user?._id || cook.user);
        const options = computeStartOptions(
          resolveCookWindows(cook, date),
          byCook.get(id) || [],
          dur
        );
        return {
          ...cook,
          slots: options.map((o) => ({ _id: `${o.startTime}-${o.endTime}`, ...o, derived: true })),
        };
      } catch {
        return { ...cook, slots: [] };
      }
    });

    let suggestions = [];
    if (
      withSlots.every((c) => c.slots.length === 0) &&
      (req.query.suggest === "1" || req.query.suggest === "true")
    ) {
      const set = new Set();
      for (const cook of withSlots) {
        const id = String(cook.user?._id || cook.user);
        for (const h of suggestDurations(
          resolveCookWindows(cook, date),
          byCook.get(id) || [],
          dur
        )) {
          if (Number.isFinite(Number(h))) set.add(Number(h));
        }
        if (set.size >= 3) break;
      }
      suggestions = [...set].sort((a, b) => b - a).slice(0, 3);
    }

    res.json({ cooks: withSlots, totalCooks, suggestions });
  } catch (error) {
    next(error);
  }
};

exports.getAvailability = async (req, res, next) => {
  try {
    const { date, durationHours, startTime, endTime } = req.query;

    let cookId = req.params.cookId;
    let profile = null;
    try {
      profile = await CookProfile.findById(cookId).select(
        "user availabilityStatus unavailableDate approvalStatus"
      ).lean();
      if (profile?.user) cookId = profile.user.toString();
    } catch {
    }
    if (!profile) {
      profile = await CookProfile.findOne({ user: cookId }).select(
        "availabilityStatus unavailableDate approvalStatus"
      ).lean();
    }
    if (profile && !(await resolveCookAvailability(profile))) {
      return res.json([]);
    }
    {
      const viewerAdmin = req.user && String(req.user.role).toUpperCase() === "ADMIN";
      const viewerSelf = req.user?.id != null && String(req.user.id) === String(cookId);
      if (profile && !viewerAdmin && !viewerSelf) {
        let suspended = false;
        try {
          const User = require("../models/User");
          const cookUser = await User.findById(cookId).select("status").lean();
          suspended = !cookUser || cookUser.status === "suspended";
        } catch {
          suspended = false;
        }
        if (profile.approvalStatus !== "approved" || suspended) {
          return res.json([]);
        }
      }
    }

    const filter = { cook: cookId, status: "available" };
    if (date) {
      const bounds = dayBounds(date);
      if (!bounds) {
        return res.status(400).json({ message: "Invalid date" });
      }
      filter.date = { $gte: bounds.start, $lte: bounds.end };
    }

    const slots = await Availability.find(filter).sort({ date: 1, startTime: 1 }).lean();

    const dur = durationHours != null && durationHours !== "" ? Number(durationHours) : null;
    if ((dur != null || startTime != null || endTime != null) && date) {
      if (dur != null && (!Number.isFinite(dur) || dur < 0.5 || dur > 12)) {
        return res.status(400).json({ message: "durationHours must be between 0.5 and 12" });
      }
      const windows = await getDayWindows(cookId, date);
      const bookings = await getDayBookings(cookId, date);
      if (startTime != null || endTime != null) {
        if (!startTime || !endTime) {
          return res.status(400).json({ message: "startTime and endTime are both required" });
        }
        const sMin = timeToMinutes(String(startTime));
        const eMin = timeToMinutes(String(endTime));
        if (sMin == null || eMin == null || eMin <= sMin) {
          return res.status(400).json({ message: "Invalid time slot" });
        }
        if (!findContainingWindow(windows, String(startTime), String(endTime))) {
          return res.json({ free: false, reason: "Cook is not available for the selected time" });
        }
        if (findOverlapBooking(bookings, String(startTime), String(endTime))) {
          return res.json({ free: false, reason: "This time is already booked. Please pick another start time." });
        }
        return res.json({ free: true });
      }
      if (dur == null) {
        return res.json(slots);
      }
      const options = computeStartOptions(windows, bookings, dur);
      const shaped = options.map((o) => ({ _id: `${o.startTime}-${o.endTime}`, ...o, derived: true }));
      if (req.query.suggest === "1" || req.query.suggest === "true") {
        const suggestions = options.length ? [] : suggestDurations(windows, bookings, dur);
        return res.json({ slots: shaped, suggestions });
      }
      return res.json(shaped);
    }

    res.json(slots);
  } catch (error) {
    next(error);
  }
};

exports.setAvailability = async (req, res, next) => {
  try {
    const { date, startTime, endTime } = req.body;

    const day = parseDay(date);
    if (!day || Number.isNaN(day.getTime())) {
      return res.status(400).json({ message: "Valid date is required" });
    }
    const sMin = timeToMinutes(startTime);
    const eMin = timeToMinutes(endTime);
    if (sMin == null || eMin == null || eMin <= sMin) {
      return res.status(400).json({ message: "End time must be after start time" });
    }
    const bounds = dayBounds(day);
    const sameDay = await Availability.find({
      cook: req.user.id,
      date: { $gte: bounds.start, $lte: bounds.end },
    }).select("startTime endTime");
    const clash = (sameDay || []).some((s) => {
      const rs = timeToMinutes(s.startTime);
      const re = timeToMinutes(s.endTime);
      return rs != null && re != null && sMin < re && rs < eMin;
    });
    if (clash) {
      return res.status(400).json({ message: "This overlaps an existing slot" });
    }

    const slot = await Availability.create({
      cook: req.user.id,
      date: day,
      startTime,
      endTime,
    });
    res.status(201).json(slot);
  } catch (error) {
    next(error);
  }
};

exports.getMySlots = async (req, res, next) => {
  try {
    const slots = await Availability.find({ cook: req.user.id }).sort({
      date: 1,
      startTime: 1,
    });
    res.json(slots);
  } catch (error) {
    next(error);
  }
};

exports.removeAvailability = async (req, res, next) => {
  try {
    const slot = await Availability.findOneAndDelete({
      _id: req.params.id,
      cook: req.user.id,
    });
    if (!slot) {
      return res.status(404).json({ message: "Slot not found" });
    }
    res.json({ message: "Slot removed" });
  } catch (error) {
    next(error);
  }
};
