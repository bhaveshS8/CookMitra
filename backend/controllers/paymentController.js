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

// POST /api/payments/order — create a Razorpay order for a booking window.
// Body: { cook, date, startTime, endTime, durationHours?, bookingId? }.
// With bookingId (the real checkout path) the order charges the booking's
// stored payable (launch slab minus coupon). Returns the order for Checkout.
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

    // Same window guards as booking so users can't pay for unavailable time.
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
    // window. (A bare order without bookingId stays generic — pre-booking.)
    // The gateway always charges the booking's stored payable (slab price
    // minus any coupon) — never a recomputed rack rate.
    let bookingForOrder = null;
    let fullFee;
    if (bookingId) {
      bookingForOrder = await Booking.findById(bookingId).select(
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
      if (
        String(bookingForOrder.cook) !== String(cook) ||
        bookingForOrder.startTime !== startTime ||
        bookingForOrder.endTime !== endTime
      ) {
        return res.status(400).json({ message: "Order does not match the booking window" });
      }
      fullFee = Math.max(1, Math.round(Number(bookingForOrder.amount) || 0));
    } else {
      // No booking yet: charge the same launch slab the booking will settle.
      // Uses the slab price (199/349/499/649), NOT rate x hours — the legacy
      // rate field is no longer a price and must never set gateway amounts.
      const { slabPriceForDuration } = require("../utils/pricing");
      fullFee = slabPriceForDuration(hours);
      if (fullFee == null) {
        return res.status(400).json({ message: "Sessions run 1–4 whole hours" });
      }
    }
    const amountPaise = fullFee * 100;

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
      const detail =
        gwErr?.error?.description || gwErr?.message || "the gateway rejected the request";
      return res.status(502).json({
        message: `Payment gateway error: ${detail}. Please check RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET.`,
      });
    }

    // Persist the gateway order id on the booking so the webhook can match a
    // captured payment back to it even if the customer closes the browser
    // before the confirm call fires.
    if (bookingForOrder) {
      try {
        bookingForOrder.payment = bookingForOrder.payment || {};
        bookingForOrder.payment.razorpayOrderId = order.id;
        await bookingForOrder.save();
      } catch {
        // non-fatal: the confirm call carries the same order id
      }
    }

    res.status(201).json({
      orderId: order.id,
      amount: fullFee,
      amountPaise,
      currency: order.currency,
      hours,
      fullFee,
      keyId,
    });
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

    const booking = await Booking.findOne({ "payment.razorpayOrderId": orderId });
    if (!booking) return res.status(200).json({ received: true, handled: false });
    // Idempotent: the confirm call already recorded this payment.
    if (booking.payment?.status === "paid") {
      return res.status(200).json({ received: true, handled: true });
    }
    const expectedPaise = Math.round(Number(booking.amount || 0) * 100);
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
        await Notification.create({
          user: booking.cook,
          type: "booking_confirmed",
          message: `Payment received — booking confirmed for ${new Date(
            booking.date
          ).toDateString()} at ${booking.startTime}.`,
        });
        await Notification.create({
          user: booking.customer,
          type: "booking_confirmed",
          message: "Booking confirmed — your payment was received!",
        });
      } catch {
        // non-fatal
      }
      return res.status(200).json({ received: true, handled: true });
    }
    // Money captured but the booking can no longer take it (expired /
    // cancelled / amount mismatch): tell the customer to contact support for
    // a manual refund instead of silently keeping the payment.
    try {
      await Notification.create({
        user: booking.customer,
        type: "booking_cancelled",
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

// POST /api/payments/verify — verify a Razorpay payment signature.
exports.verifyPayment = async (req, res, next) => {
  try {
    if (!isConfigured) {
      return res.status(503).json({ message: "Online payments are not configured." });
    }
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Payment details are incomplete" });
    }
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");
    const a = Buffer.from(String(expected), "utf8");
    const b = Buffer.from(String(razorpay_signature), "utf8");
    res.json({ verified: a.length === b.length && crypto.timingSafeEqual(a, b) });
  } catch (error) {
    next(error);
  }
};
