const mongoose = require("mongoose");

// Event payments are kept in a separate ledger so the existing Booking ledger
// (whose `booking` reference is required) stays untouched.
const eventLedgerEntrySchema = new mongoose.Schema(
  {
    eventBooking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EventBooking",
      required: true,
      index: true,
    },
    eventBookingId: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: [
        "event_payment.confirmed",
        "event_refund.requested",
        "event_refund.rejected",
        "event_refund.failed",
        "event_refund.processed",
      ],
      required: true,
      index: true,
    },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "INR", uppercase: true, trim: true },
    paymentId: { type: String, default: "", trim: true },
    orderId: { type: String, default: "", trim: true },
    refundId: { type: String, default: "", trim: true },
    source: {
      type: String,
      enum: ["customer", "webhook", "admin", "system"],
      default: "system",
    },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: "", trim: true, maxlength: 500 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

eventLedgerEntrySchema.index({ eventBooking: 1, createdAt: -1 });
eventLedgerEntrySchema.index({ type: 1, createdAt: -1 });
eventLedgerEntrySchema.index({ paymentId: 1, type: 1 });

module.exports = mongoose.model("EventLedgerEntry", eventLedgerEntrySchema);
