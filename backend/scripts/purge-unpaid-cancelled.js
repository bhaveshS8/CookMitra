// One-time purge: unpaid cancelled bookings are neither shown nor tracked.
// Deletes Booking docs with status=cancelled + payment.status != paid,
// plus their Notification and CancellationAudit rows (no audit is kept).
// Usage: node scripts/purge-unpaid-cancelled.js [--dry-run]
try {
  require("dotenv").config();
} catch {
}
const mongoose = require("mongoose");

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGO_URI/MONGODB_URI is not set — refusing to run.");
    process.exit(2);
  }
  await mongoose.connect(uri);
  const Booking = require("../models/Booking");
  const Notification = require("../models/Notification");
  const CancellationAudit = require("../models/CancellationAudit");

  const filter = {
    status: "cancelled",
    $or: [{ "payment.status": { $ne: "paid" } }, { "payment.status": { $exists: false } }],
  };
  const victims = await Booking.find(filter).select("_id").lean();
  const ids = (victims || []).map((v) => v._id);
  console.log(`found ${ids.length} unpaid cancelled booking(s)${dryRun ? " (dry-run)" : ""}`);
  if (!ids.length || dryRun) {
    await mongoose.disconnect();
    return;
  }
  const notifRes = await Notification.deleteMany({ booking: { $in: ids } });
  console.log(`deleted ${notifRes?.deletedCount ?? 0} notification(s)`);
  let auditCount = 0;
  try {
    const auditRes = await CancellationAudit.deleteMany({ bookingId: { $in: ids } });
    auditCount = auditRes?.deletedCount ?? 0;
  } catch (e) {
    console.log(`audit purge skipped: ${e.message}`);
  }
  console.log(`deleted ${auditCount} cancellation-audit row(s)`);
  const bookRes = await Booking.deleteMany({ _id: { $in: ids } });
  console.log(`deleted ${bookRes?.deletedCount ?? 0} booking(s)`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
