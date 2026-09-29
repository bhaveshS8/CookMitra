const mongoose = require("mongoose");

// One document per accepted (day, visitor, tab-session) ping — the dedupe
// set behind the "one count per browser-tab session" visit definition.
// The frontend sends one `sid` per tab (sessionStorage); the server counts
// a visit only when this triple inserts for the first time, so replayed or
// concurrent duplicate pings are idempotent instead of inflating visits.
//
// Bounded by design: rows are only needed while a tab session could still
// be replayed, so they expire 3 days after creation (TTL). Long-term
// history lives in the aggregate collections (DailyStat/PageStat/CityStat),
// which stay tiny.
const visitSessionSchema = new mongoose.Schema(
  {
    // Calendar day in Asia/Kolkata as YYYY-MM-DD.
    day: { type: String, required: true },
    // Anonymous id minted by the browser (localStorage `cm-vid`).
    vid: { type: String, required: true },
    // Per-tab session id minted by the browser (sessionStorage).
    sid: { type: String, required: true },
  },
  { timestamps: true }
);

visitSessionSchema.index({ day: 1, vid: 1, sid: 1 }, { unique: true });
// Dedup window only — long-term history lives in DailyStat/PageStat/CityStat.
visitSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

module.exports = mongoose.model("VisitSession", visitSessionSchema);
