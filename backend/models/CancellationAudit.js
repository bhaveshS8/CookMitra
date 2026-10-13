const mongoose = require("mongoose");

const cancellationAuditSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorRole: { type: String, default: "", trim: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true },
    refundId: { type: String, default: "", trim: true },
    event: {
      type: String,
      enum: [
        "CANCELLATION_REQUESTED",
        "CANCELLATION_APPROVED",
        "CANCELLATION_REJECTED",
        "REFUND_CALCULATED",
        "REFUND_APPROVED",
        "REFUND_HELD",
        "REFUND_PROCESSING",
        "REFUND_PROCESSED",
        "REFUND_FAILED",
        "REFUND_REJECTED",
        "NO_SHOW_MARKED",
        "COOK_CANCELLED",
        "COMPLAINT_SUBMITTED",
        "COMPLAINT_RESOLVED",
        "UNDER_REVIEW",
        "NOTE_ADDED",
      ],
      required: true,
    },
    previousStatus: { type: String, default: "", trim: true },
    newStatus: { type: String, default: "", trim: true },
    amount: { type: Number, default: 0 },
    reason: { type: String, default: "", trim: true, maxlength: 500 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

cancellationAuditSchema.index({ bookingId: 1, createdAt: -1 });
cancellationAuditSchema.index({ event: 1, createdAt: -1 });
cancellationAuditSchema.index({ createdAt: -1 });

module.exports = mongoose.model("CancellationAudit", cancellationAuditSchema);
