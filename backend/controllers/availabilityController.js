const Availability = require("../models/Availability");
const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const { getDayWindows, getDayBookings, computeStartOptions, suggestDurations, parseDay, resolveCookAvailability, timeToMinutes, findContainingWindow, findOverlapBooking, dayBounds, activeSlotMatch, resolveCookWindows } = require("../utils/slots");

// Batched slot search — ONE request replaces the N+1 per-cook fan-out
// (1 × GET /cooks + N × GET /availability/:cookId) the booking flow used
// to fire from the browser. Same math, server-side: approved + available
// cooks only, one bookings $in query for the whole day, in-memory slot
// derivation per cook. Keeps 1000-user search spikes to ~3 DB round trips
// instead of ~3 per cook.
//
// GET /api/availability/search?date=YYYY-MM-DD&durationHours=3&suggest=1
// → { cooks: [{...profile, slots: [{_id,startTime,endTime,derived}]}], totalCooks, suggestions }
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

    // Same discovery set as GET /cooks for guests: approved profiles whose
    // account is live and who are currently marked available.
    // Contact PII: the slot search needs names + suspension flags only —
    // cook phones are shared post-accept via booking payloads, never in
    // bulk discovery (this endpoint has no auth).
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

    // One bookings lookup for every cook on that day (indexed
    // {cook,date,…}), then pure in-memory derivation per cook. Each cook's
    // own published working hours are applied in memory (resolveCookWindows)
    // so the batched search costs no extra queries while still respecting the
    // schedule a cook actually agreed to.
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

    // Recovery hints when nothing fits: shorter sessions that DO fit,
    // unioned across cooks (same helper the per-cook endpoint uses).
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

    // Accept either a User id or a CookProfile id — Availability.cook stores
    // the user id, so a bare profile id would otherwise match nothing and
    // every slot search would come back empty ("no slots").
    let cookId = req.params.cookId;
    let profile = null;
    try {
      profile = await CookProfile.findById(cookId).select(
        "user availabilityStatus unavailableDate approvalStatus"
      );
      if (profile?.user) cookId = profile.user.toString();
    } catch {
      // not a profile id — use the param as a user id
    }
    if (!profile) {
      profile = await CookProfile.findOne({ user: cookId }).select(
        "availabilityStatus unavailableDate approvalStatus"
      );
    }
    // A cook who has toggled "unavailable" exposes no slots until they flip
    // back or the next day begins.
    if (profile && !(await resolveCookAvailability(profile))) {
      return res.json([]);
    }
    // Mirror getAvailableSlots: unapproved / suspended cooks expose no
    // public slots (the cook themself and admins still see the raw list).
    // Without this, per-cook probes answer for cooks the listing hides.
    {
      const viewerAdmin = req.user && String(req.user.role).toUpperCase() === "ADMIN";
      const viewerSelf = req.user?.id != null && String(req.user.id) === String(cookId);
      if (profile && !viewerAdmin && !viewerSelf) {
        let suspended = false;
        try {
          const User = require("../models/User");
          const cookUser = await User.findById(cookId).select("status");
          suspended = !cookUser || cookUser.status === "suspended";
        } catch {
          // fail-closed below only when we know the profile is unapproved;
          // an unreadable account record must not block a valid cook.
          suspended = false;
        }
        if (profile.approvalStatus !== "approved" || suspended) {
          return res.json([]);
        }
      }
    }

    const filter = { cook: cookId, status: "available" };
    if (date) {
      // IST business-day range (F-08) — matches how slots are stored.
      const bounds = dayBounds(date);
      if (!bounds) {
        return res.status(400).json({ message: "Invalid date" });
      }
      filter.date = { $gte: bounds.start, $lte: bounds.end };
    }

    const slots = await Availability.find(filter).sort({ date: 1, startTime: 1 });

    // Duration-aware mode: derive bookable start times sized to the input
    // service hours (open windows minus already-booked intervals).
    // Exact-window mode (?startTime=&endTime=): answer whether that single
    // interval is free — { free, reason } — so the booking flow can
    // double-check a slot before creating the request.
    const dur = durationHours != null && durationHours !== "" ? Number(durationHours) : null;
    if ((dur != null || startTime != null || endTime != null) && date) {
      if (dur != null && (!Number.isFinite(dur) || dur < 0.5 || dur > 12)) {
        return res.status(400).json({ message: "durationHours must be between 0.5 and 12" });
      }
      // Universal full-day availability: always derive from the full service
      // day — published windows are informational only and never restrict
      // bookability; existing bookings (fetched below) are the only blockers.
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
        // Exact-window-only query already returned above; without a duration
        // there are no start options to derive — fall through to raw slots.
        return res.json(slots);
      }
      const options = computeStartOptions(windows, bookings, dur);
      const shaped = options.map((o) => ({ _id: `${o.startTime}-${o.endTime}`, ...o, derived: true }));
      // Opt-in recovery hint: when nothing fits, name shorter session lengths
      // that DO fit (computed from the same in-memory windows — no extra
      // queries) so the client can offer one-tap retries. Shape is unchanged
      // unless suggest=1 is passed.
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
    // Overlap check, not exact-match: a stored 09:00–12:00 window must also
    // block a new 10:00–11:00 window (and vice versa), not just an identical
    // start time.
    // IST business-day range (F-08) — matches stored slot dates.
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
