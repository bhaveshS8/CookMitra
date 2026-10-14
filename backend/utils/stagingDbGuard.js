// Staging empty-DB guard: connects ONLY to STAGING_MONGODB_URI, asserts
// effectively empty, disconnects. Never called by offline tests.
const { checkStagingReadiness, uriDbHint } = require("./stagingPreflight");
const verifyStagingDbEmpty = async ({ uri, mongooseOpt } = {}) => {
  const target = String(uri || process.env.STAGING_MONGODB_URI || "").trim();
  if (!target) throw new Error("STAGING_MONGODB_URI missing — refusing.");
  const pre = checkStagingReadiness({ ...process.env, STAGING_MONGODB_URI: target });
  if (!pre.ok) throw new Error(`Staging preflight failed: ${pre.blockers[0]}`);
  const mongoose = mongooseOpt || require("mongoose");
  const conn = await mongoose.createConnection(target, { serverSelectionTimeoutMS: 10000 }).asPromise();
  try {
    const names = await conn.db.listCollections().toArray();
    const has = new Set(names.map((c) => c.name));
    const counts = {};
    for (const coll of ["bookings", "users", "payments", "ledgerentries", "notifications"]) {
      counts[coll] = has.has(coll) ? await conn.db.collection(coll).countDocuments({}, { limit: 50 }) : 0;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { empty: total === 0, counts, hint: uriDbHint(target) };
  } finally { try { await conn.close(); } catch {} }
};
module.exports = { verifyStagingDbEmpty };
