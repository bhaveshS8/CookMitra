const mongoose = require("mongoose");

// A complaint about the other side of a booking. Cooks complain about
// customers; customers complain about cooks (always tied to one of their own
// bookings so the counterparty is derived, never user-typed). Admins triage
// these: open → in_review → resolved (or rejected when invalid).
const complaintSchema = new mongoose.Schema(
  {
    // Who wrote it — decides who gets status updates and whose "my
    // complaints" list it appears in.
    filedBy: {
      type: String,
      enum: ["cook", "customer"],
      default: "cook",
    },
    cook: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // The booking this complaint arose from (optional — a cook may also
    // report an issue without a specific booking).
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
    category: {
      type: String,
      enum: [
        "behaviour",
        "payment",
        "address",
        "no_show",
        "safety",
        "quality",
        "hygiene",
        "other",
        // Customer service-complaint reasons (§19, additive — old values kept).
        "cook_did_not_arrive",
        "major_service_deviation",
        "service_quality_issue",
        "unprofessional_behavior",
      ],
      default: "other",
    },
    // True when a post-completion complaint arrives more than 24h after the
    // service ended (§19: preferably reported within 24h). Late reports are
    // still accepted but flagged for the reviewer — never auto-refunded.
    reportedLate: { type: Boolean, default: false },
    message: {
      type: String,
      required: [true, "Please describe the issue"],
      trim: true,
      minlength: [10, "Please give a little more detail (min 10 characters)"],
      maxlength: [2000, "Please keep it under 2000 characters"],
    },
    status: {
      type: String,
      enum: ["open", "in_review", "resolved", "rejected"],
      default: "open",
    },
    // Internal resolution note left by the handling admin.
    adminNote: {
      type: String,
      default: "",
      trim: true,
      maxlength: [2000, "Please keep it under 2000 characters"],
    },
  },
  { timestamps: true }
);

complaintSchema.index({ cook: 1, status: 1 });
complaintSchema.index({ customer: 1, filedBy: 1, status: 1 });
complaintSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Complaint", complaintSchema);
