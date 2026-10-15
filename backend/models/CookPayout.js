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
    // Weekly settlement evidence (admin workflow): the transfer happens
    // out-of-band and the admin records the method + external reference
    // together with a mandatory receipt/proof photo. The earning week
    // (weekStart/weekEnd) is immutable — settling later never moves a
    // payment to another week.
    paymentMethod: {
      type: String,
      enum: ["", "upi", "bank_transfer", "other"],
      default: "",
    },
    receiptUrl: { type: String, default: "", trim: true },
    settledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    settledAmount: { type: Number, default: 0 },
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
cookPayoutSchema.index({ status: 1, weekStart: -1 }, { name: "idx_cookpayout_status_week" });
cookPayoutSchema.index({ weekStart: -1 }, { name: "idx_cookpayout_week" });
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
// A payment reference must settle at most one cycle: the application-level
// duplicate check races under concurrent pay requests, so the database is
// the final arbiter (payCookPayout maps 11000 → 409).
cookPayoutSchema.index(
  { paymentReference: 1 },
  {
    unique: true,
    partialFilterExpression: { paymentReference: { $exists: true, $gt: "" } },
    name: "uniq_cookpayout_payref",
  }
);

module.exports = mongoose.model("CookPayout", cookPayoutSchema);
