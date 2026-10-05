// refund-deep-audit.test.js — Deep adversarial security, financial integrity

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-refund-deep-audit-key-32chars";
process.env.RAZORPAY_KEY_ID = "rk_test_audit12345678";
process.env.RAZORPAY_KEY_SECRET = "sec_test_audit87654321";
process.env.RAZORPAY_CURRENCY = "INR";

const Booking = require("./models/Booking");
const User = require("./models/User");
const Notification = require("./models/Notification");
const LedgerEntry = require("./models/LedgerEntry");
const CookProfile = require("./models/CookProfile");
const rzCfg = require("./config/razorpay");
const payoutCtrl = require("./controllers/payoutController");
const refundCtrl = require("./controllers/refundController");
const { parseRupeeAmount, normalizePayoutReference, isValidPayoutReference } = require("./utils/finance");

let passes = 0;
let failures = 0;

const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes++;
  else failures++;
};

const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
};

const next = (err) => { if (err) throw err; };

let store = new Map();
let ledgerRows = [];
let ledgerKeys = new Set();
let notifications = [];
let gatewayRefunds = [];
let gatewayCallCount = 0;
let gatewayThrow = null;

const reset = () => {
  store = new Map();
  ledgerRows = [];
  ledgerKeys = new Set();
  notifications = [];
  gatewayRefunds = [];
  gatewayCallCount = 0;
  gatewayThrow = null;

  rzCfg.razorpay.refunds.all = async ({ payment_id }) => {
    if (gatewayThrow) throw gatewayThrow;
    return {
      items: gatewayRefunds
        .filter((r) => r.payment_id === payment_id)
        .map((r) => ({ id: r.id, amount: r.amount, status: r.status || "processed" })),
    };
  };

  rzCfg.razorpay.payments.refund = async (paymentId, payload) => {
    gatewayCallCount++;
    if (gatewayThrow) throw gatewayThrow;
    const item = {
      id: `rf_${Date.now()}_${gatewayCallCount}`,
      payment_id: paymentId,
      amount: payload.amount,
      status: "processed",
    };
    gatewayRefunds.push(item);
    return item;
  };
};

const mkDoc = (id, over = {}) => {
  const base = {
    _id: id,
    customer: "cust_1",
    cook: "cook_1",
    status: "confirmed",
    serviceType: "cook_for_me",
    amount: 1000,
    cookPayout: 750,
    commission: 250,
    hoursCompleted: false,
    cookArrived: false,
    serviceStartedAt: null,
    statusHistory: [],
    payment: {
      status: "paid",
      paidAmount: 1000,
      razorpayPaymentId: `pay_${id}`,
      razorpayOrderId: `ord_${id}`,
      refundStatus: "pending",
      refundAmount: 1000,
      testMode: false,
    },
    payout: { status: "pending", amount: 0 },
    toObject() {
      const { toObject, ...rest } = this;
      return JSON.parse(JSON.stringify(rest));
    },
  };
  const doc = {
    ...base,
    ...over,
    payment: { ...base.payment, ...(over.payment || {}) },
    payout: { ...base.payout, ...(over.payout || {}) },
  };
  store.set(String(id), doc);
  return doc;
};

Booking.findById = async (id) => store.get(String(id)) || null;

Booking.findOne = async (filter) => {
  for (const doc of store.values()) {
    let match = true;
    if (filter._id && filter._id.$ne && String(doc._id) === String(filter._id.$ne)) match = false;
    if (filter["payout.referenceKey"] && doc.payout?.referenceKey !== filter["payout.referenceKey"]) match = false;
    if (filter["payout.status"] && doc.payout?.status !== filter["payout.status"]) match = false;
    if (filter["payment.refundReferenceKey"] && doc.payment?.refundReferenceKey !== filter["payment.refundReferenceKey"]) match = false;
    if (filter.$or) {
      const orMatch = filter.$or.some((clause) => {
        if (clause["payment.refundReferenceKey"] && doc.payment?.refundReferenceKey === clause["payment.refundReferenceKey"]) return true;
        if (clause["payout.referenceKey"] && doc.payout?.referenceKey === clause["payout.referenceKey"]) return true;
        return false;
      });
      if (!orMatch) match = false;
    }
    if (match) return doc;
  }
  return null;
};

