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
        // Legacy: nothing emits this any more (self-serve reschedule was
        // removed); kept so historical notifications stay valid.
        "booking_rescheduled",
        "service_started",
        "cook_arrived",
        "cooking_hours_completed",
        "review_received",
        "profile_approved",
        "profile_rejected",
        "payout_settled",
        "refund_processed",
        "general",
      ],
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    // Booking this update is about (when there is one). The app turns it into
    // a tap-through link — a notification a user cannot act on is a dead end
    // ("pay within 5 minutes" with nowhere to go).
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      default: null,
    },
    // Optional explicit destination for non-booking notifications (e.g. a
    // cook's profile-review outcome). Always an in-app path, never absolute
    // (an absolute URL here would navigate the tapper off-site).
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
