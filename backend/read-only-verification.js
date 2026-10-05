
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/festivecook";

async function runReadOnlyInspection() {
  console.log("Connecting to:", MONGODB_URI.replace(/:([^@]+)@/, ":****@"));
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
    console.log("MongoDB connection established successfully.");
  } catch (err) {
    console.log("MongoDB not running locally or unreachable:", err.message);
    console.log("Skipping live database read-only inspection (DB disconnected).");
    process.exit(0);
  }

  try {
    const db = mongoose.connection.db;
    const bookingsColl = db.collection("bookings");
    const ledgerColl = db.collection("ledgerentries");

    console.log("\n=== 1. REFUND STATE DISTRIBUTION ===");
    const stateDist = await bookingsColl.aggregate([
      { $group: { _id: "$payment.refundStatus", count: { $sum: 1 }, totalRefunded: { $sum: "$payment.refundAmount" } } }
    ]).toArray();
    console.log(JSON.stringify(stateDist, null, 2));

    console.log("\n=== 2. PROCESSING REFUNDS ===");
    const processingCount = await bookingsColl.countDocuments({ "payment.refundStatus": "processing" });
    console.log("processingCount:", processingCount);

    console.log("\n=== 3. FAILED / MANUAL REFUNDS ===");
    const failedCount = await bookingsColl.countDocuments({ "payment.refundStatus": "failed" });
    const manualCount = await bookingsColl.countDocuments({ "payment.refundStatus": "manual" });
    console.log("failedCount:", failedCount, "manualCount:", manualCount);

    console.log("\n=== 4. PROCESSED REFUNDS ===");
    const processedCount = await bookingsColl.countDocuments({ "payment.refundStatus": "processed" });
    console.log("processedCount:", processedCount);

    console.log("\n=== 5. REJECTED REFUNDS ===");
    const rejectedCount = await bookingsColl.countDocuments({ "payment.refundStatus": "rejected" });
    console.log("rejectedCount:", rejectedCount);

    console.log("\n=== 6. REFUNDS EXCEEDING CAPTURED AMOUNT ===");
    const overRefunds = await bookingsColl.find({
      $expr: {
        $gt: [
          { $ifNull: ["$payment.refundAmount", 0] },
          { $ifNull: ["$payment.paidAmount", { $ifNull: ["$amount", 0] }] }
        ]
      }
    }).toArray();
    console.log("overRefunds count:", overRefunds.length);

    console.log("\n=== 7. DUPLICATE REFUND IDs ===");
    const dupRefundIds = await bookingsColl.aggregate([
      { $match: { "payment.refundId": { $exists: true, $ne: "" } } },
      { $group: { _id: "$payment.refundId", count: { $sum: 1 }, bookings: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();
    console.log("dupRefundIds:", dupRefundIds.length);

    console.log("\n=== 8. DUPLICATE REFERENCES ===");
    const dupRefs = await bookingsColl.aggregate([
      { $match: { "payment.refundReferenceKey": { $exists: true, $ne: "" } } },
      { $group: { _id: "$payment.refundReferenceKey", count: { $sum: 1 }, bookings: { $push: "$_id" } } },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();
    console.log("dupRefs (refund):", dupRefs.length);

    console.log("\n=== 9. DUPLICATE LEDGER KEYS ===");
    const dupLedgerKeys = await ledgerColl.aggregate([
      { $match: { idempotencyKey: { $exists: true, $ne: "" } } },
      { $group: { _id: "$idempotencyKey", count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();
    console.log("dupLedgerKeys:", dupLedgerKeys.length);

    console.log("\n=== 10. MISSING REFUND LEDGER ENTRIES ===");
    const processedDocs = await bookingsColl.find({
      "payment.refundStatus": "processed",
      "payment.testMode": { $ne: true }
    }).project({ _id: 1, payment: 1 }).toArray();

    const expectedKeys = processedDocs.map(b => `refund-approve:${b._id}`).concat(processedDocs.map(b => `refund-settled:${b._id}`));
    const loggedEntries = await ledgerColl.find({ idempotencyKey: { $in: expectedKeys } }).project({ booking: 1 }).toArray();
    const loggedBookings = new Set(loggedEntries.map(l => String(l.booking)));
    const missingRefundLedger = processedDocs.filter(b => !loggedBookings.has(String(b._id)));
    console.log("missingRefundLedger count:", missingRefundLedger.length);

    console.log("\n=== 11. PAYOUT / REFUND CONTRADICTIONS ===");
    const contradictions = await bookingsColl.find({
      "payout.status": "settled",
      "payment.refundStatus": "processed",
      $expr: {
        $gt: [
          { $add: [{ $ifNull: ["$payment.refundAmount", 0] }, { $ifNull: ["$payout.amount", 0] }] },
          { $ifNull: ["$payment.paidAmount", { $ifNull: ["$amount", 0] }] }
        ]
      }
    }).toArray();
    console.log("contradictions count (payout + refund > captured without clawback):", contradictions.length);

    console.log("\n=== 12. TEST-MODE CONTAMINATION ===");
    const testContamination = await ledgerColl.find({
      $or: [
        { type: "refund.approved", amount: { $gt: 0 } },
        { type: "refund.settled", amount: { $gt: 0 } }
      ],
      booking: {
        $in: (await bookingsColl.find({ "payment.testMode": true }).project({ _id: 1 }).toArray()).map(b => b._id)
      }
    }).toArray();
    console.log("testContamination count:", testContamination.length);

    console.log("\n=== 13. NEGATIVE REMAINING REFUNDABLE AMOUNT ===");
    const negRemaining = await bookingsColl.find({
      $expr: {
        $lt: [
          { $subtract: [{ $ifNull: ["$payment.paidAmount", { $ifNull: ["$amount", 0] }] }, { $ifNull: ["$payment.refundAmount", 0] }] },
          0
        ]
      }
    }).toArray();
    console.log("negRemaining count:", negRemaining.length);

    console.log("\n=== 14. MALFORMED HISTORICAL RECORDS ===");
    const malformed = await bookingsColl.find({
      "payment.status": "paid",
      $or: [
        { "payment.paidAmount": { $type: "string" } },
        { "payment.refundAmount": { $type: "string" } },
        { "payment.paidAmount": { $lt: 0 } },
        { "payment.refundAmount": { $lt: 0 } }
      ]
    }).toArray();
    console.log("malformed count:", malformed.length);

    console.log("\n=== 15. INDEX INSPECTION ===");
    const bookingIndexes = await bookingsColl.indexes();
    console.log("Bookings collection indexes:");
    for (const idx of bookingIndexes) {
      console.log(` - ${idx.name}: ${JSON.stringify(idx.key)} unique=${!!idx.unique} sparse=${!!idx.sparse}`);
    }
    const ledgerIndexes = await ledgerColl.indexes();
    console.log("Ledger collection indexes:");
    for (const idx of ledgerIndexes) {
      console.log(` - ${idx.name}: ${JSON.stringify(idx.key)} unique=${!!idx.unique}`);
    }

  } finally {
    await mongoose.disconnect();
  }
}

runReadOnlyInspection().catch(console.error);
