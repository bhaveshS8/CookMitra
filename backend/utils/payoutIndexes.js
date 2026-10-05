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
    spec: { "payment.refundReferenceKey": 1 },
    options: {
      unique: true,
      partialFilterExpression: { "payment.refundReferenceKey": { $exists: true, $gt: "" } },
      name: "uniq_refund_reference_key",
    },
  },
  {
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
    spec: { clientKey: 1 },
    options: {
      unique: true,
      partialFilterExpression: { clientKey: { $exists: true, $gt: "" } },
      name: "uniq_booking_clientKey",
    },
  },
  {
    spec: { "payment.razorpayOrderId": 1 },
    options: { sparse: true, name: "idx_payment_razorpayOrderId" },
  },
];

const EXTRA_FINANCIAL_INDEXES = [
  {
    collection: "ledgerentries",
    spec: { idempotencyKey: 1 },
    options: {
      unique: true,
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
  const canDoExtras = !!(
    connection &&
    connection.db &&
    typeof connection.db.collection === "function"
  );
  const extraColl = (name) => (canDoExtras ? connection.db.collection(name) : null);
  for (;;) {
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
