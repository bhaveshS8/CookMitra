// Standalone regression test for the review → cook-rating sync path.
// Run:  node backend/review-rating.test.js  — exits non-zero on any failure.
//
// It stubs the mongoose statics createReview touches (Booking, Review,
// CookProfile) and drives the REAL controller with fake req/res objects.
//
// Two real bugs are pinned here:
//  1. Duplicate reviews. `Review.booking` is uniquely indexed, so the second of
//     two fast double-submits fails with E11000. That used to fall through to
//     the error handler as a 500; it must be the same 409 the pre-check returns.
//  2. Lost rating updates. The old code read every review of the cook, computed
//     an average in Node and $set it. Two reviews landing together both wrote an
//     average derived from a stale snapshot, so one silently erased the other.
//     Now the counters are $inc'd and the average is derived from them
//     server-side in one atomic pipeline update — and the O(N) Review scan is
//     gone from the request path entirely.

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const mongoose = require("mongoose");
const Booking = require("./models/Booking");
const Review = require("./models/Review");
const CookProfile = require("./models/CookProfile");
const reviewCtrl = require("./controllers/reviewController");
const {
  normalizeRating,
  ratingIncrement,
  averageSyncPipeline,
  needsCounterBackfill,
  averageFromCounters,
} = require("./utils/ratings");

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  ok ? passes++ : failures++;
};

const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => {
    r.statusCode = c;
    return r;
  };
  r.json = (p) => {
    r.body = p;
    return r;
  };
  return r;
};
// createReview must never hand an unexpected error to next() in these cases —
// if it does, fail loudly rather than silently continuing.
const next = (err) => {
  if (err) throw err instanceof Error ? err : new Error(String(err));
};

// Thenable query stub: createReview chains `.select()` before awaiting.
const Q = (doc) => ({
  select: () => Q(doc),
  populate: () => Q(doc),
  sort: () => Q(doc),
  then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
});

const Models = { Booking, Review, CookProfile };
// Swap model statics for the duration of `fn`, restoring them afterwards.
const withStubs = async (stubs, fn) => {
  const saved = [];
  for (const [path, impl] of Object.entries(stubs)) {
    const [modelName, method] = path.split(".");
    const model = Models[modelName];
    saved.push([model, method, model[method]]);
    model[method] = impl;
  }
  try {
    return await fn();
  } finally {
    for (const [model, method, impl] of saved) model[method] = impl;
  }
};

const COOK_ID = new mongoose.Types.ObjectId().toString();
const CUSTOMER_ID = new mongoose.Types.ObjectId().toString();
const BOOKING_ID = new mongoose.Types.ObjectId().toString();
const ownedBooking = (overrides = {}) => ({
  _id: BOOKING_ID,
  customer: CUSTOMER_ID,
  cook: COOK_ID,
  status: "completed",
  // A completed service implies captured payment — reviews require it.
  payment: { status: "paid" },
  ...overrides,
});
// Drives the controller and hands back the fake response so each case can
// assert on status/body. `body` lets a case override the payload.
const postReview = async (body = {}) => {
  const res = makeRes();
  await reviewCtrl.createReview(
    {
      body: { booking: BOOKING_ID, rating: 5, comment: "Great", ...body },
      user: { id: CUSTOMER_ID },
    },
    res,
    next
  );
  return res;
};
// ── 1. Pure aggregate math (utils/ratings.js) ───────────────────────────────
const testRatingHelpers = () => {
  check("normalizeRating accepts 1 and 5", normalizeRating(1) === 1 && normalizeRating(5) === 5);
  check(
    "normalizeRating rejects 0/6/fractional/NaN/null",
    normalizeRating(0) === null &&
      normalizeRating(6) === null &&
      normalizeRating(4.5) === null &&
      normalizeRating("abc") === null &&
      normalizeRating(null) === null,
    `0=${normalizeRating(0)} 6=${normalizeRating(6)} 4.5=${normalizeRating(4.5)}`
  );
  check(
    "normalizeRating accepts the numeric string the validator allows",
    normalizeRating("3") === 3,
    String(normalizeRating("3"))
  );

  const inc = ratingIncrement(4);
  check(
    "ratingIncrement bumps sum + count only (never the average)",
    inc?.$inc?.["rating.sum"] === 4 &&
      inc?.$inc?.["rating.count"] === 1 &&
      Object.keys(inc.$inc).length === 2,
    JSON.stringify(inc)
  );
  check("ratingIncrement refuses an unusable rating", ratingIncrement(9) === null);

  const avgExpr = averageSyncPipeline()?.[0]?.$set?.["rating.average"];
  check(
    "averageSyncPipeline derives the average from the document's own counters",
    avgExpr?.$cond?.[0]?.$gt?.[0] === "$rating.count" &&
      avgExpr?.$cond?.[1]?.$round?.[0]?.$divide?.[0] === "$rating.sum" &&
      avgExpr?.$cond?.[1]?.$round?.[0]?.$divide?.[1] === "$rating.count" &&
      avgExpr?.$cond?.[2] === 0,
    JSON.stringify(averageSyncPipeline())
  );

  check(
    "needsCounterBackfill flags legacy count-without-sum rows only",
    needsCounterBackfill({ count: 3, sum: 0 }) === true &&
      needsCounterBackfill({ count: 0, sum: 0 }) === false &&
      needsCounterBackfill({ count: 2, sum: 9 }) === false &&
      needsCounterBackfill(undefined) === false
  );
  check(
    "averageFromCounters averages and guards empty/NaN input",
    averageFromCounters(9, 2) === 4.5 &&
      averageFromCounters(0, 0) === 0 &&
      averageFromCounters("x", 2) === 0 &&
      averageFromCounters(5, 3) === 1.67
  );
  check(
    "pipeline $round(2) matches the Node fallback for the same counters",
    averageFromCounters(14, 3) === Math.round((14 / 3) * 100) / 100
  );
};

