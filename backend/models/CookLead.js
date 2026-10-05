const mongoose = require("mongoose");

const cookLeadSchema = new mongoose.Schema(
  {
    cook: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    customerName: { type: String, required: true, trim: true, maxlength: 80 },
    mobileNumber: { type: String, required: true, trim: true, maxlength: 20 },
    normalizedPhone: { type: String, required: true, trim: true },
    location: { type: String, required: true, trim: true, maxlength: 120 },
    requiredService: {
      type: String,
      enum: ["cook_for_me", "cook_with_me", "teach_me", "preparation_help", "other"],
      default: "other",
    },
    preferredDate: { type: Date },
    preferredDuration: { type: Number, min: 1, max: 4 },
    notes: { type: String, default: "", trim: true, maxlength: 500 },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["submitted", "under_verification", "verified", "rejected", "converted", "duplicate", "invalid"],
      default: "submitted",
    },
    verificationStatus: {
      type: String,
      enum: ["pending", "under_verification", "verified", "rejected"],
      default: "pending",
    },
    rejectionReason: { type: String, default: "", trim: true, maxlength: 300 },
    verifiedAt: { type: Date },
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    idempotencyKey: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

cookLeadSchema.index({ cook: 1, createdAt: -1 });
cookLeadSchema.index({ normalizedPhone: 1, createdAt: -1 });
cookLeadSchema.index({ phone: 1 }, { sparse: true });
cookLeadSchema.index({ status: 1 });
cookLeadSchema.index({ verificationStatus: 1 });
cookLeadSchema.index(
  { cook: 1, normalizedPhone: 1 },
  { unique: true, name: "uniq_cook_lead_phone" }
);
cookLeadSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $exists: true, $gt: "" } },
    name: "uniq_cooklead_idem",
  }
);

module.exports = mongoose.model("CookLead", cookLeadSchema);
