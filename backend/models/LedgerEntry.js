const mongoose = require("mongoose");
const crypto = require("crypto");

const ledgerEntrySchema = new mongoose.Schema(
  {
    idempotencyKey: {
      type: String,
      trim: true,
      sparse: true,
      unique: true,
      index: true,
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: [
        "payment.confirmed",
        "payment.webhook_confirmed",
        "refund.requested",
        "refund.approved",
        "refund.rejected",
        "refund.settled",
        "payout.settled",
        "payout.rejected",
      ],
      index: true,
    },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "INR", trim: true },
    prevState: { type: String, default: "", trim: true },
    newState: { type: String, default: "", trim: true },
    actor: { type: String, default: "system", trim: true },
    source: {
      type: String,
      enum: ["checkout", "webhook", "admin", "system"],
      default: "system",
    },
    razorpayOrderId: { type: String, default: "", trim: true },
    razorpayPaymentId: { type: String, default: "", trim: true },
    razorpayRefundId: { type: String, default: "", trim: true },
    payoutReference: { type: String, default: "", trim: true },
    relatedKey: { type: String, default: "", trim: true },
    reason: { type: String, default: "", trim: true, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

ledgerEntrySchema.index({ booking: 1, createdAt: 1 });
ledgerEntrySchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model("LedgerEntry", ledgerEntrySchema);
