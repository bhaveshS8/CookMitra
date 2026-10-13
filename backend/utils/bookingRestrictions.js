// Authoritative woman-presence booking restriction service.
//
// Business rule: a customer must explicitly confirm that a woman will be
// present throughout the cooking service before a new booking can be
// created. An explicit decline records a server-side lockout of exactly one
// hour, enforced on every booking-creation path for that authenticated
// account id.
//
// Failure policy is fail-closed: if the restriction state cannot be
// determined (database unavailable), callers must refuse to create a
// booking — but must NOT report a one-hour block that was never persisted.

const mongoose = require("mongoose");
const BookingRestriction = require("../models/BookingRestriction");

// Exactly one hour, in milliseconds / seconds (single source of truth).
const LOCKOUT_MS = 60 * 60 * 1000;
const LOCKOUT_SECONDS = 3600;

const POLICY_CODE = "WOMAN_PRESENCE_DECLINED";
const BLOCKED_CODE = "BOOKING_TEMPORARILY_BLOCKED";
const CONFIRMATION_REQUIRED_CODE = "WOMAN_PRESENCE_CONFIRMATION_REQUIRED";
// Returned when the restriction store is unreachable. Callers fail closed
// (refuse the booking) without claiming a persisted one-hour block.
const VERIFICATION_UNAVAILABLE_CODE = "BOOKING_VERIFICATION_UNAVAILABLE";
// Bookings created before the verification rollout carry no persisted
// confirmation and are grandfathered for dispatch/retry (they were
// legitimately created under the old rules). Everything created at or after
// this instant must carry an explicit persisted confirmation.
const WOMAN_PRESENCE_LAUNCH_ISO = "2026-10-10T00:00:00.000Z";
const WOMAN_PRESENCE_LAUNCH_MS = Date.parse(WOMAN_PRESENCE_LAUNCH_ISO);

const dbReady = () => {
  try {
    return mongoose.connection && mongoose.connection.readyState === 1;
  } catch {
    return false;
  }
};

