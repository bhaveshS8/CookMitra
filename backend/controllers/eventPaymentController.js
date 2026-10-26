const crypto = require("crypto");
const mongoose = require("mongoose");
const EventBooking = require("../models/EventBooking");
const { razorpay, isConfigured, keyId } = require("../config/razorpay");
const {
  assertRazorpayOrderAmount,
  assertRazorpayPaymentCaptured,
  expectedCurrency,
} = require("../utils/razorpayVerify");
const {
  ACTIONABLE_REFUND_STATES,
  paymentEligibilityError,
  finalizeEventPayment,
  queueEventRefund,
  recordEventLedger,
  notifyEventPayment,
  lookupGatewayRefunds,
  matchingGatewayRefund,
} = require("../services/eventPaymentService");
const { paginationParams, applyPagination, sendList } = require("../utils/pagination");

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const verifySignature = (orderId, paymentId, signature) => {
  const secret = process.env.RAZORPAY_KEY_SECRET || "";
  if (!secret) return false;
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return safeEqual(digest, signature);
};

const isOwnerOrAdmin = (event, user) =>
  String(user?.role || "").toUpperCase() === "ADMIN" ||
  String(event.customerId) === String(user?.id);

const queueCapturedRefund = async ({ event, orderId, paymentId, actor, reason }) => {
  try {
    const payment = await razorpay.payments.fetch(paymentId);
    if (
      String(payment?.status || "").toLowerCase() !== "captured" ||
      String(payment?.order_id || "") !== String(orderId) ||
      !(Number(payment?.amount) > 0)
    ) {
      return false;
    }
    const queued = await queueEventRefund(event, reason, {
      actor,
      source: "customer",
      amountPaise: Number(payment.amount),
      paymentId,
      orderId,
      markCaptured: true,
    });
    return queued.queued;
  } catch {
    return false;
  }
};

const finishRealEventRefund = async ({
  event,
  refundStatus,
  refundId = "",
  refundError = "",
  note = "",
  historyNote,
  actor,
  notify = true,
}) => {
  const amount = Math.round(Number(event.payment?.refundAmount || event.payment?.paidAmount || 0));
  const set = {
    "payment.refundStatus": refundStatus,
    "payment.refundId": refundId,
    "payment.refundAmount": amount,
    "payment.refundAdminNote": note,
    "payment.refundError": refundStatus === "failed" ? refundError : "",
  };
  if (refundStatus === "processed") set["payment.refundedAt"] = new Date();

  const fresh = await EventBooking.findOneAndUpdate(
    { _id: event._id, "payment.refundStatus": "processing" },
    {
      $set: set,
      $push: {
        statusHistory: {
          status: event.bookingStatus,
          note: historyNote,
          actor,
          actorRole: "ADMIN",
        },
      },
      $inc: { __v: 1 },
    },
    { new: true }
  );
  if (!fresh) return null;

  if (refundStatus === "processed" || refundStatus === "failed") {
    await recordEventLedger(fresh, {
      type: refundStatus === "processed" ? "event_refund.processed" : "event_refund.failed",
      amount: refundStatus === "processed" ? amount : 0,
      paymentId: fresh.payment?.razorpayPaymentId,
      orderId: fresh.payment?.razorpayOrderId,
      refundId,
      source: "admin",
      actor,
      note: refundStatus === "processed" ? historyNote : refundError,
    });
  }

  if (notify) {
    const message = refundStatus === "processed"
      ? `Your full refund of ₹${amount} for event booking ${fresh.bookingId} has been processed.`
      : refundStatus === "failed"
        ? `The refund for event booking ${fresh.bookingId} hit a gateway error. Our team will retry it.`
        : `Your refund of ₹${amount} for event booking ${fresh.bookingId} has been initiated and is awaiting confirmation from the payment gateway.`;
    await notifyEventPayment(fresh, {
      action: "refund",
      marker: `${refundStatus}:${refundId || Date.now()}`,
      recipients: [{
        user: fresh.customerId,
        type: refundStatus === "processing" ? "refund_pending" : "refund_processed",
        message,
      }],
    });
  }

  return fresh;
};

const loadEvent = async (id) => {
  if (!mongoose.isValidObjectId(id)) return null;
  return EventBooking.findById(id);
};

