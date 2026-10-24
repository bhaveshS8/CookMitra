// COOKMITRA EVENTS outbox helpers: transactional enqueue + leased retry worker.
// No new dependencies — MongoDB (already present) is the queue.
//
// Delivery guarantees (see models/EventOutbox.js for the protocol):
//  - GUARANTEED: no duplicate deliveries (unique (eventKey, user) index +
//    per-recipient existence check before insert).
//  - GUARANTEED: bounded retries (maxAttempts, capped exponential backoff,
//    then `dead` — never silent, never unbounded polling).
//  - GUARANTEED (replica set): the booking mutation and the outbox enqueue
//    commit atomically (withEventTransaction). A crash between commit and
//    in-band delivery loses nothing — the worker replays from the outbox.
//  - BEST-EFFORT (standalone mongod, no transaction support): mutation then
//    enqueue sequentially; only a process crash inside that millisecond gap
//    can lose an event (logged loudly). All reads/writes target the primary.

const mongoose = require("mongoose");
const EventOutbox = require("../models/EventOutbox");
const Notification = require("../models/Notification");

const LEASE_MS = 5 * 60 * 1000;
const BACKOFF_BASE_MIN = 1;
const BACKOFF_CAP_MIN = 360;

const backoffMin = (attempts) => Math.min(BACKOFF_CAP_MIN, BACKOFF_BASE_MIN * 2 ** Math.max(0, attempts - 1));

// Idempotent enqueue: same eventKey (same commit retried, transaction retry,
// double-submit) returns the existing doc instead of duplicating.
const enqueueEventOutbox = async ({ eventKey, bookingId = null, bookingPublicId = "", action, recipients = [] }, session = null) => {
  const doc = {
    eventKey,
    bookingId: bookingId || null,
    bookingPublicId,
    action,
    recipients,
    status: "pending",
    nextRetryAt: new Date(),
  };
  try {
    const opts = session ? { session } : {};
    const created = await EventOutbox.create([doc], opts);
    return created[0];
  } catch (e) {
    if (e && e.code === 11000) {
      return EventOutbox.findOne({ eventKey });
    }
    throw e;
  }
};

const isTxnUnsupported = (e) => {
  const msg = String((e && e.message) || "") + " " + String((e && e.codeName) || "") + " " + String((e && e.code) || "");
  return /IllegalOperation|only allowed on a replica set|mongos|Transaction numbers|code.?20|NoSuchTransaction/i.test(msg);
};

// Runs fn(session) inside a multi-document transaction when the deployment
// supports it (Atlas replica set), else falls back to fn(null) with the SAME
// write order (mutation first, enqueue second) so behaviour is identical
// apart from atomicity. Returns { result, transacted }.
const withEventTransaction = async (fn) => {
  let session = null;
  try {
    session = await mongoose.startSession();
  } catch {
    session = null;
  }
  if (!session) {
    return { result: await fn(null), transacted: false };
  }
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return { result, transacted: true };
  } catch (e) {
    if (isTxnUnsupported(e)) {
      console.error("[event-outbox] transactions unsupported here — continuing non-transactionally (best-effort durability)");
      return { result: await fn(null), transacted: false };
    }
    throw e;
  } finally {
    try {
      await session.endSession();
    } catch {
      // ignore
    }
  }
};

