const EventBooking = require("../models/EventBooking");
const EventLedgerEntry = require("../models/EventLedgerEntry");
const User = require("../models/User");
const { razorpay, isConfigured, keyId } = require("../config/razorpay");
const { enqueueEventOutbox, deliverOutboxEvent } = require("../utils/eventOutbox");
const { notifyEventCookConfirmed } = require("../utils/eventWhatsApp");

const ACTIVE_REFUND_STATES = ["pending", "processing", "processed", "manual"];
const ACTIONABLE_REFUND_STATES = ["pending", "processing", "failed"];

const isTruthyFlag = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
};

const eventPaymentsRequired = () => {
  const explicit = String(process.env.EVENT_PAYMENTS_REQUIRED || "").trim();
  if (explicit) return isTruthyFlag(explicit);
  // Events share the platform payment policy unless explicitly overridden.
  return isTruthyFlag(process.env.REQUIRE_PAYMENTS);
};

const isTestGateway = () => /^(rzp|rk)_test_/i.test(String(keyId || ""));

const paidPaise = (event) => Math.round(Number(event?.payment?.paidAmount || 0) * 100);

const paymentEligibilityError = (event) => {
  if (!event) return "Event booking not found";
  if (event.payment?.status === "paid") return "This event booking is already paid";
  if (event.bookingStatus !== "cook_assigned") {
    return "Payment opens after a cook is assigned and the final amount is verified";
  }
  if (!event.cookId) return "Assign a cook before collecting payment";
  if (event.distanceVerified !== true) {
    return "Travel distance must be verified before collecting payment";
  }
  if (!(Number(event.totalAmount) > 0)) return "The final event amount is not ready for payment";
  return null;
};

const recordEventLedger = async (event, {
  type,
  amount,
  paymentId = "",
  orderId = "",
  refundId = "",
  source = "system",
  actor = null,
  note = "",
  metadata = {},
}) => {
  try {
    await EventLedgerEntry.create({
      eventBooking: event._id,
      eventBookingId: event.bookingId,
      type,
      amount: Math.max(0, Math.round(Number(amount) || 0)),
      currency: String(process.env.RAZORPAY_CURRENCY || "INR").toUpperCase(),
      paymentId,
      orderId,
      refundId,
      source,
      actor,
      note,
      metadata,
    });
  } catch (error) {
    console.error(`[event-payment] ledger write failed for ${event.bookingId}: ${String(error?.message || error).slice(0, 200)}`);
  }
};

const notifyEventPayment = async (event, { action, marker, recipients }) => {
  if (!recipients.length) return;
  try {
    const outbox = await enqueueEventOutbox({
      eventKey: `${event.bookingId}:${action}:${marker}`,
      bookingId: event._id,
      bookingPublicId: event.bookingId,
      action,
      recipients,
    });
    await deliverOutboxEvent(outbox);
  } catch (error) {
    console.error(`[event-payment] notification failed for ${event.bookingId}: ${String(error?.message || error).slice(0, 200)}`);
  }
};

const adminRecipients = async (message) => {
  const admins = await User.find({ role: "ADMIN", status: "active" }).select("_id").lean();
  return (admins || []).map((admin) => ({ user: admin._id, type: "refund_pending", message }));
};

