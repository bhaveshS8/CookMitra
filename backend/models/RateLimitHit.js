const mongoose = require("mongoose");

// Volume note: only the security-critical, low-traffic buckets (auth, payments)

const rateLimitHitSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    totalHits: { type: Number, default: 0, min: 0 },
    resetAt: { type: Date, required: true },
  },
  { versionKey: false, timestamps: false }
);

rateLimitHitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RateLimitHit", rateLimitHitSchema);