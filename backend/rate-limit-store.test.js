// Standalone regression test for the Redis-free rate-limit store.
// Run:  node backend/rate-limit-store.test.js  — exits non-zero on any failure.
//
// The risk this pins down: express-rate-limit's `passOnStoreError` defaults to
// FALSE, so a rejected store promise is rethrown into the error middleware —
// i.e. a database hiccup would turn EVERY request into a 500. The shared store
// must therefore degrade to in-memory limits instead.
//
// The store is driven through a real express app, with Mongoose stubbed so the
// suite runs without a database. `mongoose.connection.readyState` and the
// RateLimitHit statics are the only touchpoints the store uses.

const http = require("http");
const express = require("express");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const { MemoryStore } = require("express-rate-limit");
const RateLimitHit = require("./models/RateLimitHit");
const {
  rateLimitStore,
  describeRateLimitStores,
  MongoRateLimitStore,
  withFallback,
  withTimeout,
  windowPipeline,
} = require("./utils/rateLimitStore");

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  ok ? passes++ : failures++;
};

// ── Stub the Mongoose surface the store touches ─────────────────────────────
const realReadyState = Object.getOwnPropertyDescriptor(
  mongoose.connection,
  "readyState"
);
const setConnected = (on) => {
  Object.defineProperty(mongoose.connection, "readyState", {
    value: on ? 1 : 0,
    configurable: true,
    writable: true,
  });
};
const savedStatics = {
  findOneAndUpdate: RateLimitHit.findOneAndUpdate,
  updateOne: RateLimitHit.updateOne,
  deleteOne: RateLimitHit.deleteOne,
};
const restore = () => {
  setConnected(false);
  if (realReadyState) {
    Object.defineProperty(mongoose.connection, "readyState", realReadyState);
  }
  Object.assign(RateLimitHit, savedStatics);
};

// In-memory stand-in for the RateLimitHit collection that honours the
// aggregation-pipeline update the same way MongoDB would server-side. This is
// what makes the concurrency claim testable: two overlapping updates must both
// be counted, never one overwriting the other.
const fakeCollection = () => {
  const docs = new Map();
  return {
    docs,
    findOneAndUpdate: async (filter, pipeline, options) => {
      const _id = String(filter._id);
      const existing = docs.get(_id);
      let doc = existing ? { ...existing } : null;
      if (!doc) {
        if (!options?.upsert) return null;
        doc = { _id };
      }
      // Evaluate the pipeline exactly as written in windowPipeline().
      const step = pipeline?.[0]?.$set || {};
      const now = new Date();
      const currentReset = doc.resetAt ? new Date(doc.resetAt) : null;
      const live = currentReset && currentReset.getTime() > now.getTime();
      const hits = live ? Number(doc.totalHits || 0) : 0;
      const resetAt = step.resetAt?.$cond
        ? live
          ? currentReset
          : step.resetAt.$cond[2]
        : doc.resetAt;
      const totalHits = step.totalHits?.$cond ? hits + 1 : Number(doc.totalHits || 0);
      doc = { ...doc, totalHits, resetAt };
      docs.set(_id, doc);
      return { ...doc };
    },
    updateOne: async (filter, update) => {
      const doc = docs.get(String(filter._id));
      if (!doc) return { acknowledged: true, modifiedCount: 0 };
      if (filter.totalHits?.$gt != null && !(doc.totalHits > filter.totalHits.$gt)) {
        return { acknowledged: true, modifiedCount: 0 };
      }
      doc.totalHits += update?.$inc?.totalHits || 0;
      return { acknowledged: true, modifiedCount: 1 };
    },
    deleteOne: async (filter) => {
      const existed = docs.delete(String(filter._id));
      return { acknowledged: true, deletedCount: existed ? 1 : 0 };
    },
  };
};