// Deliver one outbox event idempotently. Safe to call any number of times,
// from any worker, in any order: per-recipient existence check + unique
// (eventKey, user) index make double-insert impossible (11000 → treated as
// already-delivered, not an error).
const deliverOutboxEvent = async (outboxDoc) => {
  const event = outboxDoc;
  const fresh = (await EventOutbox.findById(event._id)) || event;
  if (!fresh || fresh.status === "sent") return { delivered: true, skipped: true };
  // Superseded (auto-reverted assignment) or exhausted events must never
  // deliver: requeue moves them back to `pending` first when retry is intended.
  // This also covers a worker that claimed just before a void landed.
  if (fresh.status === "dead") return { delivered: false, dead: true, skipped: true };
  // Every outbox action is event-booking scoped, so each delivered notice
  // carries the booking's in-app path: recipients (customer, cook, admin)
  // open the same /event-bookings/:id details view their role is allowed to
  // see. Without this the Notification has no link and no booking ref, so the
  // frontend had no click target ("open from the notification" requirement).
  const link = fresh.bookingId ? `/event-bookings/${fresh.bookingId}` : "";
  const missing = [];
  for (const r of fresh.recipients || []) {
    const exists = await Notification.exists({ eventKey: fresh.eventKey, user: r.user });
    if (!exists) missing.push({ user: r.user, type: r.type, message: r.message, link, eventKey: fresh.eventKey });
  }
  // NOTE: insertMany with {ordered:false} RESOLVES with [] when every doc
  // fails validation — it does not always throw. So success is verified by
  // re-reading, never by the absence of an exception.
  let insertError = null;
  if (missing.length > 0) {
    try {
      await Notification.insertMany(missing, { ordered: false });
    } catch (e) {
      insertError = e;
    }
  }
  const stillMissing = [];
  for (const m of missing) {
    const exists = await Notification.exists({ eventKey: fresh.eventKey, user: m.user });
    if (!exists) stillMissing.push(m);
  }
  // Retract rows this delivery just inserted when the event was voided
  // mid-flight (e.g. an assignment auto-revert marked it dead between our
  // status read and the insert, possibly after the revert's own deleteMany).
  // Without this, a worker racing the void could leave success notices for a
  // mutation that did not stand.
  const retractInserted = async () => {
    try {
      await Notification.deleteMany({ eventKey: fresh.eventKey });
    } catch (e) {
      console.error(`[event-outbox] retract failed for ${fresh.eventKey}: ${String((e && e.message) || e).slice(0, 200)}`);
    }
  };
  if (stillMissing.length > 0) {
    const e =
      insertError ||
      new Error(`delivery incomplete: ${stillMissing.length} of ${missing.length} notification(s) not persisted`);
    const attempts = (fresh.attempts || 0) + 1;
    const exhausted = attempts >= (fresh.maxAttempts || 10);
    // $ne "dead": never resurrect a voided event back to pending — a later
    // worker would otherwise deliver notices for a reverted mutation.
    const requeued = await EventOutbox.findOneAndUpdate(
      { _id: fresh._id, status: { $ne: "dead" } },
      {
        $set: {
          status: exhausted ? "dead" : "pending",
          lastError: String((e && e.message) || e).slice(0, 500),
          nextRetryAt: exhausted ? null : new Date(Date.now() + backoffMin(attempts) * 60000),
          claimedBy: null,
          claimExpiresAt: null,
        },
        $inc: { attempts: 1 },
      }
    );
    if (!requeued) {
      await retractInserted();
      return { delivered: false, dead: true, skipped: true };
    }
    if (exhausted) {
      console.error(
        `[event-outbox] DEAD event ${fresh.eventKey} after ${attempts} attempts: ${String((e && e.message) || e).slice(0, 200)} — requeue with: npm run outbox:worker -- --requeue-dead`
      );
    } else {
      console.error(`[event-outbox] delivery failed for ${fresh.eventKey} (attempt ${attempts}): ${String((e && e.message) || e).slice(0, 200)}`);
    }
    return { delivered: false, dead: exhausted };
  }
  // Mark sent only while the event is still alive. A null result means it was
  // voided after our initial status read — retract the just-inserted rows so
  // a superseded mutation never leaves a misleading notice behind.
  const marked = await EventOutbox.findOneAndUpdate(
    { _id: fresh._id, status: { $ne: "dead" } },
    { $set: { status: "sent", sentAt: new Date(), lastError: "", claimedBy: null, claimExpiresAt: null }, $inc: { attempts: 1 } }
  );
  if (!marked) {
    await retractInserted();
    return { delivered: false, dead: true, skipped: true };
  }
  return { delivered: true };
};

// Atomically lease one due event to this worker (single-winner claim).
const claimDueOutboxEvent = async (workerId) => {
  const now = new Date();
  return EventOutbox.findOneAndUpdate(
    {
      status: "pending",
      $and: [{ $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }] }],
      $or: [{ claimedBy: null }, { claimExpiresAt: { $lte: now } }],
    },
    { $set: { claimedBy: workerId, claimExpiresAt: new Date(Date.now() + LEASE_MS) } },
    { new: true, sort: { nextRetryAt: 1 } }
  );
};

