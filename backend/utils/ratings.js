// Cook rating aggregates — the atomic-counter recipe for CookProfile.rating.
//
// Why counters instead of recomputing the average from the reviews table:
// createReview used to run `Review.find({ cook })` and then $set the average
// and count it had just computed. Two customers rating the same cook at the
// same moment both read the pre-write snapshot, so one of the two writes
// silently erased the other person's review from the average. It was also an
// O(N) document transfer (every review that cook has ever received) on a
// user-facing request path.
//
// Now rating.sum / rating.count are the authoritative values. They are bumped
// with atomic $inc, and rating.average is derived from those same counters
// inside the same document update, so no Node-side snapshot can go stale.
// Pure functions only — no DB access, so this stays unit-testable.

const MIN_RATING = 1;
const MAX_RATING = 5;

// Route validation already enforces 1..5 integers; this is the second line of
// defence for callers that skip the validator (and for corrupt payloads).
const normalizeRating = (rating) => {
  const n = Number(rating);
  if (!Number.isInteger(n) || n < MIN_RATING || n > MAX_RATING) return null;
  return n;
};

// $inc fragment that records one more review without touching the average.
// Returns null for an unusable rating so callers skip instead of writing NaN.
const ratingIncrement = (rating) => {
  const n = normalizeRating(rating);
  if (n === null) return null;
  return { $inc: { "rating.sum": n, "rating.count": 1 } };
};

// Aggregation-pipeline update that recomputes rating.average FROM the
// document's own counters. MongoDB applies a pipeline update atomically per
// document, so the average can never be derived from a value another writer
// has since replaced — the exact race the old `$set` had. Requires MongoDB
// 4.2+; callers fall back to a Node-side average if the server rejects it.
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

// Legacy rows (written before the counters existed) carry a count but no sum.
// Every rating is >= 1, so a positive count with a zero sum can only mean the
// sum was never tracked — those profiles must be seeded from their real
// reviews before the first $inc, otherwise every average collapses toward 0.
const needsCounterBackfill = (rating) =>
  Number(rating?.count) > 0 && !(Number(rating?.sum) > 0);

// Average straight from the counters — used by the pipeline-update fallback
// and by tests. Rounded to 2 decimals to match averageSyncPipeline.
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