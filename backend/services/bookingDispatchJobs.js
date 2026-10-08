// Durable outbox for WhatsApp booking-request fan-out.
//
// Why this exists: booking creation used to fire the cook fan-out as an
// unawaited background task. If the process restarted, WhatsApp was briefly
// misconfigured, or eligibility came back empty for one transient reason,
// the booking was saved and returned 201 while the dispatch work vanished
// with zero trace. This module replaces that with:
//
//   1. createBooking persists a DispatchJob (upsert, unique per booking)
//      BEFORE responding, so the work is durable.
//   2. A lightweight in-process worker claims due jobs atomically
//      (findOneAndUpdate + lease), so N server/cluster instances never
//      double-process a job.
//   3. Every exit — sent, skipped, retrying, failed — records a
//      machine-readable reason code on the job plus a one-line log, so the
//      next incident is diagnosable without reading raw MongoDB documents.
//   4. Transient Meta/network failures retry with bounded exponential
//      backoff (+ Meta Retry-After); per-recipient `sent` entries in
//      Booking.whatsappDispatch make retries idempotent.
//
// Delivery semantics are at-least-once per recipient with per-recipient
// dedup via persisted `sent` entries. Exactly-once is NOT claimed: a crash
// between Meta accepting a message and MongoDB persisting the message id
// can produce one duplicate on recovery (see reconcileInFlightEntries).

const mongoose = require("mongoose");
const DispatchJob = require("../models/DispatchJob");
const Booking = require("../models/Booking");
const User = require("../models/User");
const { isWhatsAppEnabled } = require("../utils/whatsappApi");
const { fanOutBookingRequest } = require("./whatsappDispatch");

const KIND_REQUEST = "booking.requested";

// Machine-readable outcome codes (also exposed for the admin endpoint).
const REASONS = {
  DISPATCHED: "dispatched",
  PARTIAL: "partially_dispatched",
  DISABLED: "whatsapp_disabled",
  NO_COOKS: "no_eligible_cooks",
  MISSING: "booking_missing",
  NOT_REQUESTED: "booking_not_requested",
  EXPIRED: "booking_expired",
  ASSIGNED: "cook_already_assigned",
  NO_RECIPIENTS: "no_valid_recipients",
  META: "meta_api_error",
  NET: "network_timeout",
  DB: "database_error",
  UNEXPECTED: "unexpected_error",
  INFLIGHT: "dispatch_inflight",
};

const TERMINAL_STATUSES = ["completed", "skipped", "failed"];

const cfg = () => ({
  pollMs: Math.max(2000, Number(process.env.WHATSAPP_DISPATCH_POLL_MS) || 10000),
  leaseMs: Math.max(15000, Number(process.env.WHATSAPP_DISPATCH_LEASE_MS) || 60000),
  maxAttempts: Math.min(20, Math.max(1, Number(process.env.WHATSAPP_DISPATCH_MAX_ATTEMPTS) || 5)),
  backfillAgeMs: Math.max(15000, Number(process.env.WHATSAPP_DISPATCH_BACKFILL_AGE_MS) || 60000),
  // A per-recipient `sending` entry older than this with no Meta message id
  // is ambiguous (Meta may have accepted it) — treat as failed-transient
  // and resend rather than dropping it. Newer ones mean another sender is
  // probably still active, so back off instead of double-sending.
  staleSendingMs: Math.max(30000, Number(process.env.WHATSAPP_DISPATCH_STALE_SENDING_MS) || 180000),
  inflightDeferMs: 30000,
  baseBackoffMs: 5000,
  maxBackoffMs: 60000,
});

const dbReady = () => {
  try {
    return mongoose.connection && mongoose.connection.readyState === 1;
  } catch {
    return false;
  }
};

const clog = (bookingId, jobId, stage, reason, extra) => {
  try {
    console.warn(
      `[whatsapp:dispatch] booking=${bookingId || "?"} job=${jobId || "?"} stage=${stage} reason=${reason}${extra ? ` ${extra}` : ""}`
    );
  } catch {
  }
};

