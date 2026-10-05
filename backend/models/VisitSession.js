const mongoose = require("mongoose");

const visitSessionSchema = new mongoose.Schema(
  {
    day: { type: String, required: true },
    vid: { type: String, required: true },
    sid: { type: String, required: true },
  },
  { timestamps: true }
);

visitSessionSchema.index({ day: 1, vid: 1, sid: 1 }, { unique: true });
visitSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

module.exports = mongoose.model("VisitSession", visitSessionSchema);
