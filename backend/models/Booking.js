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
      required: false,
      default: null,
    },
    ignoredBy: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
      default: [],
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
    cookArrived: { type: Boolean, default: false },
    cookArrivedAt: { type: Date },
  serviceOtp: { type: String },
  serviceOtpGeneratedAt: { type: Date },
  serviceOtpAttempts: { type: Number, default: 0, min: 0 },
  serviceOtpLockedUntil: { type: Date },
  serviceStartedAt: { type: Date },
  serviceEndsAt: { type: Date },
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
    amount: {
      type: Number,
      default: 0,
    },
    slabPrice: { type: Number, default: 0 },
    couponCode: { type: String, default: "", trim: true, uppercase: true },
    discount: { type: Number, default: 0 },
    commission: { type: Number, default: 0 },
    cookPayout: { type: Number, default: 0 },
    payoutInfo: {
      regularPrice: { type: Number, default: 0 },
      discountAmount: { type: Number, default: 0 },
      finalCustomerPrice: { type: Number, default: 0 },
      platformDeductionPercent: { type: Number, default: 15 },
      platformDeductionAmount: { type: Number, default: 0 },
      cookPayoutAmount: { type: Number, default: 0 },
      payoutStatus: {
        type: String,
        enum: ["eligible", "pending_weekly", "approved", "paid", "held", "rejected"],
        default: "eligible",
      },
      payoutEligibleAt: { type: Date },
      payoutProcessedAt: { type: Date },
      payoutHoldReason: { type: String, default: "", trim: true, maxlength: 300 },
      payoutCycleRef: { type: String, default: "", trim: true },
      disputed: { type: Boolean, default: false },
      underVerification: { type: Boolean, default: false },
    },
    clientKey: { type: String, default: "", trim: true },
    rescheduleCount: { type: Number, default: 0, min: 0 },
    reschedules: [
      {
        fromDate: Date,
        fromStartTime: String,
        fromEndTime: String,
        toDate: Date,
        toStartTime: String,
        toEndTime: String,
        by: String,
        at: { type: Date, default: Date.now },
        fromCook: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        toCook: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        fromCookName: { type: String, default: "", trim: true },
        toCookName: { type: String, default: "", trim: true },
        reason: { type: String, default: "", trim: true, maxlength: 200 },
      },
    ],
    couponReleased: { type: Boolean, default: false },
    cancelledBy: { type: String, default: "" },
    cancellationInfo: {
      cancelledBy: { type: String, default: "", trim: true },
      cancelledAt: { type: Date },
      cancellationReason: { type: String, default: "", trim: true, maxlength: 200 },
      cancellationReasonNote: { type: String, default: "", trim: true, maxlength: 500 },
      cancellationCategory: {
        type: String,
        enum: [
          "BEFORE_ASSIGNMENT",
          "MORE_THAN_24_HOURS",
          "WITHIN_24_HOURS",
          "WITHIN_6_HOURS",
          "COOK_ARRIVED",
          "CUSTOMER_NO_SHOW",
          "COOK_CANCELLED",
          "COOK_FAILED_SERVICE",
        ],
      },
      policyVersion: { type: String, default: "", trim: true },
      bookingAmount: { type: Number, default: 0 },
      refundPercentage: { type: Number, default: 0 },
      cancellationChargePercentage: { type: Number, default: 0 },
      grossRefundAmount: { type: Number, default: 0 },
      nonRefundableCharges: { type: Number, default: 0 },
      finalRefundAmount: { type: Number, default: 0 },
      refundStatus: {
        type: String,
        enum: [
          "NOT_APPLICABLE",
          "PENDING",
          "UNDER_REVIEW",
          "APPROVED",
          "PROCESSING",
          "PROCESSED",
          "FAILED",
          "HELD",
          "REJECTED",
        ],
        default: "NOT_APPLICABLE",
      },
      refundReference: { type: String, default: "", trim: true },
      refundRequestedAt: { type: Date },
      refundProcessedAt: { type: Date },
      adminNote: { type: String, default: "", trim: true, maxlength: 500 },
    },
    noShow: {
      marked: { type: Boolean, default: false },
      markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      markedByRole: { type: String, default: "", trim: true },
      markedAt: { type: Date },
      reason: { type: String, default: "", trim: true, maxlength: 500 },
    },
    payout: {
      status: {
        type: String,
        enum: ["pending", "settled", "not_applicable"],
        default: "pending",
      },
      settledAt: { type: Date },
      reference: { type: String, default: "", trim: true },
      referenceKey: { type: String, default: "", trim: true },
      amount: { type: Number, default: 0 },
      recipient: {
        method: { type: String, default: "", trim: true },
        upiId: { type: String, default: "", trim: true },
        holderName: { type: String, default: "", trim: true },
        bankName: { type: String, default: "", trim: true },
        accountLast4: { type: String, default: "", trim: true },
        ifsc: { type: String, default: "", trim: true },
      },
      settledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    },
    payment: {
      razorpayOrderId: { type: String, default: "" },
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
      refundId: { type: String, default: "" },
      refundStatus: {
        type: String,
        enum: ["none", "pending", "processing", "processed", "failed", "manual", "rejected"],
        default: "none",
      },
      refundAmount: { type: Number, default: 0 },
      refundedAt: { type: Date },
      refundReference: { type: String, default: "", trim: true },
      refundReferenceKey: { type: String, default: "", trim: true },
      refundReason: { type: String, default: "", trim: true, maxlength: 120 },
      refundCustomerNote: { type: String, default: "", trim: true, maxlength: 500 },
      refundRequestedAt: { type: Date },
      refundRequestedBy: { type: String, default: "", trim: true },
      refundAdminNote: { type: String, default: "", trim: true, maxlength: 500 },
      testMode: { type: Boolean, default: false },
      webhookReconciled: { type: Boolean, default: false },
    },
    requestExpiresAt: { type: Date },
    paymentExpiresAt: { type: Date },
    // Per-booking/per-cook WhatsApp delivery state (spec section 10).
    // A message is only marked `sent` after Meta accepts it; `failed`
    // entries stay retryable. A `sent` entry also acts as the
    // idempotency key so retries never double-send.
    whatsappDispatch: {
      type: [
        {
          cook: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
          kind: { type: String, default: "request", trim: true },
          status: {
            type: String,
            enum: ["pending", "sending", "sent", "failed"],
            default: "pending",
          },
          messageId: { type: String, default: "", trim: true },
          attempts: { type: Number, default: 0, min: 0 },
          sentAt: { type: Date },
          lastAttemptAt: { type: Date },
          error: { type: String, default: "", trim: true, maxlength: 500 },
        },
      ],
      default: [],
    },
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
bookingSchema.index({ "cancellationInfo.refundStatus": 1, updatedAt: -1 });
bookingSchema.index({ "payoutInfo.payoutStatus": 1, cook: 1 });
bookingSchema.index({ customer: 1, createdAt: -1 });
bookingSchema.index({ "payment.status": 1 });
bookingSchema.index({ cook: 1, status: 1 });
bookingSchema.index({ cook: 1, date: 1, startTime: 1, endTime: 1 });
bookingSchema.index({ date: 1, status: 1 });
bookingSchema.index({ status: 1, createdAt: -1 });
bookingSchema.index({ status: 1, requestExpiresAt: 1 });
bookingSchema.index({ status: 1, cook: 1, requestExpiresAt: 1 });
bookingSchema.index({ cook: 1, date: 1, "payment.status": 1, status: 1 });

