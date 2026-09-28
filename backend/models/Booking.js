const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    cook: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    serviceType: {
      type: String,
      enum: ["cook_for_me", "cook_with_me", "teach_me", "preparation_help"],
      required: true,
    },
    selectedItems: [
      {
        type: String,
      },
    ],
    date: {
      type: Date,
      required: [true, "Booking date is required"],
    },
    startTime: {
      type: String,
      required: [true, "Start time is required"],
    },
    endTime: {
      type: String,
      required: [true, "End time is required"],
    },
    address: {
      type: String,
      required: [true, "Address is required"],
    },
    addressDetails: {
      flatNo: { type: String, default: "" },
      society: { type: String, default: "" },
      landmark: { type: String, default: "" },
      city: { type: String, default: "" },
    },
    location: {
      lat: { type: Number, min: -90, max: 90 },
      lng: { type: Number, min: -180, max: 180 },
    },
    // Arrival: set when the cook marks themselves arrived at the venue
    // (manual tap). Drives the "cook has arrived" user notification.
    cookArrived: { type: Boolean, default: false },
    cookArrivedAt: { type: Date },
    // Service-start OTP: a 4-digit code generated per order. Shown on the
    // customer's booking details; the cook must enter it on arrival, which
    // starts the service clock (serviceStartedAt). Never sent to the cook
    // before verification — always strip from cook-facing serializers.
  serviceOtp: { type: String },
  serviceOtpGeneratedAt: { type: Date },
  // Brute-force guard for the 4-digit OTP: wrong attempts are counted and
  // the code locks for 15 minutes after 10 failures (reset on success).
  serviceOtpAttempts: { type: Number, default: 0, min: 0 },
  serviceOtpLockedUntil: { type: Date },
  serviceStartedAt: { type: Date },
  serviceEndsAt: { type: Date },
    // Cooking-hours completion: set once the session end time passes while
    // the booking is active. Drives the "cooking hours complete" alarm.
    hoursCompleted: { type: Boolean, default: false },
    hoursCompletedAt: { type: Date },
    guests: {
      type: Number,
      min: [1, "At least 1 person"],
      max: [500, "Too many guests"],
    },
    durationHours: {
      type: Number,
      min: [1, "Minimum 1 hour"],
      max: [4, "Maximum 4 hours"],
    },
    notes: {
      type: String,
      default: "",
    },
    // Final payable (post-discount). Everything downstream — payment
    // verification, gateway orders, refunds — keys off this number.
    amount: {
      type: Number,
      default: 0,
    },
    // Launch price breakdown snapshot (recomputed server-side at creation).
    slabPrice: { type: Number, default: 0 },
    couponCode: { type: String, default: "", trim: true, uppercase: true },
    discount: { type: Number, default: 0 },
    // Platform 25% of the final amount; the cook earns the rest (75%).
    commission: { type: Number, default: 0 },
    cookPayout: { type: Number, default: 0 },
    // Prepaid fee via Razorpay — collected BEFORE booking is created.
    payment: {
      razorpayOrderId: { type: String, default: "" },
      razorpayPaymentId: { type: String, default: "" },
      razorpaySignature: { type: String, default: "" },
      status: {
        type: String,
        enum: ["pending", "paid", "failed"],
        default: "pending",
      },
      paidAmount: { type: Number, default: 0 },
      paidAt: { type: Date },
      // Refund tracking for cancelled paid bookings. `refundStatus`:
      // "none" (default) → "pending" (sent to gateway) → "processed", or
      // "failed" (gateway rejected — contact support), or "manual" (test
      // payment / gateway unconfigured — settled outside Razorpay).
      refundId: { type: String, default: "" },
      refundStatus: {
        type: String,
        enum: ["none", "pending", "processed", "failed", "manual"],
        default: "none",
      },
      refundAmount: { type: Number, default: 0 },
      refundedAt: { type: Date },
      // True for dev-gated test checkouts (no real money). Lets test
      // payments be told apart from real gateway payments later.
      testMode: { type: Boolean, default: false },
      // True when paid via webhook reconciliation (no checkout signature
      // exists). A real boolean beats a sentinel signature string, which a
      // future `if (payment.razorpaySignature)` check would misread as proof
      // of a verified checkout triple.
      webhookReconciled: { type: Boolean, default: false },
    },
    // 5-minute confirmation windows:
    // - requestExpiresAt: the cook must accept within 5 minutes of the
    //   request, otherwise it auto-expires and the customer is sent back to
    //   find another cook.
    // - paymentExpiresAt: once accepted, the customer must pay within 5
    //   minutes, otherwise the booking auto-cancels and frees the slot.
    requestExpiresAt: { type: Date },
    paymentExpiresAt: { type: Date },
    status: {
      type: String,
      enum: [
        "requested",
        "accepted",
        "rejected",
        "confirmed",
        "in_progress",
        "completed",
        "cancelled",
        "expired",
      ],
      default: "requested",
    },
    statusHistory: [
      {
        status: String,
        timestamp: { type: Date, default: Date.now },
        note: String,
      },
    ],
  },
  { timestamps: true }
);

bookingSchema.index({ customer: 1, status: 1 });
bookingSchema.index({ cook: 1, status: 1 });
bookingSchema.index({ cook: 1, date: 1, startTime: 1, endTime: 1 });
// Hot read paths: "today's bookings" scans and status-sorted dashboards.
bookingSchema.index({ date: 1, status: 1 });
bookingSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Booking", bookingSchema);
