const mongoose = require("mongoose");

// One document per (day, anonymous visitor id) — the dedupe set behind the
// `uniques` counter on DailyStat. Small by design: one tiny doc per visitor
// per day, compound-unique so concurrent pings can't double-count.
const dailyVisitorSchema = new mongoose.Schema(
  {
    // Calendar day in Asia/Kolkata as YYYY-MM-DD.
    day: { type: String, required: true },
    // Anonymous id minted by the browser (localStorage `cm-vid`).
    vid: { type: String, required: true },
  },
  { timestamps: true }
);

dailyVisitorSchema.index({ day: 1, vid: 1 }, { unique: true });

// Retention: visitor-day rows are only ever read at write time (to decide
// the DailyStat.uniques increment); dashboard reads sum DailyStat. The
// admin dashboard supports at most 365 days of history, so raw rows older
// than 400 days are pruned by TTL. Aggregates are never deleted.
dailyVisitorSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

module.exports = mongoose.model("DailyVisitor", dailyVisitorSchema);
