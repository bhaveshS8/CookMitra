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

  console.log(`PRE-CLEARED=${await clearCounters()}`);

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
    }
    child.kill();
    setTimeout(() => process.exit(failures > 0 ? 1 : 0), 800);
  });