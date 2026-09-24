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
    // Idempotency key for booking creation (client-generated UUID per
    // attempt). Unique + sparse so retries with the same key return the
    // existing hold instead of double-booking; bookings without a key are
    // unaffected.
    clientKey: { type: String, default: "", trim: true },
    // Legacy: self-serve reschedule was removed, so nothing increments this
    // any more. Kept so historical bookings (and their audit trail) stay
    // readable; new bookings always carry 0.
    rescheduleCount: { type: Number, default: 0, min: 0 },
    // Coupon release idempotency: set once the held coupon is freed, so
    // concurrent cancel/expire paths cannot double-decrement usedCount.
    couponReleased: { type: Boolean, default: false },
    // Who ended the booking ("customer" | "cook" | "admin" | ""), recorded so
    // cook-side reliability can be tracked instead of only the status flip.
    cancelledBy: { type: String, default: "" },
    // Payout ledger for the cook's 75%: "pending" until an admin settles it
    // (reference = UPI/bank transfer id). Without this the cook's money had
    // nowhere to live — commission was recorded but never disbursed.
    payout: {
      status: {
        type: String,
        enum: ["pending", "settled", "not_applicable"],
        default: "pending",
      },
      settledAt: { type: Date },
      reference: { type: String, default: "", trim: true },
      amount: { type: Number, default: 0 },
      // Frozen recipient snapshot taken at settlement: later edits to the
      // cook's payout details can never rewrite who a settled payout
      // claims to have paid. Read history/statements from here first.
      recipient: {
        method: { type: String, default: "", trim: true },
        upiId: { type: String, default: "", trim: true },
        holderName: { type: String, default: "", trim: true },
        bankName: { type: String, default: "", trim: true },
        accountLast4: { type: String, default: "", trim: true },
        ifsc: { type: String, default: "", trim: true },
      },
      // Admin who recorded the settlement — accountability for offline money.
      settledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    // Prepaid fee via Razorpay — collected BEFORE booking is created.
    payment: {
      razorpayOrderId: { type: String, default: "" },
      // Every gateway order ever minted for this booking (createOrder may be
      // retried). The webhook matches against both the latest id and this
      // history so an overwritten order can never orphan captured money.
      razorpayOrderIds: { type: [String], default: [] },
      razorpayPaymentId: { type: String, default: "" },
      razorpaySignature: { type: String, default: "" },
      status: {
        type: String,
        enum: ["pending", "paid", "failed"],
        default: "pending",
      },
      paidAmount: { type: Number, default: 0 },
      paidAt: { type: Date },
      // Refund tracking for paid bookings that end without service. Money is
      // never moved automatically — a cancel/reject/expiry queues "pending"
      // for an admin to approve or reject in the Payouts tab. `refundStatus`:
      // "none" (default) → "pending" (awaiting admin decision) →
      // "processing" (claimed by exactly one approver; concurrent approves
      // lose here instead of double-charging the gateway) → "processed"
      // (money returned), or "failed" (gateway rejected — contact support),
      // or "manual" (gateway unconfigured — settled outside Razorpay), or
      // "rejected" (admin declined the refund).
      refundId: { type: String, default: "" },
      refundStatus: {
        type: String,
        enum: ["none", "pending", "processing", "processed", "failed", "manual", "rejected"],
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
        "unattended",
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

// A (orderId, paymentId, signature) triple is valid for exactly ONE booking.
// Unique on the payment id — sparse partial index so unpaid/test bookings
// (empty or missing ids) never collide — blocks replaying one captured
// payment onto multiple bookings, which the confirm endpoint otherwise can't
// detect (it only re-verifies the HMAC and the order amount).
bookingSchema.index(
  { "payment.razorpayPaymentId": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "payment.razorpayPaymentId": { $exists: true, $ne: "" },
    },
    name: "uniq_payment_razorpayPaymentId",
  }
);
// Webhook lookup by gateway order id (exact + history). Sparse so unpaid
// bookings never enter the index.
bookingSchema.index(
  { "payment.razorpayOrderId": 1 },
  {
    sparse: true,
    name: "idx_payment_razorpayOrderId",
  }
);
// Idempotency-key lookup for booking-creation retries. Unique + sparse +
// partial so only non-empty keys are constrained.
bookingSchema.index(
  { clientKey: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { clientKey: { $exists: true, $ne: "" } },
    name: "uniq_booking_clientKey",
  }
);
// Offline payout references are admin-typed: the same reference settling two
// bookings is one transfer recorded twice (or a double-click). Unique +
// sparse + partial so empty references never collide.
bookingSchema.index(
  { "payout.reference": 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { "payout.reference": { $exists: true, $ne: "" } },
    name: "uniq_payout_reference",
  }
);

module.exports = mongoose.model("Booking", bookingSchema);