const sanitize = (v, max = 500) => String(v == null ? "" : v).slice(0, max);

// ---------------------------------------------------------------------------
// Enqueue (called from createBooking; never throws)
// ---------------------------------------------------------------------------
const enqueueBookingRequestJob = async (bookingId) => {
  try {
    if (!bookingId) return null;
    if (!dbReady()) {
      clog(bookingId, null, "enqueue", "database_error", "db-not-ready (backfill will pick it up)");
      return null;
    }
    const now = new Date();
    const { maxAttempts } = cfg();
    await DispatchJob.updateOne(
      { booking: bookingId, kind: KIND_REQUEST },
      {
        $setOnInsert: {
          booking: bookingId,
          kind: KIND_REQUEST,
          status: "pending",
          attempts: 0,
          maxAttempts,
          nextRetryAt: now,
        },
      },
      { upsert: true }
    );
    const found = DispatchJob.findOne({ booking: bookingId, kind: KIND_REQUEST });
    const job = found && typeof found.lean === "function" ? await found.lean() : await found;
    clog(bookingId, job?._id, "enqueue", "pending");
    return job;
  } catch (err) {
    // The booking itself is already durable; the backfill sweeper recreates
    // a missing job, so enqueue failures must never fail the request.
    clog(bookingId, null, "enqueue", "database_error", sanitize(err?.message, 120));
    return null;
  }
};

// ---------------------------------------------------------------------------
// Atomic claim (cluster-safe: exactly one worker wins)
// ---------------------------------------------------------------------------
const claimDueJob = async (workerId) => {
  try {
    if (!dbReady()) return null;
    const now = new Date();
    const { leaseMs } = cfg();
    const job = await DispatchJob.findOneAndUpdate(
      {
        kind: KIND_REQUEST,
        status: { $in: ["pending", "retrying"] },
        $and: [
          { $or: [{ nextRetryAt: null }, { nextRetryAt: { $lte: now } }] },
          { $or: [{ leaseExpiresAt: null }, { leaseExpiresAt: { $lte: now } }] },
        ],
      },
      {
        $set: {
          status: "processing",
          lockedBy: String(workerId || "worker"),
          lockedAt: now,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          lastAttemptAt: now,
        },
        $inc: { attempts: 1 },
      },
      { new: true, sort: { nextRetryAt: 1, createdAt: 1 } }
    );
    return job || null;
  } catch {
    return null;
  }
};

const loadBookingDoc = async (bookingId) => {
  try {
    const q = Booking.findById(bookingId);
    if (q && typeof q.lean === "function") return await q.lean();
    return await q;
  } catch {
    return null;
  }
};

const resolveCustomerName = async (booking) => {
  try {
    if (!booking?.customer) return "";
    const q = User.findById(booking.customer).select("name");
    const u = q && typeof q.lean === "function" ? await q.lean() : await q;
    return u?.name || "";
  } catch {
    return "";
  }
};

// Default eligibility resolver: the controller's business rules, required
// lazily to avoid a controller<->service require cycle at load time.
// Requests the diagnostics shape ({ eligible, examined, excluded });
// injected test resolvers may return a plain eligible array instead.
const defaultEligibility = async (booking) => {
  const { findEligibleCooks } = require("../controllers/bookingController");
  return findEligibleCooks({
    date: booking.date,
    startTime: booking.startTime,
    endTime: booking.endTime,
    serviceType: booking.serviceType,
    excludeCookIds: booking.ignoredBy || [],
    diagnostics: true,
  });
};

// Persist one `pending` dispatch record per intended recipient BEFORE any
// send, so the full intended set survives a mid-loop crash and the summary
// can distinguish "never attempted" from "attempted". Atomic per cook:
// cooks that already have a request entry are left untouched.
const preseedRecipientEntries = async (bookingId, cookIds) => {
  let seeded = 0;
  for (const cookId of cookIds || []) {
    if (!cookId) continue;
    try {
      const res = await Booking.updateOne(
        {
          _id: bookingId,
          whatsappDispatch: { $not: { $elemMatch: { cook: cookId, kind: "request" } } },
        },
        {
          $push: {
            whatsappDispatch: { cook: cookId, kind: "request", status: "pending", attempts: 0 },
          },
        }
      );
      if ((res?.modifiedCount ?? res?.nModified ?? 0) === 1) seeded += 1;
    } catch {
    }
  }
  return seeded;
};

