const mongoose = require("mongoose");

// COOKMITRA EVENTS — durable notification outbox (no new infrastructure).
//
// Delivery model: event notifications are persisted Notification documents
// (the frontend polls GET /api/notifications — there is no socket/push
// channel). The failure mode this closes: booking commits, then the
// in-band Notification.insertMany fails (DB blip, validation) and the
// notice is lost with only a console log.
//
// Protocol:
//  1. After a successful atomic booking update, the controller enqueues one
//     outbox event (same transaction as the update when the topology
//     supports it — see withEventTransaction in utils/eventOutbox.js).
//  2. The request path attempts immediate delivery (existing UX timing).
//  3. Anything undelivered stays `pending` and is retried by the in-process
//     worker (started by server.js; see startOutboxWorker in
//     utils/eventOutbox.js) and/or the one-shot CLI worker
//     (backend/workers/eventOutboxWorker.js — cron/manual, no new service).
//
// Idempotency: every recipient row carries the event's stable eventKey and
// Notification has a unique (eventKey, user) index, so repeated processing
// — retries, crash between insert and mark-sent, two workers racing — can
// never duplicate a delivery. Worker claims use an atomic lease
// (claimedBy + claimExpiresAt) so two workers never process one event.
// Retries are bounded (maxAttempts + capped backoff → `dead`, never silent).
const OUTBOX_ACTIONS = ["request", "assign", "status", "cancel", "revert_failed", "payment", "refund"];

const outboxRecipientSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false }
);

const eventOutboxSchema = new mongoose.Schema(
  {
    // Stable dedupe key: `${bookingPublicId}:${action}:${bookingVersion}` —
    // identical across retries of the same commit, distinct per mutation.
    eventKey: { type: String, required: true, unique: true, trim: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "EventBooking", default: null },
    bookingPublicId: { type: String, default: "", trim: true },
    action: { type: String, enum: OUTBOX_ACTIONS, required: true },
    recipients: { type: [outboxRecipientSchema], default: [] },
    status: { type: String, enum: ["pending", "sent", "dead"], default: "pending" },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 10, min: 1 },
    lastError: { type: String, default: "" },
    nextRetryAt: { type: Date, default: null },
    claimedBy: { type: String, default: null },
    claimExpiresAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

eventOutboxSchema.index({ status: 1, nextRetryAt: 1 });
eventOutboxSchema.index({ bookingId: 1, action: 1 });

const EventOutbox = mongoose.model("EventOutbox", eventOutboxSchema);
EventOutbox.OUTBOX_ACTIONS = OUTBOX_ACTIONS;

module.exports = EventOutbox;
