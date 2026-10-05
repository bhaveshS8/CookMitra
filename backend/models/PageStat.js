const mongoose = require("mongoose");

const pageStatSchema = new mongoose.Schema(
  {
    day: { type: String, required: true },
    path: { type: String, required: true },
    visits: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

pageStatSchema.index({ day: 1, path: 1 }, { unique: true });

module.exports = mongoose.model("PageStat", pageStatSchema);
