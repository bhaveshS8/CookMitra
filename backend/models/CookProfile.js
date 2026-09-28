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
    // Renamed from "bio" in the cook profile form — new input writes here.
    // `bio` is kept for backward compat with existing profiles.
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
    // Legacy hourly rate — no longer collected from cooks (pricing uses
    // slab pricing). Kept optional with a default so old profiles keep
    // working and new profiles save without a rate.
    rate: {
      type: Number,
      default: 0,
    },
    serviceArea: {
      type: String,
      default: "",
    },
    // Cook's home / contact address (visible to admin).
    address: {
      type: String,
      default: "",
    },
    // Verification documents shared by the cook (e.g. Aadhaar, FSSAI
    // certificate). Stored as label + link; visible to admin.
    documents: [
      {
        label: { type: String, default: "", trim: true },
        url: { type: String, default: "", trim: true },
      },
    ],
    // Dedicated ID verification uploads (file URLs under /uploads).
    // Aadhaar + PAN required, profile photo optional.
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
    // Cook-level on/off switch. When "unavailable" the cook is hidden from all
    // booking until they toggle back to "available" OR the next day begins
    // (unavailableDate records the local day they set it, used for the auto
    // reset — see resolveCookAvailability in cookController).
    availabilityStatus: {
      type: String,
      enum: ["available", "unavailable"],
      default: "available",
    },
    unavailableDate: {
      type: String,
      default: "",
    },
    // Rating aggregate, maintained by createReview only (updateCookProfile
    // strips a `rating` payload so a cook can never edit their own score).
    // `sum`/`count` are the authoritative counters, bumped atomically with
    // $inc; `average` is derived from them and exists for read paths (cook
    // lists, profiles) that should not have to recompute it.
    rating: {
      average: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
      sum: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

cookProfileSchema.index({ approvalStatus: 1, serviceArea: 1 });

module.exports = mongoose.model("CookProfile", cookProfileSchema);
