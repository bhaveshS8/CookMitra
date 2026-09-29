// refund-hardening.test.js — adversarial regression suite for the refund
// hardening pass (stubbed controllers, no DB).
// Run:  node backend/refund-hardening.test.js  — exits non-zero on failure.
//
// Covers:
//  1. finance.parseRupeeAmount — strict amount parser (booleans/strings/NaN/
//     Infinity/decimals/zero/negatives/objects).
//  2. approveRefund — malformed amounts refused; an already-created gateway
//     refund is ADOPTED instead of creating a second one; an ambiguous
//     gateway response is never recorded as a completed refund.
//  3. markRefundSettled — fails closed when the gateway is unreachable,
//     adopts an existing gateway refund instead of paying twice, and records
//     the normalized reference key on the manual path.
//  4. reconcileRefund — adopts an existing gateway refund, returns the row to
//     the decision queue when the gateway holds none, 503 when unreachable,
//     and refuses illegal states.
//  5. Ledger idempotency across adoption paths (one economic event → one row).
//  6. Static UI wiring checks (processing rows + recovery action + clawback
//     decision exist in the admin console).
//
// Gateway env BEFORE requires (config snapshots at load).
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.RAZORPAY_KEY_ID = "rk_test_abcdef123456";
process.env.RAZORPAY_KEY_SECRET = "s3cr3tK3yV4lu3AbCdEfGh";
process.env.RAZORPAY_CURRENCY = "INR";

const fs = require("fs");
const path = require("path");
const Booking = require("./models/Booking");
const Notification = require("./models/Notification");
const LedgerEntry = require("./models/LedgerEntry");
const rzCfg = require("./config/razorpay");
const payoutCtrl = require("./controllers/payoutController");
const { parseRupeeAmount } = require("./utils/finance");

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes += 1;
  else failures += 1;
};
const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
};
const next = (err) => { if (err) throw err || new Error("next()"); };

// ── fakes ────────────────────────────────────────────────────────────────────
let store = new Map();
let ledgerRows = [];
let ledgerKeys = new Set();
let notifications = [];
let refundCreateCalls = 0;
let refundCreateImpl = null;
let refundListImpl = null;

const savedLedgerCreate = LedgerEntry.create;
LedgerEntry.create = async (e) => {
  if (ledgerKeys.has(e.idempotencyKey)) {
    const err = new Error("dup");
    err.code = 11000;
    throw err;
  }
  ledgerKeys.add(e.idempotencyKey);
  ledgerRows.push(e);
  return e;
};
const savedNotifCreate = Notification.create;
Notification.create = async (n) => { notifications.push(n); return n; };

const mkDoc = (over = {}) => {
  const base = {
    _id: "b1",
    customer: "cust1",
    cook: "cook1",
    status: "cancelled",
    amount: 349,
    cookPayout: 262,
    commission: 87,
    statusHistory: [],
    payment: {
      status: "paid",
      paidAmount: 349,
      razorpayOrderId: "order_1",
      razorpayPaymentId: "pay_1",
      refundStatus: "pending",
      refundAmount: 349,
      testMode: false,
    },
    payout: { status: "pending" },
  };
  const doc = {
    ...base,
    ...over,
    // Sub-docs MERGE over the defaults (a partial `payment` override must not
    // wipe razorpayPaymentId/testMode, exactly like a real booking doc).
    payment: { ...base.payment, ...(over.payment || {}) },
    payout: { ...base.payout, ...(over.payout || {}) },
    toObject() {
      const { toObject, ...rest } = this;
      return { ...rest };
    },
  };
  store.set(String(doc._id), doc);
  return doc;
};