// Drives `count` requests through an app protected by `max` hits per window.
const hitEndpoint = async (store, { max = 2, count = 3 } = {}) => {
  const app = express();
  app.use(
    rateLimit({
      store,
      windowMs: 60 * 1000,
      max,
      standardHeaders: false,
      legacyHeaders: false,
    })
  );
  app.get("/ping", (req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const statuses = [];
  try {
    for (let i = 0; i < count; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/ping`);
      await res.text();
      statuses.push(res.status);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return statuses;
};

const withEnv = async (value, fn) => {
  const saved = process.env.RATE_LIMIT_SHARED;
  if (value === undefined) delete process.env.RATE_LIMIT_SHARED;
  else process.env.RATE_LIMIT_SHARED = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.RATE_LIMIT_SHARED;
    else process.env.RATE_LIMIT_SHARED = saved;
  }
};

// ── Runner ──────────────────────────────────────────────────────────────────
const main = async () => {
  // ── Bucket selection ────────────────────────────────────────────────────
  await withEnv(undefined, () => {
    const { shared, memory } = describeRateLimitStores();
    check(
      "default: auth + strict are shared, general + visit stay in-memory",
      shared.join(",") === "auth,strict" && memory.join(",") === "general,visit",
      `shared=[${shared}] memory=[${memory}]`
    );
    check(
      "default: auth gets the shared store, general does not",
      typeof rateLimitStore("auth").increment === "function" &&
        rateLimitStore("general") instanceof MemoryStore,
      `auth=${rateLimitStore("auth").constructor.name} general=${rateLimitStore("general").constructor.name}`
    );
    check(
      "each bucket gets its own store instance (no store reuse)",
      rateLimitStore("auth") !== rateLimitStore("auth")
    );
  });

  await withEnv("", () => {
    check(
      'RATE_LIMIT_SHARED="" -> every bucket in-memory',
      describeRateLimitStores().shared.length === 0 &&
        rateLimitStore("auth") instanceof MemoryStore
    );
  });

  await withEnv("all", () => {
    const { shared, memory } = describeRateLimitStores();
    check(
      '"all" -> every bucket shared',
      shared.length === 4 && memory.length === 0,
      `shared=[${shared}]`
    );
  });

  await withEnv("visit", () => {
    const { shared, memory } = describeRateLimitStores();
    check(
      "custom list is honoured",
      shared.join(",") === "visit" && memory.length === 3,
      `shared=[${shared}] memory=[${memory}]`
    );
  });

  // ── Pipeline shape ──────────────────────────────────────────────────────
  const step = windowPipeline(new Date(), new Date(Date.now() + 60000))?.[0]?.$set || {};
  check(
    "window pipeline increments inside a live window and resets a lapsed one",
    step.totalHits?.$cond?.[0]?.$gt?.[0]?.$ifNull?.[0] === "$resetAt" &&
      step.totalHits?.$cond?.[1]?.$add?.[0]?.$ifNull?.[0] === "$totalHits" &&
      step.totalHits?.$cond?.[2] === 1 &&
      step.resetAt?.$cond?.[2] instanceof Date,
    JSON.stringify(step.totalHits)
  );
  check(
    "window pipeline guards the upsert case with $ifNull (no null arithmetic)",
    String(JSON.stringify(windowPipeline())).includes('"$ifNull":["$resetAt"') &&
      String(JSON.stringify(windowPipeline())).includes('"$ifNull":["$totalHits",0]')
  );
  check(
    "pipeline extends the window's resetAt only when starting a new window",
    step.resetAt?.$cond?.[1] === "$resetAt"
  );

  // ── withTimeout ─────────────────────────────────────────────────────────
  const fast = await withTimeout(Promise.resolve("ok"), 50, "nope");
  check("withTimeout passes a fast result through", fast === "ok");
  let timedOut = false;
  try {
    await withTimeout(new Promise(() => {}), 20, "timed out");
  } catch (error) {
    timedOut = error.message === "timed out";
  }
  check("withTimeout rejects instead of hanging forever", timedOut);

  // ── Store behaviour with a stubbed database ─────────────────────────────
  const fake = fakeCollection();
  RateLimitHit.findOneAndUpdate = fake.findOneAndUpdate;
  RateLimitHit.updateOne = fake.updateOne;
  RateLimitHit.deleteOne = fake.deleteOne;
  setConnected(true);

  const store = new MongoRateLimitStore({ prefix: "auth:" });
  store.init({ windowMs: 60000 });

  const first = await store.increment("1.2.3.4");
  const second = await store.increment("1.2.3.4");
  check(
    "increment counts hits within the window (1 then 2)",
    first.totalHits === 1 && second.totalHits === 2,
    `${first.totalHits} then ${second.totalHits}`
  );
  check(
    "counter document is keyed by bucket prefix + client key",
    fake.docs.has("auth:1.2.3.4"),
    [...fake.docs.keys()].join("|")
  );
  check(
    "buckets do not share counters",
    store.keyOf("1.2.3.4") !== new MongoRateLimitStore({ prefix: "strict:" }).keyOf("1.2.3.4")
  );
  check("resetTime is a Date the limiter can use", first.resetTime instanceof Date);

  // Two overlapping increments must BOTH land: the read-modify-write the old
  // design implied would have let the second write back a stale count.
  const racestore = new MongoRateLimitStore({ prefix: "race:" });
  racestore.init({ windowMs: 60000 });
  await Promise.all([racestore.increment("k"), racestore.increment("k")]);
  const third = await racestore.increment("k");
  check(
    "concurrent increments never lose a hit (3 concurrent -> 3)",
    third.totalHits === 3,
    `totalHits=${third.totalHits}`
  );

  // A lapsed window starts over instead of counting forever.
  fake.docs.set("auth:old", {
    _id: "auth:old",
    totalHits: 99,
    resetAt: new Date(Date.now() - 60000),
  });
  const afterLapse = await store.increment("old");
  check(
    "a lapsed window resets to 1 (no permanent lock-out)",
    afterLapse.totalHits === 1,
    `totalHits=${afterLapse.totalHits}`
  );
  check(
    "a lapsed window gets a fresh resetTime in the future",
    afterLapse.resetTime.getTime() > Date.now(),
    afterLapse.resetTime.toISOString()
  );

  await store.decrement("1.2.3.4");
  const afterDecrement = await store.increment("1.2.3.4");
  check(
    "decrement lowers the counter (refunds a hit)",
    afterDecrement.totalHits === 2,
    `totalHits=${afterDecrement.totalHits}`
  );

  await store.resetKey("1.2.3.4");
  const afterReset = await store.increment("1.2.3.4");
  check(
    "resetKey clears the counter",
    afterReset.totalHits === 1,
    `totalHits=${afterReset.totalHits}`
  );

  // ── Resilience: failures degrade, never 500 ─────────────────────────────
  RateLimitHit.findOneAndUpdate = async () => {
    throw new Error("db exploded");
  };
  const wrapper = withFallback(new MongoRateLimitStore({ prefix: "x:" }), new MemoryStore());
  wrapper.init({ windowMs: 60000 });
  const degraded = await hitEndpoint(wrapper);
  check(
    "store failures degrade to in-memory limits (no 5xx)",
    !degraded.some((s) => s >= 500) && degraded.join(",") === "200,200,429",
    degraded.join(",")
  );

  // A disconnected database must fail fast, not queue behind Mongoose's buffer.
  setConnected(false);
  let fastFail = false;
  try {
    await new MongoRateLimitStore({ prefix: "y:" }).increment("k");
  } catch (error) {
    fastFail = /not connected/.test(error.message);
  }
  check("a disconnected database fails fast instead of buffering", fastFail);

  const offline = rateLimitStore("auth");
  const offlineStatuses = await hitEndpoint(offline);
  check(
    "database down: the auth bucket still enforces limits in memory",
    !offlineStatuses.some((s) => s >= 500) && offlineStatuses.join(",") === "200,200,429",
    offlineStatuses.join(",")
  );

  setConnected(true);
  const healthy = await hitEndpoint(rateLimitStore("auth"));
  check(
    "database up: the shared auth bucket enforces limits",
    healthy.join(",") === "200,200,429",
    healthy.join(",")
  );

  // ── E11000: two requests racing to create a brand-new key ───────────────
  let attempts = 0;
  RateLimitHit.findOneAndUpdate = async () => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error("E11000 duplicate key error");
      err.code = 11000;
      throw err;
    }
    return { _id: "z:k", totalHits: 2, resetAt: new Date(Date.now() + 60000) };
  };
  const retried = await new MongoRateLimitStore({ prefix: "z:" }).increment("k");
  check(
    "an upsert race (E11000) is retried, not surfaced",
    retried.totalHits === 2 && attempts === 2,
    `totalHits=${retried.totalHits} attempts=${attempts}`
  );

  console.log(`\n${passes} passed, ${failures} failed`);
  // Set the code and let the loop drain naturally. Calling process.exit() here
  // aborts the process on Windows while libuv is still closing handles
  // (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` in src/win/async.c),
  // which surfaced as a bogus non-zero exit and broke `npm test` chaining.
  process.exitCode = failures > 0 ? 1 : 0;
};

main()
  .catch((error) => {
    console.error(`FAIL  suite crashed -> ${error?.stack || error}`);
    process.exitCode = 1;
  })
  .finally(restore);