const queueEventRefund = async (
  eventOrId,
  reason,
  { actor = null, source = "system", amountPaise = 0, paymentId = "", orderId = "", markCaptured = false } = {}
) => {
  const event =
    typeof eventOrId === "object" && eventOrId?._id
      ? eventOrId
      : await EventBooking.findById(eventOrId).catch(() => null);
  if (!event) return { queued: false, event: null };
  const alreadyPaid = event.payment?.status === "paid";
  if (!alreadyPaid && !markCaptured) return { queued: false, event };
  const amount = alreadyPaid
    ? Number(event.payment?.paidAmount || 0)
    : Math.round((Number(amountPaise) || 0) / 100);
  if (!(amount > 0)) return { queued: false, event };
  if (ACTIVE_REFUND_STATES.includes(event.payment?.refundStatus)) {
    return { queued: false, event };
  }

  const requestedAt = new Date();
  const captureSet = !alreadyPaid && markCaptured
    ? {
        "payment.razorpayOrderId": String(orderId || event.payment?.razorpayOrderId || ""),
        "payment.razorpayPaymentId": String(paymentId),
        "payment.status": "paid",
        "payment.paidAmount": amount,
        "payment.paidAt": new Date(),
        "payment.testMode": isTestGateway(),
        "payment.webhookReconciled": source === "webhook",
      }
    : {};
  const filter = {
    _id: event._id,
    "payment.refundStatus": { $nin: ACTIVE_REFUND_STATES },
  };
  if (!alreadyPaid) filter["payment.status"] = { $ne: "paid" };
  const updated = await EventBooking.findOneAndUpdate(
    filter,
    {
      $set: {
        ...captureSet,
        "payment.refundStatus": "pending",
        "payment.refundAmount": amount,
        "payment.refundReason": String(reason || "Refund requested").slice(0, 120),
        "payment.refundRequestedAt": requestedAt,
        "payment.refundError": "",
      },
      $inc: { __v: 1 },
    },
    { new: true }
  );
  if (!updated) {
    const fresh = await EventBooking.findById(event._id);
    return { queued: false, event: fresh || event };
  }

  await recordEventLedger(updated, {
    type: "event_refund.requested",
    amount,
    paymentId: updated.payment?.razorpayPaymentId,
    orderId: updated.payment?.razorpayOrderId,
    source,
    actor,
    note: reason,
  });

  const customerMessage = `A full refund of ₹${Math.round(amount)} for event booking ${updated.bookingId} is awaiting admin approval.`;
  const recipients = [
    { user: updated.customerId, type: "refund_pending", message: customerMessage },
    ...(await adminRecipients(`Event refund of ₹${Math.round(amount)} is waiting for approval (${updated.bookingId}).`)),
  ];
  await notifyEventPayment(updated, {
    action: "refund",
    marker: requestedAt.toISOString(),
    recipients,
  });

  return { queued: true, event: updated };
};

