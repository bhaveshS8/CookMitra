const mongoose = require("mongoose");

// Per-city visit counts — one document per (day, city). Powers the "top
// cities" list on the admin Visits tab. City-level only: raw IPs are never
// stored anywhere, so visitor location stays approximate by design.
// Tiny by design: a few dozen distinct cities, each incremented atomically.
const cityStatSchema = new mongoose.Schema(
  {
    // Calendar day in Asia/Kolkata as YYYY-MM-DD.
    day: { type: String, required: true },
    city: { type: String, required: true, default: "" },
    state: { type: String, default: "" },
    country: { type: String, default: "" },
    visits: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

cityStatSchema.index({ day: 1, city: 1, state: 1 }, { unique: true });

module.exports = mongoose.model("CityStat", cityStatSchema);
