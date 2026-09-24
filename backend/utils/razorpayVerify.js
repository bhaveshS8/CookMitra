// Shared Razorpay verification — HMAC proves a triple is genuine, but only a
// server-side fetch proves the money actually moved for THIS booking.
// Enforced whenever the gateway client is configured; callers fail closed
// when verification is unavailable.
const { razorpay: razorpayClient, isConfigured } = require("../config/razorpay");

const expectedCurrency = () => process.env.RAZORPAY_CURRENCY || "INR";

// Order must charge exactly this booking's fee (blocks cheap-order replay).
const assertRazorpayOrderAmount = async (orderId, expectedPaise) => {
  if (!isConfigured || !razorpayClient) return null;
  let order;
  try {
    order = await razorpayClient.orders.fetch(orderId);
  } catch {
    return "Payment could not be verified with the gateway. Please try again.";
  }
  if (Number(order?.amount) !== Math.round(Number(expectedPaise))) {
    return "Paid amount does not match this booking's fee. Please create a fresh payment.";
  }
  return null;
};

// Payment must be captured (not merely authorized/failed), for the expected
// amount and currency, and belong to the submitted order. Returns null when
// OK, otherwise a client-facing error message.
const assertRazorpayPaymentCaptured = async (
  orderId,
  paymentId,
  expectedPaise
) => {
  if (!isConfigured || !razorpayClient) return null;
  let payment;
  try {
    payment = await razorpayClient.payments.fetch(paymentId);
  } catch {
    return "Payment could not be verified with the gateway. Please try again.";
  }
  if (String(payment?.order_id || "") !== String(orderId)) {
    return "This payment does not belong to this booking. Please start a fresh payment.";
  }
  if (String(payment?.status || "").toLowerCase() !== "captured") {
    return "Payment has not been captured yet. Please complete the payment and try again.";
  }
  if (Number(payment?.amount) !== Math.round(Number(expectedPaise))) {
    return "Paid amount does not match this booking's fee. Please create a fresh payment.";
  }
  const wantCurrency = String(expectedCurrency() || "INR").toUpperCase();
  const gotCurrency = String(payment?.currency || "").toUpperCase();
  if (gotCurrency && gotCurrency !== wantCurrency) {
    return "Payment currency does not match this booking. Please create a fresh payment.";
  }
  if (payment?.refunded || Number(payment?.amount_refunded || 0) > 0) {
    return "This payment has already been refunded. Please start a fresh payment.";
  }
  return null;
};

module.exports = {
  assertRazorpayOrderAmount,
  assertRazorpayPaymentCaptured,
  expectedCurrency,
};
