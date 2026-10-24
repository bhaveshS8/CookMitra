const mongoose = require("mongoose");

const cityStatSchema = new mongoose.Schema(
  {
    day: { type: String, required: true },
    city: { type: String, required: true, default: "" },
    area: { type: String, default: "" },
    state: { type: String, default: "" },
    country: { type: String, default: "" },
    visits: { type: Number, default: 0, min: 0 },
    // How many of those visits carried GPS-verified (device-fix) place
    // labels vs coarse IP estimates. Old rows predate the field and read
    // as 0 via $ifNull in the aggregation.
    gpsVisits: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

cityStatSchema.index({ day: 1, city: 1, state: 1, area: 1 }, { unique: true });

module.exports = mongoose.model("CityStat", cityStatSchema);
