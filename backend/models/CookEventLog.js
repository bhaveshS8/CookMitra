const mongoose = require("mongoose");

const cookEventLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorRole: { type: String, default: "", trim: true },
    event: {
      type: String,
      enum: [
        "lead_created",
        "lead_verified",
        "lead_rejected",
        "incentive_qualified",
        "incentive_approved",
        "incentive_rejected",
        "referral_created",
        "referral_qualified",
        "referral_approved",
        "payout_approved",
        "payout_paid",
        "payout_held",
      ],
      required: true,
    },
    cook: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },
    refModel: { type: String, default: "", trim: true },
    detail: { type: String, default: "", trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

cookEventLogSchema.index({ cook: 1, createdAt: -1 });
cookEventLogSchema.index({ event: 1, createdAt: -1 });
cookEventLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("CookEventLog", cookEventLogSchema);
