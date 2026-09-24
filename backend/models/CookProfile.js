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
    // Working hours the cook actually agreed to. Empty `weekly` = the
    // historical default (every cook bookable 08:00–20:00), so existing
    // profiles keep working until the cook publishes a real schedule.
    // day: 0 = Sunday … 6 = Saturday (JS getDay convention).
    schedule: {
      weekly: [
        {
          day: { type: Number, min: 0, max: 6 },
          startTime: { type: String, default: "" },
          endTime: { type: String, default: "" },
          enabled: { type: Boolean, default: false },
        },
      ],
      // "YYYY-MM-DD" dates the cook blocks entirely (leave/travel).
      blockedDates: { type: [String], default: [] },
      updatedAt: { type: Date },
    },
    // Where the cook's 75% should be paid. Only the last 4 digits of an
    // account are stored — the transfer itself happens in the bank/UPI app.
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
    // Append-only destination history (capped): every saved payoutDetails is
    // snapshotted here before replacement, so a destination swapped right
    // before settlement stays auditable. Settlements freeze their own copy
    // on the booking (payout.recipient) — this is the change trail.
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
    // Bookings the cook cancelled after accepting (reliability signal shown
    // on the admin dossier). Bumped atomically in cancelBooking.
    cancelledByCookCount: { type: Number, default: 0, min: 0 },
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
