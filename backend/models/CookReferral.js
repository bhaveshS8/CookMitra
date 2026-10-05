// Cook-to-cook referral (§11/§12/§13).
// ₹250 payable only after the referred cook completes 10 verified bookings.
const mongoose = require("mongoose");

const cookReferralSchema = new mongoose.Schema(
  {
    referrer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    referredCook: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    referralCode: { type: String, required: true, trim: true },
    verifiedBookings: { type: Number, default: 0, min: 0 },
    bookingTarget: { type: Number, default: 10, min: 1 },
    reward: { type: Number, default: 250, min: 0 },
    status: {
      type: String,
      enum: ["in_progress", "qualified", "approved", "paid", "rejected", "held"],
      default: "in_progress",
    },
    approvedAt: { type: Date },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    paidAt: { type: Date },
    paymentReference: { type: String, default: "", trim: true },
    rejectionReason: { type: String, default: "", trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

// One referral per referred cook — no duplicate claims, no re-claims (§15).
cookReferralSchema.index({ referredCook: 1 }, { unique: true, name: "uniq_referral_referred" });
cookReferralSchema.index({ referrer: 1, createdAt: -1 });
cookReferralSchema.index({ referralCode: 1 });
cookReferralSchema.index({ status: 1 });

module.exports = mongoose.model("CookReferral", cookReferralSchema);
