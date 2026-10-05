const mongoose = require("mongoose");

const cookIncentiveSchema = new mongoose.Schema(
  {
    cook: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    code: {
      type: String,
      enum: ["JOINING", "PERFORMANCE", "ACHIEVEMENT", "CHAMPION"],
      required: true,
    },
    target: { type: Number, required: true, min: 1 },
    timeLimitDays: { type: Number, required: true, min: 1 },
    reward: { type: Number, required: true, min: 0 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    verifiedLeadCount: { type: Number, default: 0, min: 0 },
    eligible: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["in_progress", "qualified", "approved", "rejected", "held", "paid", "expired"],
      default: "in_progress",
    },
    approvedAt: { type: Date },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    paidAt: { type: Date },
    paymentReference: { type: String, default: "", trim: true },
    rejectionReason: { type: String, default: "", trim: true, maxlength: 300 },
    cumulative: { type: Boolean, default: false },
    idempotencyKey: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

cookIncentiveSchema.index({ cook: 1, code: 1 });
cookIncentiveSchema.index({ cook: 1, status: 1 });
cookIncentiveSchema.index({ status: 1, createdAt: -1 });
cookIncentiveSchema.index({ createdAt: -1 });
cookIncentiveSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $exists: true, $gt: "" } },
    name: "uniq_cookincentive_idem",
  }
);

module.exports = mongoose.model("CookIncentive", cookIncentiveSchema);
