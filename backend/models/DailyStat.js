const mongoose = require("mongoose");

const dailyStatSchema = new mongoose.Schema(
  {
    day: {
      type: String,
      required: true,
      unique: true,
      match: [/^\d{4}-\d{2}-\d{2}$/, "Day must be YYYY-MM-DD"],
    },
    visits: { type: Number, default: 0, min: 0 },
    uniques: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DailyStat", dailyStatSchema);
