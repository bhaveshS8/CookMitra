const mongoose = require("mongoose");

const cookPayoutSchema = new mongoose.Schema(
  {
    cook: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    weekStart: { type: Date, required: true },
    weekEnd: { type: Date, required: true },
    payoutRef: { type: String, required: true, trim: true },
    bookings: [{ type: mongoose.Schema.Types.ObjectId, ref: "Booking" }],
    bookingCount: { type: Number, default: 0, min: 0 },
    grossCustomerValue: { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
    cookEarnings: { type: Number, default: 0 },
    bonuses: { type: Number, default: 0 },
    referralEarnings: { type: Number, default: 0 },
    totalPayable: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "under_verification", "approved", "paid", "held", "rejected"],
      default: "pending",
    },
    paymentDate: { type: Date },
    paymentReference: { type: String, default: "", trim: true },
    holdReason: { type: String, default: "", trim: true, maxlength: 300 },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date },
    paidAt: { type: Date },
    idempotencyKey: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

cookPayoutSchema.index({ payoutRef: 1 }, { unique: true, name: "uniq_cookpayout_ref" });
cookPayoutSchema.index({ cook: 1, weekStart: 1 }, { name: "idx_cookpayout_cook_week" });
cookPayoutSchema.index({ cook: 1, status: 1 });
cookPayoutSchema.index({ status: 1, createdAt: -1 });
cookPayoutSchema.index({ createdAt: -1 });
cookPayoutSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $exists: true, $gt: "" } },
    name: "uniq_cookpayout_idem",
  }
);

module.exports = mongoose.model("CookPayout", cookPayoutSchema);