// Called only after the gateway has confirmed a captured payment for this
// event's stored order. The caller is responsible for signature/webhook
// authenticity; this function owns the money/state invariants.
const finalizeEventPayment = async ({
  event,
  orderId,
  paymentId,
  signature = "",
  amountPaise,
  source = "customer",
  actor = null,
  webhook = false,
}) => {
  if (!event) return { ok: false, status: 404, message: "Event booking not found" };
  if (event.payment?.razorpayPaymentId && String(event.payment.razorpayPaymentId) !== String(paymentId)) {
    return { ok: false, status: 409, message: "A different payment is already recorded for this event" };
  }
  if (event.payment?.status === "paid") {
    return { ok: true, alreadyPaid: true, event };
  }
  const storedOrders = [
    event.payment?.razorpayOrderId,
    ...(event.payment?.razorpayOrderIds || []),
  ].filter(Boolean).map(String);
  if (!storedOrders.includes(String(orderId))) {
    return { ok: false, status: 400, message: "This payment order does not belong to this event" };
  }

  const expectedPaise = Math.round(Number(event.totalAmount || 0) * 100);
  const capturedPaise = Math.round(Number(amountPaise));
  if (!(expectedPaise > 0)) {
    return { ok: false, status: 400, message: "The final event amount is not ready for payment" };
  }

  const ineligible = paymentEligibilityError(event);
  if (ineligible || capturedPaise !== expectedPaise) {
    const reason = capturedPaise !== expectedPaise
      ? "Captured amount did not match the event total"
      : "Payment captured after the event was no longer payable";
    const queued = await queueEventRefund(event, reason, {
      actor,
      source,
      amountPaise: capturedPaise,
      paymentId,
      orderId,
      markCaptured: true,
    });
    return {
      ok: false,
      status: 409,
      message: queued.queued
        ? `${reason}. The payment has been queued for admin-approved refund.`
        : `${reason}. The captured payment could not be queued automatically; our team must review it.`,
      refundQueued: queued.queued,
      event: queued.event,
    };
  }

  const paidAt = new Date();
  const updated = await EventBooking.findOneAndUpdate(
    {
      _id: event._id,
      bookingStatus: "cook_assigned",
      totalAmount: Number(event.totalAmount),
      "payment.status": { $ne: "paid" },
      $or: [
        { "payment.razorpayOrderId": String(orderId) },
        { "payment.razorpayOrderIds": String(orderId) },
      ],
    },
    {
      $set: {
        "payment.razorpayOrderId": String(orderId),
        "payment.razorpayPaymentId": String(paymentId),
        "payment.razorpaySignature": String(signature || ""),
        "payment.status": "paid",
        "payment.paidAmount": Math.round(Number(event.totalAmount)),
        "payment.paidAt": paidAt,
        "payment.testMode": isTestGateway(),
        "payment.webhookReconciled": Boolean(webhook),
        bookingStatus: "confirmed",
      },
      $push: {
        statusHistory: {
          status: "confirmed",
          note: "Online payment captured - event confirmed",
          actor,
          actorRole: source === "webhook" ? "SYSTEM" : "CUSTOMER",
        },
      },
      $inc: { __v: 1 },
    },
    { new: true }
  );

  if (!updated) {
    const fresh = await EventBooking.findById(event._id);
    if (fresh?.payment?.status === "paid" && String(fresh.payment.razorpayPaymentId) === String(paymentId)) {
      return { ok: true, alreadyPaid: true, event: fresh };
    }
    const queued = await queueEventRefund(fresh || event, "Payment captured after the event was no longer payable", {
      actor,
      source,
      amountPaise: capturedPaise,
      paymentId,
      orderId,
      markCaptured: true,
    });
    return {
      ok: false,
      status: 409,
      message: "This event changed while payment was being verified. The payment has been queued for refund.",
      refundQueued: queued.queued,
      event: queued.event || fresh,
    };
  }

  await recordEventLedger(updated, {
    type: "event_payment.confirmed",
    amount: updated.payment.paidAmount,
    paymentId: updated.payment.razorpayPaymentId,
    orderId,
    source,
    actor,
    note: webhook ? "Captured via webhook" : "Captured via checkout verification",
  });

  const customerMessage = `Payment of ₹${Math.round(updated.payment.paidAmount)} received for event booking ${updated.bookingId}. Your booking is confirmed.`;
  const recipients = [
    { user: updated.customerId, type: "event_status", message: customerMessage },
  ];
  if (updated.cookId) {
    recipients.push({
      user: updated.cookId,
      type: "event_status",
      message: `Event booking ${updated.bookingId} is confirmed and paid.`,
    });
  }
  await notifyEventPayment(updated, {
    action: "payment",
    marker: String(paymentId),
    recipients,
  });

  // Payment is already committed above. WhatsApp is an extra notification:
  // fire-and-forget so a Meta outage can never fail or delay verification.
  // finalizeEventPayment only reaches this point on the first successful
  // capture, so duplicate verify/webhook calls do not resend it.
  notifyEventCookConfirmed(updated);

  return { ok: true, event: updated };
};

const lookupGatewayRefunds = async (razorpayPaymentId) => {
  try {
    if (!razorpayPaymentId || !isConfigured || !razorpay || !razorpay.refunds) {
      return { ok: false, reason: "gateway-unavailable" };
    }
    const res = await razorpay.refunds.all({ payment_id: razorpayPaymentId });
    const items = (res?.items || res?.entities || (Array.isArray(res) ? res : []) || [])
      .filter(Boolean)
      .map((refund) => ({
        id: String(refund.id || ""),
        amountPaise: Math.round(Number(refund.amount || 0)),
        status: String(refund.status || "").toLowerCase(),
      }))
      .filter((refund) => refund.id);
    return { ok: true, items };
  } catch {
    return { ok: false, reason: "gateway-error" };
  }
};

const matchingGatewayRefund = (items, refundAmountPaise) =>
  (items || []).find(
    (refund) => refund.amountPaise === refundAmountPaise && !["failed", "cancelled"].includes(refund.status)
  ) || null;

module.exports = {
  ACTIONABLE_REFUND_STATES,
  eventPaymentsRequired,
  isTestGateway,
  paymentEligibilityError,
  queueEventRefund,
  finalizeEventPayment,
  recordEventLedger,
  notifyEventPayment,
  lookupGatewayRefunds,
  matchingGatewayRefund,
  paidPaise,
};
