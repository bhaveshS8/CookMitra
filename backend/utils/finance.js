// Centralized financial validators — single source of truth for every
// money-movement decision (payout settlement, refund approval, queue
// membership). Controllers must call these instead of re-implementing
// scattered status checks, so a rule change lands in exactly one place.
//
// Pure functions over booking-like objects (no DB access) — unit-testable.
// Amounts are integer rupees throughout the domain (paise only at the
// Razorpay boundary).

// A booking may pay its cook ONLY when every condition below holds. Returns
// { eligible, reasons[] } — callers refuse when eligible is false and MUST
// surface the reasons (never a bare 400) so admins can reconcile.
const payoutEligibility = (booking) => {
  const reasons = [];
  if (!booking) return { eligible: false, reasons: ["Booking not found"] };
  const pay = booking.payment || {};
  const payout = booking.payout || {};
  if (pay.status !== "paid") reasons.push("Payment is not captured");
  if (pay.testMode) reasons.push("Test payments carry no real money");
  if (!(Number(booking.amount) > 0)) reasons.push("Booking amount is not positive");
  if (!(Number(booking.cookPayout) > 0)) reasons.push("Cook share is not positive");
  if (booking.status !== "completed") reasons.push(`Booking is ${booking.status || "unknown"}, not completed`);
  if (booking.hoursCompleted !== true) reasons.push("Service hours are not marked complete");
  // Service evidence: the OTP clock must have run and the cook must have
  // arrived. Legacy auto-completions (24h backfill) only closed with paid
  // or arrived evidence, but arrival is what proves the cook showed up —
  // a paid no-show must never become a cook payout.
  if (!booking.serviceStartedAt) reasons.push("Service was never started (no OTP verification)");
  if (!booking.cookArrived) reasons.push("Cook arrival was never recorded");
  if (payout.status === "settled") reasons.push("Payout already settled");
  if (payout.status === "not_applicable") reasons.push("Payout declined — no cook share due");
  if (payout.status && payout.status !== "pending") reasons.push(`Payout is ${payout.status}, not pending`);
  // Money must not travel both directions without reconciliation: any live
  // or completed customer refund blocks the cook leg until resolved.
  const rs = pay.refundStatus || "none";
  if (!["none", "rejected"].includes(rs)) reasons.push(`Customer refund is ${rs} — resolve it first`);
  return { eligible: reasons.length === 0, reasons };
};

// Cumulative refunded total for the single-cycle refund model: money already
// returned (gateway-processed or manually settled) can never be refunded
// again. Returns integer rupees.
const refundedTotal = (booking) => {
  const pay = booking?.payment || {};
  if (["processed", "manual"].includes(pay.refundStatus)) {
    return Math.max(0, Math.round(Number(pay.refundAmount || 0)));
  }
  return 0;
};

// Maximum still refundable right now: captured minus already returned.
// Never negative; never trusts a client-supplied figure.
const maxRefundable = (booking) => {
  const paid = Math.max(0, Math.round(Number(booking?.payment?.paidAmount || booking?.amount || 0)));
  return Math.max(0, paid - refundedTotal(booking));
};

// Gate for approving a queued refund. Also reports the capped amount the
// approval may move (never above maxRefundable).
const refundApprovalCheck = (booking, { clawback = false } = {}) => {
  const reasons = [];
  if (!booking) return { ok: false, reasons: ["Booking not found"], amount: 0 };
  const pay = booking.payment || {};
  if (pay.refundStatus !== "pending") reasons.push("Only refunds awaiting approval can be approved");
  if (pay.testMode) {
    // Test money needs no gateway move; approval just closes the record.
    return { ok: reasons.length === 0, reasons, amount: 0, testMode: true };
  }
  if (pay.status !== "paid") reasons.push("No captured payment to refund");
  const amount = Math.round(Number(pay.refundAmount || pay.paidAmount || booking.amount || 0));
  const cap = maxRefundable(booking);
  if (!(amount > 0)) reasons.push("Refund amount is not positive");
  if (amount > cap) reasons.push(`Refund of ₹${amount} exceeds the refundable ₹${cap}`);
  // Double-spend guard: a settled cook share and a customer refund are the
  // same money twice. Settled payouts need an explicit clawback decision.
  if (booking.payout?.status === "settled" && !clawback) {
    reasons.push("Cook payout already settled — approve only with an explicit clawback decision");
  }
  return { ok: reasons.length === 0, reasons, amount: Math.min(amount, cap) };
};

// Offline transfer references (UPI txn id / bank ref) are admin-typed, so
// they are validated AND de-duplicated: the same reference settling two
// payouts is either a double-click or one transfer recorded twice.
const PAYOUT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]{2,118}[A-Za-z0-9]$/;
const isValidPayoutReference = (ref) => {
  const s = String(ref || "").trim();
  if (s.length < 4 || s.length > 120) return false;
  return PAYOUT_REF_RE.test(s);
};

// Cook payout-destination validation (server-side; the cook form only hints).
// Returns { ok, reasons[], normalized } — normalized upper-cases IFSC,
// trims strings, and keeps ONLY known keys so unknown payload keys never
// persist.
const UPI_RE = /^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const validatePayoutDetails = (input) => {
  const reasons = [];
  const d = input && typeof input === "object" ? input : {};
  const method = String(d.method || "").trim().toLowerCase();
  const out = {
    method: ["upi", "bank"].includes(method) ? method : "",
    upiId: String(d.upiId || "").trim(),
    holderName: String(d.holderName || "").trim().slice(0, 80),
    bankName: String(d.bankName || "").trim().slice(0, 80),
    accountLast4: String(d.accountLast4 || "").trim(),
    ifsc: String(d.ifsc || "").trim().toUpperCase(),
    note: String(d.note || "").trim().slice(0, 200),
    updatedAt: new Date(),
  };
  if (!out.method) reasons.push("Choose UPI or bank transfer");
  if (out.method === "upi" && !UPI_RE.test(out.upiId)) {
    reasons.push("Enter a valid UPI id (name@bank)");
  }
  if (out.method === "bank") {
    if (!/^\d{4}$/.test(out.accountLast4)) reasons.push("Account last-4 must be 4 digits");
    if (!IFSC_RE.test(out.ifsc)) reasons.push("Enter a valid IFSC code");
    if (!out.holderName) reasons.push("Account holder name is required");
  }
  return { ok: reasons.length === 0, reasons, normalized: out };
};

// Append-only financial audit writer. Best-effort by contract: ledger rows
// must never break a money operation, but every failure is logged loudly so
// a silent audit gap is impossible to miss. Callers pass a stable
// idempotencyKey per decision (e.g. `payout:<bookingId>`); a duplicate key
// collides on the unique index and is swallowed as "already recorded".
const recordLedger = async (entry) => {
  try {
    const LedgerEntry = require("../models/LedgerEntry");
    try {
      await LedgerEntry.create(entry);
    } catch (e) {
      if (e?.code === 11000) return { duplicate: true };
      throw e;
    }
    return { recorded: true };
  } catch (e) {
    console.error(
      `LEDGER WRITE FAILED type=${entry?.type} booking=${entry?.booking} key=${entry?.idempotencyKey}: ${e?.message || e}`
    );
    return { failed: true };
  }
};

module.exports = {
  payoutEligibility,
  refundedTotal,
  maxRefundable,
  refundApprovalCheck,
  isValidPayoutReference,
  validatePayoutDetails,
  recordLedger,
};
