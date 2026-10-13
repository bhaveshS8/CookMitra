
const MIN_RATING = 1;
const MAX_RATING = 5;

const normalizeRating = (rating) => {
  const n = Number(rating);
  if (!Number.isInteger(n) || n < MIN_RATING || n > MAX_RATING) return null;
  return n;
};

const ratingIncrement = (rating) => {
  const n = normalizeRating(rating);
  if (n === null) return null;
  return { $inc: { "rating.sum": n, "rating.count": 1 } };
};

const averageSyncPipeline = () => [
  {
    $set: {
      "rating.average": {
        $cond: [
          { $gt: ["$rating.count", 0] },
          { $round: [{ $divide: ["$rating.sum", "$rating.count"] }, 2] },
          0,
        ],
      },
    },
  },
];

const needsCounterBackfill = (rating) =>
  Number(rating?.count) > 0 && !(Number(rating?.sum) > 0);

const averageFromCounters = (sum, count) => {
  const total = Number(sum);
  const n = Number(count);
  if (!Number.isFinite(total) || !Number.isFinite(n) || n <= 0) return 0;
  return Math.round((total / n) * 100) / 100;
};

module.exports = {
  MIN_RATING,
  MAX_RATING,
  normalizeRating,
  ratingIncrement,
  averageSyncPipeline,
  needsCounterBackfill,
  averageFromCounters,
};