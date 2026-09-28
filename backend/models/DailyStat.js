const mongoose = require("mongoose");

// Aggregated site-visit counter — exactly one document per calendar day
// (IST). Written by POST /api/stats/public/visit (one ping per browser
// session), read by the admin Visits tab. Aggregated instead of per-hit so
// the collection stays at ~365 docs/year no matter the traffic.
const dailyStatSchema = new mongoose.Schema(
  {
    // Calendar day in Asia/Kolkata as YYYY-MM-DD.
    day: {
      type: String,
      required: true,
      unique: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, "Day must be YYYY-MM-DD"],
    },
    // Sessions that pinged the endpoint that day.
    visits: { type: Number, default: 0, min: 0 },
    // Distinct anonymous visitor ids seen that day.
    uniques: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DailyStat", dailyStatSchema);
