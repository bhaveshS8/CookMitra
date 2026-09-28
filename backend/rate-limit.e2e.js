// Live end-to-end test of the Redis-free SHARED rate-limit store.
// Run:  ALLOW_LIVE_TESTS=1 node backend/rate-limit.e2e.js
//        (PowerShell: $env:ALLOW_LIVE_TESTS='1'; node backend/rate-limit.e2e.js)
//
// Safety: this script CLEARS rate-limit counters in the target database and
// boots its own server on PORT 5094, so point MONGODB_URI at a scratch database.
//
// What it proves (things a pure unit test cannot):
//   1. The boot log reports which buckets are MongoDB-backed.
//   2. The auth bucket really counts hits in MongoDB: with the limit set to 3,
//      requests 1-3 answer 401 and 4-6 answer exactly 429 — not the 500 that a
//      broken store would produce.
//   3. The counter document lands in the `ratelimithits` collection keyed
//      "<bucket>:<client>".
//   4. The TTL index on `resetAt` actually exists on the live database (a
//      model-level index only helps if Mongoose created it).
//   5. In-memory buckets still serve normally — no collateral damage.
const { spawn } = require("child_process");
const mongoose = require("mongoose");
require("dotenv").config();

if (!process.env.ALLOW_LIVE_TESTS) {
  console.error(
    "Refusing to run: this e2e script clears rate-limit counters in " +
      `${process.env.MONGODB_URI || "(unset MONGODB_URI)"}. ` +
      "Re-run with ALLOW_LIVE_TESTS=1 to confirm (use a scratch database)."
  );
  process.exit(1);
}

const PORT = 5094;
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH_MAX = 3;
const COLLECTION = "ratelimithits";

let passes = 0;
let failures = 0;
const step = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -> ${detail}` : ""}`);
  ok ? passes++ : failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(process.execPath, ["server.js"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    RATE_LIMIT_SHARED: "auth,strict",
    // Low enough to prove the shared counter is real, not theoretical.
    RATE_LIMIT_AUTH: String(AUTH_MAX),
  },
  cwd: __dirname,
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => (stdout += d.toString()));
child.stderr.on("data", (d) => (stderr += d.toString()));

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
};

const counters = () =>
  mongoose.connection.db.collection(COLLECTION).find({ _id: /^auth:/ }).toArray();

const clearCounters = async () => {
  const { deletedCount } = await mongoose.connection.db
    .collection(COLLECTION)
    .deleteMany({ _id: /^(auth|strict):/ });
  return deletedCount;
};

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

  // Clear counters left by an earlier run FIRST: a persisted window would make
  // every request 429 (correct behaviour, but not a deterministic assertion).
  console.log(`PRE-CLEARED=${await clearCounters()}`);

  // Wait for READINESS, not just liveness. /api/health answers 200 while the
  // database is still "connecting", and during that window the shared store
  // deliberately degrades to memory (assertConnected throws -> withFallback), so
  // the first hit lands in a different counter and the exact-count assertion
  // below is off by one. Probe only once health reports db=connected.
  let health = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        health = await res.json();
        if (health?.db === "connected") break;
      }
    } catch {
      /* not up yet */
    }
  }
  step("server boots healthy with the shared store configured", Boolean(health));
  step(
    "health reports the database connected",
    health?.db === "connected",
    JSON.stringify(health)
  );

  const storeLine = stdout.split("\n").find((l) => l.includes("Rate limiting:")) || "";
  step(
    "boot log names the MongoDB-backed buckets",
    /shared \(MongoDB-backed\) buckets \[auth, strict\]/.test(storeLine),
    storeLine.trim() || "MISSING"
  );

  // The real assertion: the 429 must land exactly on request AUTH_MAX+1, and a
  // store failure would surface as a 500 instead.
  const statuses = [];
  for (let i = 0; i < AUTH_MAX * 2; i++) {
    statuses.push(
      await post("/api/auth/login", { email: "nobody@example.com", password: "wrong-pass-123" })
    );
  }
  const joined = statuses.join(",");
  step(
    `${AUTH_MAX} attempts pass, then the bucket 429s`,
    statuses.slice(0, AUTH_MAX).every((s) => s === 401) &&
      statuses.slice(AUTH_MAX).every((s) => s === 429),
    joined
  );
  step("no request 5xx'd (a store failure would)", !statuses.some((s) => s >= 500), joined);

  const rows = await counters();
  const row = rows.find((r) => /^auth:/.test(r._id));
  step(
    "the counter document is persisted in MongoDB",
    Boolean(row) && Number(row.totalHits) >= AUTH_MAX,
    rows.map((r) => `${r._id}=${r.totalHits}`).join(" | ") || "NONE"
  );
  step(
    "the stored resetAt is a real Date (drives window rollover)",
    row?.resetAt instanceof Date,
    row ? String(row.resetAt) : "-"
  );

  const indexes = await mongoose.connection.db.collection(COLLECTION).indexes();
  const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined && i.key?.resetAt);
  step(
    "TTL index on resetAt exists on the live database",
    Boolean(ttl),
    indexes
      .map(
        (i) =>
          `${JSON.stringify(i.key)}${
            i.expireAfterSeconds !== undefined ? ` ttl=${i.expireAfterSeconds}` : ""
          }`
      )
      .join(" | ")
  );

  // In-memory buckets must be untouched by the shared-store wiring.
  const cooks = await fetch(`${BASE}/api/cooks?limit=3`);
  const body = await cooks.text();
  step(
    "in-memory (general) bucket still serves requests",
    cooks.status === 200,
    `${cooks.status}, ${body.length} bytes`
  );

  step("server kept stderr clean", !stderr.trim(), stderr.trim().slice(0, 300) || "(empty)");

  console.log(`\n${passes} passed, ${failures} failed`);
};

main()
  .catch((error) => {
    console.log(`FAIL  suite crashed -> ${error?.stack || error?.message || error}`);
    failures += 1;
  })
  .finally(async () => {
    try {
      await clearCounters();
      await mongoose.disconnect();
    } catch {
      /* best effort */
    }
    child.kill();
    // The spawned server holds the port and mongoose keeps sockets open; exit
    // explicitly rather than waiting for both to unwind.
    setTimeout(() => process.exit(failures > 0 ? 1 : 0), 800);
  });