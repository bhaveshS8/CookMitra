const mongoose = require("mongoose");

const cookProfileSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    bio: {
      type: String,
      default: "",
    },
    skills: {
      type: String,
      default: "",
    },
    experienceYears: {
      type: Number,
      default: 0,
    },
    specialties: [
      {
        type: String,
        trim: true,
      },
    ],
    serviceTypes: [
      {
        type: String,
        enum: ["cook_for_me", "cook_with_me", "teach_me", "preparation_help"],
      },
    ],
    rate: {
      type: Number,
      default: 0,
    },
    serviceArea: {
      type: String,
      default: "",
    },
    address: {
      type: String,
      default: "",
    },
    documents: [
      {
        label: { type: String, default: "", trim: true },
        url: { type: String, default: "", trim: true },
      },
    ],
    aadharCardUrl: {
      type: String,
      default: "",
      trim: true,
    },
    panCardUrl: {
      type: String,
      default: "",
      trim: true,
    },
    photoUrl: {
      type: String,
      default: "",
      trim: true,
    },
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    availabilityStatus: {
      type: String,
      enum: ["available", "unavailable"],
      default: "available",
    },
    unavailableDate: {
      type: String,
      default: "",
    },
    schedule: {
      weekly: [
        {
          day: { type: Number, min: 0, max: 6 },
          startTime: { type: String, default: "" },
          endTime: { type: String, default: "" },
          enabled: { type: Boolean, default: false },
        },
      ],
      blockedDates: { type: [String], default: [] },
      updatedAt: { type: Date },
    },
    payoutDetails: {
      method: {
        type: String,
        enum: ["upi", "bank", ""],
        default: "",
      },
      upiId: { type: String, default: "", trim: true },
      holderName: { type: String, default: "", trim: true },
      bankName: { type: String, default: "", trim: true },
      accountLast4: { type: String, default: "", trim: true },
      ifsc: { type: String, default: "", trim: true },
      note: { type: String, default: "", trim: true },
      updatedAt: { type: Date },
    },
    payoutDetailsHistory: {
      type: [
        {
          method: { type: String, default: "", trim: true },
          upiId: { type: String, default: "", trim: true },
          holderName: { type: String, default: "", trim: true },
          bankName: { type: String, default: "", trim: true },
          accountLast4: { type: String, default: "", trim: true },
          ifsc: { type: String, default: "", trim: true },
          changedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    cancelledByCookCount: { type: Number, default: 0, min: 0 },
    referralCode: { type: String, default: "", trim: true, uppercase: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    incentiveEnrolledAt: { type: Date },
    rating: {
      average: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
      sum: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

cookProfileSchema.index({ approvalStatus: 1, serviceArea: 1 });
cookProfileSchema.index(
  { referralCode: 1 },
  {
    unique: true,
    partialFilterExpression: { referralCode: { $exists: true, $gt: "" } },
    name: "uniq_cookprofile_referralCode",
  }
);
cookProfileSchema.index({ approvalStatus: 1, createdAt: -1 });

module.exports = mongoose.model("CookProfile", cookProfileSchema);