const bookingExpired = (booking, now) =>
  Boolean(
    booking?.status === "expired" ||
      (booking?.requestExpiresAt && new Date(booking.requestExpiresAt).getTime() <= now)
  );

// ---------------------------------------------------------------------------
// In-flight reconciliation: ambiguous per-recipient `sending` entries
// ---------------------------------------------------------------------------
const reconcileInFlightEntries = async (booking, job) => {
  const out = { deferred: false, recovered: 0 };
  try {
    const now = Date.now();
    const { staleSendingMs } = cfg();
    const entries = Array.isArray(booking?.whatsappDispatch) ? booking.whatsappDispatch : [];
    const inflight = entries.filter(
      (e) => String(e?.kind || "") === "request" && String(e?.status || "") === "sending"
    );
    if (!inflight.length) return out;
    const freshCutoff = now - staleSendingMs;
    const recent = inflight.filter((e) => {
      const t = e?.lastAttemptAt ? new Date(e.lastAttemptAt).getTime() : 0;
      return !e?.messageId && t >= freshCutoff;
    });
    if (recent.length) {
      // Another sender (worker or manual retry) is probably mid-send right
      // now — defer this run instead of risking a duplicate.
      out.deferred = true;
      return out;
    }
    // Stale `sending` with no message id: Meta may or may not have accepted
    // it. At-least-once beats silent loss: flip to failed-transient so the
    // fan-out below resends, and the `sent` dedup still protects cooks whose
    // message id did persist.
    for (const e of inflight) {
      if (e?.messageId) continue;
      try {
        await Booking.updateOne(
          {
            _id: booking._id,
            whatsappDispatch: { $elemMatch: { cook: e.cook, kind: "request", status: "sending" } },
          },
          {
            $set: {
              "whatsappDispatch.$.status": "failed",
              "whatsappDispatch.$.attempts": Number(e.attempts || 0) + 1,
              "whatsappDispatch.$.lastAttemptAt": new Date(),
              "whatsappDispatch.$.error": "stale sending entry recovered — resending",
            },
          }
        );
        out.recovered += 1;
      } catch {
      }
    }
  } catch {
  }
  return out;
};

const computeBackoffMs = (attempts, retryAfterMs) => {
  const { baseBackoffMs, maxBackoffMs } = cfg();
  const exp = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, attempts - 1));
  const jitter = Math.floor(Math.random() * 1000);
  let wait = exp + jitter;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) wait = Math.max(wait, retryAfterMs);
  return wait;
};

const saveJob = async (job, patch, workerId) => {
  try {
    const filter = workerId
      ? { _id: job._id, lockedBy: String(workerId) }
      : { _id: job._id };
    const res = await DispatchJob.updateOne(filter, { $set: patch });
    return (res?.modifiedCount ?? res?.nModified ?? 0) === 1;
  } catch {
    return false;
  }
};

const finishJob = async (job, workerId, status, reason, extra = {}) => {
  const now = new Date();
  const patch = {
    status,
    reason,
    error: sanitize(extra.error || "", 500),
    ...(extra.eligibleCookCount != null ? { eligibleCookCount: Number(extra.eligibleCookCount) || 0 } : {}),
    ...(extra.sentCount != null ? { sentCount: Number(extra.sentCount) || 0 } : {}),
    ...(extra.failedCount != null ? { failedCount: Number(extra.failedCount) || 0 } : {}),
    ...(extra.diagnostics ? { diagnostics: extra.diagnostics } : {}),
    ...(status === "completed" ? { completedAt: now } : {}),
    ...(extra.nextRetryAt ? { nextRetryAt: extra.nextRetryAt } : {}),
    ...(status === "processing" || status === "retrying"
      ? { leaseExpiresAt: new Date(now.getTime() + cfg().leaseMs) }
      : { leaseExpiresAt: null, lockedBy: "" }),
  };
  const saved = await saveJob(job, patch, workerId);
  clog(job.booking, job._id, "finish", reason, `status=${status} attempts=${job.attempts}${extra.note ? ` ${extra.note}` : ""}`);
  return saved;
};

