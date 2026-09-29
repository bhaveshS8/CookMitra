const express = require("express");
const router = express.Router();
const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const Review = require("../models/Review");
const DailyStat = require("../models/DailyStat");
const DailyVisitor = require("../models/DailyVisitor");
const VisitSession = require("../models/VisitSession");
const PageStat = require("../models/PageStat");
const CityStat = require("../models/CityStat");
const { auth, authorize } = require("../middleware/auth");
const { istDayString, istDayRange, parseDaysParam, isBot, normalizeVisitInput } = require("../utils/visits");

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

    // All 4 reads are independent — run together so one slow query can't
    // serialize the homepage hero (was: 3 in parallel, then distinct alone).
    const [approvedCooks, completedBookings, ratingAgg, areas] = await Promise.all([
      CookProfile.countDocuments({ approvalStatus: "approved" }),
      // Completed services, or hours actually worked — both mean a family
      // was served.
      Booking.countDocuments({
        $or: [{ status: "completed" }, { hoursCompleted: true }],
      }),
      Review.aggregate([
        { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
      ]),
      // Distinct service areas among approved cooks, e.g. "Baner, Kothrud".
      CookProfile.distinct("serviceArea", {
        approvalStatus: "approved",
        serviceArea: { $ne: "" },
      }),
    ]);
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

// POST /visit — public visit ping, fired once per browser-tab session by the
// frontend (utils/analytics trackSiteVisit sends { vid, sid, path, ... }).
// No auth by design: guests must count too. Bots are ignored, garbage input
// is 400'd, and failures are invisible to the visitor (fire-and-forget).
//
// Counting rule (server-enforced, not just the browser's sessionStorage
// gate): a visit is counted only for the FIRST accepted (day, vid, sid)
// triple. Replays and concurrent duplicates hit the VisitSession unique
// index and are answered idempotently ({ ok:true, deduped:true }) without
// touching any counter. A new tab (new sid) legitimately counts again.
// Duplicate-key races (E11000) under concurrency are treated as duplicates,
// never as errors.
const isDupKey = (err) => err && (err.code === 11000 || err.code === 11001);
router.post("/visit", async (req, res, next) => {
  try {
    if (isBot(req.get("user-agent"))) return res.json({ ok: true, ignored: "bot" });
    const parsed = normalizeVisitInput(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    const day = istDayString();
    // Session gate FIRST: exactly one counted visit per (day, vid, sid).
    let sessionSeen;
    try {
      sessionSeen = await VisitSession.updateOne(
        { day, vid: parsed.vid, sid: parsed.sid },
        { $setOnInsert: { day, vid: parsed.vid, sid: parsed.sid } },
        { upsert: true }
      );
    } catch (err) {
      if (isDupKey(err)) return res.json({ ok: true, deduped: true });
      throw err;
    }
    // Fail-closed toward NOT counting: only a fresh insert (upsertedCount
    // 1) is a new session. Anything else is a replay/duplicate.
    if (!(sessionSeen.upsertedCount > 0)) {
      return res.json({ ok: true, deduped: true });
    }
    // Independent counter upserts — one Atlas round-trip instead of 3-4
    // sequential ones. The uniques increment below still waits on `seen`.
    // Approximate city when the browser resolved one (IP-based, city-level
    // only — raw IPs are never sent or stored).
    const visitWrites = [
      DailyStat.updateOne(
        { day },
        { $inc: { visits: 1 }, $setOnInsert: { uniques: 0 } },
        { upsert: true }
      ),
      PageStat.updateOne(
        { day, path: parsed.path },
        { $inc: { visits: 1 } },
        { upsert: true }
      ),
      // First time this anonymous id is seen today → counts as a new unique
      // visitor-day. The compound-unique index makes concurrent pings safe
      // (E11000 losers are treated as already-seen, never as failures).
      DailyVisitor.updateOne(
        { day, vid: parsed.vid },
        { $setOnInsert: { day, vid: parsed.vid } },
        { upsert: true }
      ).catch((err) => {
        if (isDupKey(err)) return { upsertedCount: 0, matchedCount: 1, dupKeyRace: true };
        throw err;
      }),
    ];
    if (parsed.city) {
      visitWrites.push(
        CityStat.updateOne(
          { day, city: parsed.city, state: parsed.state },
          { $inc: { visits: 1 }, $setOnInsert: { country: parsed.country } },
          { upsert: true }
        )
      );
    }
    const [, , seen] = await Promise.all(visitWrites);
    if (seen.upsertedCount > 0) {
      // A hard DB failure here undercounts uniques by one while the
      // DailyVisitor row exists — bounded, logged, and visible in the 500.
      // (Uniques can be reconciled from DailyVisitor counts per day.)
      await DailyStat.updateOne({ day }, { $inc: { uniques: 1 } });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /visits — admin dashboard chart data: per-day visits/uniques for the
// last N days (default 30, max 365; see parseDaysParam), range totals, top
// pages and top cities. Days are IST calendar days; the series is zero-filled
// across the whole range so a quiet day renders as 0 instead of vanishing
// (which would misleadingly join its neighbours on the chart).
// `uniques` are unique visitor-DAYS (distinct vid per day), summed across the
// range — the UI labels them accordingly.
router.get("/visits", auth, authorize("admin"), async (req, res, next) => {
  try {
    const days = parseDaysParam(req.query.days);
    const range = istDayRange(days);
    const since = range[0];
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
    const byDay = new Map((series || []).map((r) => [r.day, r]));
    const filled = range.map((day) => {
      const row = byDay.get(day);
      return {
        day,
        visits: Math.max(0, Math.round(Number(row?.visits) || 0)),
        uniques: Math.max(0, Math.round(Number(row?.uniques) || 0)),
      };
    });
    const totals = totalsAgg[0] || { visits: 0, uniques: 0 };
    res.json({
      days: filled,
      totals: { visits: totals.visits || 0, uniques: totals.uniques || 0 },
      topPaths,
      topCities,
      meta: {
        days,
        since,
        timezone: "Asia/Kolkata",
        uniquesDefinition: "unique visitor-days: distinct anonymous visitor ids per IST day, summed across the range",
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
