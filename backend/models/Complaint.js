const mongoose = require("mongoose");

const complaintSchema = new mongoose.Schema(
  {
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
        "cook_did_not_arrive",
        "major_service_deviation",
        "service_quality_issue",
        "unprofessional_behavior",
      ],
      default: "other",
    },
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