// ---------------------------------------------------------------------------
// Core job processing. deps injectable for tests:
//   { findEligibleCooks, fanOut, workerId }
// ---------------------------------------------------------------------------
const processJob = async (job, deps = {}) => {
  const workerId = deps.workerId || "worker";
  const findEligible = deps.findEligibleCooks || defaultEligibility;
  const fanOut = deps.fanOut || fanOutBookingRequest;
  const nowMs = Date.now();
  const { maxAttempts } = cfg();
  const maxTries = Number(job?.maxAttempts) || maxAttempts;

  const skip = (reason, extra) => finishJob(job, workerId, "skipped", reason, extra);
  const fail = (reason, extra) => finishJob(job, workerId, "failed", reason, extra);
  const retry = (reason, extra = {}) => {
    if ((job.attempts || 0) >= maxTries) {
      return fail(reason, { ...extra, note: `attempts-exhausted(${job.attempts})` });
    }
    return finishJob(job, workerId, "retrying", reason, {
      ...extra,
      nextRetryAt: new Date(Date.now() + computeBackoffMs(job.attempts, extra.retryAfterMs)),
    });
  };

  try {
    if (!job?.booking) return fail(REASONS.MISSING, { error: "job has no booking id" });

    const booking = await loadBookingDoc(job.booking);
    if (!booking) return fail(REASONS.MISSING, { error: "booking document not found" });

    if (booking.cook) return skip(REASONS.ASSIGNED, { error: "cook already assigned — no broadcast needed" });
    if (bookingExpired(booking, nowMs)) return skip(REASONS.EXPIRED, { error: "request window elapsed" });
    if (String(booking.status) !== "requested") {
      return skip(REASONS.NOT_REQUESTED, { error: `status=${booking.status}` });
    }

    if (!isWhatsAppEnabled()) {
      // Config may be fixed within the 5-minute window, so this stays
      // retryable while attempts remain; afterwards it is a visible failure.
      return retry(REASONS.DISABLED, { error: "WHATSAPP_ENABLED/token/phone-id not configured" });
    }

    const { deferred, recovered } = await reconcileInFlightEntries(booking, job);
    if (deferred) {
      return finishJob(job, workerId, "retrying", REASONS.INFLIGHT, {
        error: "another sender is mid-send — deferred to avoid duplicates",
        nextRetryAt: new Date(Date.now() + cfg().inflightDeferMs),
      });
    }

    let eligible = [];
    let diagInfo = null;
    try {
      const res = await findEligible(booking);
      if (Array.isArray(res)) {
        eligible = res || [];
      } else {
        eligible = res?.eligible || [];
        diagInfo = res;
      }
    } catch (err) {
      return retry(REASONS.DB, { error: `eligibility lookup failed: ${sanitize(err?.message, 200)}` });
    }

    // Counts-only eligibility summary (no personal data). Explains "why did
    // only N qualify?" without inspecting raw documents.
    const diagSummary = (summary) => {
      if (!diagInfo && !summary) return undefined;
      const out = {};
      if (diagInfo) {
        out.examined = Number(diagInfo.examined) || 0;
        out.excludedByReason = diagInfo.excluded || {};
      }
      if (summary) {
        out.attempted = Number(summary.attempted) || 0;
        out.skipped = Number(summary.skipped) || 0;
        out.noPhone = Number(summary.noPhone) || 0;
        out.ineligible = Number(summary.ineligible) || 0;
      }
      return out;
    };

    if (!eligible.length) {
      // Deliberate re-evaluation policy: cooks may come online or free up
      // inside the 5-minute request window, so re-check with backoff while
      // attempts remain; afterwards record the permanent skip.
      if ((job.attempts || 0) < maxTries && !bookingExpired(booking, Date.now())) {
        return retry(REASONS.NO_COOKS, { eligibleCookCount: 0, diagnostics: diagSummary(), error: "no eligible cooks yet — re-evaluating" });
      }
      return skip(REASONS.NO_COOKS, { eligibleCookCount: 0, diagnostics: diagSummary(), error: "no eligible cooks after re-evaluation" });
    }

    const eligibleIds = eligible.map((c) => String(c?.userId || "")).filter(Boolean);
    await preseedRecipientEntries(booking._id, eligibleIds);

    const customerName = await resolveCustomerName(booking);
    let result;
    try {
      result = await fanOut(booking, eligible, { customerName });
    } catch (err) {
      return retry(REASONS.UNEXPECTED, { eligibleCookCount: eligible.length, error: sanitize(err?.message, 200) });
    }

    const results = Array.isArray(result?.results) ? result.results : [];
    const actionable = results.filter((r) => !(r?.skipped && /already-sent/i.test(String(r?.reason || ""))));
    const sent = actionable.filter((r) => r?.ok).length;
    const failedEntries = actionable.filter((r) => !r?.ok);
    const summary = result?.summary || null;
    try {
      clog(
        job.booking,
        job._id,
        "summary",
        sent > 0 ? "dispatched" : "all-failed",
        `examined=${diagInfo?.examined ?? "?"} eligible=${eligible.length} attempted=${summary?.attempted ?? actionable.length} sent=${sent} failed=${failedEntries.length} skipped=${summary?.skipped ?? 0} noPhone=${summary?.noPhone ?? 0} excluded=${JSON.stringify(diagInfo?.excluded || {})}`
      );
    } catch {
    }
    const extra = {
      eligibleCookCount: eligible.length,
      sentCount: sent,
      failedCount: failedEntries.length,
      diagnostics: diagSummary(summary),
      ...(recovered ? { note: `recovered-stale-sending(${recovered})` } : {}),
    };

    if (sent > 0) {
      const reason = failedEntries.length ? REASONS.PARTIAL : REASONS.DISPATCHED;
      const error = failedEntries.length
        ? sanitize(failedEntries.map((r) => `${r?.cookId || "?"}:${r?.error || r?.reason || "failed"}`).join("; "), 500)
        : "";
      return finishJob(job, workerId, "completed", reason, { ...extra, error });
    }

    if (!actionable.length) {
      // Everyone was already sent (or nothing actionable) — nothing left.
      return finishJob(job, workerId, "completed", REASONS.DISPATCHED, { ...extra, error: "" });
    }

    const noNumber = failedEntries.filter((r) =>
      /no-whatsapp-number|invalid-recipient|no-recipients/i.test(String(r?.error || r?.reason || ""))
    );
    const notEligible = failedEntries.filter((r) =>
      /cook-not-eligible/i.test(String(r?.error || r?.reason || ""))
    );
    const retryable = failedEntries.filter((r) => r?.retryable === true);
    const firstErr = sanitize(failedEntries[0]?.error || failedEntries[0]?.reason || "send failed", 300);

    if (noNumber.length === failedEntries.length) {
      return skip(REASONS.NO_RECIPIENTS, { ...extra, error: "no valid cook WhatsApp numbers" });
    }
    if (notEligible.length === failedEntries.length) {
      return retry(REASONS.NO_COOKS, { ...extra, error: "cooks no longer eligible — re-evaluating" });
    }
    if (retryable.length && !bookingExpired(booking, Date.now())) {
      const isNet = retryable.every((r) => !Number.isFinite(Number(r?.status)));
      return retry(isNet ? REASONS.NET : REASONS.META, {
        ...extra,
        error: firstErr,
        retryAfterMs: result?.retryAfterMs,
      });
    }
    return fail(REASONS.META, { ...extra, error: firstErr });
  } catch (err) {
    try {
      return retry(REASONS.UNEXPECTED, { error: sanitize(err?.message, 200) });
    } catch {
      return false;
    }
  }
};

