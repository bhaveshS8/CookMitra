const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      unique: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    cook: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    rating: {
      type: Number,
      required: [true, "Rating is required"],
      min: 1,
      max: 5,
    },
    comment: {
      type: String,
      default: "",
      trim: true,
      maxlength: [2000, "Review must be at most 2000 characters"],
    },
  },
  { timestamps: true }
);

reviewSchema.index({ cook: 1 });
// "My reviews" filters by customer — needs its own index.
reviewSchema.index({ customer: 1 });

module.exports = mongoose.model("Review", reviewSchema);
