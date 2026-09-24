const mongoose = require("mongoose");

// Processed Razorpay webhook events. Two deliveries of one event carry
// identical payloads, so a stable content key de-duplicates them even when
// they race: exactly one insert wins, the loser is acknowledged as a
// duplicate without touching any booking. TTL keeps the table bounded.
const webhookEventSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true, trim: true },
    event: { type: String, default: "", trim: true },
    orderId: { type: String, default: "", trim: true },
    paymentId: { type: String, default: "", trim: true },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null },
    receivedAt: { type: Date, default: Date.now, expires: 30 * 24 * 60 * 60 },
  },
  { timestamps: false }
);

module.exports = mongoose.model("WebhookEvent", webhookEventSchema);
