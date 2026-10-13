const mongoose = require("mongoose");

const dailyVisitorSchema = new mongoose.Schema(
  {
    day: { type: String, required: true },
    vid: { type: String, required: true },
  },
  { timestamps: true }
);

dailyVisitorSchema.index({ day: 1, vid: 1 }, { unique: true });

dailyVisitorSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 24 * 60 * 60 });

module.exports = mongoose.model("DailyVisitor", dailyVisitorSchema);
