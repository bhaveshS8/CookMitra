// Multi-core entry point — `node cluster.js` instead of `node server.js`.
//
// Why: server.js runs ONE Node process (one event loop). CPU-bound work
// (bcrypt logins, JSON, TLS) on a single core caps throughput long before
// MongoDB or the network does. Cluster mode forks one worker per CPU core
// (overridable via WORKERS) behind the OS-shared listen socket, so a
// 4-core box serves ~4x the concurrent load with zero code changes.
//
// Notes:
// - Workers share NOTHING in memory: rate-limit counters on the shared
//   (MongoDB-backed) buckets stay exact across workers because they live in the
//   database. Buckets left in-memory are per-worker, so their effective limit
//   is multiplied by the worker count — set RATE_LIMIT_SHARED=all if that
//   matters, or keep WORKERS=1 for those buckets. server.js logs which mode is
//   active at boot.
// - Sticky sessions are NOT needed — the API is stateless (JWT auth).
// - A dead worker is reforked automatically; the master never serves traffic.

// Business clock: Asia/Kolkata (see server.js) — set before anything else so
// workers inherit the pinned timezone.
if (!process.env.TZ) process.env.TZ = "Asia/Kolkata";
const cluster = require("node:cluster");
const os = require("node:os");

const WORKERS = Number(process.env.WORKERS || os.cpus().length);

if (cluster.isPrimary) {
  console.log(`Cluster master ${process.pid} starting ${WORKERS} worker(s)...`);
  for (let i = 0; i < WORKERS; i += 1) cluster.fork();

  cluster.on("exit", (worker, code, signal) => {
    console.warn(
      `Worker ${worker.process.pid} died (code=${code}, signal=${signal}) — reforking...`
    );
    cluster.fork();
  });

  const shutdown = (sig) => {
    console.log(`Master received ${sig} — stopping workers...`);
    for (const id of Object.keys(cluster.workers || {})) {
      cluster.workers[id]?.kill(sig);
    }
    setTimeout(() => process.exit(0), 6000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
} else {
  // Each worker runs the full API (server.js listens on PORT; the cluster
  // module shares the socket across workers on all platforms).
  require("./server");
}
