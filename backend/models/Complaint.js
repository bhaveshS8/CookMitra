const mongoose = require("mongoose");

// A cook's complaint about a customer (filed from a booking, or standalone).
// Admins triage these: open → in_review → resolved (or rejected when invalid).
const complaintSchema = new mongoose.Schema(
  {
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
        "other",
      ],
      default: "other",
    },
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
complaintSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Complaint", complaintSchema);
