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

// POST /api/payments/order — create a Razorpay order for a booking window.
// Body: { cook, date, startTime, endTime, durationHours?, bookingId? }.
// With bookingId (the real checkout path) the order charges the booking's
// stored payable (launch slab minus coupon). Returns the order for Checkout.
//
// In-flight mint guard (F-03 backend half): concurrent taps for one booking
// share a single mint promise so only one gateway order is created.
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
    // Suspended accounts take no money either (mirrors createBooking).
    try {
      const User = require("../models/User");
      const cookAccount = await User.findById(cook).select("status");
      if (!cookAccount || cookAccount.status === "suspended") {
        return res.status(400).json({ message: "Cook not found or not approved" });
      }
    } catch {
      return res.status(400).json({ message: "Cook not found or not approved" });
    }

    // Same window guards as booking so users can't pay for unavailable time.
    // Strict time/date shape (full HH:MM, real calendar day, 30-min grid)
    // so malformed slots never reach the gateway.
    const strictStart = parseTimeStrict(startTime);
    const strictEnd = parseTimeStrict(endTime);
    if (strictStart == null || strictEnd == null || strictEnd <= strictStart) {
      return res.status(400).json({ message: "Invalid time slot" });
    }
    if (!isOnGrid(strictStart) || !isOnGrid(strictEnd)) {
      return res.status(400).json({ message: "Start and end times must be on 30-minute intervals" });
    }
    if (!parseDayStrict(date)) {
      return res.status(400).json({ message: "Valid date (YYYY-MM-DD) is required" });
    }
    if (istDayString(parseDayStrict(date)) < istDayString()) {
      return res.status(400).json({ message: "That date already passed — please pick today or a future date." });
    }
    const windows = await getDayWindows(cook, date);
    if (!findContainingWindow(windows, startTime, endTime)) {
      return res.status(400).json({ message: "Cook is not available for the selected time" });
    }
    const activeBookings = await getDayBookings(cook, date);
    // Post-acceptance checkout: the customer's own held request occupies this
    // window — exclude it so paying for your own hold isn't a "conflict".
    const othersBookings = bookingId
      ? activeBookings.filter((b) => String(b._id) !== String(bookingId))
      : activeBookings;
    if (findOverlapBooking(othersBookings, startTime, endTime)) {
      return res.status(409).json({ message: "This time is already booked. Please pick another start time." });
    }

    const startMin = timeToMinutes(startTime);
    const endMin = timeToMinutes(endTime);
    if (startMin == null || endMin == null || endMin <= startMin) {
      return res.status(400).json({ message: "Invalid time slot" });
    }
    const hours = (endMin - startMin) / 60;
    // Generic (pre-booking) orders must use the same whole-hour launch slabs
    // as booking creation — otherwise the gateway charges rate x hours while
    // the booking later settles a flat slab price (e.g. 2h = 349).
    if (!Number.isInteger(hours) || hours < 1 || hours > 4) {
      return res.status(400).json({ message: "Sessions run 1–4 whole hours" });
    }
    if (durationHours != null && durationHours !== "") {
      const stated = Number(durationHours);
      if (!Number.isInteger(stated) || stated !== hours) {
        return res.status(400).json({ message: "Duration does not match the selected time slot" });
      }
    }

    // Post-acceptance checkout must be for the customer's own live booking:
    // it must exist, belong to them, still await payment, and match this
    // window. A bare order without bookingId is refused — a captured payment
    // with no booking to attach to has no reconciliation path (the webhook
    // matches by the order id stored on the booking), so it would be
    // orphaned money. The gateway always charges the booking's stored
    // payable (slab price minus any coupon) — never a recomputed rack rate.
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
    // The payment window may have elapsed while the customer sat on the
    // payment page — never mint an order for a dead window (they'd pay in
    // Checkout and land on a 410 with captured money).
    try {
      const { expireBookingIfNeeded } = require("./bookingController");
      await expireBookingIfNeeded(bookingForOrder);
    } catch {
      // non-fatal: the checks below still apply
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

    // Fully-discounted session (100% coupon): nothing to charge. Return a
    // zero-amount "free" order so Checkout skips the gateway and the confirm
    // call records a no-money payment — never mint a ₹1 order for a ₹0 fee
    // (Razorpay amounts must match the booking's payable exactly).
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

    // F-03/F-04: a refresh or double-tap must not mint a second gateway order.
    // First the stored-order reuse below (refresh recovery), then the
    // in-flight guard (concurrent double-tap): the loser awaits the winner's
    // mint and receives the same order id.
    const mintKey = `order:${bookingForOrder._id}`;
    if (inflightOrderMints.has(mintKey)) {
      try {
        const prior = await inflightOrderMints.get(mintKey);
        return res.status(200).json({ ...prior, reused: true });
      } catch {
        // Winner failed — fall through and attempt the mint ourselves.
      }
    }
    const mintTask = (async () => {
      // Idempotent reuse: a retry/refresh while the window is still live must
      // NOT mint a second gateway order. If this booking already has a stored
      // order that still charges exactly this fee, hand it back instead of
      // creating another one (the confirm call accepts it either way).
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
          // Stored order is stale (amount/currency drifted after a coupon
          // change) — fall through and mint a fresh one below.
        } catch {
          // Unreadable order (deleted/expired at the gateway or gateway down):
          // fall through and mint a fresh one. A fetch failure here must not
          // block payment — the confirm path re-verifies whatever is paid.
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
        // Gateway rejection (bad keys, network, etc.) maps to a clear 502
        // instead of leaking a raw 500 — the frontend shows this message.
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

      // Persist the gateway order id on the booking so the webhook can match a
      // captured payment back to it even if the customer closes the browser
      // before the confirm call fires. History is kept so an overwritten order
      // can never orphan captured money. Atomic $set+$push (not read-modify-
      // save) so two concurrent order creations cannot lose each other's id.
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
          // non-fatal: the confirm call carries the same order id
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

// POST /api/payments/webhook — Razorpay event webhook (NO auth; verified by
// HMAC signature instead). server.js mounts express.raw() for this path so
// req.body is the raw Buffer Razorpay signed.
//
// Why it exists: if the customer closes the browser after paying in Checkout
// but before PATCH /bookings/:id/pay fires, money is captured while the
// booking still awaits payment (and would later expire). On
// `payment.captured` we reconcile: confirm the still-payable booking, or
// flag the customer for manual refund when the window already closed.
// Always responds 200 quickly — Razorpay retries anything slower/5xx.
exports.handleWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || "";
    const signature = req.headers["x-razorpay-signature"];
    const raw = req.body && Buffer.isBuffer(req.body) ? req.body : null;
    if (!secret || !signature || !raw) {
      // Can't verify — acknowledge without acting (avoids retry storms and
      // never mutates bookings on unverified calls).
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
    // Only captured money reconciles — authorized/failed/refunded events
    // never flip a booking to paid.
    if (String(entity.status || "").toLowerCase() !== "captured") {
      return res.status(200).json({ received: true, handled: false });
    }
    // Event de-duplication: identical deliveries carry identical payloads,
    // so a content key admits exactly one processing — concurrent redeliveries
    // race on the unique index instead of on the booking.
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
      // A dedup-store outage must not lose money events: fall through to the
      // paid-status idempotency below (fail-open narrowly, logged loudly).
      console.error(`WEBHOOK DEDUP STORE FAILED order=${orderId} pay=${paymentId}: ${e?.message || e}`);
    }

    const booking = await Booking.findOne({
      $or: [
        { "payment.razorpayOrderId": orderId },
        { "payment.razorpayOrderIds": orderId },
      ],
    });
    if (!booking) return res.status(200).json({ received: true, handled: false });
    // Idempotent: the confirm call already recorded this payment.
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
      booking.payment = {
        ...(booking.payment?.toObject ? booking.payment.toObject() : booking.payment || {}),
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: "",
        webhookReconciled: true,
        status: "paid",
        paidAmount: booking.amount,
        paidAt: new Date(),
        testMode: false,
      };
      booking.status = "confirmed";
      booking.statusHistory.push({
        status: "confirmed",
        note: "Payment captured (confirmed via Razorpay webhook after the app confirm call was missed)",
      });
      await booking.save();
      try {
        const WebhookEvent = require("../models/WebhookEvent");
        await WebhookEvent.updateOne({ key: webhookKey }, { $set: { booking: booking._id } });
      } catch {
        // non-fatal: the event row already exists for tracing
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
        // non-fatal
      }
      return res.status(200).json({ received: true, handled: true });
    }
    // Money captured but the booking can no longer take it (expired /
    // cancelled / amount mismatch): queue a refund for admin approval AND
    // tell the customer, instead of silently keeping the payment.
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
            // non-fatal: notification below still fires
          }
        }
      }
    } catch {
      // non-fatal
    }
    try {
      await Notification.create({
        user: booking.customer,
        type: "booking_cancelled",
        booking: booking._id,
        message: `We received your payment (${paymentId}) but booking ${booking._id} is ${booking.status}. Please contact support with this payment ID for a refund.`,
      });
    } catch {
      // non-fatal
    }
    return res.status(200).json({ received: true, handled: false });
  } catch {
    // Never 500 a webhook — that triggers gateway retries.
    return res.status(200).json({ received: true, handled: false });
  }
};

// POST /api/payments/verify — verify a Razorpay payment signature FOR ONE
// BOOKING. HMAC-only "is this triple genuine?" answers are misleading (a
// genuine triple for another booking also verifies), so this endpoint binds
// the triple to the caller's booking: ownership, stored order id, and the
// gateway order amount must all match. It never confirms a booking —
// PATCH /bookings/:id/pay remains the only confirm path.
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
