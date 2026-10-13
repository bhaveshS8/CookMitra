const mongoose = require("mongoose");

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: [true, "Coupon code is required"],
      unique: true,
      uppercase: true,
      trim: true,
      minlength: [3, "Code must be at least 3 characters"],
      maxlength: [24, "Code must be at most 24 characters"],
      match: [/^[A-Z0-9]+$/, "Code may only contain letters and numbers"],
    },
    description: {
      type: String,
      trim: true,
      default: "",
    },
    discountType: {
      type: String,
      enum: ["flat", "percent"],
      default: "percent",
    },
    percent: {
      type: Number,
      min: [1, "Percent must be at least 1"],
      max: [100, "Percent cannot exceed 100"],
      default: null,
    },
    flatAmount: {
      type: Number,
      min: [1, "Flat amount must be at least ₹1"],
      default: null,
    },
    maxDiscount: {
      type: Number,
      min: [1, "Max discount must be at least ₹1"],
      default: null,
    },
    minOrder: {
      type: Number,
      min: [0, "Minimum order cannot be negative"],
      default: 0,
    },
    usageLimit: {
      type: Number,
      min: [1, "Usage limit must be at least 1"],
      default: null,
    },
    usedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    usedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    perUserLimit: {
      type: Number,
      min: [1, "Per-user limit must be at least 1"],
      default: 1,
    },
    firstBookingOnly: {
      type: Boolean,
      default: false,
    },
    applicableServices: {
      type: [String],
      default: [],
    },
    validFrom: {
      type: Date,
      default: null,
    },
    validTo: {
      type: Date,
      default: null,
    },
    active: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

couponSchema.index({ active: 1, validFrom: 1, validTo: 1 });

module.exports = mongoose.model("Coupon", couponSchema);