exports.createEventOrder = async (req, res, next) => {
  try {
    const event = await loadEvent(req.params.id);
    if (!event) return res.status(404).json({ message: "Event booking not found" });
    if (String(event.customerId) !== String(req.user.id)) {
      return res.status(403).json({ message: "Not authorized for this event" });
    }
    if (event.payment?.status === "paid") {
      return res.status(409).json({ message: "This event booking is already paid" });
    }
    const ineligible = paymentEligibilityError(event);
    if (ineligible) return res.status(400).json({ message: ineligible });
    if (!isConfigured || !razorpay) {
      return res.status(503).json({ message: "Online payments are not configured" });
    }

    const amountPaise = Math.round(Number(event.totalAmount) * 100);
    let order = null;
    const existingOrderId = String(event.payment?.razorpayOrderId || "");
    if (existingOrderId) {
      try {
        const existing = await razorpay.orders.fetch(existingOrderId);
        if (
          Math.round(Number(existing?.amount)) === amountPaise &&
          String(existing?.currency || "").toUpperCase() === expectedCurrency().toUpperCase()
        ) {
          order = existing;
        }
      } catch {
        return res.status(502).json({ message: "Could not reach the payment gateway. Please try again." });
      }
    }
    if (!order) {
      try {
        order = await razorpay.orders.create({
          amount: amountPaise,
          currency: expectedCurrency(),
          receipt: `evt_${String(event.bookingId).slice(-14)}_${Date.now().toString(36)}`.slice(0, 40),
          notes: {
            eventBooking: String(event._id),
            eventBookingId: String(event.bookingId),
            customer: String(event.customerId),
          },
        });
      } catch {
        return res.status(502).json({ message: "Could not start the payment. Please try again." });
      }
    }

    const orderId = String(order?.id || "");
    if (!orderId || Math.round(Number(order?.amount)) !== amountPaise) {
      return res.status(502).json({ message: "The gateway returned an invalid payment order" });
    }

    const updateDoc = { $set: { "payment.razorpayOrderId": orderId } };
    if (String(event.payment?.razorpayOrderId || "") !== orderId) {
      updateDoc.$push = { "payment.razorpayOrderIds": { $each: [orderId], $slice: -10 } };
    }
    const updated = await EventBooking.findOneAndUpdate(
      {
        _id: event._id,
        "payment.status": { $ne: "paid" },
        bookingStatus: "cook_assigned",
      },
      updateDoc,
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({ message: "This event changed while starting payment - please refresh." });
    }

    res.json({
      orderId,
      keyId,
      amount: amountPaise,
      currency: expectedCurrency(),
      eventId: String(updated._id),
    });
  } catch (error) {
    next(error);
  }
};

exports.verifyEventPayment = async (req, res, next) => {
  try {
    const event = await loadEvent(req.params.id);
    if (!event) return res.status(404).json({ message: "Event booking not found" });
    if (!isOwnerOrAdmin(event, req.user)) {
      return res.status(403).json({ message: "Not authorized for this event" });
    }
    const orderId = String(req.body?.razorpay_order_id || "");
    const paymentId = String(req.body?.razorpay_payment_id || "");
    const signature = String(req.body?.razorpay_signature || "");
    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ message: "Payment verification details are incomplete" });
    }
    if (!verifySignature(orderId, paymentId, signature)) {
      return res.status(400).json({ message: "Payment signature verification failed" });
    }
    if (!isConfigured || !razorpay) {
      return res.status(503).json({ message: "Online payments are not configured" });
    }
    if (event.payment?.status === "paid") {
      if (String(event.payment.razorpayPaymentId) === paymentId) return res.json(event);
      return res.status(409).json({ message: "A different payment is already recorded for this event" });
    }

    const expectedPaise = Math.round(Number(event.totalAmount) * 100);
    const orderError = await assertRazorpayOrderAmount(orderId, expectedPaise);
    const captureError = orderError
      ? null
      : await assertRazorpayPaymentCaptured(orderId, paymentId, expectedPaise);
    const paymentError = orderError || captureError;
    if (paymentError) {
      const refundQueued = await queueCapturedRefund({
        event,
        orderId,
        paymentId,
        actor: req.user.id,
        reason: orderError
          ? "Captured payment did not match the current event total"
          : "Captured amount did not match the current event total",
      });
      return res.status(400).json({
        message: refundQueued
          ? `${paymentError} The captured amount has been queued for admin-approved refund.`
          : paymentError,
        refundQueued,
      });
    }

    const result = await finalizeEventPayment({
      event,
      orderId,
      paymentId,
      signature,
      amountPaise: expectedPaise,
      source: "customer",
      actor: req.user.id,
    });
    if (!result.ok) {
      return res.status(result.status || 409).json({
        message: result.message,
        refundQueued: Boolean(result.refundQueued),
      });
    }
    const populated = await EventBooking.findById(result.event._id);
    res.json(populated);
  } catch (error) {
    next(error);
  }
};

