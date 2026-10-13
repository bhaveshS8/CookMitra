// READ-ONLY operational checklist for Cook payout database readiness.
// Usage (staging or production, from a machine with DB access):
//   MONGODB_URI="mongodb+srv://<user>:<password>@<cluster>/<db>?retryWrites=true&w=majority" node scripts/check-payout-indexes.js
//
// This script NEVER writes: it uses only getIndexes(), countDocuments()
// and read-only aggregations. It never prints credentials, tokens, phone
// numbers, names, or full customer records — only counts and short refs.
// Exit code 0 = all checks pass; 1 = at least one check needs attention.

const mongoose = require("mongoose");

const maskSecrets = (s) => {
  try {
    return String(s)
      .replace(/\/\/([^:/?#\s]+:)([^@/?#\s]*)@/g, "//$1****@")
      .replace(/([?&](?:password|passwd|pwd|token|secret)[^=]*=)[^&\s]*/gi, "$1****");
  } catch {
    return "<unparseable>";
  }
};

// partial: the exact partialFilterExpression from the Mongoose schema, or
// null when the schema defines a plain (non-partial) unique index.
const P = (field) => ({ [field]: { $exists: true, $gt: "" } });
const EXPECTED = [
  { coll: "cookpayouts", name: "uniq_cookpayout_payref", key: { paymentReference: 1 }, unique: true, partial: P("paymentReference") },
  { coll: "cookpayouts", name: "uniq_cookpayout_ref", key: { payoutRef: 1 }, unique: true, partial: null },
  { coll: "cookpayouts", name: "uniq_cookpayout_idem", key: { idempotencyKey: 1 }, unique: true, partial: P("idempotencyKey") },
  { coll: "bookings", name: "uniq_payout_reference", key: { "payout.reference": 1 }, unique: true, partial: P("payout.reference") },
  { coll: "bookings", name: "uniq_payout_reference_key", key: { "payout.referenceKey": 1 }, unique: true, partial: P("payout.referenceKey") },
  { coll: "bookings", name: "uniq_refund_reference_key", key: { "payment.refundReferenceKey": 1 }, unique: true, partial: P("payment.refundReferenceKey") },
  { coll: "bookings", name: "uniq_booking_clientKey", key: { clientKey: 1 }, unique: true, partial: P("clientKey") },
  { coll: "bookings", name: "uniq_payment_razorpayPaymentId", key: { "payment.razorpayPaymentId": 1 }, unique: true, partial: P("payment.razorpayPaymentId") },
];

// Order-insensitive deep equality (server may return keys in any order).
const norm = (v) => {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
    return o;
  }
  return v;
};
const sameDoc = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const samePartial = (found, expected) => {
  if (!expected) return !found; // plain unique index must have NO partial filter
  return !!found && sameDoc(found, expected);
};

async function main() {
  const uri = (process.env.MONGODB_URI || "").trim();
  if (!uri) {
    console.error("MONGODB_URI is not set — refusing to run. Point it at staging/production explicitly.");
    process.exit(2);
  }
  console.log(`Target: ${maskSecrets(uri).replace(/\/[^/]*(\?|$)/, "/<db>$1")}`);
  let failures = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
    if (!ok) failures += 1;
  };

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  } catch (e) {
    console.error(`CONNECTION FAILED (no checks ran, nothing was changed): ${maskSecrets(e?.message || e)}`);
    process.exit(1);
  }
  try {
    const db = mongoose.connection.db;

    // 0. Server version (partial indexes need MongoDB >= 3.2; transactions
    //    need a replica set / sharded cluster).
    try {
      const info = await db.admin().serverInfo();
      const setName = info?.setName || null;
      console.log(`INFO  mongod version=${info?.version || "?"} replicaSet=${setName || "none (standalone — transaction fallback applies)"}`);
      check("server supports partial indexes (>= 3.2)", String(info?.version || "0").split(".").map(Number)[0] >= 3, info?.version);
    } catch (e) {
      check("server version readable", false, maskSecrets(e?.message || e));
    }

    // 1. Required unique indexes exist with the exact key, uniqueness AND
    //    partial filter (a unique index with a wrong/missing partial filter
    //    either over-blocks empty refs or under-protects duplicates).
    for (const exp of EXPECTED) {
      let indexes = [];
      try {
        indexes = await db.collection(exp.coll).indexes();
      } catch (e) {
        check(`index ${exp.coll}.${exp.name} present`, false, `cannot list indexes: ${maskSecrets(e?.message || e)}`);
        continue;
      }
      const found = indexes.find((ix) => ix.name === exp.name);
      if (!found) {
        check(`index ${exp.coll}.${exp.name} present`, false, "MISSING — create only after the duplicate check below is clean");
        continue;
      }
      const keyOk = sameDoc(found.key, exp.key) && found.unique === true;
      const partialOk = samePartial(found.partialFilterExpression, exp.partial);
      check(
        `index ${exp.coll}.${exp.name} definition`,
        keyOk && partialOk,
        `key=${JSON.stringify(found.key)} unique=${!!found.unique} partial=${JSON.stringify(found.partialFilterExpression || null)}`
      );
    }

    const payouts = db.collection("cookpayouts");
    const bookings = db.collection("bookings");

    // 2. Duplicate non-empty payment references (must be zero before creating
    //    uniq_cookpayout_payref anywhere it is missing).
    const dupRefs = await payouts
      .aggregate([
        { $match: { paymentReference: { $exists: true, $ne: "" } } },
        { $group: { _id: "$paymentReference", n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $project: { n: 1 } },
      ])
      .toArray();
    check("no duplicate non-empty paymentReference", dupRefs.length === 0, dupRefs.length ? `${dupRefs.length} duplicated value(s)` : "clean");

    // 3. Paid cycles whose bookings are not all synced to paid (divergence
    //    scan; repair via POST /api/admin/cook-payouts/payouts/:id/sync-bookings).
    const paidCycles = await payouts.find({ status: "paid" }).project({ payoutRef: 1, bookings: 1 }).toArray();
    let diverged = 0;
    for (const c of paidCycles) {
      const ids = c.bookings || [];
      if (!ids.length) continue;
      const unsynced = await bookings.countDocuments({ _id: { $in: ids }, "payoutInfo.payoutStatus": { $ne: "paid" } });
      if (unsynced > 0) {
        diverged += 1;
        console.log(`   DIVERGED cycle ${c.payoutRef}: ${unsynced}/${ids.length} bookings not paid`);
      }
    }
    check("no paid cycle with unsynced bookings", diverged === 0, diverged ? `${diverged} cycle(s) need sync-bookings` : `${paidCycles.length} paid cycle(s) scanned`);

    // 3b. AMBIGUOUS paid cycles: status paid but no payment reference. These
    // must NOT be auto-healed (sync-bookings refuses them); each needs
    // out-of-band transfer verification + record-reference first.
    const ambiguous = await payouts
      .find({ status: "paid", $or: [{ paymentReference: "" }, { paymentReference: { $exists: false } }] })
      .project({ payoutRef: 1 })
      .toArray();
    for (const c of ambiguous) console.log(`   AMBIGUOUS cycle ${c.payoutRef}: paid without payment reference`);
    check("no ambiguous paid cycles (paid, no reference)", ambiguous.length === 0, ambiguous.length ? `${ambiguous.length} cycle(s) need verification + record-reference` : `${paidCycles.length} paid cycle(s) scanned`);

    // 3c. Paid cycles missing their payout_paid audit event (forensic gap;
    //     resolved by sync-bookings backfill on evidenced cycles only).
    const eventLogs = db.collection("cookeventlogs");
    let auditGap = 0;
    try {
      for (const c of paidCycles) {
        const n = await eventLogs.countDocuments({ event: "payout_paid", refId: c._id });
        if (n === 0) {
          auditGap += 1;
          console.log(`   AUDIT-GAP cycle ${c.payoutRef}: paid but no payout_paid event`);
        }
      }
      check("every paid cycle has a payout_paid audit", auditGap === 0, auditGap ? `${auditGap} cycle(s) — verify transfer, then sync-bookings backfills` : `${paidCycles.length} paid cycle(s) scanned`);
    } catch (e) {
      check("payout_paid audit coverage readable", false, maskSecrets(e?.message || e));
    }

    // 4. No booking claimed by two cycles (same payoutCycleRef owner check is
    //    by construction; here: bookings stuck mid-claim with no cycle).
    const orphanClaimed = await bookings
      .countDocuments({
        "payoutInfo.payoutCycleRef": { $exists: true, $ne: "" },
        "payoutInfo.payoutStatus": { $in: ["eligible", "pending_weekly"] },
      })
      .catch(() => -1);
    console.log(`INFO  bookings carrying a cycle ref while still eligible/pending_weekly: ${orphanClaimed} (informational only)`);
  } finally {
    await mongoose.disconnect();
  }

  console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) NEED ATTENTION`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", maskSecrets(e?.message || e));
  process.exit(1);
});