// ── 2. Happy path: counters + server-side average, no Review scan ───────────
const testHappyPath = async () => {
  const updateCalls = [];
  await withStubs(
    {
      "Booking.findById": async () => ownedBooking(),
      "Review.findOne": async () => null,
      "Review.create": async (doc) => ({ _id: "r1", ...doc }),
      // The O(N) scan is exactly what was removed — using it must fail loudly.
      "Review.find": () => {
        throw new Error("Review.find must not be used to aggregate ratings");
      },
      "Review.aggregate": async () => {
        throw new Error("aggregate must not run when the counters are already seeded");
      },
      "CookProfile.findOne": () => Q({ rating: { average: 0, count: 0, sum: 0 } }),
      "CookProfile.updateOne": async (filter, update) => {
        updateCalls.push({ filter, update });
        return { acknowledged: true };
      },
    },
    async () => {
      const res = await postReview();
      check("review on a completed booking -> 201", res.statusCode === 201, `s=${res.statusCode}`);

      const incCall = updateCalls.find((c) => c.update?.$inc);
      check(
        "counters are $inc'd with the submitted rating",
        incCall?.update?.$inc?.["rating.sum"] === 5 &&
          incCall?.update?.$inc?.["rating.count"] === 1,
        JSON.stringify(incCall?.update)
      );
      check(
        "counter write is scoped to the reviewed cook",
        String(incCall?.filter?.user) === COOK_ID,
        JSON.stringify(incCall?.filter)
      );

      const pipelineCall = updateCalls.find((c) => Array.isArray(c.update));
      check(
        "average is recomputed by a server-side pipeline update",
        Boolean(pipelineCall?.update?.[0]?.$set?.["rating.average"]),
        JSON.stringify(pipelineCall?.update)
      );
      check(
        "no Node-side average is written from a stale snapshot",
        !updateCalls.some(
          (c) => !Array.isArray(c.update) && c.update?.$set?.["rating.average"] !== undefined
        ),
        JSON.stringify(updateCalls.map((c) => c.update))
      );
      check(
        "exactly two profile writes (counters, then average)",
        updateCalls.length === 2,
        `${updateCalls.length} writes`
      );
      check(
        "response returns the created review",
        res.body?.rating === 5,
        JSON.stringify(res.body)
      );
    }
  );
};

