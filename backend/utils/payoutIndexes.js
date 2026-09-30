// Financial index guarantee.
//
// Uniqueness invariants that block double-spend must hold at the DATABASE
// level: two concurrent workers can both pass app-level checks before either
// commits, so only a unique index fails the loser closed. Auto-index creation
// proved unreliable in this deployment (uniq_payout_reference was absent on
// live bookings despite being declared in the schema), so boot ensures these
// explicitly: idempotent (same name+spec is a no-op), retrying forever in
// the background, and never fatal to the API.
//
// Covers bookings (payout/refund references, gateway payment id, booking
// clientKey) plus the ledger idempotency key and the webhook dedup key.
// NOTE: specs use partialFilterExpression WITHOUT sparse — MongoDB rejects
// sparse+partial combinations, which is exactly why these indexes never
// converged via schema auto-indexing (partial alone already excludes the
// non-matching documents, so nothing is lost).
const PAYOUT_INDEXES = [
  {
    spec: { "payout.reference": 1 },
    options: {
      unique: true,
      partialFilterExpression: { "payout.reference": { $exists: true, $gt: "" } },
      name: "uniq_payout_reference",
    },
  },
  {
    spec: { "payout.referenceKey": 1 },
    options: {
      unique: true,
      partialFilterExpression: { "payout.referenceKey": { $exists: true, $gt: "" } },
      name: "uniq_payout_reference_key",
    },
  },
  {
    // Manual refund settlements carry the same invariant: one offline
    // transfer reference can never close two refunds (case/whitespace
    // variants included). Live auto-index creation proved unreliable for the
    // payout twin, so the refund twin is ensured here too.
    spec: { "payment.refundReferenceKey": 1 },
    options: {
      unique: true,
      partialFilterExpression: { "payment.refundReferenceKey": { $exists: true, $gt: "" } },
      name: "uniq_refund_reference_key",
    },
  },
  {
    // One captured gateway payment confirms at most one booking: without
    // this, a replayed (order, payment) pair could confirm N bookings.
    // Mirrors models/Booking.js uniq_payment_razorpayPaymentId.
    spec: { "payment.razorpayPaymentId": 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        "payment.razorpayPaymentId": { $exists: true, $gt: "" },
      },
      name: "uniq_payment_razorpayPaymentId",
    },
  },
  {
    // Booking-creation idempotency: retried creates with the same clientKey
    // collide here instead of double-booking. Mirrors uniq_booking_clientKey.
    spec: { clientKey: 1 },
    options: {
      unique: true,
      partialFilterExpression: { clientKey: { $exists: true, $gt: "" } },
      name: "uniq_booking_clientKey",
    },
  },
  {
    // Gateway order lookup used by the webhook path (exact + history).
    // Non-unique: several orders may exist per booking (re-mints), the
    // confirm step always binds to the latest stored order id.
    spec: { "payment.razorpayOrderId": 1 },
    options: { sparse: true, name: "idx_payment_razorpayOrderId" },
  },
];

// Non-booking financial collections. Index names deliberately match the
// Mongoose schema defaults (`<path>_1`) so boot-ensure and schema
// auto-indexing converge on the same index instead of fighting over names.
const EXTRA_FINANCIAL_INDEXES = [
  {
    collection: "ledgerentries",
    spec: { idempotencyKey: 1 },
    options: {
      unique: true,
      // sparse (without partial — that combination is illegal) matches the
      // schema declaration and the live index exactly.
      sparse: true,
      name: "idempotencyKey_1",
    },
  },
  {
    collection: "webhookevents",
    spec: { key: 1 },
    options: { unique: true, name: "key_1" },
  },
];

// ensurePayoutIndexes({ connection, collection, waitMs, retryMs, onLog }) loops
// until both indexes exist, then returns. `collection` defaults to the
// Booking collection. Never throws — callers fire-and-forget at boot.
const ensurePayoutIndexes = async ({
  connection,
  collection,
  waitMs = 5000,
  retryMs = 30000,
  onLog = () => {},
} = {}) =>
  ensurePayoutIndexesOnce({ connection, collection, waitMs, retryMs, onLog, loop: true });

const ensurePayoutIndexesOnce = async ({
  connection,
  collection,
  waitMs = 5000,
  retryMs = 30000,
  onLog = () => {},
  loop = false,
} = {}) => {
  const coll =
    collection ||
    (connection && connection.db && connection.db.collection("bookings"));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Extra collections resolve off the live connection. When callers pass an
  // explicit `collection` (unit-test path) without a db handle, extras are
  // skipped — the production boot path always passes the connection, so live
  // deployments still ensure every financial index.
  const canDoExtras = !!(
    connection &&
    connection.db &&
    typeof connection.db.collection === "function"
  );
  const extraColl = (name) => (canDoExtras ? connection.db.collection(name) : null);
  for (;;) {
    // Not connected yet: poll quietly until the driver is ready.
    if (connection && connection.readyState !== 1) {
      if (!loop) return { ok: false, error: "database not connected yet" };
      await sleep(waitMs);
      continue;
    }
    try {
      if (!coll || typeof coll.createIndex !== "function") {
        throw new Error("bookings collection unavailable");
      }
      for (const { spec, options } of PAYOUT_INDEXES) {
        await coll.createIndex(spec, options);
      }
      if (canDoExtras) {
        for (const { collection: name, spec, options } of EXTRA_FINANCIAL_INDEXES) {
          const target = extraColl(name);
          if (!target || typeof target.createIndex !== "function") {
            throw new Error(`${name} collection unavailable`);
          }
          await target.createIndex(spec, options);
        }
      }
      onLog(
        "Financial indexes ensured (payout/reference keys, payment id, clientKey, ledger idempotency, webhook dedup)"
      );
      return { ok: true };
    } catch (error) {
      onLog(`Financial index ensure failed (${error?.message || error}) — retrying in background...`);
      if (!loop) return { ok: false, error: error?.message || String(error) };
      await sleep(retryMs);
    }
  }
};

module.exports = { ensurePayoutIndexes, ensurePayoutIndexesOnce, PAYOUT_INDEXES, EXTRA_FINANCIAL_INDEXES };
