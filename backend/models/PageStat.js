const mongoose = require("mongoose");

// Per-page visit counts — one document per (day, path). Powers the "top
// pages" list on the admin Visits tab. Tiny by design: only a few dozen
// distinct paths exist, each incremented atomically.
const pageStatSchema = new mongoose.Schema(
  {
    // Calendar day in Asia/Kolkata as YYYY-MM-DD.
    day: { type: String, required: true },
    // App path, e.g. "/" or "/cook-on-demand" (no query/hash).
    path: { type: String, required: true },
    visits: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

pageStatSchema.index({ day: 1, path: 1 }, { unique: true });

module.exports = mongoose.model("PageStat", pageStatSchema);
