// Rate-limit store selection — no Redis, no new infrastructure.
//
// Two stores, chosen per bucket:
//
//   1. express-rate-limit's in-memory store (default). Exact on a single
//      instance, and the only sane choice for high-volume buckets: the general
//      limiter guards every /api/* request, so backing it with a database
//      would add one write per request (~1000/sec at target load) — far more
//      expensive than the coarse per-instance dampener it replaces.
//
//   2. A MongoDB-backed shared store for the security-critical, low-traffic
//      buckets (auth, payments). These are the ones where being off by the
//      replica count actually matters: with 3 instances a 100/15min login
//      limit silently becomes 300/15min. Volume here is tiny, so one primary
//      key update per attempt is nothing, and MongoDB is already a hard
//      dependency — no new service to run.
//
// `RATE_LIMIT_SHARED` picks the buckets ("auth,strict" by default, "all" to
// share every bucket, "" for pure in-memory everywhere).
//
// express-rate-limit contract, verified against express-rate-limit@8:
//   - increment(key)/decrement(key)/resetKey(key) are all required (they are
//     type-checked at construction), init(options) is optional.
//   - The key handed to increment() is the RAW keyGenerator output — limiters
//     do not namespace it — so a shared store must add its own per-bucket
//     prefix or two buckets would share one counter.
//   - `localKeys` marks a store whose keys cannot be read by another instance.
//     This one deliberately leaves it unset (shared semantics).
//   - `passOnStoreError` defaults to FALSE, so a store error would be rethrown
//     into the error middleware and turn every request into a 500. That is why
//     the shared store is always wrapped in the fallback below: a database
//     hiccup must degrade the limits, never the availability.

const mongoose = require("mongoose");
const { MemoryStore } = require("express-rate-limit");
const RateLimitHit = require("../models/RateLimitHit");

// Warn once per concern: a database outage fires this on every request, and log
// spam at 1000 rps is an incident of its own.
const warned = new Set();
const warnOnce = (tag, message) => {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(message);
};

// Bounds how long a request can wait on the store. Mongoose buffers queries
// while the connection is down (30s by default), which would hang the request
// instead of failing over to memory. The pending operation is left to finish
// on its own — it is only a counter.
//
// The timer is deliberately NOT unref'd: an unref'd timer cannot fire when it
// is the only thing left on the event loop, so the race would never settle and
// the caller would hang instead of failing over. It cannot leak either — the
// `.finally` below clears it whenever the primary promise wins.
const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
};

// Atomic "increment, or start a new window if the old one lapsed" update.
//
// A pipeline update is evaluated server-side against the document it is
// applied to, so the read and the write are one indivisible operation: two
// instances incrementing the same client at the same moment both land, and
// neither can overwrite the other with a stale count. This replaces the
// read-modify-write a naive store would do.
//
// $ifNull guards a freshly upserted document (no resetAt/totalHits yet):
// `$gt: [null, now]` is false, so a new document starts at 1 with a fresh
// window, and `$add` never sees null (which would yield null, not a number).
const windowPipeline = (now, resetAt) => [
  {
    $set: {
      totalHits: {
        $cond: [
          { $gt: [{ $ifNull: ["$resetAt", new Date(0)] }, now] },
          { $add: [{ $ifNull: ["$totalHits", 0] }, 1] },
          1,
        ],
      },
      resetAt: {
        $cond: [
          { $gt: [{ $ifNull: ["$resetAt", new Date(0)] }, now] },
          "$resetAt",
          resetAt,
        ],
      },
    },
  },
];
class MongoRateLimitStore {
  constructor({ prefix = "", maxTimeMs = 1500 } = {}) {
    this.prefix = prefix;
    this.maxTimeMs = maxTimeMs;
    this.windowMs = 60 * 1000;
  }

  init(options) {
    if (options?.windowMs) this.windowMs = Number(options.windowMs);
  }

  // Per-bucket namespace, so "auth:1.2.3.4" and "strict:1.2.3.4" stay separate
  // counters. Required because limiters pass the raw key straight through.
  keyOf(key) {
    return `${this.prefix}${key}`;
  }

  // Before connectDB() finishes — or after the connection drops — a query would
  // sit in Mongoose's buffer for up to 30s. Fail fast instead so the memory
  // fallback engages immediately.
  assertConnected() {
    if (mongoose.connection.readyState !== 1) {
      throw new Error("rate-limit store: database not connected");
    }
  }