// Atomic-update emulation: honours the refundStatus guard ($in / equality) and
// the payout-status $ne pin, applies dotted $set, pushes history.
Booking.findOneAndUpdate = async (filter, update) => {
  const doc = store.get(String(filter._id));
  if (!doc) return null;
  const want = filter["payment.refundStatus"];
  const cur = doc.payment?.refundStatus;
  const okStatus = want && typeof want === "object" && "$in" in want ? want.$in.includes(cur) : cur === want;
  if (!okStatus) return null;
  const pin = filter["payout.status"];
  if (pin && pin.$ne !== undefined && doc.payout?.status === pin.$ne) return null;
  for (const [k, v] of Object.entries(update.$set || {})) {
    const ks = String(k).split(".");
    let t = doc;
    for (let i = 0; i < ks.length - 1; i++) t = t[ks[i]];
    t[ks[ks.length - 1]] = v;
  }
  if (update.$push?.statusHistory) doc.statusHistory.push(update.$push.statusHistory);
  return doc;
};
Booking.findById = async (id) => store.get(String(id)) || null;

const reset = () => {
  store = new Map();
  ledgerRows = [];
  ledgerKeys = new Set();
  notifications = [];
  refundCreateCalls = 0;
  refundCreateImpl = null;
  refundListImpl = async () => ({ items: [] });
  rzCfg.razorpay.refunds.all = async (...args) => refundListImpl(...args);
  rzCfg.razorpay.payments.refund = async (...args) => {
    refundCreateCalls += 1;
    if (refundCreateImpl) return refundCreateImpl(...args);
    return { id: "rf_new", amount: 34900, status: "processed" };
  };
};

