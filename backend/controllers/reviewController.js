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

const syncCookRating = async (cookId, rating) => {
  const value = normalizeRating(rating);
  if (value === null) return;
  try {
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

    try {
      await CookProfile.updateOne({ user: cookId }, averageSyncPipeline());
    } catch (pipelineError) {
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
    if (["requested", "rejected", "cancelled", "expired"].includes(booking.status)) {
      return res.status(400).json({ message: "You can rate your cook once the service is complete" });
    }
    if (booking.payment?.status !== "paid") {
      return res.status(400).json({ message: "You can rate your cook once the service is complete" });
    }
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
      if (error?.code === 11000) {
        return res.status(409).json({ message: "Review already exists" });
      }
      throw error;
    }

    await syncCookRating(booking.cook, cleanRating);

    try {
      const Notification = require("../models/Notification");
      await Notification.create({
        user: booking.cook,
        type: "review_received",
        booking: booking._id,
        message: `You received a new ${cleanRating}-star review — open your reviews to see it.`,
      });
    } catch {
    }

    res.status(201).json(review);
  } catch (error) {
    next(error);
  }
};

exports.getCookReviews = async (req, res, next) => {
  try {
    let cookId = req.params.cookId;
    try {
      const profile = await CookProfile.findById(cookId).select("user");
      if (profile?.user) cookId = profile.user.toString();
    } catch {
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