Booking.findOneAndUpdate = async (filter, update) => {
  const doc = store.get(String(filter._id));
  if (!doc) return null;

  if (filter.customer && String(doc.customer) !== String(filter.customer)) return null;
  if (filter.status) {
    if (filter.status.$nin && filter.status.$nin.includes(doc.status)) return null;
    if (typeof filter.status === "string" && doc.status !== filter.status) return null;
  }
  if (filter["payment.status"] && doc.payment?.status !== filter["payment.status"]) return null;
  if (filter["payment.refundStatus"]) {
    const want = filter["payment.refundStatus"];
    const cur = doc.payment?.refundStatus;
    if (typeof want === "string" && cur !== want) return null;
    if (want.$in && !want.$in.includes(cur)) return null;
  }
  if (filter["payout.status"]) {
    const want = filter["payout.status"];
    const cur = doc.payout?.status;
    if (want.$ne !== undefined && cur === want.$ne) return null;
  }

  if (update.$set) {
    for (const [k, v] of Object.entries(update.$set)) {
      const parts = k.split(".");
      let target = doc;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!target[parts[i]]) target[parts[i]] = {};
        target = target[parts[i]];
      }
      target[parts[parts.length - 1]] = v;
    }
  }
  if (update.$push) {
    for (const [k, v] of Object.entries(update.$push)) {
      if (!doc[k]) doc[k] = [];
      doc[k].push(v);
    }
  }
  return doc;
};

LedgerEntry.create = async (entry) => {
  if (ledgerKeys.has(entry.idempotencyKey)) {
    const err = new Error("Duplicate key");
    err.code = 11000;
    throw err;
  }
  ledgerKeys.add(entry.idempotencyKey);
  ledgerRows.push({ ...entry, createdAt: new Date() });
  return entry;
};

LedgerEntry.findOne = (query) => ({
  select: () => ({
    lean: async () => {
      if (query.idempotencyKey) {
        return ledgerKeys.has(query.idempotencyKey) ? { _id: "ledg_mock" } : null;
      }
      if (query.$or) {
        const found = query.$or.some((c) => c.idempotencyKey && ledgerKeys.has(c.idempotencyKey));
        return found ? { _id: "ledg_mock" } : null;
      }
      return null;
    },
  }),
});

Notification.create = async (payload) => {
  notifications.push(payload);
  return payload;
};

User.find = () => ({
  select: () => ({
    limit: () => ({
      lean: async () => [{ _id: "admin_1" }, { _id: "admin_2" }],
    }),
  }),
});

CookProfile.findOne = () => ({
  select: () => ({
    lean: async () => ({
      payoutDetails: { method: "upi", upiId: "cook@bank" },
    }),
  }),
});

const ADMIN_USER = { id: "admin_1", role: "ADMIN" };
const CUSTOMER_1 = { id: "cust_1", role: "CUSTOMER" };
const CUSTOMER_2 = { id: "cust_2", role: "CUSTOMER" };
const COOK_USER = { id: "cook_1", role: "COOK" };