// ── 3. Legacy profile: counters seeded from the REAL reviews ────────────────
// A count-without-sum row must be seeded from the reviews table, not from
// average × count (which would re-import whatever drift the old code left).
const testBackfill = async () => {
  const updateCalls = [];
  let aggregateFilter = null;
  await withStubs(
    {
      "Booking.findById": async () => ownedBooking(),
      "Review.findOne": async () => null,
      "Review.create": async (doc) => ({ _id: "r2", ...doc }),
      "Review.aggregate": async (pipeline) => {
        aggregateFilter = pipeline?.[0]?.$match;
        // Two earlier reviews (4 + 5) exist; the stored average (4) was stale.
        return [{ _id: null, sum: 9, count: 2 }];
      },
      "CookProfile.findOne": () => Q({ rating: { average: 4, count: 2, sum: 0 } }),
      "CookProfile.updateOne": async (filter, update) => {
        updateCalls.push({ filter, update });
        return { acknowledged: true };
      },
    },
    async () => {
      const res = await postReview();
      check("review on a legacy profile -> 201", res.statusCode === 201, `s=${res.statusCode}`);
      check(
        "backfill aggregates the cook's real reviews",
        String(aggregateFilter?.cook) === COOK_ID,
        JSON.stringify(aggregateFilter)
      );
      const seedIndex = updateCalls.findIndex((c) => c.update?.$set?.["rating.sum"] !== undefined);
      check(
        "counters seeded from the reviews (sum 9 / count 2), not average x count",
        updateCalls[seedIndex]?.update?.$set?.["rating.sum"] === 9 &&
          updateCalls[seedIndex]?.update?.$set?.["rating.count"] === 2,
        JSON.stringify(updateCalls[seedIndex]?.update)
      );
      check(
        "seed happens before the $inc",
        seedIndex >= 0 &&
          seedIndex < updateCalls.findIndex((c) => c.update?.$inc !== undefined),
        `seed=${seedIndex} inc=${updateCalls.findIndex((c) => c.update?.$inc !== undefined)}`
      );
    }
  );
};

// ── 4. Guard rails + failure tolerance ──────────────────────────────────────
const runCase = async (name, { booking, create, profileUpdate, expectStatus, expectMessage }) => {
  await withStubs(
    {
      "Booking.findById": async () => booking,
      "Review.findOne": async () => null,
      "Review.create": create,
      "CookProfile.findOne": () => Q({ rating: { average: 0, count: 0, sum: 0 } }),
      "CookProfile.updateOne": profileUpdate || (async () => ({ acknowledged: true })),
    },
    async () => {
      const res = await postReview();
      check(
        name,
        res.statusCode === expectStatus &&
          (!expectMessage || res.body?.message === expectMessage),
        `s=${res.statusCode} body=${JSON.stringify(res.body)}`
      );
    }
  );
};

const testGuardRails = async () => {
  await runCase("duplicate review (E11000) -> 409, not 500", {
    booking: ownedBooking(),
    create: async () => {
      const err = new Error("E11000 duplicate key error");
      err.code = 11000;
      return Promise.reject(err);
    },
    expectStatus: 409,
    expectMessage: "Review already exists",
  });

  // The cheap path: a pre-existing review is rejected before any write.
  await withStubs(
    {
      "Booking.findById": async () => ownedBooking(),
      "Review.findOne": async () => ({ _id: "existing" }),
      "Review.create": async () => {
        throw new Error("Review.create must not run when a review already exists");
      },
    },
    async () => {
      const res = await postReview();
      check(
        "pre-existing review -> 409 with no write",
        res.statusCode === 409 && res.body?.message === "Review already exists",
        `s=${res.statusCode} ${JSON.stringify(res.body)}`
      );
    }
  );

  // An unexpected DB error must reach next() (the error handler), not be
  // swallowed into a fake 201.
  let propagated = false;
  try {
    await runCase("unexpected create failure reaches the error handler", {
      booking: ownedBooking(),
      create: async () => {
        throw new Error("boom");
      },
      expectStatus: 200,
    });
  } catch {
    propagated = true;
  }
  check("unexpected create failure reaches the error handler", propagated);

  await runCase("review on a pending request -> 400", {
    booking: ownedBooking({ status: "requested" }),
    create: async (doc) => ({ _id: "r3", ...doc }),
    expectStatus: 400,
  });

  // Unpaid holds are not rendered service — no review even after the slot
  // time passes. The create must never run.
  await runCase("review on an unpaid booking -> 400 with no write", {
    booking: ownedBooking({ status: "confirmed", payment: { status: "pending" } }),
    create: async () => {
      throw new Error("Review.create must not run for unpaid bookings");
    },
    expectStatus: 400,
  });

  await runCase("someone else's booking -> 403", {
    booking: ownedBooking({ customer: new mongoose.Types.ObjectId().toString() }),
    create: async (doc) => ({ _id: "r4", ...doc }),
    expectStatus: 403,
  });

  // The review row is already saved — a profile write failure must not 500.
  await runCase("profile sync failure is non-fatal -> review still 201", {
    booking: ownedBooking(),
    create: async (doc) => ({ _id: "r5", ...doc }),
    profileUpdate: async () => {
      throw new Error("profile write failed");
    },
    expectStatus: 201,
  });
};

// ── Runner ──────────────────────────────────────────────────────────────────
const main = async () => {
  testRatingHelpers();
  await testHappyPath();
  await testBackfill();
  await testGuardRails();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
};

main().catch((error) => {
  console.error(`FAIL  suite crashed -> ${error?.stack || error}`);
  process.exitCode = 1;
});