// ---------------------------------------------------------------------------
// Recovery: stale leases + backfill for bookings that never got a job
// (covers the crash window between Booking.create and job enqueue).
// ---------------------------------------------------------------------------
const recoverStaleLocks = async () => {
  try {
    if (!dbReady()) return 0;
    const now = new Date();
    const res = await DispatchJob.updateMany(
      { status: "processing", leaseExpiresAt: { $lte: now } },
      {
        $set: {
          status: "retrying",
          nextRetryAt: now,
          lockedBy: "",
          lockedAt: null,
          leaseExpiresAt: null,
          error: "worker lease expired — requeued for recovery",
        },
      }
    );
    const n = res?.modifiedCount ?? res?.nModified ?? 0;
    if (n) clog(null, null, "recover", "stale-leases", `requeued=${n}`);
    return n;
  } catch {
    return 0;
  }
};

const backfillMissingJobs = async (limit = 50) => {
  try {
    if (!dbReady()) return 0;
    const now = new Date();
    const { backfillAgeMs } = cfg();
    const candidates = await Booking.find({
      status: "requested",
      cook: null,
      requestExpiresAt: { $gt: now },
      createdAt: { $lt: new Date(now.getTime() - backfillAgeMs) },
    })
      .select("_id whatsappDispatch createdAt")
      .limit(limit)
      .lean();
    if (!candidates?.length) return 0;
    const ids = candidates.map((b) => b._id);
    const existing = await DispatchJob.find({ booking: { $in: ids }, kind: KIND_REQUEST })
      .select("booking")
      .lean();
    const have = new Set((existing || []).map((j) => String(j.booking)));
    let created = 0;
    for (const b of candidates) {
      if (have.has(String(b._id))) continue;
      const sent = (b.whatsappDispatch || []).some(
        (e) => String(e?.kind || "") === "request" && String(e?.status || "") === "sent"
      );
      if (sent) continue;
      const job = await enqueueBookingRequestJob(b._id);
      if (job) created += 1;
    }
    if (created) clog(null, null, "backfill", "missing-jobs", `created=${created}`);
    return created;
  } catch {
    return 0;
  }
};