  async increment(key) {
    this.assertConnected();
    const _id = this.keyOf(key);
    const now = new Date();
    const resetAt = new Date(now.getTime() + this.windowMs);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const doc = await withTimeout(
          RateLimitHit.findOneAndUpdate({ _id }, windowPipeline(now, resetAt), {
            upsert: true,
            new: true,
            maxTimeMS: this.maxTimeMs,
          }),
          this.maxTimeMs + 500,
          "rate-limit store timed out"
        );
        const hits = Math.floor(Number(doc?.totalHits));
        return {
          // express-rate-limit validates this is a positive integer — never
          // hand it 0 or NaN, which it treats as a broken store.
          totalHits: Number.isFinite(hits) && hits > 0 ? hits : 1,
          resetTime: doc?.resetAt instanceof Date ? doc.resetAt : resetAt,
        };
      } catch (error) {
        // Two requests racing to create the same brand-new key: the unique
        // _id index rejects the loser's upsert with E11000. Retrying is the
        // fix — the winner's document exists by then, so the retry takes the
        // increment branch instead of trying to insert again.
        if (error?.code !== 11000) throw error;
      }
    }
    // Three straight collisions on one key is pathological; count the request
    // rather than reject it.
    return { totalHits: 1, resetTime: resetAt };
  }

  async decrement(key) {
    this.assertConnected();
    // The `totalHits > 0` predicate stops the counter going negative when
    // decrement is called more often than increment (double-settle races).
    await RateLimitHit.updateOne(
      { _id: this.keyOf(key), totalHits: { $gt: 0 } },
      { $inc: { totalHits: -1 } }
    );
  }

  async resetKey(key) {
    this.assertConnected();
    await RateLimitHit.deleteOne({ _id: this.keyOf(key) });
  }
}

// Wrap a shared store so any failure degrades to `fallback` (in-memory) instead
// of reaching the error middleware — which, given passOnStoreError defaults to
// false, WOULD mean a 500 on every request during a database outage.
const withFallback = (primary, fallback) => {
  const warn = (error) =>
    warnOnce(
      "store-fallback",
      `[rate-limit] Shared store unavailable (${error?.message || error}) — serving rate limits from memory until it recovers.`
    );
  return {
    init: (options) => {
      // A thrown init error would escape into the limiter's constructor, so
      // guard it. The fallback is always initialised: it is what serves
      // traffic while the shared store is down.
      try {
        const pending = primary.init?.(options);
        if (pending && typeof pending.catch === "function") pending.catch(warn);
      } catch (error) {
        warn(error);
      }
      return fallback.init?.(options);
    },
    increment: async (key) => {
      try {
        return await primary.increment(key);
      } catch (error) {
        warn(error);
        return fallback.increment(key);
      }
    },
    decrement: async (key) => {
      try {
        return await primary.decrement(key);
      } catch (error) {
        warn(error);
        return fallback.decrement(key);
      }
    },
    resetKey: async (key) => {
      try {
        return await primary.resetKey(key);
      } catch (error) {
        warn(error);
        return fallback.resetKey(key);
      }
    },
  };
};

// Buckets that get a shared (database-backed) counter. Everything else stays
// in-memory: see the header for why the high-volume buckets must not gain a
// database write per request.
const DEFAULT_SHARED_BUCKETS = "auth,strict";
const ALL_BUCKETS = ["general", "auth", "strict", "visit"];

const sharedBuckets = () => {
  const raw = String(process.env.RATE_LIMIT_SHARED ?? DEFAULT_SHARED_BUCKETS);
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
};

const isShared = (bucket, wanted) =>
  wanted.has(bucket) || wanted.has("all") || wanted.has("*");

const rateLimitStore = (name) => {
  const bucket = String(name || "").toLowerCase();
  // A fresh in-memory store per limiter: sharing one instance across limiters
  // trips express-rate-limit's ERR_ERL_STORE_REUSE validation.
  const memory = new MemoryStore();
  if (!isShared(bucket, sharedBuckets())) return memory;
  return withFallback(new MongoRateLimitStore({ prefix: `${bucket}:` }), memory);
};

// Boot-time truth, logged by server.js so nobody has to guess which mode a
// deployment is in.
const describeRateLimitStores = () => {
  const wanted = sharedBuckets();
  const shared = ALL_BUCKETS.filter((bucket) => isShared(bucket, wanted));
  const memory = ALL_BUCKETS.filter((bucket) => !isShared(bucket, wanted));
  return { shared, memory };
};

module.exports = {
  rateLimitStore,
  describeRateLimitStores,
  MongoRateLimitStore,
  withFallback,
  withTimeout,
  windowPipeline,
};