(async () => {
  try {
    console.log("\n═══ strict amount parser ═══");
    check("700 accepted", parseRupeeAmount(700).ok === true && parseRupeeAmount(700).value === 700);
    check('"700" accepted', parseRupeeAmount("700").ok === true && parseRupeeAmount("700").value === 700);
    check('" 700 " accepted', parseRupeeAmount(" 700 ").value === 700);
    check('"999999" accepted (cap enforced downstream)', parseRupeeAmount("999999").value === 999999);
    check("true refused (would coerce to ₹1)", parseRupeeAmount(true).ok === false);
    check("false refused", parseRupeeAmount(false).ok === false);
    check("null refused", parseRupeeAmount(null).ok === false);
    check("undefined refused", parseRupeeAmount(undefined).ok === false);
    check('"NaN" refused', parseRupeeAmount("NaN").ok === false);
    check('"Infinity" refused', parseRupeeAmount("Infinity").ok === false);
    check("Infinity refused", parseRupeeAmount(Infinity).ok === false);
    check("0 refused", parseRupeeAmount(0).ok === false);
    check("-100 refused", parseRupeeAmount(-100).ok === false);
    check("0.001 refused", parseRupeeAmount(0.001).ok === false);
    check("1.999999 refused (no silent rounding)", parseRupeeAmount(1.999999).ok === false);
    check("object refused", parseRupeeAmount({ amount: 700 }).ok === false);
    check("array refused", parseRupeeAmount([700]).ok === false);

    console.log("\n═══ approveRefund: malformed amounts never move money ═══");
    {
      reset();
      const doc = mkDoc({});
      let r = makeRes();
      await payoutCtrl.approveRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: { amount: true } }, r, next);
      check("boolean amount refused", r.statusCode === 400, `s=${r.statusCode}`);
      check("boolean amount moved nothing", doc.payment.refundStatus === "pending" && ledgerRows.length === 0, doc.payment.refundStatus);
      r = makeRes();
      await payoutCtrl.approveRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: { amount: 1.999999 } }, r, next);
      check("decimal amount refused", r.statusCode === 400 && doc.payment.refundStatus === "pending", `s=${r.statusCode}`);
      r = makeRes();
      await payoutCtrl.approveRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: { amount: 999999 } }, r, next);
      check("over-cap amount refused", r.statusCode === 400 && /exceeds the refundable/.test(r.body?.message || ""), `s=${r.statusCode}`);
    }

    console.log("\n═══ approveRefund: adopt an existing gateway refund ═══");
    {
      reset();
      const doc = mkDoc({});
      refundListImpl = async () => ({ items: [{ id: "rf_existing", amount: 34900, status: "processed" }] });
      const r = makeRes();
      await payoutCtrl.approveRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: {} }, r, next);
      check("approve succeeds via adoption", r.statusCode === 200, `s=${r.statusCode}`);
      check("no second gateway refund created", refundCreateCalls === 0, `createCalls=${refundCreateCalls}`);
      check("existing refund id recorded", doc.payment.refundId === "rf_existing" && doc.payment.refundStatus === "processed", `${doc.payment.refundId}/${doc.payment.refundStatus}`);
      const row = ledgerRows.find((l) => l.type === "refund.approved");
      check("ledger records the adopted refund", !!row && row.razorpayRefundId === "rf_existing" && /adopted/i.test(row.reason || ""), row?.reason || "no row");
      check("history names the adoption", /adopted/i.test(String(doc.statusHistory.map((h) => h.note).join(" "))));
      check("customer notified", notifications.some((n) => String(n.user) === "cust1"));
    }

    console.log("\n═══ approveRefund: ambiguous gateway response ═══");
    {
      reset();
      const doc = mkDoc({});
      refundCreateImpl = async () => ({ id: "", amount: 34900, status: "processed" }); // missing id
      let r = makeRes();
      await payoutCtrl.approveRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: {} }, r, next);
      check("missing gateway id -> failed, not processed", r.statusCode === 200 && doc.payment.refundStatus === "failed", `${r.statusCode}/${doc.payment.refundStatus}`);
      check("no refund id persisted from an ambiguous body", doc.payment.refundId === "", `id=${doc.payment.refundId}`);
      check("failed approval still audited", ledgerRows.some((l) => l.type === "refund.approved" && l.newState === "refund:failed"));
    }
    {
      reset();
      const doc = mkDoc({});
      refundCreateImpl = async () => ({ id: "rf_amt", amount: 100, status: "processed" }); // wrong amount (₹1)
      const r = makeRes();
      await payoutCtrl.approveRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: {} }, r, next);
      check("amount mismatch -> failed", doc.payment.refundStatus === "failed", doc.payment.refundStatus);
    }
    {
      reset();
      const doc = mkDoc({});
      refundCreateImpl = async () => { throw new Error("gateway boom"); };
      const r = makeRes();
      await payoutCtrl.approveRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: {} }, r, next);
      check("gateway throw -> failed (stays visible for reconcile)", doc.payment.refundStatus === "failed", doc.payment.refundStatus);
    }

    console.log("\n═══ markRefundSettled: gateway guard ═══");
    {
      // (a) Gateway unreachable → refuse to guess (503), nothing changes.
      reset();
      const doc = mkDoc({ payment: { refundStatus: "failed", refundAmount: 349 } });
      refundListImpl = async () => { throw new Error("network down"); };
      const r = makeRes();
      await payoutCtrl.markRefundSettled({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "ABC123" } }, r, next);
      check("unreachable gateway -> 503, state untouched", r.statusCode === 503 && doc.payment.refundStatus === "failed", `s=${r.statusCode}/${doc.payment.refundStatus}`);
      check("503 wrote no ledger row", ledgerRows.length === 0);
    }
    {
      // (b) Gateway already holds the refund → adopt, never record a manual transfer.
      reset();
      const doc = mkDoc({ payment: { refundStatus: "processing", refundAmount: 349 } });
      refundListImpl = async () => ({ items: [{ id: "rf_gw", amount: 34900, status: "processed" }] });
      const r = makeRes();
      await payoutCtrl.markRefundSettled({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "ABC123" } }, r, next);
      check("existing gateway refund adopted, 200", r.statusCode === 200 && r.body?.adopted === true, `s=${r.statusCode}`);
      check("adopted: processed + gateway id, no manual reference", doc.payment.refundStatus === "processed" && doc.payment.refundId === "rf_gw" && !doc.payment.refundReferenceKey, `${doc.payment.refundStatus}/${doc.payment.refundId}/${doc.payment.refundReferenceKey}`);
      check("adoption ledger row points at the gateway refund", ledgerRows.some((l) => l.type === "refund.settled" && l.razorpayRefundId === "rf_gw" && /no manual transfer/i.test(l.reason || "")));
      check("customer notified about the adopted refund", notifications.some((n) => String(n.user) === "cust1"));
    }
    {
      // (c) Gateway holds none → manual settlement records the normalized key.
      reset();
      const doc = mkDoc({ payment: { refundStatus: "manual", refundAmount: 349 } });
      const r = makeRes();
      await payoutCtrl.markRefundSettled({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: " MANUAL-Ref 001 " } }, r, next);
      check("manual settlement succeeds", r.statusCode === 200 && doc.payment.refundStatus === "processed", `s=${r.statusCode}/${doc.payment.refundStatus}`);
      check("exact reference stored, normalized key derived", doc.payment.refundReference === "MANUAL-Ref 001" && doc.payment.refundReferenceKey === "manual-ref001", `${doc.payment.refundReference}/${doc.payment.refundReferenceKey}`);
      const row = ledgerRows.find((l) => l.type === "refund.settled");
      check("ledger keeps prevState + relatedKey", row?.prevState === "refund:manual" && row?.relatedKey === "manual-ref001", `${row?.prevState}/${row?.relatedKey}`);
    }
    {
      // Invalid reference shapes never reach the DB.
      reset();
      const doc = mkDoc({ payment: { refundStatus: "manual", refundAmount: 349 } });
      for (const bad of ["A", "   ", "<script>x</script>", "AB\nCD", "X".repeat(121)]) {
        const r = makeRes();
        await payoutCtrl.markRefundSettled({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: bad } }, r, next);
        check(`reference ${JSON.stringify(String(bad).slice(0, 14))} refused`, r.statusCode === 400, `s=${r.statusCode}`);
      }
      check("no bad reference ever persisted", doc.payment.refundReference === undefined && doc.payment.refundStatus === "manual", String(doc.payment.refundReference));
      // Duplicate-key race at the DB level fails closed (unique index).
      reset();
      const raced = mkDoc({ payment: { refundStatus: "manual", refundAmount: 349 } });
      const savedClaim = Booking.findOneAndUpdate;
      Booking.findOneAndUpdate = async () => { const e = new Error("dup key"); e.code = 11000; throw e; };
      const r2 = makeRes();
      await payoutCtrl.markRefundSettled({ params: { id: "b1" }, user: { id: "admin1" }, body: { reference: "RACE-REF-9" } }, r2, next);
      Booking.findOneAndUpdate = savedClaim;
      check("reference race -> 409, nothing settled", r2.statusCode === 409 && raced.payment.refundStatus === "manual", `s=${r2.statusCode}`);
    }

    console.log("\n═══ reconcileRefund ═══");
    {
      // (a) Adopts an existing gateway refund (and keeps the ledger key stable).
      reset();
      const doc = mkDoc({ payment: { refundStatus: "processing", refundAmount: 349 } });
      refundListImpl = async () => ({ items: [{ id: "rf_reconcile", amount: 34900, status: "processed" }] });
      const r = makeRes();
      await payoutCtrl.reconcileRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: {} }, r, next);
      check("reconcile adopts the gateway refund", r.statusCode === 200 && r.body?.adopted === true && doc.payment.refundStatus === "processed", `s=${r.statusCode}/${doc.payment.refundStatus}`);
      check("reconcile ledger uses the approve key", ledgerRows.some((l) => l.idempotencyKey === "refund-approve:b1" && l.razorpayRefundId === "rf_reconcile"));
      check("reconcile notifies the customer once", notifications.filter((n) => String(n.user) === "cust1").length === 1);
    }
    {
      // (b) Gateway holds no refund → back to pending, no ledger event.
      reset();
      const doc = mkDoc({ payment: { refundStatus: "processing", refundAmount: 349 } });
      const r = makeRes();
      await payoutCtrl.reconcileRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: {} }, r, next);
      check("no gateway refund -> back to pending", r.statusCode === 200 && r.body?.adopted === false && doc.payment.refundStatus === "pending", `s=${r.statusCode}/${doc.payment.refundStatus}`);
      check("re-queue moves no money in the ledger", ledgerRows.length === 0);
      check("history explains the re-queue", /no refund found/i.test(String(doc.statusHistory.map((h) => h.note).join(" "))));
    }
    {
      // (c) Unreachable gateway → 503, untouched. (d–f) Illegal states.
      reset();
      const doc = mkDoc({ payment: { refundStatus: "failed", refundAmount: 349 } });
      refundListImpl = async () => { throw new Error("timeout"); };
      let r = makeRes();
      await payoutCtrl.reconcileRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: {} }, r, next);
      check("unreachable gateway -> 503, untouched", r.statusCode === 503 && doc.payment.refundStatus === "failed", `s=${r.statusCode}`);
      refundListImpl = async () => ({ items: [] });
      r = makeRes();
      await payoutCtrl.reconcileRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: {} }, r, next);
      check("failed row with no gateway refund -> pending", r.statusCode === 200 && doc.payment.refundStatus === "pending", `${r.statusCode}/${doc.payment.refundStatus}`);
      r = makeRes();
      await payoutCtrl.reconcileRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: {} }, r, next);
      check("pending row is not reconcilable (400)", r.statusCode === 400, `s=${r.statusCode}`);
      const testDoc = mkDoc({ _id: "b2", payment: { refundStatus: "processing", testMode: true, refundAmount: 349 } });
      r = makeRes();
      await payoutCtrl.reconcileRefund({ params: { id: "b2" }, user: { id: "admin1" }, body: {} }, r, next);
      check("test-mode row refused (400)", r.statusCode === 400 && testDoc.payment.refundStatus === "processing", `s=${r.statusCode}`);
      const noGw = mkDoc({ _id: "b3", payment: { refundStatus: "processing", razorpayPaymentId: "", refundAmount: 349 } });
      r = makeRes();
      await payoutCtrl.reconcileRefund({ params: { id: "b3" }, user: { id: "admin1" }, body: {} }, r, next);
      check("no gateway payment id -> 400", r.statusCode === 400 && noGw.payment.refundStatus === "processing", `s=${r.statusCode}`);
      r = makeRes();
      await payoutCtrl.reconcileRefund({ params: { id: "nope" }, user: { id: "admin1" }, body: {} }, r, next);
      check("unknown booking -> 404", r.statusCode === 404, `s=${r.statusCode}`);
    }
    {
      // (g) Idempotency: a pre-existing approve ledger row is never duplicated.
      reset();
      ledgerKeys.add("refund-approve:b1");
      ledgerRows.push({ idempotencyKey: "refund-approve:b1", type: "refund.approved", amount: 349 });
      const doc = mkDoc({ payment: { refundStatus: "processing", refundAmount: 349 } });
      refundListImpl = async () => ({ items: [{ id: "rf_dup", amount: 34900, status: "processed" }] });
      const r = makeRes();
      await payoutCtrl.reconcileRefund({ params: { id: "b1" }, user: { id: "admin1" }, body: {} }, r, next);
      check("adoption with existing ledger row stays 200", r.statusCode === 200, `s=${r.statusCode}`);
      check("ledger not duplicated for one economic event", ledgerRows.filter((l) => l.idempotencyKey === "refund-approve:b1").length === 1);
    }

    console.log("\n═══ admin console wiring (static) ═══");
    {
      const panel = fs.readFileSync(path.join(__dirname, "..", "frontend", "src", "components", "AdminPayoutsPanel.jsx"), "utf8");
      const dialog = fs.readFileSync(path.join(__dirname, "..", "frontend", "src", "components", "ConfirmDialog.jsx"), "utf8");
      check("refunds tab renders a processing section", /processingRefunds/.test(panel) && /refundStatus === "processing"/.test(panel));
      check("processing rows expose the reconcile action", /refunds\/\$\{[^}]+\}\/reconcile/.test(panel));
      check("approve sends the clawback decision", /clawback:\s*true/.test(panel));
      check("approve dialog uses a single-line numeric field", /singleLine/.test(panel) && /inputMode/.test(panel));
      check("refund status filter present (history view)", /statusFilter/.test(panel));
      check("ConfirmDialog supports a checkbox decision", /checkbox/.test(dialog));
    }

    console.log(`\n${passes} passed, ${failures} failed`);
    if (failures > 0) {
      console.log("FAILURES PRESENT");
      process.exit(1);
    }
    console.log("ALL TESTS PASSED");
  } catch (err) {
    console.error("FATAL", err);
    process.exit(1);
  } finally {
    LedgerEntry.create = savedLedgerCreate;
    Notification.create = savedNotifCreate;
  }
})();



