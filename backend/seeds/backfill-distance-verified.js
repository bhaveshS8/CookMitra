// One-time safe backfill: set distanceVerified=false on event bookings that
// predate the provisional-travel fix (the field does not exist on them).
// NON-DESTRUCTIVE: only touches documents where the field is missing; never
// modifies verified bookings, pricing snapshots, statuses, customers, or
// cook assignments. Safe to re-run (idempotent: second run finds 0 missing).
//
// DEPLOYMENT SAFETY: the target database name must be passed explicitly and
// must match the connected database, otherwise the script aborts WITHOUT
// touching anything. This prevents accidentally running it against the wrong
// environment (e.g. production vs staging).
//
// Run (after verifying the target with `node -e` or Atlas UI):
//   node seeds/backfill-distance-verified.js <expectedDbName>
// Example:
//   node seeds/backfill-distance-verified.js festivecook
//
// The script reports examined/modified counts only — no personal data.
// NEVER run this from automated tests: tests must use the isolated
// cookmitra_eventtest database and their own updateMany calls instead.
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const EventBooking = require("../models/EventBooking");

dotenv.config();

const run = async () => {
  try {
    const expectedDb = process.argv[2];
    if (!expectedDb || String(expectedDb).startsWith("--")) {
      console.error("Refusing to run without an explicit target: node seeds/backfill-distance-verified.js <expectedDbName>");
      process.exit(1);
    }
    const uri = (process.env.MONGODB_URI || "").trim();
    if (!uri) {
      console.error("MONGODB_URI is not set — aborting (no database touched).");
      process.exit(1);
    }
    await mongoose.connect(uri);
    const actualDb = mongoose.connection.name;
    if (actualDb !== expectedDb) {
      console.error(`Target mismatch: connected to "${actualDb}" but expected "${expectedDb}" — aborting (no database touched).`);
      await mongoose.disconnect();
      process.exit(1);
    }
    console.log(`MongoDB connected (database "${actualDb}") for distanceVerified backfill`);

    const examined = await EventBooking.countDocuments({});
    const missing = await EventBooking.countDocuments({ distanceVerified: { $exists: false } });
    console.log(`Examined ${examined} booking(s); missing distanceVerified: ${missing}`);
    if (missing === 0) {
      console.log("Nothing to backfill — all bookings already carry the flag.");
    } else {
      const res = await EventBooking.updateMany(
        { distanceVerified: { $exists: false } },
        { $set: { distanceVerified: false } }
      );
      const modified = res.modifiedCount ?? res.nModified ?? 0;
      console.log(`Backfilled ${modified} booking(s) with distanceVerified=false (provisional travel).`);
      if (modified !== missing) {
        console.error(`[backfill] WARNING: matched ${missing} but modified ${modified} — rerun to converge.`);
        await mongoose.disconnect();
        process.exit(1);
      }
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("[backfill] FAILED:", error.message || error);
    try {
      await mongoose.disconnect();
    } catch {
      // ignore
    }
    process.exit(1);
  }
};

run();