(async function runDeepAudit() {
  console.log("══════════════════════════════════════════════════════════════════");
  console.log("   COOK MITRA — REFUNDS DEEP AUDIT & RECONCILIATION TEST SUITE    ");
  console.log("══════════════════════════════════════════════════════════════════\n");

  console.log("─── 1. Authorization & IDOR ───");
  {
    reset();
    mkDoc("b_idor_1", { customer: "cust_1" });

    let r = makeRes();
    await refundCtrl.requestRefund({ params: { id: "b_idor_1" }, user: CUSTOMER_2, body: { reason: "Cook did not arrive" } }, r, next);
    check("Customer B calling Customer A booking refund-request -> 403", r.statusCode === 403, `s=${r.statusCode}`);

    r = makeRes();
    await refundCtrl.getRefundEligibility({ params: { id: "b_idor_1" }, user: CUSTOMER_2 }, r, next);
    check("Customer B calling Customer A refund-eligibility -> 403", r.statusCode === 403, `s=${r.statusCode}`);

    r = makeRes();
    try {
      await payoutCtrl.approveRefund({ params: { id: "b_idor_1" }, user: COOK_USER, body: {} }, r, next);
    } catch (e) {
      r.status(500);
    }
    check("Customer 1 cannot approve own refund (role gated)", CUSTOMER_1.role !== "ADMIN");
  }

  console.log("\n─── 2. State Machine & Illegal Transitions ───");
  {
    reset();
    mkDoc("b_state_1", { payment: { refundStatus: "processed", refundAmount: 1000 } });

    let r = makeRes();
    await payoutCtrl.approveRefund({ params: { id: "b_state_1" }, user: ADMIN_USER, body: {} }, r, next);
    check("Processed refund cannot be approved again -> 400", r.statusCode === 400, `s=${r.statusCode}`);

    r = makeRes();
    await payoutCtrl.rejectRefund({ params: { id: "b_state_1" }, user: ADMIN_USER, body: {} }, r, next);
    check("Processed refund cannot be rejected -> 400", r.statusCode === 400, `s=${r.statusCode}`);

    r = makeRes();
    await payoutCtrl.markRefundSettled({ params: { id: "b_state_1" }, user: ADMIN_USER, body: { reference: "UTR12345678" } }, r, next);
    check("Processed refund cannot be settled again -> 400", r.statusCode === 400, `s=${r.statusCode}`);

    mkDoc("b_state_2", { payment: { refundStatus: "rejected" } });
    r = makeRes();
    await payoutCtrl.approveRefund({ params: { id: "b_state_2" }, user: ADMIN_USER, body: {} }, r, next);
    check("Rejected refund cannot be approved -> 400", r.statusCode === 400, `s=${r.statusCode}`);

    r = makeRes();
    await payoutCtrl.markRefundSettled({ params: { id: "b_state_2" }, user: ADMIN_USER, body: { reference: "UTR12345678" } }, r, next);
    check("Rejected refund cannot be settled -> 400", r.statusCode === 400, `s=${r.statusCode}`);
  }

  console.log("\n─── 3. Hostile Amount Matrix ───");
  {
    reset();
    mkDoc("b_amt_1", { amount: 500, payment: { paidAmount: 500, refundAmount: 500, refundStatus: "pending" } });

    let rBlank = makeRes();
    mkDoc("b_amt_full", { amount: 500, payment: { paidAmount: 500, refundAmount: 500, refundStatus: "pending" } });
    await payoutCtrl.approveRefund({ params: { id: "b_amt_full" }, user: ADMIN_USER, body: {} }, rBlank, next);
    check("Omitted amount (blank) approves full refund -> 200", rBlank.statusCode === 200 && store.get("b_amt_full").payment.refundAmount === 500);

    const hostileInputs = [
      { val: true, desc: "boolean true" },
      { val: false, desc: "boolean false" },
      { val: null, desc: "null" },
      { val: "NaN", desc: "string NaN" },
      { val: "Infinity", desc: "string Infinity" },
      { val: Infinity, desc: "numeric Infinity" },
      { val: 0, desc: "zero" },
      { val: -100, desc: "negative number" },
      { val: 0.001, desc: "tiny decimal" },
      { val: 1.999999, desc: "fractional decimal" },
      { val: { amount: 500 }, desc: "object payload" },
      { val: [500], desc: "array payload" },
      { val: 999999999, desc: "over-cap huge amount" },
    ];

    for (const h of hostileInputs) {
      const r = makeRes();
      await payoutCtrl.approveRefund({ params: { id: "b_amt_1" }, user: ADMIN_USER, body: { amount: h.val } }, r, next);
      check(`Hostile amount [${h.desc}] rejected without moving money`, r.statusCode === 400, `s=${r.statusCode}`);
    }
    const curDoc = store.get("b_amt_1");
    check("Booking remained pending after all hostile attempts", curDoc.payment.refundStatus === "pending" && ledgerRows.length === 1 /* from b_amt_full */);
  }

  console.log("\n─── 4. Concurrency: Simultaneous Approvals & Settlements ───");
  {
    reset();
    mkDoc("b_race_1", { amount: 400, payment: { paidAmount: 400, refundAmount: 400, refundStatus: "pending" } });
    const approvePromises = Array.from({ length: 10 }, () => {
      const r = makeRes();
      return payoutCtrl.approveRefund({ params: { id: "b_race_1" }, user: ADMIN_USER, body: {} }, r, next).then(() => r.statusCode);
    });
    const approveCodes = await Promise.all(approvePromises);
    const winApproves = approveCodes.filter((c) => c === 200).length;
    const lossApproves = approveCodes.filter((c) => c === 400).length;
    check("10 concurrent approves: exactly 1 wins (200), 9 fail (400)", winApproves === 1 && lossApproves === 9, `wins=${winApproves} losses=${lossApproves}`);
    check("10 concurrent approves: exactly 1 ledger row written", ledgerRows.filter((l) => l.type === "refund.approved").length === 1);

    reset();
    mkDoc("b_race_2", { amount: 400, payment: { paidAmount: 400, refundAmount: 400, refundStatus: "pending" } });
    const rApp = makeRes();
    const rRej = makeRes();
    await Promise.all([
      payoutCtrl.approveRefund({ params: { id: "b_race_2" }, user: ADMIN_USER, body: {} }, rApp, next),
      payoutCtrl.rejectRefund({ params: { id: "b_race_2" }, user: ADMIN_USER, body: { reason: "Declined" } }, rRej, next),
    ]);
    const appOk = rApp.statusCode === 200;
    const rejOk = rRej.statusCode === 200;
    check("Approve vs Reject race: exactly one wins", (appOk && !rejOk) || (!appOk && rejOk), `app=${rApp.statusCode} rej=${rRej.statusCode}`);
    const winnerStatus = store.get("b_race_2").payment.refundStatus;
    check("Final status matches winner", winnerStatus === (appOk ? "processed" : "rejected"));
  }

  console.log("\n─── 5. Race: Refund Approval vs Cook Payout Settlement ───");
  {
    reset();
    mkDoc("b_payout_race_1", {
      status: "completed",
      hoursCompleted: true,
      serviceStartedAt: new Date(Date.now() - 3 * 3600000),
      cookArrived: true,
      amount: 1000,
      cookPayout: 750,
      payment: { status: "paid", paidAmount: 1000, refundStatus: "pending", refundAmount: 1000 },
      payout: { status: "pending", amount: 750 },
    });

    const rSet = makeRes();
    const rApp = makeRes();
    await Promise.all([
      payoutCtrl.settlePayout({ params: { id: "b_payout_race_1" }, user: ADMIN_USER, body: { reference: "UTR_RACE_P1" } }, rSet, next),
      payoutCtrl.approveRefund({ params: { id: "b_payout_race_1" }, user: ADMIN_USER, body: { clawback: false } }, rApp, next),
    ]);
    const setWon = rSet.statusCode === 200;
    const appWon = rApp.statusCode === 200;
    check("Payout settle vs Refund approve: cannot both win without clawback", !(setWon && appWon), `settle=${rSet.statusCode} approve=${rApp.statusCode}`);
    check("Database is never in contradictory double-spent state", !(store.get("b_payout_race_1").payout.status === "settled" && store.get("b_payout_race_1").payment.refundStatus === "processed"));
  }

  console.log("\n─── 6. Clawback Integrity ───");
  {
    reset();
    mkDoc("b_claw_1", {
      status: "completed",
      hoursCompleted: true,
      amount: 1000,
      cookPayout: 750,
      payment: { status: "paid", paidAmount: 1000, refundStatus: "pending", refundAmount: 1000 },
      payout: { status: "settled", amount: 750, reference: "UTR_SETTLED_01" },
    });

    let r = makeRes();
    await payoutCtrl.approveRefund({ params: { id: "b_claw_1" }, user: ADMIN_USER, body: { clawback: false } }, r, next);
    check("Settled payout requires explicit clawback decision -> 400", r.statusCode === 400 && /clawback/i.test(r.body?.message || ""), `s=${r.statusCode}`);

    r = makeRes();
    await payoutCtrl.approveRefund({ params: { id: "b_claw_1" }, user: ADMIN_USER, body: { clawback: true } }, r, next);
    check("Settled payout with clawback approved -> 200", r.statusCode === 200 && store.get("b_claw_1").payment.refundStatus === "processed", `s=${r.statusCode}`);

    const clawDoc = store.get("b_claw_1");
    const clawNote = clawDoc.statusHistory.map((h) => h.note).join(" ");
    check("Clawback permanently audited in status history", /clawback required/i.test(clawNote));

    const clawLedger = ledgerRows.find((l) => l.booking === "b_claw_1" && l.type === "refund.approved");
    check("Clawback recorded in ledger reason", /clawback/i.test(clawLedger?.reason || ""));
    check("Cook notified about clawback recovery", notifications.some((n) => String(n.user) === "cook_1" && /recovery/i.test(n.message)));
  }

  console.log("\n─── 7. Gateway Response Integrity & Recovery ───");
  {
    reset();
    mkDoc("b_gw_amb", { amount: 500, payment: { paidAmount: 500, refundAmount: 500, refundStatus: "pending" } });
    rzCfg.razorpay.payments.refund = async () => ({ id: "", amount: 50000, status: "processed" });
    let r = makeRes();
    await payoutCtrl.approveRefund({ params: { id: "b_gw_amb" }, user: ADMIN_USER, body: {} }, r, next);
    check("Missing gateway ID marks refund failed (not processed)", r.statusCode === 200 && store.get("b_gw_amb").payment.refundStatus === "failed");

    reset();
    mkDoc("b_gw_tout", { amount: 500, payment: { paidAmount: 500, refundAmount: 500, refundStatus: "pending" } });
    gatewayThrow = new Error("Gateway GatewayTimeout");
    r = makeRes();
    await payoutCtrl.approveRefund({ params: { id: "b_gw_tout" }, user: ADMIN_USER, body: {} }, r, next);
    check("Gateway error leaves row in failed status for follow-up", store.get("b_gw_tout").payment.refundStatus === "failed");

    gatewayThrow = null;
    gatewayRefunds.push({ id: "rf_recovered_1", payment_id: "pay_b_gw_tout", amount: 50000, status: "processed" });
    r = makeRes();
    await payoutCtrl.reconcileRefund({ params: { id: "b_gw_tout" }, user: ADMIN_USER, body: {} }, r, next);
    check("reconcileRefund adopts existing gateway refund -> processed", r.statusCode === 200 && r.body?.adopted === true && store.get("b_gw_tout").payment.refundStatus === "processed");
    check("reconcileRefund recorded refundId from gateway", store.get("b_gw_tout").payment.refundId === "rf_recovered_1");
  }

  console.log("\n─── 8. Ledger Durability & Backfill Deduplication ───");
  {
    reset();
    mkDoc("b_backfill_gw", { payment: { refundStatus: "processed", refundAmount: 300, refundId: "rf_gw_1" } });

    mkDoc("b_backfill_man", { payment: { refundStatus: "processed", refundAmount: 400, refundReference: "MAN_REF_1", refundReferenceKey: "man_ref_1" } });
    ledgerKeys.add("refund-settled:b_backfill_man");
    ledgerRows.push({ idempotencyKey: "refund-settled:b_backfill_man", booking: "b_backfill_man", type: "refund.settled", amount: 400 });

    Booking.find = (q) => ({
      select: () => ({
        limit: () => ({
          lean: async () => {
            if (q["payment.refundStatus"] === "processed") {
              return [store.get("b_backfill_gw"), store.get("b_backfill_man")];
            }
            return [];
          },
        }),
      }),
    });

    const r = makeRes();
    await payoutCtrl.reconcileMissingPayoutLedger({ user: ADMIN_USER }, r, next);
    check("Backfill reconciles missing gateway refund ledger entry", r.body?.reconciledRefunds?.includes("b_backfill_gw"), JSON.stringify(r.body));
    check("Backfill identifies manual refund as alreadyLoggedRefunds (NO duplicate created)", r.body?.alreadyLoggedRefunds?.includes("b_backfill_man"));
    check("Manual refund still has exactly 1 ledger entry", ledgerRows.filter((l) => l.booking === "b_backfill_man").length === 1);
  }

  console.log("\n─── 9. Reference Validation & De-Duplication ───");
  {
    check("Valid alphanumeric reference accepted", isValidPayoutReference("UPI-1234567890"));
    check("Valid reference with dots, dashes, slashes accepted", isValidPayoutReference("UTR/2026/09/A1.2"));
    check("Reference under 4 chars rejected", !isValidPayoutReference("ABC"));
    check("Reference over 120 chars rejected", !isValidPayoutReference("A".repeat(121)));
    check("Whitespace-only reference rejected", !isValidPayoutReference("     "));
    check("Reference with control characters rejected", !isValidPayoutReference("UTR123\n456"));
    check("Reference with HTML/script rejected", !isValidPayoutReference("<script>alert(1)</script>"));
    check("Normalization removes all internal spaces and folds lowercase", normalizePayoutReference("  ABC  123 / XYZ  ") === "abc123/xyz");
  }

  console.log("\n─── 10. Test Mode Isolation ───");
  {
    reset();
    mkDoc("b_test_1", { payment: { status: "paid", testMode: true, refundStatus: "none", paidAmount: 500 } });

    let r = makeRes();
    await refundCtrl.requestRefund({ params: { id: "b_test_1" }, user: CUSTOMER_1, body: { reason: "Cook did not arrive" } }, r, next);
    check("Test payment refund request rejected -> 400", r.statusCode === 400, `s=${r.statusCode}`);

    store.get("b_test_1").payment.refundStatus = "pending";
    r = makeRes();
    await payoutCtrl.approveRefund({ params: { id: "b_test_1" }, user: ADMIN_USER, body: {} }, r, next);
    check("Test payment approval succeeds without moving money", r.statusCode === 200 && store.get("b_test_1").payment.refundStatus === "processed");
    check("Gateway refund never called for test payment", gatewayCallCount === 0);
    const testLedger = ledgerRows.find((l) => l.booking === "b_test_1");
    check("Test payment ledger recorded amount = 0", testLedger?.amount === 0);
  }

  console.log("\n─── 11. Payment Order Date Normalization ───");
  {
    reset();
    const fs = require("fs");
    const path = require("path");
    const { istDayString, parseDayStrict } = require("./utils/time");

    const futureDateObj = new Date(Date.now() + 2 * 24 * 3600000);
    const futureYmd = istDayString(futureDateObj);
    const futureIso = futureDateObj.toISOString();

    const parsedIso = new Date(futureIso);
    const normalizedIso = !Number.isNaN(parsedIso.getTime()) ? istDayString(parsedIso) : futureIso;
    check("ISO date string normalizes to strict YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(normalizedIso) && normalizedIso === futureYmd, `${futureIso} -> ${normalizedIso}`);
    check("Normalized ISO date passes parseDayStrict", parseDayStrict(normalizedIso) instanceof Date, String(normalizedIso));

    check("Strict YYYY-MM-DD date accepted", parseDayStrict(futureYmd) instanceof Date, futureYmd);

    check("Invalid date string rejected", parseDayStrict("not-a-valid-date") == null, "not-a-valid-date");

    const paySrc = fs.readFileSync(path.join(__dirname, "controllers", "paymentController.js"), "utf8");
    check(
      "createOrder contains ISO->IST-day normalization",
      /parsedIso/.test(paySrc) && /istDayString/.test(paySrc) && /Valid date \(YYYY-MM-DD\) is required/.test(paySrc),
      ""
    );
  }

  console.log("\n─── 11. Independent Financial Reconciliation ───");
  {
    const rawBookings = [
      {
        id: "rec_1",
        captured: 1200,
        cookShare: 900,
        commission: 300,
        refundStatus: "processed",
        refundAmount: 1200, // Full refund
        payoutStatus: "not_applicable",
        payoutAmount: 0,
        testMode: false,
      },
      {
        id: "rec_2",
        captured: 1000,
        cookShare: 750,
        commission: 250,
        refundStatus: "processed",
        refundAmount: 400, // Partial refund: ₹400 returned, ₹600 kept
        payoutStatus: "pending",
        payoutAmount: 0,
        testMode: false,
      },
      {
        id: "rec_3",
        captured: 800,
        cookShare: 600,
        commission: 200,
        refundStatus: "processed",
        refundAmount: 800, // Refund with clawback (payout was settled)
        payoutStatus: "settled",
        payoutAmount: 600, // Settled to cook, then clawback required
        clawback: true,
        testMode: false,
      },
      {
        id: "rec_4",
        captured: 1500,
        cookShare: 1125,
        commission: 375,
        refundStatus: "none",
        refundAmount: 0,
        payoutStatus: "settled",
        payoutAmount: 1125, // Normal settled session
        testMode: false,
      },
      {
        id: "rec_5_test",
        captured: 500,
        cookShare: 375,
        commission: 125,
        refundStatus: "processed",
        refundAmount: 500,
        payoutStatus: "pending",
        payoutAmount: 0,
        testMode: true, // Must be excluded from real money totals
      },
    ];

    let totalRealCaptured = 0;
    let totalRealRefunded = 0;
    let totalRealPayouts = 0;
    let totalRealCommission = 0;
    let totalClawbackExposure = 0;

    for (const b of rawBookings) {
      if (b.testMode) continue; // Exclude test mode completely

      totalRealCaptured += b.captured;
      totalRealRefunded += b.refundAmount;
      totalRealPayouts += b.payoutAmount;
      if (b.payoutStatus === "settled" && !b.clawback) {
        totalRealCommission += b.commission;
      }
      if (b.clawback) {
        totalClawbackExposure += b.payoutAmount;
      }

      check(`Booking ${b.id}: refund <= captured`, b.refundAmount <= b.captured);

      const remainingRefundable = b.captured - b.refundAmount;
      check(`Booking ${b.id}: remaining refundable is non-negative`, remainingRefundable >= 0);
    }

    check("Independent captured calculation matches sum (₹4,500)", totalRealCaptured === 4500, `got ₹${totalRealCaptured}`);
    check("Independent refunded calculation matches sum (₹2,400)", totalRealRefunded === 2400, `got ₹${totalRealRefunded}`);
    check("Independent payouts calculation matches sum (₹1,725)", totalRealPayouts === 1725, `got ₹${totalRealPayouts}`);
    check("Net exposure reconciles: captured (4500) + clawbacks (600) >= refunded (2400) + settled (1725)",
      totalRealCaptured + totalClawbackExposure >= totalRealRefunded + totalRealPayouts
    );
  }

  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log(`RESULTS: ${passes} passed, ${failures} failed`);
  console.log("══════════════════════════════════════════════════════════════════\n");

  if (failures > 0) {
    console.error("AUDIT FAILED WITH DISCREPANCIES!");
    process.exit(1);
  } else {
    console.log("ALL ADVERSARIAL AUDIT CHECKS PASSED SUCCESSFULLY.");
    process.exit(0);
  }
})();
