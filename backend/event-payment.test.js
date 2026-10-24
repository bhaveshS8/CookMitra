// Event payment lifecycle tests with a mocked Razorpay gateway and an isolated
// MongoDB database. No real money, live keys, or production data are used.
const crypto = require("crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.RAZORPAY_KEY_ID = "rk_test_eventpay_123456";
process.env.RAZORPAY_KEY_SECRET = "eventpay_test_secret_abcdef123456";
process.env.RAZORPAY_WEBHOOK_SECRET = "eventpay_webhook_secret_123456";
process.env.RAZORPAY_CURRENCY = "INR";
process.env.EVENT_PAYMENTS_REQUIRED = "false";

const RUN = `evpay${Date.now().toString(36)}`;
const TEST_DB = "cookmitra_eventpay";
let failures = 0;

const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) failures++;
};

const mockRes = () => {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

const nextFail = (error) =>
  check("controller did not call next(err)", false, String((error && error.stack) || error));

const futureDay = (daysAhead) => {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const signCheckout = (orderId, paymentId) =>
  crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

(async () => {
  let memoryServer = null;
  let baseUri = String(process.env.EVENT_PAYMENT_TEST_MONGODB_URI || "").trim();
  if (!baseUri) {
    console.log("STARTING_MEMORY  isolated Event payment database");
    memoryServer = await MongoMemoryServer.create();
    baseUri = await memoryServer.getUri(`${TEST_DB}_base`);
  }
  const testUri = baseUri.replace(/\/([^/?]+)(\?|$)/, `/${TEST_DB}$2`);
  if (testUri === baseUri) {
    console.log("SKIP  could not derive isolated test database URI");
    process.exit(0);
  }
  try {
    await mongoose.connect(testUri, { serverSelectionTimeoutMS: 12000 });
  } catch (e) {
    console.log(`SKIP  test database unreachable - ${(e.message || "").slice(0, 100)}`);
    process.exit(0);
  }

  const rzCfg = require("./config/razorpay");
  const EventBooking = require("./models/EventBooking");
  const EventLedgerEntry = require("./models/EventLedgerEntry");
  const User = require("./models/User");
  const CookProfile = require("./models/CookProfile");
  const WebhookEvent = require("./models/WebhookEvent");
  const { istMidnight } = require("./utils/time");
  const whatsappApi = require("./utils/whatsappApi");
  const eventCtrl = require("./controllers/eventBookingController");
  const payCtrl = require("./controllers/eventPaymentController");
  const paymentCtrl = require("./controllers/paymentController");
  const { eventPaymentsRequired, finalizeEventPayment } = require("./services/eventPaymentService");

  const waSends = [];
  const originalWaSend = whatsappApi.sendWhatsAppText;
  whatsappApi.sendWhatsAppText = async (to, body) => {
    waSends.push({ to, body });
    return { ok: true, id: `wamid.event-payment.${waSends.length}` };
  };

  let orderSeq = 0;
  let refundCalls = 0;
  let orderCreates = 0;
  let refundStatusOverride = "";
  const orders = new Map();
  const payments = new Map();
  const refunds = new Map();
  rzCfg.razorpay.orders.create = async (payload) => {
    orderCreates += 1;
    const id = `order_${RUN}_${++orderSeq}`;
    const order = { ...payload, id };
    orders.set(id, order);
    return order;
  };
  rzCfg.razorpay.orders.fetch = async (id) => {
    const order = orders.get(id);
    if (!order) throw new Error("order not found");
    return order;
  };
  rzCfg.razorpay.payments.fetch = async (id) => {
    const payment = payments.get(id);
    if (!payment) throw new Error("payment not found");
    return payment;
  };
  rzCfg.razorpay.payments.refund = async (paymentId, payload) => {
    refundCalls += 1;
    const refund = {
      id: `rfnd_${RUN}_${refundCalls}`,
      payment_id: paymentId,
      amount: payload.amount,
      status: refundStatusOverride || "processed",
    };
    refunds.set(paymentId, [...(refunds.get(paymentId) || []), refund]);
    return refund;
  };
  rzCfg.razorpay.refunds = {
    all: async ({ payment_id }) => ({ items: refunds.get(payment_id) || [] }),
  };

  const mintPayment = (orderId, amountPaise, { id = `pay_${RUN}_${orderId}` } = {}) => {
    const payment = { id, order_id: orderId, amount: amountPaise, currency: "INR", status: "captured", amount_refunded: 0 };
    payments.set(id, payment);
    return payment;
  };

  const BASE = {
    eventType: "Birthday",
    eventDate: istMidnight(futureDay(20)),
    startTime: "09:00",
    duration: 2,
    guestCount: 10,
    address: "1 Payment Test St",
    menu: "Rice, Dal",
    serviceType: "preparation_cooking",
    totalAmount: 1000,
    distanceKm: 5,
    distanceVerified: true,
  };

  try {
    await mongoose.connection.db.dropDatabase();
    const customer = await User.create({
      name: `${RUN} customer`,
      email: `${RUN}-customer@test.example.com`,
      password: "Test1234!",
      phone: "9876543210",
      role: "CUSTOMER",
      status: "active",
    });
    const admin = await User.create({
      name: `${RUN} admin`,
      email: `${RUN}-admin@test.example.com`,
      password: "Test1234!",
      phone: "9876543211",
      role: "ADMIN",
      status: "active",
    });
    const cook = await User.create({
      name: `${RUN} cook`,
      email: `${RUN}-cook@test.example.com`,
      password: "Test1234!",
      phone: "9876543212",
      role: "COOK",
      status: "active",
    });
    await CookProfile.create({ user: cook._id, approvalStatus: "approved" });

    const createEvent = (suffix, over = {}) =>
      EventBooking.create({
        ...BASE,
        bookingId: `${RUN}-${suffix}`,
        customerId: customer._id,
        cookId: cook._id,
        bookingStatus: "cook_assigned",
        ...over,
      });

    const customerReq = (event) => ({
      params: { id: String(event._id) },
      user: { id: String(customer._id), role: "customer" },
      body: {},
    });
    const adminReq = (event, body = {}) => ({
      params: { id: String(event._id) },
      user: { id: String(admin._id), role: "admin" },
      body,
    });

    const event1 = await createEvent("A");
    const orderRes1 = mockRes();
    await payCtrl.createEventOrder(customerReq(event1), orderRes1, nextFail);
    check("order created for eligible event", orderRes1.statusCode === 200 && orderRes1.body?.orderId, JSON.stringify(orderRes1.body));
    check("order amount matches finalized event total", orderRes1.body?.amount === 100000, String(orderRes1.body?.amount));
    check("test-mode key is returned for checkout", String(orderRes1.body?.keyId || "").startsWith("rk_test_"), orderRes1.body?.keyId);

    const orderRes2 = mockRes();
    await payCtrl.createEventOrder(customerReq(event1), orderRes2, nextFail);
    check("repeated order request reuses the stored order", orderRes2.body?.orderId === orderRes1.body?.orderId && orderCreates === 1, `${orderRes2.body?.orderId} / creates=${orderCreates}`);
    check("stored order id persisted on event", (await EventBooking.findById(event1._id)).payment.razorpayOrderId === orderRes1.body?.orderId, "");

    const orderId1 = orderRes1.body.orderId;
    const payment1 = mintPayment(orderId1, 100000);
    const verifyBody = {
      razorpay_order_id: orderId1,
      razorpay_payment_id: payment1.id,
      razorpay_signature: signCheckout(orderId1, payment1.id),
    };
    const badVerifyRes = mockRes();
    await payCtrl.verifyEventPayment(
      { params: { id: String(event1._id) }, user: { id: String(customer._id), role: "customer" }, body: { ...verifyBody, razorpay_signature: "00" } },
      badVerifyRes,
      nextFail
    );
    check("bad checkout signature is rejected", badVerifyRes.statusCode === 400, String(badVerifyRes.statusCode));
    check("bad signature does not mark event paid", (await EventBooking.findById(event1._id)).payment.status === "pending", "");

    const verifyRes = mockRes();
    await payCtrl.verifyEventPayment({ ...customerReq(event1), body: verifyBody }, verifyRes, nextFail);
    const paid1 = await EventBooking.findById(event1._id);
    check("valid checkout capture confirms and pays event", verifyRes.statusCode === 200 && paid1.bookingStatus === "confirmed" && paid1.payment.status === "paid", JSON.stringify({ status: paid1.bookingStatus, pay: paid1.payment.status }));
    check("paid amount is the finalized full amount", paid1.payment.paidAmount === 1000, String(paid1.payment.paidAmount));
    check("test-mode payment is marked", paid1.payment.testMode === true, String(paid1.payment.testMode));
    check("payment ledger entry created", (await EventLedgerEntry.countDocuments({ eventBooking: paid1._id, type: "event_payment.confirmed" })) === 1, "");
    await new Promise((resolve) => setTimeout(resolve, 100));
    check(
      "confirmed payment sends cook WhatsApp details",
      waSends.length === 1 &&
        waSends[0].to === "9876543212" &&
        waSends[0].body.includes(`${RUN}-A`) &&
        waSends[0].body.includes("Birthday"),
      JSON.stringify(waSends.map((send) => send.to))
    );

    const dupVerifyRes = mockRes();
    await payCtrl.verifyEventPayment({ ...customerReq(event1), body: verifyBody }, dupVerifyRes, nextFail);
    check("duplicate verification is idempotent", dupVerifyRes.statusCode === 200 && dupVerifyRes.body?.payment?.status === "paid", String(dupVerifyRes.statusCode));
    check("duplicate verification does not duplicate ledger", (await EventLedgerEntry.countDocuments({ eventBooking: paid1._id, type: "event_payment.confirmed" })) === 1, "");
    await new Promise((resolve) => setTimeout(resolve, 50));
    check("duplicate verification does not resend WhatsApp", waSends.length === 1, String(waSends.length));

    const eventFailed = await createEvent("K");
    const orderFailedRes = mockRes();
    await payCtrl.createEventOrder(customerReq(eventFailed), orderFailedRes, nextFail);
    const failedPayment = mintPayment(orderFailedRes.body.orderId, 100000, { id: `pay_failed_${RUN}` });
    failedPayment.status = "failed";
    const failedVerifyRes = mockRes();
    await payCtrl.verifyEventPayment(
      {
        ...customerReq(eventFailed),
        body: {
          razorpay_order_id: orderFailedRes.body.orderId,
          razorpay_payment_id: failedPayment.id,
          razorpay_signature: signCheckout(orderFailedRes.body.orderId, failedPayment.id),
        },
      },
      failedVerifyRes,
      nextFail
    );
    const failedAfter = await EventBooking.findById(eventFailed._id);
    check(
      "failed payment is not confirmed",
      failedVerifyRes.statusCode === 400 &&
        failedAfter.payment.status === "pending" &&
        failedAfter.payment.refundStatus === "none",
      JSON.stringify({ status: failedVerifyRes.statusCode, pay: failedAfter.payment.status, refund: failedAfter.payment.refundStatus })
    );
    check("failed payment does not queue a refund", failedVerifyRes.body?.refundQueued === false, JSON.stringify(failedVerifyRes.body));

    const pendingPayment = mintPayment(orderFailedRes.body.orderId, 100000, { id: `pay_pending_${RUN}` });
    pendingPayment.status = "pending";
    const pendingVerifyRes = mockRes();
    await payCtrl.verifyEventPayment(
      {
        ...customerReq(eventFailed),
        body: {
          razorpay_order_id: orderFailedRes.body.orderId,
          razorpay_payment_id: pendingPayment.id,
          razorpay_signature: signCheckout(orderFailedRes.body.orderId, pendingPayment.id),
        },
      },
      pendingVerifyRes,
      nextFail
    );
    const pendingAfter = await EventBooking.findById(eventFailed._id);
    check(
      "pending payment is not confirmed",
      pendingVerifyRes.statusCode === 400 &&
        pendingAfter.payment.status === "pending" &&
        pendingAfter.payment.refundStatus === "none",
      JSON.stringify({ status: pendingVerifyRes.statusCode, pay: pendingAfter.payment.status, refund: pendingAfter.payment.refundStatus })
    );

    const failedWebhookPayload = { event: "payment.failed", payload: { payment: { entity: failedPayment } } };
    const failedWebhookRaw = Buffer.from(JSON.stringify(failedWebhookPayload));
    const failedWebhookSig = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(failedWebhookRaw)
      .digest("hex");
    const failedWebhookRes = mockRes();
    await paymentCtrl.handleWebhook(
      { headers: { "x-razorpay-signature": failedWebhookSig }, body: failedWebhookRaw },
      failedWebhookRes
    );
    const failedWebhookEvent = await EventBooking.findById(eventFailed._id);
    const failedWebhookDedupe = await WebhookEvent.findOne({ paymentId: failedPayment.id });
    check(
      "failed-payment webhook is ignored safely",
      failedWebhookRes.statusCode === 200 &&
        failedWebhookRes.body?.handled === false &&
        failedWebhookEvent.payment.status === "pending" &&
        failedWebhookDedupe === null,
      JSON.stringify({ body: failedWebhookRes.body, pay: failedWebhookEvent.payment.status })
    );

    const eventAbandoned = await createEvent("L");
    const createsBeforeAbandoned = orderCreates;
    const abandonedOrder1 = mockRes();
    await payCtrl.createEventOrder(customerReq(eventAbandoned), abandonedOrder1, nextFail);
    const abandonedOrder2 = mockRes();
    await payCtrl.createEventOrder(customerReq(eventAbandoned), abandonedOrder2, nextFail);
    const abandonedAfter = await EventBooking.findById(eventAbandoned._id);
    check(
      "abandoned order remains reusable without duplicate order creation",
      abandonedOrder1.body?.orderId &&
        abandonedOrder2.body?.orderId === abandonedOrder1.body.orderId &&
        orderCreates === createsBeforeAbandoned + 1 &&
        abandonedAfter.payment.status === "pending",
      JSON.stringify({ first: abandonedOrder1.body?.orderId, second: abandonedOrder2.body?.orderId, creates: orderCreates - createsBeforeAbandoned })
    );

    const lockedRes = mockRes();
    await eventCtrl.verifyTravelDistance(
      { params: { id: String(event1._id) }, user: { id: String(admin._id), role: "admin" }, body: { distanceKm: 12 } },
      lockedRes,
      nextFail
    );
    check("paid event travel/final amount is immutable", lockedRes.statusCode === 409 && lockedRes.body?.code === "EVENT_PAYMENT_LOCKED", JSON.stringify(lockedRes.body));

    const event2 = await createEvent("B", { distanceVerified: false });
    const notReadyRes = mockRes();
    await payCtrl.createEventOrder(customerReq(event2), notReadyRes, nextFail);
    check("payment is blocked before distance verification", notReadyRes.statusCode === 400, `${notReadyRes.statusCode} ${notReadyRes.body?.message || ""}`);

    process.env.EVENT_PAYMENTS_REQUIRED = "true";
    const gateRes = mockRes();
    await eventCtrl.updateEventBookingStatus(
      { params: { id: String(event2._id) }, user: { id: String(admin._id), role: "admin" }, body: { status: "confirmed" } },
      gateRes,
      nextFail
    );
    check("flag blocks unpaid confirmation", gateRes.statusCode === 400 && gateRes.body?.code === "EVENT_PAYMENT_REQUIRED", JSON.stringify(gateRes.body));
    process.env.EVENT_PAYMENTS_REQUIRED = "false";

    const cancelViaStatusRes = mockRes();
    await eventCtrl.updateEventBookingStatus(
      { params: { id: String(event2._id) }, user: { id: String(admin._id), role: "admin" }, body: { status: "cancelled" } },
      cancelViaStatusRes,
      nextFail
    );
    const statusCancelledEvent = await EventBooking.findById(event2._id);
    check(
      "status endpoint cannot bypass cancellation/refunds",
      cancelViaStatusRes.statusCode === 400 &&
        cancelViaStatusRes.body?.code === "USE_CANCEL_ENDPOINT" &&
        statusCancelledEvent.bookingStatus === "cook_assigned",
      JSON.stringify({ status: cancelViaStatusRes.statusCode, body: cancelViaStatusRes.body, booking: statusCancelledEvent.bookingStatus })
    );

    const cancelRes = mockRes();
    await eventCtrl.cancelEventBooking(customerReq(paid1), cancelRes, nextFail);
    const cancelled = await EventBooking.findById(paid1._id);
    check("pre-service cancellation queues full refund", cancelRes.statusCode === 200 && cancelled.bookingStatus === "cancelled" && cancelled.payment.refundStatus === "pending", JSON.stringify({ status: cancelled.bookingStatus, refund: cancelled.payment.refundStatus }));
    check("queued refund equals the full paid amount", cancelled.payment.refundAmount === 1000, String(cancelled.payment.refundAmount));
    check("refund request ledger entry created", (await EventLedgerEntry.countDocuments({ eventBooking: paid1._id, type: "event_refund.requested" })) >= 1, "");

    await EventBooking.updateOne({ _id: paid1._id }, { $set: { "payment.testMode": false } });
    const approveRes = mockRes();
    await payCtrl.approveEventRefund(adminReq(cancelled), approveRes, nextFail);
    const refunded = await EventBooking.findById(paid1._id);
    check("admin approval processes real-mode full refund", approveRes.statusCode === 200 && refunded.payment.refundStatus === "processed", JSON.stringify({ status: refunded.payment.refundStatus, err: refunded.payment.refundError }));
    check("gateway refund called exactly once", refundCalls === 1, String(refundCalls));
    check("gateway refund id stored", String(refunded.payment.refundId || "").startsWith("rfnd_"), refunded.payment.refundId);
    check("refund processed ledger entry created", (await EventLedgerEntry.countDocuments({ eventBooking: paid1._id, type: "event_refund.processed" })) === 1, "");

    const approveAgainRes = mockRes();
    await payCtrl.approveEventRefund(adminReq(refunded), approveAgainRes, nextFail);
    check("approving a processed refund is idempotent", approveAgainRes.statusCode === 200 && refundCalls === 1, `calls=${refundCalls}`);

    const event9 = await createEvent("I");
    const order9Res = mockRes();
    await payCtrl.createEventOrder(customerReq(event9), order9Res, nextFail);
    const payment9 = mintPayment(order9Res.body.orderId, 100000);
    const verify9 = mockRes();
    await payCtrl.verifyEventPayment(
      {
        ...customerReq(event9),
        body: {
          razorpay_order_id: order9Res.body.orderId,
          razorpay_payment_id: payment9.id,
          razorpay_signature: signCheckout(order9Res.body.orderId, payment9.id),
        },
      },
      verify9,
      nextFail
    );
    const cancel9Res = mockRes();
    await eventCtrl.cancelEventBooking(customerReq(event9), cancel9Res, nextFail);
    await EventBooking.updateOne({ _id: event9._id }, { $set: { "payment.testMode": false } });

    refundStatusOverride = "pending";
    const approvePendingRes = mockRes();
    await payCtrl.approveEventRefund(adminReq(await EventBooking.findById(event9._id)), approvePendingRes, nextFail);
    const pendingRefund = await EventBooking.findById(event9._id);
    check(
      "gateway-pending refund stays processing",
      approvePendingRes.statusCode === 200 &&
        pendingRefund.payment.refundStatus === "processing" &&
        pendingRefund.payment.refundedAt === undefined,
      JSON.stringify({ status: pendingRefund.payment.refundStatus, at: pendingRefund.payment.refundedAt })
    );
    check(
      "gateway-pending refund does not write a processed ledger row",
      (await EventLedgerEntry.countDocuments({ eventBooking: event9._id, type: "event_refund.processed" })) === 0,
      ""
    );

    refundStatusOverride = "";
    const gatewayRefund9 = refunds.get(payment9.id)[0];
    gatewayRefund9.status = "processed";
    const reconcileRes = mockRes();
    await payCtrl.reconcileEventRefund(adminReq(pendingRefund), reconcileRes, nextFail);
    const reconciled = await EventBooking.findById(event9._id);
    check(
      "reconcile confirms the pending gateway refund",
      reconcileRes.statusCode === 200 &&
        reconcileRes.body?.adopted === true &&
        reconciled.payment.refundStatus === "processed" &&
        reconciled.payment.refundId === gatewayRefund9.id,
      JSON.stringify({ status: reconciled.payment.refundStatus, id: reconciled.payment.refundId })
    );
    check(
      "reconcile writes exactly one processed ledger row",
      (await EventLedgerEntry.countDocuments({ eventBooking: event9._id, type: "event_refund.processed" })) === 1,
      ""
    );

    const event10 = await createEvent("J");
    const order10Res = mockRes();
    await payCtrl.createEventOrder(customerReq(event10), order10Res, nextFail);
    mintPayment(order10Res.body.orderId, 100000, { id: `pay_reconcile_none_${RUN}` });
    await EventBooking.updateOne(
      { _id: event10._id },
      {
        $set: {
          "payment.status": "paid",
          "payment.paidAmount": 1000,
          "payment.razorpayPaymentId": `pay_reconcile_none_${RUN}`,
          "payment.testMode": false,
          "payment.refundStatus": "processing",
          "payment.refundAmount": 1000,
        },
      }
    );
    const reconcileNoneRes = mockRes();
    await payCtrl.reconcileEventRefund(
      adminReq(await EventBooking.findById(event10._id)),
      reconcileNoneRes,
      nextFail
    );
    const requeued = await EventBooking.findById(event10._id);
    check(
      "reconcile with no gateway refund returns the request to the queue",
      reconcileNoneRes.statusCode === 200 &&
        reconcileNoneRes.body?.pending === true &&
        requeued.payment.refundStatus === "pending",
      JSON.stringify({ status: requeued.payment.refundStatus, pending: reconcileNoneRes.body?.pending })
    );

    await EventBooking.updateOne(
      { _id: event10._id },
      { $set: { "payment.refundStatus": "processing" } }
    );
    const originalRefundList = rzCfg.razorpay.refunds.all;
    rzCfg.razorpay.refunds.all = async () => {
      throw new Error("gateway timeout");
    };
    const reconcileUnavailableRes = mockRes();
    await payCtrl.reconcileEventRefund(
      adminReq(await EventBooking.findById(event10._id)),
      reconcileUnavailableRes,
      nextFail
    );
    const reconcileUnavailable = await EventBooking.findById(event10._id);
    rzCfg.razorpay.refunds.all = originalRefundList;
    check(
      "reconcile gateway failure remains processing for retry",
      reconcileUnavailableRes.statusCode === 503 &&
        reconcileUnavailable.payment.refundStatus === "processing",
      JSON.stringify({ status: reconcileUnavailableRes.statusCode, refund: reconcileUnavailable.payment.refundStatus })
    );

    const event11 = await createEvent("M");
    const order11Res = mockRes();
    await payCtrl.createEventOrder(customerReq(event11), order11Res, nextFail);
    const payment11 = mintPayment(order11Res.body.orderId, 100000, { id: `pay_refund_retry_${RUN}` });
    const verify11 = mockRes();
    await payCtrl.verifyEventPayment(
      {
        ...customerReq(event11),
        body: {
          razorpay_order_id: order11Res.body.orderId,
          razorpay_payment_id: payment11.id,
          razorpay_signature: signCheckout(order11Res.body.orderId, payment11.id),
        },
      },
      verify11,
      nextFail
    );
    const cancel11Res = mockRes();
    await eventCtrl.cancelEventBooking(customerReq(event11), cancel11Res, nextFail);
    await EventBooking.updateOne({ _id: event11._id }, { $set: { "payment.testMode": false } });
    const refundCallsBeforeFailure = refundCalls;
    refundStatusOverride = "failed";
    const failedRefundRes = mockRes();
    await payCtrl.approveEventRefund(adminReq(await EventBooking.findById(event11._id)), failedRefundRes, nextFail);
    const failedRefund = await EventBooking.findById(event11._id);
    check(
      "gateway refund failure is recorded without marking refund processed",
      failedRefundRes.statusCode === 200 &&
        failedRefund.payment.refundStatus === "failed" &&
        refundCalls === refundCallsBeforeFailure + 1 &&
        !failedRefund.payment.refundedAt,
      JSON.stringify({ status: failedRefund.payment.refundStatus, calls: refundCalls, error: failedRefund.payment.refundError })
    );
    refundStatusOverride = "";
    const retryRefundRes = mockRes();
    await payCtrl.approveEventRefund(adminReq(failedRefund), retryRefundRes, nextFail);
    const retriedRefund = await EventBooking.findById(event11._id);
    check(
      "failed refund can be retried to processed",
      retryRefundRes.statusCode === 200 &&
        retriedRefund.payment.refundStatus === "processed" &&
        refundCalls === refundCallsBeforeFailure + 2,
      JSON.stringify({ status: retriedRefund.payment.refundStatus, calls: refundCalls })
    );

    const event3 = await createEvent("C");
    const order3Res = mockRes();
    await payCtrl.createEventOrder(customerReq(event3), order3Res, nextFail);
    const payment3 = mintPayment(order3Res.body.orderId, 100000);
    const verify3 = mockRes();
    await payCtrl.verifyEventPayment(
      {
        ...customerReq(event3),
        body: {
          razorpay_order_id: order3Res.body.orderId,
          razorpay_payment_id: payment3.id,
          razorpay_signature: signCheckout(order3Res.body.orderId, payment3.id),
        },
      },
      verify3,
      nextFail
    );
    const paid3 = await EventBooking.findById(event3._id);
    await EventBooking.updateOne(
      { _id: paid3._id },
      { $set: { bookingStatus: "cancelled", "payment.refundStatus": "pending", "payment.refundAmount": 1000, "payment.refundReason": "test rejection" } }
    );
    const rejectRes = mockRes();
    await payCtrl.rejectEventRefund(adminReq(paid3, { reason: "Verified exception" }), rejectRes, nextFail);
    const rejected = await EventBooking.findById(paid3._id);
    check("admin can decline a refund", rejectRes.statusCode === 200 && rejected.payment.refundStatus === "rejected", rejected.payment.refundStatus);
    check("rejection ledger entry created", (await EventLedgerEntry.countDocuments({ eventBooking: paid3._id, type: "event_refund.rejected" })) === 1, "");

    const event4 = await createEvent("D");
    const order4Res = mockRes();
    await payCtrl.createEventOrder(customerReq(event4), order4Res, nextFail);
    const orderId4 = order4Res.body.orderId;
    const payment4 = mintPayment(orderId4, 100000, { id: `pay_webhook_${RUN}` });
    const webhookPayload = {
      event: "payment.captured",
      payload: { payment: { entity: payment4 } },
    };
    const raw = Buffer.from(JSON.stringify(webhookPayload));
    const webhookSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(raw)
      .digest("hex");
    const webhookRes = mockRes();
    await paymentCtrl.handleWebhook(
      { headers: { "x-razorpay-signature": webhookSignature }, body: raw },
      webhookRes
    );
    const webhookPaid = await EventBooking.findById(event4._id);
    check("signed webhook confirms event payment", webhookRes.statusCode === 200 && webhookPaid.bookingStatus === "confirmed" && webhookPaid.payment.webhookReconciled === true, JSON.stringify({ res: webhookRes.body, status: webhookPaid.bookingStatus }));
    const webhookDoc = await WebhookEvent.findOne({ paymentId: payment4.id });
    check("webhook dedup row links the event booking", String(webhookDoc?.eventBooking || "") === String(event4._id), String(webhookDoc?.eventBooking || ""));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const webhookSends = waSends.filter((send) => send.body.includes(`${RUN}-D`));
    check(
      "webhook-confirmed payment sends cook WhatsApp details",
      webhookSends.length === 1 && webhookSends[0].to === "9876543212",
      String(webhookSends.length)
    );
    const duplicateWebhookSends = waSends.length;
    const duplicateWebhookRes = mockRes();
    await paymentCtrl.handleWebhook(
      { headers: { "x-razorpay-signature": webhookSignature }, body: raw },
      duplicateWebhookRes
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    check(
      "duplicate webhook is idempotent",
      duplicateWebhookRes.statusCode === 200 &&
        duplicateWebhookRes.body?.handled === "duplicate" &&
        (await EventLedgerEntry.countDocuments({ eventBooking: event4._id, type: "event_payment.confirmed" })) === 1,
      JSON.stringify(duplicateWebhookRes.body)
    );
    check("duplicate webhook sends no WhatsApp", waSends.length === duplicateWebhookSends, String(waSends.length));

    const eventUnverified = await createEvent("Q");
    const orderUnverifiedRes = mockRes();
    await payCtrl.createEventOrder(customerReq(eventUnverified), orderUnverifiedRes, nextFail);
    const unverifiedPayment = mintPayment(orderUnverifiedRes.body.orderId, 100000, { id: `pay_unverified_${RUN}` });
    const unverifiedRaw = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { payment: { entity: unverifiedPayment } } }));
    const unverifiedSig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(unverifiedRaw).digest("hex");
    const noSigRes = mockRes();
    await paymentCtrl.handleWebhook({ headers: {}, body: unverifiedRaw }, noSigRes);
    check("webhook without signature rejected", noSigRes.statusCode === 200 && noSigRes.body?.received === false, JSON.stringify(noSigRes.body));
    const badSigRes = mockRes();
    await paymentCtrl.handleWebhook({ headers: { "x-razorpay-signature": "00" }, body: unverifiedRaw }, badSigRes);
    check("webhook with invalid signature rejected", badSigRes.statusCode === 200 && badSigRes.body?.received === false, JSON.stringify(badSigRes.body));
    const nonBufferRes = mockRes();
    await paymentCtrl.handleWebhook(
      { headers: { "x-razorpay-signature": unverifiedSig }, body: JSON.parse(unverifiedRaw.toString("utf8")) },
      nonBufferRes
    );
    check("webhook with parsed/non-raw body rejected", nonBufferRes.statusCode === 200 && nonBufferRes.body?.received === false, JSON.stringify(nonBufferRes.body));
    const malformedRaw = Buffer.from("{not-json");
    const malformedSig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(malformedRaw).digest("hex");
    const malformedRes = mockRes();
    await paymentCtrl.handleWebhook({ headers: { "x-razorpay-signature": malformedSig }, body: malformedRaw }, malformedRes);
    check("webhook with malformed JSON rejected", malformedRes.statusCode === 200 && malformedRes.body?.received === false, JSON.stringify(malformedRes.body));
    const savedWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    let noSecretRes;
    try {
      delete process.env.RAZORPAY_WEBHOOK_SECRET;
      noSecretRes = mockRes();
      await paymentCtrl.handleWebhook({ headers: { "x-razorpay-signature": unverifiedSig }, body: unverifiedRaw }, noSecretRes);
    } finally {
      process.env.RAZORPAY_WEBHOOK_SECRET = savedWebhookSecret;
    }
    check("webhook without configured secret rejected", noSecretRes.statusCode === 200 && noSecretRes.body?.received === false, JSON.stringify(noSecretRes.body));
    const unverifiedEvent = await EventBooking.findById(eventUnverified._id);
    check(
      "rejected webhooks cannot confirm the booking",
      unverifiedEvent.bookingStatus === "cook_assigned" && !unverifiedEvent.payment?.webhookReconciled,
      JSON.stringify({ status: unverifiedEvent.bookingStatus, reconciled: unverifiedEvent.payment?.webhookReconciled })
    );
    check(
      "rejected webhooks leave no dedup row",
      (await WebhookEvent.countDocuments({ paymentId: unverifiedPayment.id })) === 0,
      unverifiedPayment.id
    );

    const event5 = await createEvent("E");
    const order5Res = mockRes();
    await payCtrl.createEventOrder(customerReq(event5), order5Res, nextFail);
    const cancel5Res = mockRes();
    await eventCtrl.cancelEventBooking(customerReq(event5), cancel5Res, nextFail);
    const payment5 = mintPayment(order5Res.body.orderId, 100000, { id: `pay_late_${RUN}` });
    const latePayload = { event: "payment.captured", payload: { payment: { entity: payment5 } } };
    const lateRaw = Buffer.from(JSON.stringify(latePayload));
    const lateSig = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(lateRaw)
      .digest("hex");
    const lateRes = mockRes();
    await paymentCtrl.handleWebhook({ headers: { "x-razorpay-signature": lateSig }, body: lateRaw }, lateRes);
    const lateEvent = await EventBooking.findById(event5._id);
    check("capture after cancellation queues refund", lateRes.statusCode === 200 && lateEvent.bookingStatus === "cancelled" && lateEvent.payment.refundStatus === "pending", JSON.stringify({ status: lateEvent.bookingStatus, refund: lateEvent.payment.refundStatus }));
    check("late-capture refund is full amount", lateEvent.payment.refundAmount === 1000, String(lateEvent.payment.refundAmount));
    await new Promise((resolve) => setTimeout(resolve, 50));
    check(
      "refund-only captures do not send cook WhatsApp",
      !waSends.some((send) => send.body.includes(`${RUN}-E`)),
      String(waSends.length)
    );

    const event6 = await createEvent("F");
    const order6Res = mockRes();
    await payCtrl.createEventOrder(customerReq(event6), order6Res, nextFail);
    const payment6 = mintPayment(order6Res.body.orderId, 99900, { id: `pay_short_${RUN}` });
    const shortPayload = { event: "payment.captured", payload: { payment: { entity: payment6 } } };
    const shortRaw = Buffer.from(JSON.stringify(shortPayload));
    const shortSig = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(shortRaw)
      .digest("hex");
    const shortRes = mockRes();
    await paymentCtrl.handleWebhook({ headers: { "x-razorpay-signature": shortSig }, body: shortRaw }, shortRes);
    const shortEvent = await EventBooking.findById(event6._id);
    check("amount-mismatched capture queues refund", shortRes.statusCode === 200 && shortEvent.payment.refundStatus === "pending" && shortEvent.bookingStatus === "cook_assigned", JSON.stringify({ status: shortEvent.bookingStatus, refund: shortEvent.payment.refundStatus }));

    const event7 = await createEvent("G");
    const order7Res = mockRes();
    await payCtrl.createEventOrder(customerReq(event7), order7Res, nextFail);
    const orderId7 = order7Res.body.orderId;
    const payment7 = mintPayment(orderId7, 99000, { id: `pay_verify_short_${RUN}` });
    const verifyShortRes = mockRes();
    await payCtrl.verifyEventPayment(
      {
        ...customerReq(event7),
        body: {
          razorpay_order_id: orderId7,
          razorpay_payment_id: payment7.id,
          razorpay_signature: signCheckout(orderId7, payment7.id),
        },
      },
      verifyShortRes,
      nextFail
    );
    const verifyShortEvent = await EventBooking.findById(event7._id);
    check(
      "verify-time amount mismatch queues captured refund",
      verifyShortRes.statusCode === 400 &&
        verifyShortRes.body?.refundQueued === true &&
        verifyShortEvent.payment.status === "paid" &&
        verifyShortEvent.payment.refundStatus === "pending",
      JSON.stringify({ status: verifyShortRes.statusCode, body: verifyShortRes.body, pay: verifyShortEvent.payment.status, refund: verifyShortEvent.payment.refundStatus })
    );
    check("verify-time refund uses captured amount", verifyShortEvent.payment.refundAmount === 990, String(verifyShortEvent.payment.refundAmount));

    const eventCurrency = await createEvent("N");
    const orderCurrencyRes = mockRes();
    await payCtrl.createEventOrder(customerReq(eventCurrency), orderCurrencyRes, nextFail);
    const paymentCurrency = mintPayment(orderCurrencyRes.body.orderId, 100000, { id: `pay_currency_${RUN}` });
    paymentCurrency.currency = "USD";
    const currencyPayload = { event: "payment.captured", payload: { payment: { entity: paymentCurrency } } };
    const currencyRaw = Buffer.from(JSON.stringify(currencyPayload));
    const currencySig = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(currencyRaw)
      .digest("hex");
    const currencyWebhookRes = mockRes();
    await paymentCtrl.handleWebhook(
      { headers: { "x-razorpay-signature": currencySig }, body: currencyRaw },
      currencyWebhookRes
    );
    const currencyEvent = await EventBooking.findById(eventCurrency._id);
    check(
      "currency-mismatched capture is not confirmed",
      currencyWebhookRes.statusCode === 200 &&
        currencyWebhookRes.body?.handled === false &&
        currencyEvent.bookingStatus === "cook_assigned" &&
        currencyEvent.payment.status === "pending",
      JSON.stringify({ body: currencyWebhookRes.body, booking: currencyEvent.bookingStatus, pay: currencyEvent.payment.status })
    );

    const eventWebhookRetry = await createEvent("W");
    const orderWebhookRes = mockRes();
    await payCtrl.createEventOrder(customerReq(eventWebhookRetry), orderWebhookRes, nextFail);
    const paymentWebhookRetry = mintPayment(orderWebhookRes.body.orderId, 100000, { id: `pay_retry_${RUN}` });
    const retryPayload = { event: "payment.captured", payload: { payment: { entity: paymentWebhookRetry } } };
    const retryRaw = Buffer.from(JSON.stringify(retryPayload));
    const retrySig = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(retryRaw)
      .digest("hex");
    const retryReq = { headers: { "x-razorpay-signature": retrySig }, body: retryRaw };
    const originalEventFindOne = EventBooking.findOne;
    EventBooking.findOne = async () => {
      throw new Error("transient database failure");
    };
    const transientWebhookRes = mockRes();
    await paymentCtrl.handleWebhook(retryReq, transientWebhookRes);
    EventBooking.findOne = originalEventFindOne;
    const transientDedupe = await WebhookEvent.findOne({ paymentId: paymentWebhookRetry.id });
    check(
      "transient webhook failure requests retry and releases dedupe",
      transientWebhookRes.statusCode === 500 &&
        transientWebhookRes.body?.retry === true &&
        transientDedupe === null,
      JSON.stringify({ status: transientWebhookRes.statusCode, dedupe: transientDedupe?.key || null })
    );
    const retryWebhookRes = mockRes();
    await paymentCtrl.handleWebhook(retryReq, retryWebhookRes);
    const retryEvent = await EventBooking.findById(eventWebhookRetry._id);
    check(
      "retried webhook reconciles the event payment",
      retryWebhookRes.statusCode === 200 &&
        retryWebhookRes.body?.handled === true &&
        retryEvent.bookingStatus === "confirmed" &&
        retryEvent.payment.status === "paid",
      JSON.stringify({ status: retryWebhookRes.statusCode, body: retryWebhookRes.body, booking: retryEvent.bookingStatus })
    );

    const event8 = await createEvent("H");
    const staleOrderId = `order_stale_${RUN}`;
    await EventBooking.updateOne(
      { _id: event8._id },
      { $set: { "payment.razorpayOrderId": staleOrderId } }
    );
    const staleEvent = await EventBooking.findById(event8._id);
    await EventBooking.updateOne({ _id: event8._id }, { $set: { totalAmount: 1200 } });
    const staleResult = await finalizeEventPayment({
      event: staleEvent,
      orderId: staleOrderId,
      paymentId: `pay_stale_${RUN}`,
      amountPaise: 100000,
      source: "customer",
      actor: customer._id,
    });
    const staleAfter = await EventBooking.findById(event8._id);
    check(
      "stale event total cannot be confirmed",
      !staleResult.ok &&
        staleResult.status === 409 &&
        staleAfter.bookingStatus === "cook_assigned" &&
        staleAfter.payment.refundStatus === "pending",
      JSON.stringify({ result: staleResult.status, booking: staleAfter.bookingStatus, refund: staleAfter.payment.refundStatus })
    );

    const savedEventFlag = process.env.EVENT_PAYMENTS_REQUIRED;
    const savedPlatformFlag = process.env.REQUIRE_PAYMENTS;
    process.env.EVENT_PAYMENTS_REQUIRED = "";
    process.env.REQUIRE_PAYMENTS = "true";
    check("events inherit platform payment policy", eventPaymentsRequired() === true, String(eventPaymentsRequired()));
    process.env.EVENT_PAYMENTS_REQUIRED = "false";
    check("explicit event payment flag overrides platform policy", eventPaymentsRequired() === false, String(eventPaymentsRequired()));
    if (savedEventFlag === undefined) delete process.env.EVENT_PAYMENTS_REQUIRED;
    else process.env.EVENT_PAYMENTS_REQUIRED = savedEventFlag;
    if (savedPlatformFlag === undefined) delete process.env.REQUIRE_PAYMENTS;
    else process.env.REQUIRE_PAYMENTS = savedPlatformFlag;
  } catch (e) {
    check("test execution completed without exception", false, String((e && e.stack) || e));
  } finally {
    whatsappApi.sendWhatsAppText = originalWaSend;
    try {
      await mongoose.connection.db.dropDatabase();
    } catch {}
    await mongoose.disconnect();
    if (memoryServer) await memoryServer.stop();
    console.log(`EVENT_PAYMENT_FAILURES=${failures}`);
    process.exit(failures ? 1 : 0);
  }
})();
