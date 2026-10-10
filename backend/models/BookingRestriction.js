const mongoose = require("mongoose");

// Server-authoritative per-customer booking restriction.
//
// A customer who explicitly declines the woman-presence confirmation gets a
// one-hour booking lockout. One document per customer (unique index); the
// lockout is active while serverNow < blockedUntil. Repeated declines while
// active preserve the existing expiry (never extend); a decline after expiry
// starts a fresh one-hour window.
//
// Identity is ALWAYS the authenticated account id — never a client-supplied
// value — so the restriction survives refresh, logout/login, new browsers
// and new devices. Existing bookings, payments, refunds and payouts are
// never touched by this collection.
const bookingRestrictionSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    // Authoritative window, UTC, backend clock is the source of truth.
    declinedAt: { type: Date, required: true },
    blockedUntil: { type: Date, required: true },
    reason: {
      type: String,
      default: "WOMAN_PRESENCE_DECLINED",
      trim: true,
      maxlength: 60,
    },
  },
  { timestamps: true }
);

bookingRestrictionSchema.index({ blockedUntil: 1 });

module.exports = mongoose.model("BookingRestriction", bookingRestrictionSchema);
