const mongoose = require("mongoose");

// Shared rate-limit counters — the Redis-free way to keep one bucket per
// client across multiple API instances.
//
// The document key IS the `_id`: "<bucket>:<client key>", so every read and
// write is a primary-key lookup (no secondary index) and two instances can
// never disagree about which document a client's counter lives in.
//
// Correctness does not depend on this collection being clean: increment()
// compares `resetAt` against the current time and starts a fresh window when
// the stored one has lapsed. The TTL index below is pure hygiene, and Mongo's
// reaper only runs about once a minute, so expired windows can briefly linger.
//
// Volume note: only the security-critical, low-traffic buckets (auth, payments)
// are backed by this collection. Putting a write here on every /api/* request
// would add ~1000 writes/sec at target load, which costs more than the coarse
// per-instance limit it would replace.

const rateLimitHitSchema = new mongoose.Schema(
  {
    // "<bucket>:<client key>" — for example "auth:203.0.113.7".
    _id: { type: String, required: true },
    // Hits inside the current window.
    totalHits: { type: Number, default: 0, min: 0 },
    // When the current window lapses and the counter starts over.
    resetAt: { type: Date, required: true },
  },
  { versionKey: false, timestamps: false }
);

// Reap windows that have lapsed. Hygiene only — see the note above.
rateLimitHitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RateLimitHit", rateLimitHitSchema);