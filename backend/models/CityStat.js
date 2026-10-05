const mongoose = require("mongoose");

const cityStatSchema = new mongoose.Schema(
  {
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