// ---------------------------------------------------------------------------
// Worker loop (in-process; safe with N instances via atomic claims)
// ---------------------------------------------------------------------------
let workerTimer = null;
let workerBusy = false;
let workerId = `dispatch-${process.pid}-${Date.now().toString(36)}`;

const processDueJobsOnce = async (deps = {}) => {
  if (workerBusy) return { claimed: false, busy: true };
  workerBusy = true;
  try {
    const id = deps.workerId || workerId;
    const job = await claimDueJob(id);
    if (!job) return { claimed: false };
    await processJob(job, { ...deps, workerId: id });
    return { claimed: true, jobId: job._id };
  } finally {
    workerBusy = false;
  }
};

const tick = async () => {
  try {
    await recoverStaleLocks().catch(() => 0);
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 25) break;
      const r = await processDueJobsOnce();
      if (!r?.claimed) break;
    }
  } catch {
  }
};

let tickCount = 0;
const wrappedTick = async () => {
  tickCount += 1;
  await tick();
  if (tickCount % 5 === 0) {
    try {
      await backfillMissingJobs();
    } catch {
    }
  }
};

const startWorker = (opts = {}) => {
  if (workerTimer) return { stop: stopWorker, workerId };
  if (opts.workerId) workerId = String(opts.workerId);
  const { pollMs } = cfg();
  clog(null, null, "worker-start", "ready", `pollMs=${pollMs} worker=${workerId}`);
  // Recover anything left by a previous process/deploy, then poll.
  setImmediate(() => {
    tick().catch(() => {});
  });
  workerTimer = setInterval(() => {
    wrappedTick().catch(() => {});
  }, pollMs);
  if (workerTimer.unref) workerTimer.unref();
  return { stop: stopWorker, workerId };
};

const stopWorker = () => {
  try {
    if (workerTimer) clearInterval(workerTimer);
  } catch {
  }
  workerTimer = null;
};

