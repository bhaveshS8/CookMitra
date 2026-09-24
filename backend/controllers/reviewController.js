const mongoose = require("mongoose");
const Review = require("../models/Review");
const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const { paginationParams, applyPagination, sendList } = require("../utils/pagination");
const {
  normalizeRating,
  ratingIncrement,
  averageSyncPipeline,
  needsCounterBackfill,
  averageFromCounters,
} = require("../utils/ratings");

// Keep CookProfile.rating in sync after a new review.
//
// `rating` is stored as counters ($inc — atomic per document) and
// `rating.average` is derived from those counters inside a single pipeline
// update, so two simultaneous reviews of the same cook cannot clobber each
// other's average the way the previous read-modify-write did. The old code
// also fetched every review of the cook on each new review; that O(N) scan is
// gone from the hot path.
//
// Best-effort by design: the review row is already committed, so a profile
// hiccup must not fail the customer's request. A missed sync self-heals on the
// next review (that is what the counter backfill is for).
const syncCookRating = async (cookId, rating) => {
  const value = normalizeRating(rating);
  if (value === null) return;
  try {
    // One-time repair for profiles written before the counters existed: a
    // positive count with a zero sum means the average was tracked without a
    // running sum, so seed both from the real reviews before incrementing.
    const profile = await CookProfile.findOne({ user: cookId }).select("rating");
    if (profile && needsCounterBackfill(profile.rating)) {
      const cookObjectId = mongoose.Types.ObjectId.isValid(String(cookId))
        ? new mongoose.Types.ObjectId(String(cookId))
        : null;
      const [agg] = cookObjectId
        ? await Review.aggregate([
            { $match: { cook: cookObjectId } },
            {
              $group: {
                _id: null,
                sum: { $sum: "$rating" },
                count: { $sum: 1 },
              },
            },
          ])
        : [];
      if (agg && Number(agg.count) > 0) {
        await CookProfile.updateOne(
          { user: cookId },
          {
            $set: {
              "rating.sum": Number(agg.sum) || 0,
              "rating.count": Number(agg.count),
            },
          }
        );
      }
    }

    const inc = ratingIncrement(value);
    if (!inc) return;
    await CookProfile.updateOne({ user: cookId }, inc);

    // Derive the average from the authoritative counters — the aggregation
    // pipeline runs server-side, so no stale snapshot can win.
    try {
      await CookProfile.updateOne({ user: cookId }, averageSyncPipeline());
    } catch (pipelineError) {
      // Pipeline updates need MongoDB 4.2+. Fall back to a Node-side average
      // read from the fresh counters: sum/count stay correct either way, so
      // the next review repairs the average.
      const fresh = await CookProfile.findOne({ user: cookId }).select("rating");
      await CookProfile.updateOne(
        { user: cookId },
        {
          $set: {
            "rating.average": averageFromCounters(
              fresh?.rating?.sum,
              fresh?.rating?.count
            ),
          },
        }
      );
    }
  } catch {
    // non-fatal: the review itself is saved and the next review re-syncs
  }
};

exports.createReview = async (req, res, next) => {
  try {
    const { booking: bookingId, rating, comment } = req.body;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (booking.customer.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized" });
    }
    // Only services that actually happened can be rated — never requests the
    // cook didn't accept or dead bookings (mirrors the Home prompt filter).
    if (["requested", "rejected", "cancelled", "expired"].includes(booking.status)) {
      return res.status(400).json({ message: "You can rate your cook once the service is complete" });
    }
    // Paid service only: an unpaid hold that merely aged past its slot is
    // not a rendered service and cannot be rated.
    if (booking.payment?.status !== "paid") {
      return res.status(400).json({ message: "You can rate your cook once the service is complete" });
    }
    // Rateable once service hours are over: completed status, the
    // hours-complete flag, or the session end time has passed (covers legacy
    // bookings without the OTP clock and cooks who forgot to tap complete).
    // Shared IST-anchored helper (F-08) — one definition for the cutoff.
    const { sessionEndDate } = require("./bookingController");
    const sessionEnd = sessionEndDate(booking);
    const serviceHoursEnded =
      booking.status === "completed" ||
      booking.hoursCompleted === true ||
      (sessionEnd ? Date.now() >= sessionEnd.getTime() : false);
    if (!serviceHoursEnded) {
      return res.status(400).json({ message: "You can rate your cook once the service hours are over" });
    }

    const existingReview = await Review.findOne({ booking: bookingId });
    if (existingReview) {
      return res.status(409).json({ message: "Review already exists" });
    }

    let review;
    const cleanRating = normalizeRating(rating);
    if (cleanRating === null) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }
    try {
      review = await Review.create({
        booking: bookingId,
        customer: req.user.id,
        cook: booking.cook,
        rating: cleanRating,
        comment: String(comment || "").trim().slice(0, 2000),
      });
    } catch (error) {
      // Review.booking is uniquely indexed — that index, not the findOne above,
      // is the real duplicate guard. Two fast double-submits both pass the
      // check, and the loser hits E11000: surface it as the same 409 the
      // pre-check returns instead of letting it fall through as a 500.
      if (error?.code === 11000) {
        return res.status(409).json({ message: "Review already exists" });
      }
      throw error;
    }

    // Counters are incremented atomically and the average is derived from them
    // server-side, so two reviews landing together cannot clobber each other.
    await syncCookRating(booking.cook, cleanRating);

    res.status(201).json(review);
  } catch (error) {
    next(error);
  }
};

exports.getCookReviews = async (req, res, next) => {
  try {
    // Callers pass either the cook's User id (Review.cook) or the CookProfile
    // id (e.g. /cooks/:id pages) — resolve profiles to their user first.
    let cookId = req.params.cookId;
    try {
      const profile = await CookProfile.findById(cookId).select("user");
      if (profile?.user) cookId = profile.user.toString();
    } catch {
      // not a profile id — fall through and use the param as a user id
    }
    const filter = { cook: cookId };
    const pg = paginationParams(req);
    const reviews = await applyPagination(
      Review.find(filter).populate("customer", "name").sort({ createdAt: -1 }),
      pg
    );
    return sendList(res, reviews, pg, () => Review.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

exports.getMyReviews = async (req, res, next) => {
  try {
    const filter = { customer: req.user.id };
    const pg = paginationParams(req);
    const reviews = await applyPagination(
      Review.find(filter).populate("cook", "name").sort({ createdAt: -1 }),
      pg
    );
    return sendList(res, reviews, pg, () => Review.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

// Reviews received by the logged-in cook (one per completed service).
exports.getCookOwnReviews = async (req, res, next) => {
  try {
    const filter = { cook: req.user.id };
    const pg = paginationParams(req);
    const reviews = await applyPagination(
      Review.find(filter)
        .populate("customer", "name")
        .populate("booking", "date serviceType startTime endTime")
        .sort({ createdAt: -1 }),
      pg
    );
    return sendList(res, reviews, pg, () => Review.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};
