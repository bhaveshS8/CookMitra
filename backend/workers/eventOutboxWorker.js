// Event-notification outbox worker (one-shot, cron-safe).
// Retries delivery of booking notifications that were durably enqueued but
// not yet delivered (DB blip during the request, process crash after commit).
//
// Usage (run against the DEPLOYMENT database after verifying the target):
//   MONGODB_URI=<uri> node workers/eventOutboxWorker.js --target <dbName> [--limit 20] [--requeue-dead]
//   npm run outbox:worker -- --target festivecook
//
// Scheduling: server.js runs an in-process worker automatically (see
// startOutboxWorker in utils/eventOutbox.js); this CLI remains for cron,
// manual recovery and dead-letter requeues. One-shot + atomic leases make
// overlapping runs safe (second worker finds nothing claimable).
// Exits 0 on success, 1 on operational failure.
// No secrets are printed: only the database NAME is echoed for confirmation.
const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config();

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const run = async () => {
  const uri = (process.env.MONGODB_URI || "").trim();
  if (!uri) {
    console.error("[event-outbox] MONGODB_URI is not set — aborting (no database touched).");
    process.exit(1);
  }
  const expectedDb = flag("--target");
  if (!expectedDb || expectedDb === true) {
    console.error("[event-outbox] Refusing to run without --target <dbName>. Pass the intended database name explicitly.");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const actualDb = mongoose.connection.name;
  if (actualDb !== expectedDb) {
    console.error(`[event-outbox] Target mismatch: connected to "${actualDb}" but --target is "${expectedDb}" — aborting (no database touched).`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const { processEventOutbox, requeueDeadEvents, outboxSummary } = require("../utils/eventOutbox");

  if (flag("--requeue-dead")) {
    const n = await requeueDeadEvents();
    console.log(`[event-outbox] Requeued ${n} dead event(s) to pending.`);
  }

  const limit = Math.min(200, Math.max(1, Number(flag("--limit")) || 20));
  const summary = await processEventOutbox({ limit, batchCap: limit, workerId: `cli-${process.pid}-${Date.now()}` });
  const totals = await outboxSummary();
  console.log(
    `[event-outbox] processed=${summary.processed} sent=${summary.sent} failed=${summary.failed} dead=${summary.dead} | totals: pending=${totals.pending} due=${totals.due} dead=${totals.dead} sent=${totals.sent}`
  );
  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (e) => {
  console.error(`[event-outbox] worker failed: ${(e.message || e).toString().slice(0, 200)}`);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore
  }
  process.exit(1);
});