// Process due events until none remain or batchCap claims are done (bounded).
const processEventOutbox = async ({ limit = 20, workerId = `worker-${process.pid}`, batchCap = 25 } = {}) => {
  const summary = { processed: 0, sent: 0, failed: 0, dead: 0 };
  const n = Math.min(Math.max(1, limit), batchCap);
  for (let i = 0; i < n; i++) {
    const claimed = await claimDueOutboxEvent(workerId);
    if (!claimed) break;
    summary.processed += 1;
    const res = await deliverOutboxEvent(claimed);
    if (res.delivered) summary.sent += 1;
    else if (res.dead) summary.dead += 1;
    else summary.failed += 1;
  }
  return summary;
};

const requeueDeadEvents = async () => {
  const res = await EventOutbox.updateMany(
    { status: "dead" },
    { $set: { status: "pending", nextRetryAt: new Date(), lastError: "", claimedBy: null, claimExpiresAt: null } }
  );
  return res.modifiedCount || 0;
};

const outboxSummary = async () => {
  const now = new Date();
  const [pending, due, dead, sent, flagged] = await Promise.all([
    EventOutbox.countDocuments({ status: "pending" }),
    EventOutbox.countDocuments({ status: "pending", nextRetryAt: { $lte: now } }),
    EventOutbox.countDocuments({ status: "dead" }),
    EventOutbox.countDocuments({ status: "sent" }),
    // Failed assignment reverts awaiting manual admin review (task 7
    // visibility). These are also delivered as ACTION NEEDED admin notices.
    EventOutbox.countDocuments({ action: "revert_failed" }),
  ]);
  return { pending, due, dead, sent, flagged };
};

// ── In-process delivery worker ──────────────────────────────────────────────
// Mirrors services/bookingDispatchJobs: a poll timer whose ticks claim due
// events with the atomic lease above, so any number of API instances/cluster
// workers can run it concurrently without duplicate deliveries. Started by
// server.js (disabled in tests and when EVENT_OUTBOX_WORKER=false). Without a
// worker like this — or an external cron running `npm run outbox:worker` —
// a failed delivery would stay pending forever in deployments with no cron.
const WORKER_POLL_MS = Math.max(1000, Number(process.env.EVENT_OUTBOX_POLL_MS) || 60000);
let outboxTimer = null;
let outboxWorkerId = null;

const outboxTick = async (workerId) => {
  try {
    await processEventOutbox({ limit: 20, workerId });
  } catch (e) {
    // Never let a tick crash the process; the next poll retries.
    console.error(`[event-outbox] worker tick failed (will retry next poll): ${String((e && e.message) || e).slice(0, 200)}`);
  }
};

const startOutboxWorker = (opts = {}) => {
  if (outboxTimer) return { stop: stopOutboxWorker, workerId: outboxWorkerId };
  const pollMs = opts.pollMs || WORKER_POLL_MS;
  outboxWorkerId = opts.workerId || `outbox-${process.pid}-${Date.now().toString(36)}`;
  console.log(`[event-outbox] worker started (pollMs=${pollMs} worker=${outboxWorkerId})`);
  // Immediate first tick recovers anything left pending by a previous process.
  setImmediate(() => {
    outboxTick(outboxWorkerId);
  });
  outboxTimer = setInterval(() => {
    outboxTick(outboxWorkerId);
  }, pollMs);
  if (outboxTimer.unref) outboxTimer.unref();
  return { stop: stopOutboxWorker, workerId: outboxWorkerId };
};

const stopOutboxWorker = () => {
  try {
    if (outboxTimer) clearInterval(outboxTimer);
  } catch {
    // ignore
  }
  outboxTimer = null;
};

module.exports = {
  enqueueEventOutbox,
  deliverOutboxEvent,
  claimDueOutboxEvent,
  processEventOutbox,
  requeueDeadEvents,
  outboxSummary,
  withEventTransaction,
  isTxnUnsupported,
  startOutboxWorker,
  stopOutboxWorker,
};
