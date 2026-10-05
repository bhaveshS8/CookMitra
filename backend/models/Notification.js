const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: [
        "booking_request",
        "booking_accepted",
        "booking_rejected",
        "booking_confirmed",
        "booking_completed",
        "booking_expired",
        "booking_cancelled",
        "booking_rescheduled",
        "service_started",
        "cook_arrived",
        "cooking_hours_completed",
        "booking_unattended",
        "review_received",
        "profile_approved",
        "profile_rejected",
        "payout_settled",
        "payout_failed",
        "payout_approved",
        "payout_held",
        "payout_paid",
        "lead_submitted",
        "lead_verified",
        "lead_rejected",
        "incentive_qualified",
        "incentive_approved",
        "incentive_rejected",
        "referral_registered",
        "referral_milestone",
        "referral_approved",
        "refund_pending",
        "refund_processed",
        "refund_approved",
        "refund_processing",
        "refund_failed",
        "cancellation_requested",
        "cancellation_confirmed",
        "no_show_marked",
        "cook_cancelled",
        "complaint_received",
        "complaint_resolved",
        "general",
      ],
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
    link: {
      type: String,
      default: "",
      trim: true,
      validate: {
        validator: (v) =>
          !v || (/^\/(?!\/)/.test(v) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)),
        message: "link must be a relative in-app path",
      },
    },
    read: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, read: 1 });

module.exports = mongoose.model("Notification", notificationSchema);
