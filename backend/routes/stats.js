const express = require("express");
const router = express.Router();
const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const Review = require("../models/Review");
const DailyStat = require("../models/DailyStat");
const DailyVisitor = require("../models/DailyVisitor");
const PageStat = require("../models/PageStat");
const CityStat = require("../models/CityStat");
const { auth, authorize } = require("../middleware/auth");
const { istDayString, isBot, normalizeVisitInput } = require("../utils/visits");

// Public marketing stats for the homepage hero.
//
// Why this exists: the hero previously hardcoded "100+ cooks / 4.9 rating /
// 10+ cities", which is a CCPA 2022 misleading-ad exposure for a payment
// merchant. These numbers are computed live from the database so the site
// can never drift from reality again. Cached in memory for 5 minutes —
// the counts change slowly and this endpoint is hit on every homepage load.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, payload: null };

router.get("/", async (_req, res, next) => {
  try {
    if (cache.payload && Date.now() - cache.at < CACHE_TTL_MS) {
      return res.json(cache.payload);
    }

    const [approvedCooks, completedBookings, ratingAgg] = await Promise.all([
      CookProfile.countDocuments({ approvalStatus: "approved" }),
      // Completed services, or hours actually worked — both mean a family
      // was served.
      Booking.countDocuments({
        $or: [{ status: "completed" }, { hoursCompleted: true }],
      }),
      Review.aggregate([
        { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
      ]),
    ]);

    // Distinct service areas among approved cooks, e.g. "Baner, Kothrud".
    // Capped so the string stays short; empty when no cook lists an area.
    const areas = await CookProfile.distinct("serviceArea", {
      approvalStatus: "approved",
      serviceArea: { $ne: "" },
    });
    const cities = areas
      .map((a) => String(a || "").split(",")[0].trim())
      .filter(Boolean)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .slice(0, 8);

    const rating = ratingAgg[0] || { avg: null, count: 0 };

    // The frontend hides any stat below its display threshold, so the page
    // shows "growing in Pune" instead of "0 cooks" on day one and real
    // numbers the moment they are meaningful.
    const payload = {
      cooks: approvedCooks,
      bookings: completedBookings,
      ratingAverage:
        rating.count > 0 ? Math.round(Number(rating.avg) * 10) / 10 : null,
      ratingCount: rating.count,
      cities,
      updatedAt: new Date().toISOString(),
    };
    cache = { at: Date.now(), payload };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// POST /visit — public visit ping, fired once per browser session by the
// frontend (utils/analytics trackSiteVisit). No auth by design: guests must
// count too. Bots are ignored, garbage input is 400'd, and failures are
// invisible to the visitor (the client fire-and-forgets).
router.post("/visit", async (req, res, next) => {
  try {
    if (isBot(req.get("user-agent"))) return res.json({ ok: true, ignored: "bot" });
    const parsed = normalizeVisitInput(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const day = istDayString();
    await DailyStat.updateOne(
      { day },
      { $inc: { visits: 1 }, $setOnInsert: { uniques: 0 } },
      { upsert: true }
    );
    await PageStat.updateOne(
      { day, path: parsed.path },
      { $inc: { visits: 1 } },
      { upsert: true }
    );
    // Approximate city when the browser resolved one (IP-based, city-level
    // only — raw IPs are never sent or stored).
    if (parsed.city) {
      await CityStat.updateOne(
        { day, city: parsed.city, state: parsed.state },
        { $inc: { visits: 1 }, $setOnInsert: { country: parsed.country } },
        { upsert: true }
      );
    }
    // First time this anonymous id is seen today → counts as a new unique.
    // The compound-unique index makes concurrent pings safe.
    const seen = await DailyVisitor.updateOne(
      { day, vid: parsed.vid },
      { $setOnInsert: { day, vid: parsed.vid } },
      { upsert: true }
    );
    if (seen.upsertedCount > 0) {
      await DailyStat.updateOne({ day }, { $inc: { uniques: 1 } });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /visits — admin dashboard chart data: per-day visits/uniques for the
// last N days (default 30, max 365), range totals, top pages and top cities.
router.get("/visits", auth, authorize("admin"), async (req, res, next) => {
  try {
    let days = Math.round(Number(req.query.days)) || 30;
    days = Math.min(Math.max(days, 1), 365);
    const since = istDayString(new Date(Date.now() - (days - 1) * 86400000));
    const [series, totalsAgg, topPaths, topCities] = await Promise.all([
      DailyStat.find({ day: { $gte: since } })
        .sort({ day: 1 })
        .select("day visits uniques -_id")
        .lean(),
      DailyStat.aggregate([
        { $match: { day: { $gte: since } } },
        {
          $group: {
            _id: null,
            visits: { $sum: "$visits" },
            uniques: { $sum: "$uniques" },
          },
        },
      ]),
      PageStat.aggregate([
        { $match: { day: { $gte: since } } },
        { $group: { _id: "$path", visits: { $sum: "$visits" } } },
        { $sort: { visits: -1 } },
        { $limit: 10 },
        { $project: { _id: 0, path: "$_id", visits: 1 } },
      ]),
      CityStat.aggregate([
        { $match: { day: { $gte: since } } },
        {
          $group: {
            _id: { city: "$city", state: "$state", country: "$country" },
            visits: { $sum: "$visits" },
          },
        },
        { $sort: { visits: -1 } },
        { $limit: 10 },
        {
          $project: {
            _id: 0,
            city: "$_id.city",
            state: "$_id.state",
            country: "$_id.country",
            visits: 1,
          },
        },
      ]),
    ]);
    const totals = totalsAgg[0] || { visits: 0, uniques: 0 };
    res.json({
      days: series,
      totals: { visits: totals.visits || 0, uniques: totals.uniques || 0 },
      topPaths,
      topCities,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
