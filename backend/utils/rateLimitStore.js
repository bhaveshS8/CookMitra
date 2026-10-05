//   2. A MongoDB-backed shared store for the security-critical, low-traffic

const mongoose = require("mongoose");
const { MemoryStore } = require("express-rate-limit");
const RateLimitHit = require("../models/RateLimitHit");

const warned = new Set();
const warnOnce = (tag, message) => {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(message);
};

const withTimeout = (promise, ms, message) => {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
};

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

  keyOf(key) {
    return `${this.prefix}${key}`;
  }

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
          totalHits: Number.isFinite(hits) && hits > 0 ? hits : 1,
          resetTime: doc?.resetAt instanceof Date ? doc.resetAt : resetAt,
        };
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
    }
    return { totalHits: 1, resetTime: resetAt };
  }

  async decrement(key) {
    this.assertConnected();
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

const withFallback = (primary, fallback) => {
  const warn = (error) =>
    warnOnce(
      "store-fallback",
      `[rate-limit] Shared store unavailable (${error?.message || error}) — serving rate limits from memory until it recovers.`
    );
  return {
    init: (options) => {
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

const DEFAULT_SHARED_BUCKETS = "auth,strict,otp";
const ALL_BUCKETS = ["general", "auth", "strict", "visit", "otp"];

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
  const memory = new MemoryStore();
  if (!isShared(bucket, sharedBuckets())) return memory;
  return withFallback(new MongoRateLimitStore({ prefix: `${bucket}:` }), memory);
};

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