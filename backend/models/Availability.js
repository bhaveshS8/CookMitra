const mongoose = require("mongoose");

const availabilitySchema = new mongoose.Schema(
  {
    cook: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    startTime: {
      type: String,
      required: true,
    },
    endTime: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["available", "booked", "blocked"],
      default: "available",
    },
  },
  { timestamps: true }
);

availabilitySchema.index({ cook: 1, date: 1, startTime: 1 }, { unique: true });
availabilitySchema.index({ cook: 1, status: 1, date: 1 });

module.exports = mongoose.model("Availability", availabilitySchema);