// Server-side bound so the endpoint answers in milliseconds even when the
// database stalls (connecting, saturated, far away): callers fail closed
// with 503 instead of leaving the UI on an endless spinner. Override with
// BOOKING_RESTRICTION_TIMEOUT_MS (tests use a tiny value).
const storeTimeoutMs = () => {
  const v = Number(process.env.BOOKING_RESTRICTION_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 5000;
};
const withTimeout = (promise, message) => {
  const ms = storeTimeoutMs();
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    // NOTE: deliberately NOT unref'd — an unref'd timer is skipped when the
    // event loop would otherwise empty, which would silently abandon the
    // race instead of rejecting. The timer is always cleared on settle, so
    // it never lingers past the operation.
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
};

// Strict affirmation check. ONLY boolean true authorizes booking — never a
// truthiness check. Missing, null, false, "true", 1, objects and every other
// client-forged value are rejected.
const isValidAffirmation = (value) => value === true;

const toMs = (v) => {
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
};

// Current restriction state for a customer.
// Resolves { blocked, blockedUntil, declinedAt }.
// REJECTS with an Error (code VERIFICATION_UNAVAILABLE_CODE) when the state
// cannot be determined — callers must fail closed.
const getRestrictionState = async (customerId) => {
  let doc = null;
  try {
    if (!dbReady()) throw new Error("database not ready");
    doc = await withTimeout(
      BookingRestriction.findOne({ customer: customerId }).lean(),
      "restriction read timed out"
    );
  } catch (err) {
    const wrapped = new Error("Booking restriction store unavailable");
    wrapped.code = VERIFICATION_UNAVAILABLE_CODE;
    wrapped.cause = err;
    throw wrapped;
  }
  const now = Date.now();
  const untilMs = doc ? toMs(doc.blockedUntil) : NaN;
  if (doc && Number.isFinite(untilMs) && untilMs > now) {
    return {
      blocked: true,
      blockedUntil: doc.blockedUntil,
      declinedAt: doc.declinedAt || null,
    };
  }
  return { blocked: false, blockedUntil: null, declinedAt: doc?.declinedAt || null };
};

// Record an explicit decline. Atomic and concurrency-safe:
//  - active restriction  -> preserved as-is (repeated declines never extend)
//  - expired / missing   -> fresh one-hour window from the server clock
// Resolves { created, blockedUntil }. Rejects on persistence failure (callers
// surface a safe error; no booking and no dispatch job is created here).
const recordDecline = async (customerId) => {
  if (!customerId) {
    const err = new Error("Customer identity is required");
    err.code = "INVALID_CUSTOMER";
    throw err;
  }
  const now = new Date();
  try {
    if (!dbReady()) throw new Error("database not ready");
    const active = await withTimeout(
      BookingRestriction.findOne({
        customer: customerId,
        blockedUntil: { $gt: now },
      }).lean(),
      "restriction read timed out"
    );
    if (active) {
      return { created: false, blockedUntil: active.blockedUntil };
    }
    const blockedUntil = new Date(now.getTime() + LOCKOUT_MS);
    let doc = null;
    try {
      // Conditional upsert: only installs a fresh window when no active one
      // exists, so a concurrent decline that won the race is never clobbered.
      doc = await withTimeout(
        BookingRestriction.findOneAndUpdate(
          {
            customer: customerId,
            $or: [{ blockedUntil: { $lte: now } }, { blockedUntil: { $exists: false } }],
          },
          {
            $set: { blockedUntil, declinedAt: now, reason: POLICY_CODE },
            $setOnInsert: { customer: customerId },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        ),
        "restriction write timed out"
      );
    } catch (upsertErr) {
      if (upsertErr?.code !== 11000) throw upsertErr;
      // Lost the race with a concurrent decline — re-read the winner.
      const winner = await withTimeout(
        BookingRestriction.findOne({ customer: customerId }).lean(),
        "restriction read timed out"
      );
      const winnerUntil = winner ? toMs(winner.blockedUntil) : NaN;
      if (winner && Number.isFinite(winnerUntil) && winnerUntil > Date.now()) {
        return { created: false, blockedUntil: winner.blockedUntil };
      }
      throw upsertErr;
    }
    if (!doc) {
      // Filter did not match (a concurrent request installed an active
      // window between our read and write) — re-read instead of overwriting.
      const reread = await withTimeout(
        BookingRestriction.findOne({ customer: customerId }).lean(),
        "restriction read timed out"
      );
      const rereadUntil = reread ? toMs(reread.blockedUntil) : NaN;
      if (reread && Number.isFinite(rereadUntil) && rereadUntil > Date.now()) {
        return { created: false, blockedUntil: reread.blockedUntil };
      }
      const err = new Error("Could not record the booking restriction");
      err.code = "RESTRICTION_WRITE_FAILED";
      throw err;
    }
    const stored = doc.toObject ? doc.toObject() : doc;
    return { created: true, blockedUntil: stored.blockedUntil || blockedUntil };
  } catch (err) {
    if (err?.code === "RESTRICTION_WRITE_FAILED" || err?.code === "INVALID_CUSTOMER") throw err;
    const wrapped = new Error("Could not record the booking restriction. Please try again.");
    wrapped.code = "RESTRICTION_WRITE_FAILED";
    wrapped.cause = err;
    throw wrapped;
  }
};

const remainingSeconds = (blockedUntil, nowMs = Date.now()) => {
  const until = toMs(blockedUntil);
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, Math.ceil((until - nowMs) / 1000));
};

module.exports = {
  LOCKOUT_MS,
  LOCKOUT_SECONDS,
  POLICY_CODE,
  BLOCKED_CODE,
  CONFIRMATION_REQUIRED_CODE,
  VERIFICATION_UNAVAILABLE_CODE,
  WOMAN_PRESENCE_LAUNCH_ISO,
  WOMAN_PRESENCE_LAUNCH_MS,
  isValidAffirmation,
  getRestrictionState,
  recordDecline,
  remainingSeconds,
};