bookingSchema.index(
  { "payment.razorpayPaymentId": 1 },
  {
    unique: true,
    partialFilterExpression: {
      "payment.razorpayPaymentId": { $exists: true, $gt: "" },
    },
    name: "uniq_payment_razorpayPaymentId",
  }
);
bookingSchema.index(
  { "payment.razorpayOrderId": 1 },
  {
    sparse: true,
    name: "idx_payment_razorpayOrderId",
  }
);
bookingSchema.index(
  { clientKey: 1 },
  {
    unique: true,
    partialFilterExpression: { clientKey: { $exists: true, $gt: "" } },
    name: "uniq_booking_clientKey",
  }
);
bookingSchema.index(
  { "payout.reference": 1 },
  {
    unique: true,
    partialFilterExpression: { "payout.reference": { $exists: true, $gt: "" } },
    name: "uniq_payout_reference",
  }
);
bookingSchema.index(
  { "payout.referenceKey": 1 },
  {
    unique: true,
    partialFilterExpression: { "payout.referenceKey": { $exists: true, $gt: "" } },
    name: "uniq_payout_reference_key",
  }
);
bookingSchema.index(
  { "payment.refundReferenceKey": 1 },
  {
    unique: true,
    partialFilterExpression: { "payment.refundReferenceKey": { $exists: true, $gt: "" } },
    name: "uniq_refund_reference_key",
  }
);

module.exports = mongoose.model("Booking", bookingSchema);
