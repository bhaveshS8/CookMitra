const mongoose = require("mongoose");

// Durable outbox for WhatsApp booking-request fan-out.
//
// A job is persisted (upserted) at booking-creation time, BEFORE the HTTP
// 201 response, so a crash/restart can never silently lose the dispatch
// work the way the old unawaited fire-and-forget task could. A worker
// (services/bookingDispatchJobs.js) claims due jobs atomically, so any
// number of server/cluster instances can run without double-processing.
//
// Never stores phone numbers, message bodies, or customer data — only ids,
// counters, timestamps, and machine-readable reason codes.
const dispatchJobSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    kind: { type: String, default: "booking.requested", trim: true, maxlength: 60 },
    status: {
      type: String,
      enum: ["pending", "processing", "retrying", "completed", "skipped", "failed"],
      default: "pending",
    },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 5, min: 1, max: 20 },
    nextRetryAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    // Machine-readable outcome, e.g. dispatched, whatsapp_disabled,
    // no_eligible_cooks, booking_not_requested, booking_expired,
    // cook_already_assigned, no_valid_recipients, meta_api_error,
    // network_timeout, database_error, unexpected_error, booking_missing.
    reason: { type: String, default: "", trim: true, maxlength: 60 },
    // Sanitized human-readable summary (no phones / message bodies).
    error: { type: String, default: "", trim: true, maxlength: 500 },
    eligibleCookCount: { type: Number, default: 0, min: 0 },
    sentCount: { type: Number, default: 0, min: 0 },
    failedCount: { type: Number, default: 0, min: 0 },
    // Eligibility/dispatch summary counts only (no personal data):
    // { examined, excludedByReason: {...}, attempted, skipped, noPhone,
    //   ineligible }. Answers "why did only N qualify?" without DB digging.
    diagnostics: { type: mongoose.Schema.Types.Mixed, default: undefined },
    // Atomic-claim lease: set on claim, honoured by competing workers.
    lockedBy: { type: String, default: "", trim: true, maxlength: 120 },
    lockedAt: { type: Date, default: null },
    leaseExpiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One job per (booking, kind): replays / double booking-create calls can
// never duplicate dispatch work.
dispatchJobSchema.index({ booking: 1, kind: 1 }, { unique: true });
// Recovery + due-retry scans.
dispatchJobSchema.index({ status: 1, nextRetryAt: 1 });
dispatchJobSchema.index({ updatedAt: -1 });

module.exports = mongoose.model("DispatchJob", dispatchJobSchema);
