const mongoose = require("mongoose");
const crypto = require("crypto");

// Immutable financial ledger: one append-only row per money decision.
// There are deliberately NO update/delete routes for this collection —
// corrections are new reversing entries, never edits. Amounts are integer
// rupees to match the domain (paise live only at the Razorpay boundary).
const ledgerEntrySchema = new mongoose.Schema(
  {
    // Stable per decision (e.g. `payout:<bookingId>`, `refund-approve:<id>`).
    // Unique + sparse: a retried decision collides here and is recorded once.
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
    // payment.confirmed | payment.webhook_confirmed | refund.approved |
    // refund.rejected | refund.settled | payout.settled | payout.rejected
    type: {
      type: String,
      required: true,
      enum: [
        "payment.confirmed",
        "payment.webhook_confirmed",
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
    // Who/what moved the money: admin user id, "customer:<id>", "system",
    // "webhook". Never a display name (names change; ids don't).
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
