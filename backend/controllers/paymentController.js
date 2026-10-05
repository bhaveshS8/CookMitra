const crypto = require("crypto");
const Booking = require("../models/Booking");
const Notification = require("../models/Notification");
const CookProfile = require("../models/CookProfile");
const {
  getDayWindows,
  getDayBookings,
  findContainingWindow,
  findOverlapBooking,
  timeToMinutes,
} = require("../utils/slots");
const { isConfigured, keyId, razorpay } = require("../config/razorpay");
const {
  parseTimeStrict,
  isOnGrid,
  parseDayStrict,
  istDayString,
  istNowMinutes,
} = require("../utils/time");

const inflightOrderMints = new Map();
exports.createOrder = async (req, res, next) => {
  try {
    if (!isConfigured) {
      return res.status(503).json({
        message:
          "Online payments are not configured yet (missing or placeholder Razorpay keys). Please set real RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET from https://dashboard.razorpay.com/app/keys and restart the server.",
      });
    }
    const { cook, date, startTime, endTime, durationHours, bookingId } = req.body;
    if (!cook || !date || !startTime || !endTime) {
      return res.status(400).json({ message: "cook, date, startTime and endTime are required" });
    }

    const cookProfile = await CookProfile.findOne({ user: cook, approvalStatus: "approved" });
    if (!cookProfile) {
      return res.status(400).json({ message: "Cook not found or not approved" });
    }
    try {
      const User = require("../models/User");
      const cookAccount = await User.findById(cook).select("status");
      if (!cookAccount || cookAccount.status === "suspended") {
        return res.status(400).json({ message: "Cook not found or not approved" });
      }
    } catch {
      return res.status(400).json({ message: "Cook not found or not approved" });
    }

    const strictStart = parseTimeStrict(startTime);
    const strictEnd = parseTimeStrict(endTime);
    if (strictStart == null || strictEnd == null || strictEnd <= strictStart) {
      return res.status(400).json({ message: "Invalid time slot" });
    }
    if (!isOnGrid(strictStart) || !isOnGrid(strictEnd)) {
      return res.status(400).json({ message: "Start and end times must be on 30-minute intervals" });
    }
    let orderDay = typeof date === "string" ? date.trim() : "";
    if (date instanceof Date && !Number.isNaN(date.getTime())) {
      orderDay = istDayString(date);
    } else if (orderDay && !/^\d{4}-\d{2}-\d{2}$/.test(orderDay)) {
      const parsedIso = new Date(orderDay);
      if (!Number.isNaN(parsedIso.getTime())) {
        orderDay = istDayString(parsedIso);
      }
    }
    if (!parseDayStrict(orderDay)) {
      return res.status(400).json({ message: "Valid date (YYYY-MM-DD) is required" });
    }
    if (istDayString(parseDayStrict(orderDay)) < istDayString()) {
      return res.status(400).json({ message: "That date already passed — please pick today or a future date." });
    }
    const windows = await getDayWindows(cook, orderDay);
    if (!findContainingWindow(windows, startTime, endTime)) {
      return res.status(400).json({ message: "Cook is not available for the selected time" });
    }
    const activeBookings = await getDayBookings(cook, orderDay);
    const othersBookings = bookingId
      ? activeBookings.filter((b) => String(b._id) !== String(bookingId))
      : activeBookings;
    if (findOverlapBooking(othersBookings, startTime, endTime)) {
      return res.status(409).json({ message: "This time is already booked. Please pick another start time.", code: "SLOT_UNAVAILABLE" });
    }

    const startMin = timeToMinutes(startTime);
    const endMin = timeToMinutes(endTime);
    if (startMin == null || endMin == null || endMin <= startMin) {
      return res.status(400).json({ message: "Invalid time slot" });
    }
    const hours = (endMin - startMin) / 60;
    if (!Number.isInteger(hours) || hours < 1 || hours > 4) {
      return res.status(400).json({ message: "Sessions run 1–4 whole hours" });
    }
    if (durationHours != null && durationHours !== "") {
      const stated = Number(durationHours);
      if (!Number.isInteger(stated) || stated !== hours) {
        return res.status(400).json({ message: "Duration does not match the selected time slot" });
      }
    }

    if (!bookingId) {
      return res.status(400).json({
        message: "bookingId is required — the payment order belongs to your accepted booking.",
      });
    }
    const bookingForOrder = await Booking.findById(bookingId).select(
      "customer cook date startTime endTime status payment amount"
    );
    if (!bookingForOrder) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (String(bookingForOrder.customer) !== String(req.user.id)) {
      return res.status(403).json({ message: "Not authorized for this booking" });
    }
    if (bookingForOrder.status !== "accepted" || bookingForOrder.payment?.status === "paid") {
      return res.status(400).json({ message: "This booking is not awaiting payment" });
    }
    if (!bookingForOrder.cook) {
      return res.status(400).json({ message: "No cook has accepted this request yet — payment unlocks after a cook accepts." });
    }
    try {
      const { expireBookingIfNeeded } = require("./bookingController");
      await expireBookingIfNeeded(bookingForOrder);
    } catch {
    }
    if (
      bookingForOrder.status !== "accepted" ||
      (bookingForOrder.paymentExpiresAt && bookingForOrder.paymentExpiresAt < new Date())
    ) {
      return res.status(410).json({
        message: "Payment window expired — the slot was released. Please book the cook again.",
      });
    }
    if (
      String(bookingForOrder.cook) !== String(cook) ||
      bookingForOrder.startTime !== startTime ||
      bookingForOrder.endTime !== endTime
    ) {
      return res.status(400).json({ message: "Order does not match the booking window" });
    }
    const fullFee = Math.round(Number(bookingForOrder.amount) || 0);

    if (fullFee <= 0) {
      return res.status(201).json({
        free: true,
        orderId: "",
        amount: 0,
        amountPaise: 0,
        currency: process.env.RAZORPAY_CURRENCY || "INR",
        hours,
        fullFee: 0,
        keyId,
      });
    }
    const amountPaise = fullFee * 100;
    const wantCurrency = process.env.RAZORPAY_CURRENCY || "INR";

    const mintKey = `order:${bookingForOrder._id}`;
    if (inflightOrderMints.has(mintKey)) {
      try {
        const prior = await inflightOrderMints.get(mintKey);
        return res.status(200).json({ ...prior, reused: true });
      } catch {
      }
    }
    const mintTask = (async () => {
      const storedOrderId = String(bookingForOrder.payment?.razorpayOrderId || "");
      if (storedOrderId) {
        try {
          const live = await razorpay.orders.fetch(storedOrderId);
          if (
            Number(live?.amount) === amountPaise &&
            String(live?.currency || "").toUpperCase() === String(wantCurrency).toUpperCase()
          ) {
            return {
              orderId: live.id,
              amount: fullFee,
              amountPaise,
              currency: live.currency,
              hours,
              fullFee,
              keyId,
              reused: true,
            };
          }
        } catch {
        }
      }

      let order;
      try {
        order = await razorpay.orders.create({
          amount: amountPaise,
          currency: process.env.RAZORPAY_CURRENCY || "INR",
          receipt: `bk_${req.user.id}_${Date.now()}`,
          notes: {
            cook: String(cook),
            date: String(date),
            startTime,
            endTime,
            customer: req.user.id,
            ...(bookingId ? { bookingId: String(bookingId) } : {}),
          },
        });
      } catch (gwErr) {
        const status =
          gwErr?.statusCode || gwErr?.error?.status_code || gwErr?.error?.http_status_code;
        const detail =
          gwErr?.error?.description || gwErr?.message || "the gateway rejected the request";
        const hint =
          String(status) === "401"
            ? " The key pair is invalid or mismatched — copy RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET together from the same page at dashboard.razorpay.com/app/keys."
            : "";
        return {
          __gatewayError: {
            status: 502,
            message: `Payment gateway error${status ? ` (${status})` : ""}: ${detail}.${hint || " Please check the server's RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET."}`,
          },
        };
      }

      if (bookingForOrder) {
        try {
          await Booking.updateOne(
            { _id: bookingForOrder._id },
            {
              $set: { "payment.razorpayOrderId": order.id },
              $push: { "payment.razorpayOrderIds": { $each: [order.id], $slice: -10 } },
            }
          );
        } catch {
        }
      }

      return {
        orderId: order.id,
        amount: fullFee,
        amountPaise,
        currency: order.currency,
        hours,
        fullFee,
        keyId,
      };
    })();
    inflightOrderMints.set(mintKey, mintTask);
    let payload;
    try {
      payload = await mintTask;
    } finally {
      if (inflightOrderMints.get(mintKey) === mintTask) inflightOrderMints.delete(mintKey);
    }
    if (payload?.__gatewayError) {
      return res.status(payload.__gatewayError.status).json({ message: payload.__gatewayError.message });
    }

    res.status(payload?.reused ? 200 : 201).json(payload);
  } catch (error) {
    next(error);
  }
};

