// Payout reference index guarantee.
//
// The offline-reference uniqueness invariant (one transfer id settles at
// most one payout) must hold at the DATABASE level: two concurrent settles
// can both pass the app-level duplicate check before either commits, so
// only a unique index fails the loser closed. Auto-index creation proved
// unreliable in this deployment (uniq_payout_reference was absent on live
// bookings despite being declared in the schema), so boot ensures these
// explicitly: idempotent (same name+spec is a no-op), retrying forever in
// the background, and never fatal to the API.
const PAYOUT_INDEXES = [
  {
    spec: { "payout.reference": 1 },
    options: {
      unique: true,
      sparse: true,
      partialFilterExpression: { "payout.reference": { $exists: true, $ne: "" } },
      name: "uniq_payout_reference",
    },
  },
  {
    spec: { "payout.referenceKey": 1 },
    options: {
      unique: true,
      sparse: true,
      partialFilterExpression: { "payout.referenceKey": { $exists: true, $ne: "" } },
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
      sparse: true,
      partialFilterExpression: { "payment.refundReferenceKey": { $exists: true, $ne: "" } },
      name: "uniq_refund_reference_key",
    },
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
      onLog("Reference indexes ensured (uniq_payout_reference, uniq_payout_reference_key, uniq_refund_reference_key)");
      return { ok: true };
    } catch (error) {
      onLog(`Payout index ensure failed (${error?.message || error}) — retrying in background...`);
      if (!loop) return { ok: false, error: error?.message || String(error) };
      await sleep(retryMs);
    }
  }
};

module.exports = { ensurePayoutIndexes, ensurePayoutIndexesOnce, PAYOUT_INDEXES };