exports.getEventRefundQueue = async (req, res, next) => {
  try {
    const raw = String(req.query?.status || "").trim().toLowerCase();
    const statuses = raw && raw !== "all" && ACTIONABLE_REFUND_STATES.includes(raw)
      ? [raw]
      : ACTIONABLE_REFUND_STATES;
    const pg = paginationParams(req);
    const filter = { "payment.status": "paid", "payment.refundStatus": { $in: statuses } };
    const query = EventBooking.find(filter)
      .sort({ "payment.refundRequestedAt": 1, _id: 1 })
      .populate("customerId", "name phone email")
      .populate("cookId", "name phone");
    const rows = await applyPagination(query, pg);
    return sendList(res, rows, pg, EventBooking.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

exports.approveEventRefund = async (req, res, next) => {
  try {
    const event = await loadEvent(req.params.id);
    if (!event) return res.status(404).json({ message: "Event booking not found" });
    const current = event.payment?.refundStatus;
    if (current === "processed" || current === "manual") return res.json(event);
    if (!["pending", "failed"].includes(current)) {
      return res.status(400).json({ message: "Only pending or failed refunds can be approved" });
    }
    if (event.payment?.status !== "paid") {
      return res.status(400).json({ message: "This event has no captured payment to refund" });
    }
    const amount = Math.round(Number(event.payment?.paidAmount || 0));
    if (!(amount > 0)) {
      return res.status(400).json({ message: "This event has no refundable amount" });
    }
    const note = String(req.body?.note || "").trim().slice(0, 500);

    if (!event.payment?.testMode && (!isConfigured || !razorpay)) {
      return res.status(503).json({ message: "Razorpay is not configured - the refund remains pending" });
    }

    const claimed = await EventBooking.findOneAndUpdate(
      { _id: event._id, "payment.refundStatus": { $in: ["pending", "failed"] } },
      {
        $set: {
          "payment.refundStatus": "processing",
          "payment.refundAmount": amount,
          "payment.refundApprovedAt": new Date(),
          "payment.refundApprovedBy": req.user.id,
          "payment.refundAdminNote": note,
          "payment.refundError": "",
        },
      },
      { new: true }
    );
    if (!claimed) {
      return res.status(409).json({ message: "This refund was just updated - please refresh." });
    }

    const finish = async (set, historyNote) =>
      EventBooking.findOneAndUpdate(
        { _id: claimed._id, "payment.refundStatus": "processing" },
        {
          $set: set,
          $push: {
            statusHistory: {
              status: claimed.bookingStatus,
              note: historyNote,
              actor: req.user.id,
              actorRole: "ADMIN",
            },
          },
          $inc: { __v: 1 },
        },
        { new: true }
      );

    if (claimed.payment?.testMode) {
      const fresh = await finish(
        {
          "payment.refundStatus": "processed",
          "payment.refundAmount": amount,
          "payment.refundedAt": new Date(),
          "payment.refundReference": "TEST_MODE",
          "payment.refundAdminNote": note || "Test payment - no real money moved",
          "payment.refundError": "",
        },
        "Test-payment refund approved (no real money moved)"
      );
      if (!fresh) return res.status(409).json({ message: "This refund was just updated - please refresh." });
      await recordEventLedger(fresh, {
        type: "event_refund.processed",
        amount: 0,
        paymentId: fresh.payment?.razorpayPaymentId,
        orderId: fresh.payment?.razorpayOrderId,
        source: "admin",
        actor: req.user.id,
        note: "Test payment - no real money moved",
      });
      return res.json(fresh);
    }

    let refundStatus = "failed";
    let refundId = "";
    let refundError = "";
    let adopted = false;
    const existing = await lookupGatewayRefunds(claimed.payment?.razorpayPaymentId);
    const match = existing.ok ? matchingGatewayRefund(existing.items, amount * 100) : null;
    if (!existing.ok) {
      refundError = "Could not confirm whether a gateway refund already exists - retry when Razorpay is reachable";
    } else if (match) {
      const matchStatus = String(match.status || "").toLowerCase();
      refundId = match.id;
      adopted = true;
      if (matchStatus === "processed") {
        refundStatus = "processed";
      } else if (["created", "pending"].includes(matchStatus)) {
        refundStatus = "processing";
      } else {
        refundStatus = "failed";
        refundError = `The existing gateway refund is ${matchStatus || "not in a final state"}`;
      }
    } else {
      try {
        const refund = await razorpay.payments.refund(claimed.payment.razorpayPaymentId, {
          amount: amount * 100,
          speed: "normal",
          notes: { eventBooking: String(claimed._id), reason: "admin_approved_full_refund" },
        });
        const gatewayId = String(refund?.id || "");
        const gatewayPaise = Math.round(Number(refund?.amount ?? amount * 100));
        const gatewayStatus = String(refund?.status || "").toLowerCase();
        if (gatewayId && gatewayPaise === amount * 100) {
          refundId = gatewayId;
          if (gatewayStatus === "processed") {
            refundStatus = "processed";
          } else if (["failed", "cancelled"].includes(gatewayStatus)) {
            refundStatus = "failed";
            refundError = `The gateway reported the refund as ${gatewayStatus}`;
          } else {
            refundStatus = "processing";
          }
        } else {
          refundError = "The gateway returned an unexpected refund response";
        }
      } catch (error) {
        refundError = String(error?.message || "Gateway refund failed").slice(0, 300);
      }
    }

    const historyNote = refundStatus === "processed"
      ? `Full refund of ₹${amount} approved${adopted ? ` (existing gateway refund ${refundId} adopted)` : ""}`
      : refundStatus === "processing"
        ? `Refund of ₹${amount} initiated${adopted ? ` (existing gateway refund ${refundId})` : ""}; awaiting gateway confirmation`
        : `Refund approval failed: ${refundError}`;
    const fresh = await finishRealEventRefund({
      event: claimed,
      refundStatus,
      refundId,
      refundError,
      note,
      historyNote,
      actor: req.user.id,
    });
    if (!fresh) return res.status(409).json({ message: "This refund was just updated - please refresh." });

    res.json(fresh);
  } catch (error) {
    next(error);
  }
};

exports.reconcileEventRefund = async (req, res, next) => {
  try {
    const event = await loadEvent(req.params.id);
    if (!event) return res.status(404).json({ message: "Event booking not found" });
    if (event.payment?.refundStatus !== "processing") {
      return res.status(400).json({ message: "Only a refund already in processing can be reconciled" });
    }
    if (event.payment?.status !== "paid") {
      return res.status(400).json({ message: "This event has no captured payment to refund" });
    }
    if (event.payment?.testMode) {
      return res.status(400).json({ message: "Test-mode refunds do not need gateway reconciliation" });
    }
    if (!isConfigured || !razorpay) {
      return res.status(503).json({ message: "Razorpay is not configured - try again when the gateway is reachable" });
    }
    const paymentId = String(event.payment?.razorpayPaymentId || "");
    if (!paymentId) {
      return res.status(400).json({ message: "This event has no gateway payment reference" });
    }
    const amount = Math.round(Number(event.payment?.refundAmount || event.payment?.paidAmount || 0));
    if (!(amount > 0)) {
      return res.status(400).json({ message: "This event has no refundable amount" });
    }

    const existing = await lookupGatewayRefunds(paymentId);
    if (!existing.ok) {
      return res.status(503).json({ message: "Could not reach Razorpay - the refund remains processing" });
    }

    const matches = (existing.items || []).filter((refund) => refund.amountPaise === amount * 100);
    const match = matches.find((refund) => !["failed", "cancelled"].includes(refund.status)) || matches[0] || null;
    if (!match) {
      const fresh = await EventBooking.findOneAndUpdate(
        { _id: event._id, "payment.refundStatus": "processing" },
        {
          $set: {
            "payment.refundStatus": "pending",
            "payment.refundError": "No matching gateway refund found - returned to the approval queue",
          },
          $push: {
            statusHistory: {
              status: event.bookingStatus,
              note: "Gateway reconciliation found no matching refund - returned to the approval queue",
              actor: req.user.id,
              actorRole: "ADMIN",
            },
          },
          $inc: { __v: 1 },
        },
        { new: true }
      );
      if (!fresh) return res.status(409).json({ message: "This refund was just updated - please refresh." });
      return res.json({ ...fresh.toObject(), adopted: false, pending: true });
    }

    const matchStatus = String(match.status || "").toLowerCase();
    const refundStatus = matchStatus === "processed"
      ? "processed"
      : ["failed", "cancelled"].includes(matchStatus)
        ? "failed"
        : "processing";
    const refundError = refundStatus === "failed"
      ? `The gateway refund is ${matchStatus}`
      : "";
    const historyNote = refundStatus === "processed"
      ? `Gateway refund ${match.id} confirmed`
      : refundStatus === "failed"
        ? `Gateway refund ${match.id} is ${matchStatus}`
        : `Gateway refund ${match.id} is still awaiting confirmation`;
    const fresh = await finishRealEventRefund({
      event,
      refundStatus,
      refundId: match.id,
      refundError,
      note: event.payment?.refundAdminNote || "",
      historyNote,
      actor: req.user.id,
      notify: refundStatus !== "processing",
    });
    if (!fresh) return res.status(409).json({ message: "This refund was just updated - please refresh." });

    res.json({ ...fresh.toObject(), adopted: true, pending: refundStatus === "processing" });
  } catch (error) {
    next(error);
  }
};

exports.rejectEventRefund = async (req, res, next) => {
  try {
    const event = await loadEvent(req.params.id);
    if (!event) return res.status(404).json({ message: "Event booking not found" });
    if (!["pending", "failed"].includes(event.payment?.refundStatus)) {
      return res.status(400).json({ message: "Only pending or failed refunds can be rejected" });
    }
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    const rejected = await EventBooking.findOneAndUpdate(
      { _id: event._id, "payment.refundStatus": { $in: ["pending", "failed"] } },
      {
        $set: {
          "payment.refundStatus": "rejected",
          "payment.refundAdminNote": reason,
          "payment.refundApprovedAt": new Date(),
          "payment.refundApprovedBy": req.user.id,
        },
        $push: {
          statusHistory: {
            status: event.bookingStatus,
            note: `Refund declined by admin${reason ? `: ${reason}` : ""}`,
            actor: req.user.id,
            actorRole: "ADMIN",
          },
        },
        $inc: { __v: 1 },
      },
      { new: true }
    );
    if (!rejected) {
      return res.status(409).json({ message: "This refund was just updated - please refresh." });
    }

    await recordEventLedger(rejected, {
      type: "event_refund.rejected",
      amount: Number(rejected.payment?.refundAmount || 0),
      paymentId: rejected.payment?.razorpayPaymentId,
      orderId: rejected.payment?.razorpayOrderId,
      source: "admin",
      actor: req.user.id,
      note: reason || "Declined by admin",
    });
    await notifyEventPayment(rejected, {
      action: "refund",
      marker: `rejected:${Date.now()}`,
      recipients: [{
        user: rejected.customerId,
        type: "refund_processed",
        message: `Your refund request for event booking ${rejected.bookingId} was declined${reason ? `: ${reason}` : ""}. Please contact support.`,
      }],
    });
    res.json(rejected);
  } catch (error) {
    next(error);
  }
};

exports.reconcileCapturedEventPayment = async ({ event, orderId, paymentId, amountPaise, source = "webhook" }) =>
  finalizeEventPayment({
    event,
    orderId,
    paymentId,
    amountPaise,
    source,
    webhook: true,
  });

exports.queueCapturedEventRefund = async (event, reason) =>
  queueEventRefund(event, reason, { source: "webhook" });