exports.handleWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || "";
    const signature = req.headers["x-razorpay-signature"];
    const raw = req.body && Buffer.isBuffer(req.body) ? req.body : null;
    if (!secret || !signature || !raw) {
      return res.status(200).json({ received: false });
    }
    let expected;
    try {
      expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    } catch {
      return res.status(200).json({ received: false });
    }
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(String(signature), "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(200).json({ received: false });
    }

    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(200).json({ received: false });
    }
    if (event?.event !== "payment.captured") {
      return res.status(200).json({ received: true, handled: false });
    }
    const entity = event?.payload?.payment?.entity || {};
    const orderId = entity.order_id;
    const paymentId = entity.id;
    if (!orderId || !paymentId) {
      return res.status(200).json({ received: true, handled: false });
    }
    if (String(entity.status || "").toLowerCase() !== "captured") {
      return res.status(200).json({ received: true, handled: false });
    }
    const webhookKey = crypto
      .createHash("sha256")
      .update(`${event?.event || ""}|${orderId}|${paymentId}|${entity.amount ?? ""}`)
      .digest("hex");
    try {
      const WebhookEvent = require("../models/WebhookEvent");
      await WebhookEvent.create({
        key: webhookKey,
        event: event?.event || "",
        orderId: String(orderId),
        paymentId: String(paymentId),
      });
    } catch (e) {
      if (e?.code === 11000) {
        return res.status(200).json({ received: true, handled: "duplicate" });
      }
      console.error(`WEBHOOK DEDUP STORE FAILED order=${orderId} pay=${paymentId}: ${e?.message || e}`);
      return res.status(500).json({ received: true, handled: false, retry: true });
    }

    let booking = await Booking.findOne({
      $or: [
        { "payment.razorpayOrderId": orderId },
        { "payment.razorpayOrderIds": orderId },
      ],
    });
    if (!booking) return res.status(200).json({ received: true, handled: false });
    if (booking.payment?.status === "paid") {
      return res.status(200).json({ received: true, handled: true });
    }
    const expectedPaise = Math.round(Number(booking.amount || 0) * 100);
    const wantCurrency = String(process.env.RAZORPAY_CURRENCY || "INR").toUpperCase();
    const gotCurrency = String(entity.currency || "").toUpperCase();
    if (gotCurrency && gotCurrency !== wantCurrency) {
      return res.status(200).json({ received: true, handled: false });
    }
    if (booking.status === "accepted" && Number(entity.amount) === expectedPaise) {
      const now = new Date();
      const claimed = await Booking.findOneAndUpdate(
        {
          _id: booking._id,
          status: "accepted",
          "payment.status": { $ne: "paid" },
          $or: [
            { "payment.razorpayOrderId": orderId },
            { "payment.razorpayOrderIds": orderId },
          ],
        },
        {
          $set: {
            "payment.razorpayOrderId": orderId,
            "payment.razorpayPaymentId": paymentId,
            "payment.razorpaySignature": "",
            "payment.webhookReconciled": true,
            "payment.status": "paid",
            "payment.paidAmount": booking.amount,
            "payment.paidAt": now,
            "payment.testMode": false,
            status: "confirmed",
          },
          $push: {
            statusHistory: {
              status: "confirmed",
              note: "Payment captured (confirmed via Razorpay webhook after the app confirm call was missed)",
            },
          },
        },
        { new: true }
      );
      if (!claimed) {
        let latest = null;
        try {
          latest = await Booking.findOne({
            $or: [
              { "payment.razorpayOrderId": orderId },
              { "payment.razorpayOrderIds": orderId },
            ],
          });
        } catch {
          latest = null;
        }
        if (latest?.payment?.status === "paid") {
          return res.status(200).json({ received: true, handled: true });
        }
        return res.status(200).json({ received: true, handled: false });
      }
      booking = claimed;
      try {
        const WebhookEvent = require("../models/WebhookEvent");
        await WebhookEvent.updateOne({ key: webhookKey }, { $set: { booking: booking._id } });
      } catch {
      }
      const { recordLedger } = require("../utils/finance");
      await recordLedger({
        idempotencyKey: `pay:${booking._id}:${paymentId}`,
        booking: booking._id,
        type: "payment.webhook_confirmed",
        amount: Math.round(Number(booking.amount || 0)),
        prevState: "payment:pending",
        newState: "payment:paid",
        actor: "system",
        source: "webhook",
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        reason: "Razorpay payment.captured reconciled",
      });
      try {
        await Notification.create({
          user: booking.cook,
          type: "booking_confirmed",
          booking: booking._id,
          message: `Payment received — booking confirmed for ${new Date(
            booking.date
          ).toDateString()} at ${booking.startTime}.`,
        });
        await Notification.create({
          user: booking.customer,
          type: "booking_confirmed",
          booking: booking._id,
          message: "Booking confirmed — your payment was received!",
        });
      } catch {
      }
      return res.status(200).json({ received: true, handled: true });
    }
    try {
      const pay = booking.payment || {};
      if (
        pay.status !== "paid" &&
        !pay.testMode &&
        (!pay.refundStatus || pay.refundStatus === "none")
      ) {
        const amount = Math.round(Number(entity.amount || 0) / 100) || Math.round(Number(booking.amount || 0));
        if (amount > 0) {
          booking.payment = {
            ...(booking.payment?.toObject ? booking.payment.toObject() : booking.payment || {}),
            razorpayOrderId: booking.payment?.razorpayOrderId || orderId,
            razorpayPaymentId: paymentId,
            refundStatus: "pending",
            refundAmount: amount,
          };
          booking.statusHistory.push({
            status: booking.status,
            note: `Refund of ₹${amount} queued for admin approval (webhook captured after window closed)`,
          });
          try {
            await booking.save();
          } catch {
          }
        }
      }
    } catch {
    }
    try {
      await Notification.create({
        user: booking.customer,
        type: "refund_pending",
        booking: booking._id,
        message: `We received your payment (${paymentId}) but booking ${booking._id} is ${booking.status}. A refund has been queued for admin approval — please keep this payment ID for support.`,
      });
    } catch {
    }
    return res.status(200).json({ received: true, handled: false });
  } catch {
    return res.status(200).json({ received: true, handled: false });
  }
};

exports.verifyPayment = async (req, res, next) => {
  try {
    if (!isConfigured) {
      return res.status(503).json({ message: "Online payments are not configured." });
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, bookingId } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Payment details are incomplete" });
    }
    if (!bookingId) {
      return res.status(400).json({ message: "bookingId is required — verification is per booking." });
    }
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    const a = Buffer.from(String(expected), "utf8");
    const b = Buffer.from(String(razorpay_signature), "utf8");
    const signatureOk = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!signatureOk) {
      return res.json({ verified: false });
    }
    const booking = await Booking.findById(bookingId).select(
      "customer amount payment"
    );
    if (!booking || String(booking.customer) !== String(req.user.id)) {
      return res.status(403).json({ message: "Not authorized for this booking" });
    }
    const storedOrderId = String(booking.payment?.razorpayOrderId || "");
    if (!storedOrderId || storedOrderId !== String(razorpay_order_id)) {
      return res.json({ verified: false });
    }
    const { assertRazorpayOrderAmount } = require("../utils/razorpayVerify");
    const orderErr = await assertRazorpayOrderAmount(
      razorpay_order_id,
      Number(booking.amount || 0) * 100
    );
    return res.json({ verified: !orderErr });
  } catch (error) {
    next(error);
  }
};