// Immediate kick after enqueue: best-effort only — durability already
// comes from the persisted job, so losing this timer is harmless.
const kickWorker = () => {
  try {
    setImmediate(() => {
      tick().catch(() => {});
    });
  } catch {
  }
};

// ---------------------------------------------------------------------------
// Manual retry compatibility: refresh the job record after an admin
// re-notify so the admin endpoint reflects the latest outcome.
// ---------------------------------------------------------------------------
const recordManualAttempt = async (bookingId, result) => {
  try {
    if (!bookingId || !dbReady()) return null;
    const results = Array.isArray(result?.results) ? result.results : [];
    const sent = results.filter((r) => r?.ok).length;
    const failed = results.filter((r) => !r?.ok && !r?.skipped).length;
    const now = new Date();
    if (result?.ok && sent > 0) {
      await DispatchJob.updateOne(
        { booking: bookingId, kind: KIND_REQUEST },
        {
          $set: {
            status: "completed",
            reason: "dispatched",
            error: "",
            sentCount: sent,
            failedCount: failed,
            completedAt: now,
            leaseExpiresAt: null,
            lockedBy: "",
          },
          $setOnInsert: { booking: bookingId, kind: KIND_REQUEST, attempts: 0, maxAttempts: cfg().maxAttempts },
        },
        { upsert: true }
      );
    } else {
      await DispatchJob.updateOne(
        { booking: bookingId, kind: KIND_REQUEST },
        {
          $set: { sentCount: sent, failedCount: failed, lastAttemptAt: now },
          $setOnInsert: {
            booking: bookingId,
            kind: KIND_REQUEST,
            status: "pending",
            attempts: 0,
            maxAttempts: cfg().maxAttempts,
            nextRetryAt: now,
            reason: "",
            error: "",
          },
        },
        { upsert: true }
      );
    }
    const refreshed = DispatchJob.findOne({ booking: bookingId, kind: KIND_REQUEST });
    return refreshed && typeof refreshed.lean === "function" ? refreshed.lean() : refreshed;
  } catch {
    return null;
  }
};

const sanitizeJob = (j) => {
  if (!j) return null;
  const o = typeof j.toObject === "function" ? j.toObject() : j;
  return {
    id: String(o._id),
    booking: String(o.booking),
    kind: o.kind,
    status: o.status,
    reason: o.reason || "",
    error: o.error || "",
    attempts: o.attempts || 0,
    maxAttempts: o.maxAttempts,
    nextRetryAt: o.nextRetryAt || null,
    lastAttemptAt: o.lastAttemptAt || null,
    completedAt: o.completedAt || null,
    eligibleCookCount: o.eligibleCookCount || 0,
    sentCount: o.sentCount || 0,
    failedCount: o.failedCount || 0,
    diagnostics: o.diagnostics || null,
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null,
  };
};

const listJobs = async ({ status, bookingId, limit = 20, skip = 0 } = {}) => {
  const filter = { kind: KIND_REQUEST };
  const STATUSES = ["pending", "processing", "retrying", "completed", "skipped", "failed"];
  if (status && STATUSES.includes(String(status))) filter.status = String(status);
  if (bookingId) filter.booking = bookingId;
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const sk = Math.max(0, Number(skip) || 0);
  const [rows, total] = await Promise.all([
    DispatchJob.find(filter).sort({ updatedAt: -1 }).skip(sk).limit(lim).lean(),
    DispatchJob.countDocuments(filter),
  ]);
  return { jobs: (rows || []).map(sanitizeJob), total };
};

module.exports = {
  KIND_REQUEST,
  REASONS,
  TERMINAL_STATUSES,
  enqueueBookingRequestJob,
  claimDueJob,
  processJob,
  processDueJobsOnce,
  recoverStaleLocks,
  backfillMissingJobs,
  startWorker,
  stopWorker,
  kickWorker,
  recordManualAttempt,
  listJobs,
  sanitizeJob,
  computeBackoffMs,
  reconcileInFlightEntries,
};
