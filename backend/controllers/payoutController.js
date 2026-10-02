// Cook payout settlement + refund console — admin-only ledger operations.
//
// Every paid booking records the cook's 85% in Booking.payout (status
// "pending"). Nothing paid the cook until an admin makes an actual UPI/bank
// transfer outside the app and records the reference here. This module gives
// that flow one console: a pending queue with the cook's payout details,
// history, per-cook statements, and a failed-refund follow-up queue.
const Booking = require("../models/Booking");
const mongoose = require("mongoose");
const CookProfile = require("../models/CookProfile");
const { paginationParams, applyPagination, sendList } = require("../utils/pagination");
const { razorpay: razorpayClient, isConfigured: razorpayConfigured } = require("../config/razorpay");
const {
  payoutEligibility,
  refundApprovalCheck,
  maxRefundable,
  isValidPayoutReference,
  normalizePayoutReference,
  parseRupeeAmount,
  recordLedger,
} = require("../utils/finance");

// Test payments carry no real money — they must never enter the payout
// queue. Real gateway/webhook payments (paid + not testMode) do — but only
// once the service is actually rendered: booking `completed` AND cooking
// hours flagged complete. Upcoming (confirmed/in_progress) and cancelled
// bookings never enter the queue — settling those would release the cook's
// share for an unrendered session (a cancelled session is refunded to the
// customer instead). Zero-value rows carry no money and are excluded so a
// free booking can never look payable. Rows predating the payout subdoc
// (missing `payout`) are treated as pending so legacy money can't stick.
const PAYOUT_PENDING_OR_MISSING = {
  $or: [{ "payout.status": "pending" }, { "payout.status": { $exists: false } }],
};
const pendingFilter = () => ({
  "payment.status": "paid",
  "payment.testMode": { $ne: true },
  status: "completed",
  hoursCompleted: true,
  cookPayout: { $gt: 0 },
  ...PAYOUT_PENDING_OR_MISSING,
});

// Cook payout queue: every completed paid booking whose 85% is not yet
// settled, oldest first (fairness — cooks see their oldest money first).
// Includes the cook's saved payout details so the admin can copy the UPI id
// / read the bank last-4 without opening another page.
exports.getPayoutQueue = async (req, res, next) => {
  try {
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      Booking.find(pendingFilter())
        .sort({ date: 1, createdAt: 1, _id: 1 })
        .populate("cook", "name phone")
        .populate("customer", "name"),
      pg
    );
    // Attach each cook's payout details in one extra query round.
    const cookIds = [...new Set((bookings || []).map((b) => String(b.cook?._id || b.cook)))];
    const profiles = await CookProfile.find({ user: { $in: cookIds } })
      .select("user payoutDetails")
      .lean();
    const byUser = new Map(profiles.map((p) => [String(p.user), p.payoutDetails || null]));
    // Eligibility flags ride along so the console never implies a blocked
    // row is payable: settlePayout enforces the same validator server-side.
    const enriched = (bookings || []).map((b) => {
      const plain = b.toObject ? b.toObject() : b;
      const { eligible, reasons } = payoutEligibility(b);
      return {
        ...plain,
        cookPayoutDetails: byUser.get(String(b.cook?._id || b.cook)) || null,
        payoutEligible: eligible,
        payoutBlockers: eligible ? [] : reasons,
      };
    });
    return sendList(res, enriched, pg, () => Booking.countDocuments(pendingFilter()));
  } catch (error) {
    next(error);
  }
};

// Payout history: bookings already settled (newest first) for the audit trail.
exports.getPayoutHistory = async (req, res, next) => {
  try {
    const filter = { "payout.status": "settled", "payment.testMode": { $ne: true } };
    if (req.query.cook) {
      if (!/^[0-9a-fA-F]{24}$/.test(String(req.query.cook))) {
        return res.status(400).json({ message: "Valid cook id is required" });
      }
      filter.cook = req.query.cook;
    }
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      Booking.find(filter).sort({ "payout.settledAt": -1, _id: 1 }).populate("cook", "name phone"),
      pg
    );
    return sendList(res, bookings, pg, () => Booking.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

// Mark one booking's cook share as paid. Offline money is treated as a
// financial transaction, not a text field:
// - the reference is format-validated AND globally unique (one transfer
//   recorded twice is the classic double-spend);
// - the centralized eligibility validator gates every rupee (paid, completed,
//   evidenced service, no live refund);
// - the recipient is snapshotted from the cook's profile at settle time, so
//   later detail edits can't rewrite history;
// - the claim is atomic (pending→settled) + idempotent on retry.
exports.settlePayout = async (req, res, next) => {
  try {
    const reference = String(req.body?.reference || "").trim();
    if (!isValidPayoutReference(reference)) {
      return res.status(400).json({ message: "Enter a valid transfer reference (4–120 characters: letters, digits, spaces and . - _ /)" });
    }
    const existing = await Booking.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (existing.payout?.status === "settled") {
      return res.json(existing); // already settled — idempotent success
    }
    if (existing.payout?.status === "not_applicable") {
      return res.status(400).json({ message: "This booking has no cook payout" });
    }
    const { eligible, reasons } = payoutEligibility(existing);
    if (!eligible) {
      return res.status(400).json({ message: reasons[0], reasons, code: "PAYOUT_NOT_ELIGIBLE" });
    }
    // One transfer, one record: a reference that already settled another
    // booking is a double-entry until proven otherwise. Compared on the
    // NORMALIZED key (case/whitespace-insensitive) — bank refs are too;
    // the exact typed text is still stored for audit fidelity. Checked
    // across BOTH families: the same offline transfer must not close a
    // manual refund and a payout (markRefundSettled checks both directions).
    const refKey = normalizePayoutReference(reference);
    const dup = await Booking.findOne({
      $or: [
        { "payout.referenceKey": refKey, "payout.status": "settled" },
        { "payment.refundReferenceKey": refKey },
      ],
    }).select("_id");
    if (dup && String(dup._id) !== String(existing._id)) {
      return res.status(409).json({ message: "This reference is already recorded on another payment — use the unique UPI/bank transaction id", code: "DUPLICATE_PAYOUT_REFERENCE" });
    }
    // Freeze who is being paid: the cook's CURRENT destination details.
    // Semantics (documented, not proof): this records the destination the
    // admin had on file at settlement time — "recipient recorded by the
    // admin at settlement time". The transfer itself happens externally
    // BEFORE this click, so the UI requires the admin to confirm the shown
    // destination matches the actual transfer (see AdminPayoutsPanel).
    // Later profile edits can never rewrite this snapshot.
    let recipient = null;
    try {
      const profile = await CookProfile.findOne({ user: existing.cook }).select("payoutDetails").lean();
      const d = profile?.payoutDetails || {};
      recipient = {
        method: String(d.method || ""),
        upiId: String(d.upiId || ""),
        holderName: String(d.holderName || ""),
        bankName: String(d.bankName || ""),
        accountLast4: String(d.accountLast4 || ""),
        ifsc: String(d.ifsc || ""),
      };
    } catch {
      recipient = null;
    }
    let booking;
    try {
      // Atomic claim with the FULL economic guard set, not just the payout
      // flag: a customer refund queued (or approved) between the eligibility
      // read above and this write must fail the claim instead of creating a
      // refund+payout contradiction. Legacy rows without a payout subdoc
      // claim through the same gate.
      booking = await Booking.findOneAndUpdate(
        {
          _id: existing._id,
          ...PAYOUT_PENDING_OR_MISSING,
          "payment.refundStatus": { $in: ["none", "rejected"] },
        },
        {
          $set: {
            "payout.status": "settled",
            "payout.settledAt": new Date(),
            "payout.reference": reference,
            "payout.referenceKey": refKey,
            "payout.amount": existing.cookPayout,
            "payout.recipient": recipient,
            "payout.settledBy": req.user.id,
          },
          $push: {
            statusHistory: {
              status: existing.status,
              note: `Cook payout ₹${existing.cookPayout} settled (ref: ${reference}) by admin`,
            },
          },
        },
        { new: true }
      );
    } catch (e) {
      // Lost a uniqueness race between the check above and the claim:
      // another booking settled with this reference (or its case-variant)
      // first. The uniq_payout_reference* indexes make this fail closed.
      if (e?.code === 11000) {
        return res.status(409).json({ message: "This reference is already recorded on another payment — use the unique UPI/bank transaction id", code: "DUPLICATE_PAYOUT_REFERENCE" });
      }
      throw e;
    }
    if (!booking) {
      const fresh = await Booking.findById(req.params.id);
      if (fresh?.payout?.status === "settled") return res.json(fresh);
      return res.status(409).json({ message: "Payout is already being processed — please refresh.", code: "PAYOUT_ALREADY_PROCESSED" });
    }
    await recordLedger({
      idempotencyKey: `payout:${booking._id}`,
      booking: booking._id,
      type: "payout.settled",
      amount: Math.round(Number(booking.payout.amount || 0)),
      prevState: "payout:pending",
      newState: "payout:settled",
      actor: `admin:${req.user.id}`,
      source: "admin",
      payoutReference: reference,
      reason: `Cook share settled to ${recipient?.upiId || recipient?.accountLast4 || "recorded destination"}`,
    });

    // Tell the cook their money is on the way (non-fatal).
    try {
      const Notification = require("../models/Notification");
      await Notification.create({
        user: booking.cook,
        type: "payout_settled",
        booking: booking._id,
        message: `Payout of ₹${booking.cookPayout} sent for the ${
          booking.date
            ? new Date(booking.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
            : ""
        } session. Ref: ${booking.payout.reference}`,
      });
    } catch {
      // non-fatal
    }

    res.json(booking);
  } catch (error) {
    next(error);
  }
};

// Per-cook statement: earnings, commission, settled vs pending totals.
// Cooks call this for "me"; admins use /statement/:cookId for anyone.
exports.getPayoutStatement = async (req, res, next) => {
  try {
    const cookId = req.params.cookId === "me" ? req.user.id : req.params.cookId;
    if (!/^[0-9a-fA-F]{24}$/.test(String(cookId))) {
      return res.status(400).json({ message: "Valid cook id is required" });
    }
    const isAdmin = String(req.user.role).toUpperCase() === "ADMIN";
    if (!isAdmin && String(cookId) !== String(req.user.id)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const match = {
      cook: cookId,
      "payment.status": "paid",
      "payment.testMode": { $ne: true },
      status: { $in: ["confirmed", "in_progress", "completed", "cancelled"] },
    };
    const rows = await Booking.find(match)
      .select("amount commission cookPayout payout payment status date hoursCompleted")
      .lean();
    // earnings = gross cook share across paid real bookings (refunds NOT
    // deducted); refunded = successful refunds (processed/manual, real money
    // only); netEarnings = what the cook side actually keeps. Labels must
    // use netEarnings for "earned" — see CookPayoutPanel.
    const SETTLED_REFUND = ["processed", "manual"];
    const statement = rows.reduce(
      (acc, b) => {
        acc.bookings += 1;
        acc.gross += b.amount || 0;
        acc.commission += b.commission || 0;
        acc.earnings += b.cookPayout || 0;
        if (
          SETTLED_REFUND.includes(b.payment?.refundStatus) &&
          b.payment?.testMode !== true
        ) {
          acc.refunded += Math.round(Number(b.payment?.refundAmount || 0));
        }
        if (b.payout?.status === "settled") {
          acc.settled += b.payout.amount || b.cookPayout || 0;
        } else if (!b.payout || b.payout?.status === "pending") {
          // "Pending" means releasable money: only a completed service with
          // completed service hours can ever be settled, and never while a
          // customer refund for the same money is live. Upcoming or
          // cancelled rows stay in history but hold no payable amount.
          // Missing payout subdoc (legacy rows) behaves as pending.
          const liveRefund = b.payment?.refundStatus
            && !["none", "rejected"].includes(b.payment.refundStatus);
          if (b.status === "completed" && b.hoursCompleted === true && !liveRefund) {
            acc.pending += b.cookPayout || 0;
            acc.pendingCount += 1;
          }
        }
        return acc;
      },
      { bookings: 0, gross: 0, commission: 0, earnings: 0, refunded: 0, settled: 0, pending: 0, pendingCount: 0 }
    );
    statement.netEarnings = Math.max(0, statement.earnings - statement.refunded);

    const profile = await CookProfile.findOne({ user: cookId })
      .select("payoutDetails")
      .lean();
    res.json({
      statement,
      payoutDetails: profile?.payoutDetails || null,
      payouts: rows
        .filter((b) => b.payout?.status === "settled")
        .sort((a, b) => new Date(b.payout.settledAt) - new Date(a.payout.settledAt))
        .slice(0, 50)
        .map((b) => ({
          _id: b._id,
          date: b.date,
          amount: b.payout.amount,
          settledAt: b.payout.settledAt,
          reference: b.payout.reference,
        })),
    });
  } catch (error) {
    next(error);
  }
};

// Best-effort gateway refund lookup: returns { ok, items[] } where items
// are normalized { id, amountPaise, status }. Used by recovery paths to
// adopt an already-created gateway refund instead of moving money twice.
// Never throws — callers decide how to proceed when the gateway is silent.
const lookupGatewayRefunds = async (razorpayPaymentId) => {
  try {
    if (!razorpayPaymentId || !razorpayConfigured || !razorpayClient || !razorpayClient.refunds) {
      return { ok: false, reason: "gateway-unavailable" };
    }
    const res = await razorpayClient.refunds.all({ payment_id: razorpayPaymentId });
    const items = (res?.items || res?.entities || (Array.isArray(res) ? res : []) || [])
      .filter(Boolean)
      .map((r) => ({
        id: String(r.id || ""),
        amountPaise: Math.round(Number(r.amount || 0)),
        status: String(r.status || "").toLowerCase(),
      }))
      .filter((r) => r.id);
    return { ok: true, items };
  } catch (e) {
    return { ok: false, reason: e?.message || "gateway-error" };
  }
};

// An already-created gateway refund matching this approval (same amount in
// paise), if any. Matching by amount prevents adopting an unrelated partial
// refund for a different decision.
const matchingGatewayRefund = (items, refundAmountPaise) =>
  (items || []).find((r) => r.amountPaise === refundAmountPaise && !["failed", "cancelled"].includes(r.status)) || null;

// Admin refund queue: refund requests awaiting a decision ("pending"), rows
// mid-approval ("processing" — a crashed approve must stay visible, never
// vanish), plus bookings whose approved refund failed or needs a manual
// transfer, so support never has to query the DB by hand. Optional
// ?status=pending|processing|failed|manual|processed|rejected|all narrows
// the list (default: actionable states); processed/rejected provide the
// historical view for support follow-ups.
exports.getRefundQueue = async (req, res, next) => {
  try {
    const ACTIONABLE = ["pending", "processing", "failed", "manual"];
    const rawStatus = req.query?.status;
    let statuses = ACTIONABLE;
    if (rawStatus != null && String(rawStatus).trim() !== "") {
      const want = String(rawStatus).trim().toLowerCase();
      if (want === "all") {
        statuses = ["pending", "processing", "failed", "manual", "processed", "rejected"];
      } else if (["pending", "processing", "failed", "manual", "processed", "rejected"].includes(want)) {
        statuses = [want];
      } else {
        return res.status(400).json({ message: "status must be one of pending, processing, failed, manual, processed, rejected, all" });
      }
    }
    const filter = {
      "payment.refundStatus": { $in: statuses },
      "payment.testMode": { $ne: true },
    };
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      Booking.find(filter)
        .sort({ updatedAt: -1, _id: 1 })
        .populate("customer", "name phone")
        .populate("cook", "name"),
      pg
    );
    return sendList(res, bookings, pg, () => Booking.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

// Admin: approve a queued refund — the ONLY path that moves money back to
// the customer. Atomic claim (pending→processing) first: two concurrent
// approves cannot both reach the gateway. Real gateway payments are refunded
// via Razorpay (failures stay queued as "failed" for retry/follow-up); when
// the gateway is not configured the request becomes "manual" for an outside
// transfer, closed later via markRefundSettled. Test payments carry no real
// money, so they close as processed immediately.
exports.approveRefund = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (booking.payment?.refundStatus !== "pending") {
      return res.status(400).json({ message: "Only refunds awaiting approval can be approved", code: "REFUND_NOT_ELIGIBLE" });
    }
    // Validate BEFORE claiming: amount caps, test-mode routing, and the
    // settled-payout clawback gate are all pure checks on the queued state.
    // Optional body.amount selects a PARTIAL refund (0 < amount <= cap);
    // omitted/wild values fall back to the full capped amount. The customer
    // can never set this — this route is admin-only.
    const clawback = req.body?.clawback === true;
    const pre = refundApprovalCheck(booking, { clawback });
    if (!pre.ok) {
      return res.status(400).json({ message: pre.reasons[0], reasons: pre.reasons, code: "REFUND_NOT_ELIGIBLE" });
    }
    let approvedAmount = pre.amount;
    let partial = false;
    if (req.body?.amount !== undefined && (typeof req.body.amount !== "string" || req.body.amount.trim() !== "")) {
      // Strict parse (finance.parseRupeeAmount): booleans would otherwise
      // coerce via Number(true) === 1 into a silent ₹1 refund, and decimals
      // would round to an amount the admin never typed. Rejected loudly.
      const parsed = parseRupeeAmount(req.body.amount, { label: "Approved amount" });
      if (!parsed.ok) {
        return res.status(400).json({ message: parsed.error, code: "REFUND_AMOUNT_INVALID" });
      }
      const cap = maxRefundable(booking);
      if (parsed.value > cap) {
        return res.status(400).json({ message: `Refund of ₹${parsed.value} exceeds the refundable ₹${cap}`, code: "REFUND_AMOUNT_INVALID" });
      }
      approvedAmount = parsed.value;
      partial = parsed.value < pre.amount;
    }
    // Exactly one approver survives: concurrent approves lose here with a
    // safe 400 instead of double-charging the gateway. When no clawback was
    // declared, the claim additionally pins payout-not-settled: a cook
    // settlement committing between the pre-check and this write must fail
    // the claim instead of creating a refund+payout contradiction without a
    // recorded clawback decision. (With clawback:true the payout was already
    // settled at pre-check time, and settled is terminal, so no pin needed.)
    const claimFilter = { _id: booking._id, "payment.refundStatus": "pending" };
    if (!clawback) claimFilter["payout.status"] = { $ne: "settled" };
    const claimed = await Booking.findOneAndUpdate(
      claimFilter,
      { $set: { "payment.refundStatus": "processing" } },
      { new: true }
    );
    if (!claimed) {
      return res.status(400).json({ message: "This refund is already being processed — please refresh.", code: "REFUND_ALREADY_PROCESSED" });
    }
    // Whether a settled payout actually backs the clawback flag: a flag set
    // on an UNsettled payout must not fabricate a "was already settled"
    // audit trail below.
    const hadSettledPayout = booking.payout?.status === "settled";
    // Final state commit, atomically: the gateway call above (or a parallel
    // admin action such as manual settlement) must not be clobbered by a
    // stale full-document save. Loser re-reads for an accurate answer.
    const commitRefundState = async (set) => {
      const { _note, ...fields } = set;
      const done = await Booking.findOneAndUpdate(
        { _id: claimed._id, "payment.refundStatus": "processing" },
        {
          $set: fields,
          $push: {
            statusHistory: {
              status: claimed.status,
              note: _note,
            },
          },
        },
        { new: true }
      );
      if (!done) {
        const fresh = await Booking.findById(claimed._id);
        return { conflict: true, fresh };
      }
      return { conflict: false, fresh: done };
    };
    if (claimed.payment?.testMode) {
      const { conflict, fresh } = await commitRefundState({
        "payment.refundStatus": "processed",
        "payment.refundedAt": claimed.payment.refundedAt || new Date(),
        _note: "Test-payment refund approved (no real money moved)",
      });
      if (conflict) {
        return res.status(409).json({ message: "This refund was just updated — please refresh to see its current state." });
      }
      await recordLedger({
        idempotencyKey: `refund-approve:${fresh._id}`,
        booking: fresh._id,
        type: "refund.approved",
        amount: 0,
        prevState: "refund:pending",
        newState: "refund:processed",
        actor: `admin:${req.user.id}`,
        source: "admin",
        reason: "Test payment — no money moved",
      });
      return res.json(fresh);
    }
    const refundAmount = approvedAmount;
    const requestedAmount = Math.round(Number(claimed.payment?.refundAmount || refundAmount));
    let endStatus;
    let refundId = "";
    // Idempotency before money: ask the gateway what already exists for this
    // payment. A previous approval may have created a refund and then crashed
    // before the database learned about it (the row was later reconciled back
    // to pending). Adopt the matching refund instead of creating a second one
    // — the customer must never be paid twice.
    let adoptedNote = "";
    if (claimed.payment?.razorpayPaymentId && razorpayConfigured && razorpayClient) {
      const existing = await lookupGatewayRefunds(claimed.payment.razorpayPaymentId);
      const adopted = existing.ok ? matchingGatewayRefund(existing.items, refundAmount * 100) : null;
      if (adopted) {
        refundId = adopted.id;
        endStatus = "processed";
        adoptedNote = ` — existing gateway refund ${adopted.id} adopted (no second refund created)`;
      } else {
        try {
          const refund = await razorpayClient.payments.refund(claimed.payment.razorpayPaymentId, {
            amount: refundAmount * 100,
            speed: "normal",
            notes: { booking: String(claimed._id), reason: "admin_approved" },
          });
          // Gateway response integrity: an ambiguous body (missing id, wrong
          // amount, unacceptable status) must NOT be recorded as a completed
          // refund — it stays "failed" so the reconciliation path can adopt
          // the real refund (if any) later instead of guessing.
          const gatewayId = String(refund?.id || "");
          const gatewayPaise = Math.round(Number(refund?.amount ?? refundAmount * 100));
          const gatewayStatus = String(refund?.status || "").toLowerCase();
          const statusOk = !gatewayStatus || ["created", "pending", "processed"].includes(gatewayStatus);
          if (gatewayId && gatewayPaise === refundAmount * 100 && statusOk) {
            refundId = gatewayId;
            endStatus = "processed";
          } else {
            endStatus = "failed";
          }
        } catch {
          endStatus = "failed";
        }
      }
    } else {
      endStatus = "manual";
    }
    const adminNote = partial
      ? `Partially approved: ₹${refundAmount}`
      : `Approved in full: ₹${refundAmount}`;
    const historyNote =
      (partial
        ? `Partial refund of ₹${refundAmount} approved by admin (requested ₹${requestedAmount}, ${endStatus})`
        : `Refund of ₹${refundAmount} approved by admin (${endStatus})`) +
      (clawback && hadSettledPayout ? " — clawback required: cook payout was already settled, recover from the cook" : "") +
      adoptedNote;
    const { conflict, fresh } = await commitRefundState({
      "payment.refundId": refundId,
      "payment.refundStatus": endStatus,
      "payment.refundAmount": refundAmount,
      "payment.refundedAt": new Date(),
      "payment.refundAdminNote": adminNote,
      _note: historyNote,
    });
    if (conflict) {
      return res.status(409).json({ message: "This refund was just updated — please refresh to see its current state." });
    }
    const settled = fresh;

    await recordLedger({
      idempotencyKey: `refund-approve:${settled._id}`,
      booking: settled._id,
      type: "refund.approved",
      amount: refundAmount,
      prevState: "refund:pending",
      newState: `refund:${settled.payment.refundStatus}`,
      actor: `admin:${req.user.id}`,
      source: "admin",
      razorpayOrderId: settled.payment?.razorpayOrderId || "",
      razorpayPaymentId: settled.payment?.razorpayPaymentId || "",
      razorpayRefundId: settled.payment?.refundId || "",
      reason: adoptedNote
        ? "Existing gateway refund adopted — no second refund created"
        : clawback && hadSettledPayout
          ? "Approved with clawback (payout already settled)"
          : "Admin-approved refund",
    });

    try {
      const Notification = require("../models/Notification");
      const approved =
        settled.payment.refundStatus === "processed" || settled.payment.refundStatus === "manual";
      await Notification.create({
        user: settled.customer,
        type: "refund_processed",
        booking: settled._id,
        message: approved
          ? partial
            ? `Your refund request was partially approved — ₹${refundAmount} of ₹${settled.payment.paidAmount}. Refund processing has started.`
            : `Your refund of ₹${refundAmount} has been approved — it reaches your account in 5–7 business days.`
          : "Your approved refund hit a gateway error — our team is following up and will notify you.",
      });
    } catch {
      // non-fatal
    }
    // The assigned cook's payout is decided by this refund (blocked while the
    // refund is live; clawback when already settled) — they hear the outcome
    // too, in their own words.
    try {
      const Notification = require("../models/Notification");
      const ref = String(settled._id).slice(-6).toUpperCase();
      await Notification.create({
        user: settled.cook,
        type: "refund_processed",
        booking: settled._id,
        message:
          `A refund of ₹${refundAmount} was approved for booking #${ref} — the cook payout for this booking will not proceed` +
          (clawback && hadSettledPayout ? " (it was already settled — our team will contact you about recovery)." : "."),
      });
    } catch {
      // non-fatal
    }

    res.json(settled);
  } catch (error) {
    next(error);
  }
};

// Admin: reject a queued refund — the customer keeps no refund for this
// booking. An optional reason is stored in history and shared with the
// customer.
exports.rejectRefund = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (booking.payment?.refundStatus !== "pending") {
      return res.status(400).json({ message: "Only refunds awaiting approval can be rejected" });
    }
    const reason = String(req.body?.reason || "").trim().slice(0, 200);
    // Atomic claim (not read-modify-save): a concurrent approval settling or
    // processing this refund must win outright instead of being clobbered by
    // a stale save. Loser re-reads below for an accurate message.
    const rejected = await Booking.findOneAndUpdate(
      { _id: booking._id, "payment.refundStatus": "pending" },
      {
        $set: {
          "payment.refundStatus": "rejected",
          "payment.refundAdminNote": reason,
        },
        $push: {
          statusHistory: {
            status: booking.status,
            note: `Refund request declined by admin${reason ? `: ${reason}` : ""}`,
          },
        },
      },
      { new: true }
    );
    if (!rejected) {
      const fresh = await Booking.findById(req.params.id);
      if (fresh && fresh.payment?.refundStatus !== "pending") {
        return res.status(409).json({ message: "This refund was just decided — please refresh to see its current state." });
      }
      return res.status(409).json({ message: "This refund is already being processed — please refresh." });
    }
    await recordLedger({
      idempotencyKey: `refund-reject:${rejected._id}`,
      booking: rejected._id,
      type: "refund.rejected",
      amount: Math.round(Number(rejected.payment?.refundAmount || 0)),
      prevState: "refund:pending",
      newState: "refund:rejected",
      actor: `admin:${req.user.id}`,
      source: "admin",
      reason: reason || "Declined by admin",
    });

    try {
      const Notification = require("../models/Notification");
      await Notification.create({
        user: rejected.customer,
        type: "refund_processed",
        booking: rejected._id,
        message: `Your refund request for ₹${rejected.payment?.refundAmount || rejected.amount} was declined by our team${reason ? `: ${reason}` : ""}. Please contact support if you need help.`,
      });
    } catch {
      // non-fatal
    }
    // Declining unblocks the cook leg (a rejected refund never gates payout)
    // — the cook hears the request is closed.
    try {
      const Notification = require("../models/Notification");
      const ref = String(rejected._id).slice(-6).toUpperCase();
      await Notification.create({
        user: rejected.cook,
        type: "refund_processed",
        booking: rejected._id,
        message: `The refund request for booking #${ref} was declined — the cook payout for this booking is no longer blocked.`,
      });
    } catch {
      // non-fatal
    }

    res.json(rejected);
  } catch (error) {
    next(error);
  }
};

// Admin: reject a pending cook payout — the cook is not paid for this
// booking (e.g. service not rendered to satisfaction). Recorded as
// "not_applicable" so it leaves the queue without looking payable.
exports.rejectPayout = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (booking.payout?.status === "settled") {
      return res.json(booking); // already settled — idempotent success
    }
    if (booking.payout?.status === "not_applicable") {
      return res.json(booking); // already rejected — idempotent success
    }
    // Rows predating the payout subdoc behave as pending (same rule as the
    // queue and settlement), so legacy money can be decided, not stuck.
    if ((booking.payout?.status || "pending") !== "pending") {
      return res.status(400).json({ message: "Only pending payouts can be rejected" });
    }
    const reason = String(req.body?.reason || "").trim().slice(0, 200);
    // Atomic claim (not read-modify-save): a concurrent settlement committing
    // between the read above and this write must win outright instead of
    // being clobbered by a stale save (money moved, state says declined).
    // Rows predating the payout subdoc claim as pending. Loser re-reads for
    // an accurate idempotent/409 answer.
    const declined = await Booking.findOneAndUpdate(
      { _id: booking._id, ...PAYOUT_PENDING_OR_MISSING },
      {
        $set: { "payout.status": "not_applicable" },
        $push: {
          statusHistory: {
            status: booking.status,
            note: `Cook payout ₹${booking.cookPayout} declined by admin${reason ? `: ${reason}` : ""}`,
          },
        },
      },
      { new: true }
    );
    if (!declined) {
      const fresh = await Booking.findById(req.params.id);
      if (fresh?.payout?.status === "settled" || fresh?.payout?.status === "not_applicable") return res.json(fresh);
      return res.status(409).json({ message: "Payout is already being processed — please refresh." });
    }
    await recordLedger({
      idempotencyKey: `payout-reject:${declined._id}`,
      booking: declined._id,
      type: "payout.rejected",
      amount: Math.round(Number(declined.cookPayout || 0)),
      prevState: "payout:pending",
      newState: "payout:not_applicable",
      actor: `admin:${req.user.id}`,
      source: "admin",
      reason: reason || "Declined by admin",
    });

    try {
      const Notification = require("../models/Notification");
      await Notification.create({
        user: declined.cook,
        type: "payout_failed",
        booking: declined._id,
        message: `Your payout for the ${
          declined.date
            ? new Date(declined.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
            : ""
        } session was declined by our team${reason ? `: ${reason}` : ""}. Please contact support if you need help.`,
      });
    } catch {
      // non-fatal
    }

    res.json(declined);
  } catch (error) {
    next(error);
  }
};

// Admin: mark a failed gateway refund as manually settled (the money left
// via bank/UPI outside Razorpay). Also the recovery path for a "processing"
// row stuck by a crashed approval: the admin verifies the gateway dashboard
// by hand, then closes it here. An optional amount must exactly match the
// approved figure — manual settlement can never exceed it.
// Shared: close a non-terminal refund row as "processed" because the refund
// already exists at the gateway (found by a pre-create lookup, a manual-
// settlement verification or the reconciliation endpoint). The atomic filter
// is the one every closer uses, so exactly one caller can win. Returns the
// updated booking, or null when another writer got there first.
const adoptGatewayRefund = async (booking, match, { historyNote, adminNote }) =>
  Booking.findOneAndUpdate(
    { _id: booking._id, "payment.refundStatus": { $in: ["processing", "failed", "manual"] } },
    {
      $set: {
        "payment.refundStatus": "processed",
        "payment.refundId": match.id,
        "payment.refundedAt": booking.payment?.refundedAt || new Date(),
        "payment.refundAdminNote": adminNote,
      },
      $push: {
        statusHistory: { status: booking.status, note: historyNote },
      },
    },
    { new: true }
  );

exports.markRefundSettled = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (!["processing", "failed", "manual"].includes(booking.payment?.refundStatus)) {
      return res.status(400).json({ message: "Only processing, failed or manual refunds can be marked settled" });
    }
    const reference = String(req.body?.reference || "").trim();
    if (!isValidPayoutReference(reference)) {
      return res.status(400).json({ message: "Enter a valid transfer reference (4–120 characters: letters, digits, spaces and . - _ /)" });
    }
    const key = normalizePayoutReference(reference);
    if (!key) {
      return res.status(400).json({ message: "Enter a valid transfer reference (4–120 characters: letters, digits, spaces and . - _ /)" });
    }
    const approved = Math.round(Number(booking.payment.refundAmount || booking.amount || 0));
    if (!(approved > 0)) {
      return res.status(400).json({ message: "This booking has no approved refund amount to settle." });
    }
    if (req.body?.amount !== undefined && req.body?.amount !== "") {
      const parsed = parseRupeeAmount(req.body.amount, { label: "Settled amount" });
      if (!parsed.ok || parsed.value !== approved) {
        return res.status(400).json({ message: `Settled amount must equal the approved ₹${approved}` });
      }
    }
    // Gateway verification BEFORE recording a manual settlement: the refund
    // may already exist at Razorpay (a crash/timeout left the row in
    // processing/failed while the money actually left). Adopt it instead of
    // paying the customer twice; when the gateway cannot be reached, refuse
    // to guess — the admin verifies in the dashboard and retries.
    if (booking.payment?.razorpayPaymentId && razorpayConfigured && razorpayClient) {
      const gw = await lookupGatewayRefunds(booking.payment.razorpayPaymentId);
      if (!gw.ok) {
        return res.status(503).json({
          message: "Razorpay could not be reached — verify this refund in the gateway dashboard before recording a manual settlement.",
        });
      }
      const match = matchingGatewayRefund(gw.items, approved * 100);
      if (match) {
        const adopted = await adoptGatewayRefund(booking, match, {
          historyNote: `Gateway refund ${match.id} already exists for ₹${approved} — adopted (no manual transfer recorded)`,
          adminNote: `Gateway refund ${match.id} adopted — settled at the gateway, not by transfer`,
        });
        if (!adopted) {
          const fresh = await Booking.findById(req.params.id);
          if (fresh?.payment?.refundStatus === "processed") return res.json(fresh);
          return res.status(409).json({ message: "This refund was just updated — please refresh to see its current state." });
        }
        await recordLedger({
          idempotencyKey: `refund-settled:${adopted._id}`,
          booking: adopted._id,
          type: "refund.settled",
          amount: approved,
          prevState: `refund:${booking.payment.refundStatus}`,
          newState: "refund:processed",
          actor: `admin:${req.user.id}`,
          source: "admin",
          razorpayPaymentId: adopted.payment?.razorpayPaymentId || "",
          razorpayRefundId: match.id,
          reason: "Existing gateway refund adopted — no manual transfer recorded",
        });
        try {
          const Notification = require("../models/Notification");
          await Notification.create({
            user: adopted.customer,
            type: "refund_processed",
            booking: adopted._id,
            message: `Your refund of ₹${adopted.payment.refundAmount || adopted.amount} has been processed.`,
          });
        } catch {
          // non-fatal
        }
        return res.json({ ...(adopted.toObject ? adopted.toObject() : adopted), adopted: true, refundId: match.id });
      }
    }
    // One transfer, one refund: a reference already recorded against another
    // payout or refund is a double-entry until proven otherwise. Runs only on
    // a live connection (unit tests run disconnected; there the unique index
    // `uniq_refund_reference_key` is still the final, atomic guard).
    let dup = null;
    if (mongoose.connection?.readyState === 1) {
      dup = await Booking.findOne({
        _id: { $ne: booking._id },
        $or: [{ "payment.refundReferenceKey": key }, { "payout.referenceKey": key }],
      })
        .select("_id")
        .lean();
    }
    if (dup) {
      return res.status(409).json({ message: "This reference already settled another payout or refund — use the unique UPI/bank transaction id", code: "DUPLICATE_PAYOUT_REFERENCE" });
    }
    const prevStatus = booking.payment.refundStatus;
    // Atomic close (not read-modify-save): a concurrent approval/retry
    // committing first must win instead of being clobbered. Loser re-reads.
    let closed;
    try {
      closed = await Booking.findOneAndUpdate(
        { _id: booking._id, "payment.refundStatus": { $in: ["processing", "failed", "manual"] } },
        {
          $set: {
            "payment.refundStatus": "processed",
            "payment.refundedAt": booking.payment.refundedAt || new Date(),
            "payment.refundReference": reference.slice(0, 120),
            "payment.refundReferenceKey": key,
          },
          $push: {
            statusHistory: {
              status: booking.status,
              note: `Refund of ₹${approved} settled manually (ref: ${reference.slice(0, 120)})`,
            },
          },
        },
        { new: true }
      );
    } catch (e) {
      // Unique-index collision on the reference key: another refund (or a
      // concurrent double-click) recorded the same transfer first.
      if (e?.code === 11000) {
        return res.status(409).json({ message: "This reference already settled another payout or refund — use the unique UPI/bank transaction id", code: "DUPLICATE_PAYOUT_REFERENCE" });
      }
      throw e;
    }
    if (!closed) {
      const fresh = await Booking.findById(req.params.id);
      if (fresh?.payment?.refundStatus === "processed") return res.json(fresh);
      return res.status(409).json({ message: "This refund was just updated — please refresh to see its current state.", code: "REFUND_ALREADY_PROCESSED" });
    }
    await recordLedger({
      idempotencyKey: `refund-settled:${closed._id}`,
      booking: closed._id,
      type: "refund.settled",
      amount: approved,
      prevState: `refund:${prevStatus}`,
      newState: "refund:processed",
      actor: `admin:${req.user.id}`,
      source: "admin",
      payoutReference: reference.slice(0, 120),
      relatedKey: key,
      reason: "Manual settlement recorded",
    });

    try {
      const Notification = require("../models/Notification");
      await Notification.create({
        user: closed.customer,
        type: "refund_processed",
        booking: closed._id,
        message: `Your refund of ₹${closed.payment.refundAmount || closed.amount} has been processed.`,
      });
    } catch {
      // non-fatal
    }

    res.json(closed);
  } catch (error) {
    next(error);
  }
};

// Admin: reconcile a refund stuck mid-approval ("processing") or left
// "failed" by an ambiguous gateway error. Razorpay is asked what actually
// exists for this payment, and then:
//   - a matching refund exists → the row is closed as processed with the
//     gateway id recorded; the ledger row is written under the SAME key the
//     original approval would have used, so reconciliation can never
//     double-record one economic event;
//   - no refund exists → the row returns to "pending" so an admin can decide
//     again, now with certainty that nothing was refunded;
//   - the gateway is unreachable → 503 and nothing changes. Never guess with
//     money: a lost gateway response must not become a second refund.
exports.reconcileRefund = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    const status = booking.payment?.refundStatus;
    if (!["processing", "failed"].includes(status)) {
      return res.status(400).json({ message: "Only processing or failed refunds need gateway reconciliation" });
    }
    if (booking.payment?.testMode) {
      return res.status(400).json({ message: "Test payments carry no gateway refund to reconcile." });
    }
    const paymentId = booking.payment?.razorpayPaymentId || "";
    if (!paymentId || !razorpayConfigured || !razorpayClient) {
      return res.status(400).json({ message: "This booking has no gateway payment — verify the transfer yourself and record it with Mark settled." });
    }
    const approved = Math.round(Number(booking.payment.refundAmount || booking.amount || 0));
    if (!(approved > 0)) {
      return res.status(400).json({ message: "This booking has no approved refund amount." });
    }
    const gw = await lookupGatewayRefunds(paymentId);
    if (!gw.ok) {
      return res.status(503).json({ message: "Razorpay could not be reached — nothing was changed; try again shortly." });
    }
    const match = matchingGatewayRefund(gw.items, approved * 100);
    if (match) {
      const closed = await adoptGatewayRefund(booking, match, {
        historyNote: `Gateway reconciliation: refund ${match.id} (₹${approved}) confirmed — marked processed, no manual transfer needed`,
        adminNote: `Gateway refund ${match.id} confirmed by reconciliation`,
      });
      if (!closed) {
        return res.status(409).json({ message: "This refund was just updated — please refresh to see its current state." });
      }
      await recordLedger({
        idempotencyKey: `refund-approve:${closed._id}`,
        booking: closed._id,
        type: "refund.approved",
        amount: approved,
        prevState: "refund:pending",
        newState: "refund:processed",
        actor: `admin:${req.user.id}`,
        source: "admin",
        razorpayPaymentId: paymentId,
        razorpayRefundId: match.id,
        reason: "Gateway reconciliation confirmed an existing refund",
      });
      try {
        const Notification = require("../models/Notification");
        await Notification.create({
          user: closed.customer,
          type: "refund_processed",
          booking: closed._id,
          message: `Your refund of ₹${approved} has been processed — it reaches your account in 5–7 business days.`,
        });
      } catch {
        // non-fatal
      }
      return res.json({ adopted: true, refundId: match.id, booking: closed });
    }
    // Gateway answered and holds no refund for this payment: the approval
    // never moved money, so the request goes back to the decision queue.
    const reset = await Booking.findOneAndUpdate(
      { _id: booking._id, "payment.refundStatus": { $in: ["processing", "failed"] } },
      {
        $set: {
          "payment.refundStatus": "pending",
          "payment.refundAdminNote": "Reconciled: no gateway refund exists — awaiting a new decision",
        },
        $push: {
          statusHistory: {
            status: booking.status,
            note: "Gateway reconciliation: no refund found for this payment — request returned to the decision queue",
          },
        },
      },
      { new: true }
    );
    if (!reset) {
      return res.status(409).json({ message: "This refund was just updated — please refresh to see its current state." });
    }
    return res.json({ adopted: false, refundStatus: reset.payment.refundStatus, booking: reset });
  } catch (error) {
    next(error);
  }
};

// Admin reconciliation: booking-aggregate money truth (source of record)
// cross-checked against ledger entry counts. Any mismatch surfaces here for
// manual review — the console never silently drifts from the books.
exports.getLedgerSummary = async (req, res, next) => {
  try {
    const REAL_MONEY = { $ne: ["$payment.testMode", true] };
    const [money] = await Booking.aggregate([
      {
        $group: {
          _id: null,
          captured: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$payment.status", "paid"] },
                    REAL_MONEY,
                  ],
                },
                { $ifNull: ["$payment.paidAmount", 0] },
                0,
              ],
            },
          },
          refunded: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $in: ["$payment.refundStatus", ["processed", "manual"]] },
                    REAL_MONEY,
                  ],
                },
                { $ifNull: ["$payment.refundAmount", 0] },
                0,
              ],
            },
          },
          settledPayouts: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$payout.status", "settled"] },
                    REAL_MONEY,
                  ],
                },
                { $ifNull: ["$payout.amount", 0] },
                0,
              ],
            },
          },
          settledCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$payout.status", "settled"] },
                    REAL_MONEY,
                  ],
                },
                1,
                0,
              ],
            },
          },
          commissionOnSettled: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$payout.status", "settled"] },
                    REAL_MONEY,
                  ],
                },
                { $ifNull: ["$commission", 0] },
                0,
              ],
            },
          },
        },
      },
    ]);
    const LedgerEntry = require("../models/LedgerEntry");
    const ledgerCounts = await LedgerEntry.aggregate([
      { $group: { _id: "$type", n: { $sum: 1 }, total: { $sum: "$amount" } } },
    ]);
    // Settled bookings with no payout.settled ledger row need a look
    // (e.g. settled before the ledger existed, or a failed ledger write).
    const settledIds = await Booking.find({ "payout.status": "settled" }).select("_id").lean();
    const logged = await LedgerEntry.find({
      type: "payout.settled",
      booking: { $in: settledIds.map((b) => b._id) },
    })
      .select("booking")
      .lean();
    const loggedSet = new Set(logged.map((l) => String(l.booking)));
    const missingPayoutLedger = settledIds
      .map((b) => String(b._id))
      .filter((id) => !loggedSet.has(id))
      .slice(0, 50);
    // Blocked payable-looking money: completed + paid real + unsettled share
    // but missing service evidence (never OTP-started / arrival unrecorded /
    // hours incomplete) or a live refund. Never auto-paid, never auto-denied
    // — surfaced here so it cannot silently disappear from accounting.
    const blockedRows = await Booking.find({
      status: "completed",
      "payment.status": "paid",
      "payment.testMode": { $ne: true },
      cookPayout: { $gt: 0 },
      ...PAYOUT_PENDING_OR_MISSING,
      "payment.refundStatus": { $in: ["none", "rejected"] },
      $or: [
        { serviceStartedAt: { $exists: false } },
        { cookArrived: { $ne: true } },
        { hoursCompleted: { $ne: true } },
      ],
    })
      .select("cook amount cookPayout date payment.refundStatus serviceStartedAt cookArrived hoursCompleted")
      .limit(50)
      .lean();
    const blockedCount = await Booking.countDocuments({
      status: "completed",
      "payment.status": "paid",
      "payment.testMode": { $ne: true },
      cookPayout: { $gt: 0 },
      ...PAYOUT_PENDING_OR_MISSING,
      "payment.refundStatus": { $in: ["none", "rejected"] },
      $or: [
        { serviceStartedAt: { $exists: false } },
        { cookArrived: { $ne: true } },
        { hoursCompleted: { $ne: true } },
      ],
    });
    const blockedPayouts = {
      count: blockedCount,
      amount: blockedRows.reduce((a, b) => a + Math.round(Number(b.cookPayout || 0)), 0),
      sample: blockedRows.map((b) => ({
        _id: b._id,
        cook: b.cook,
        amount: b.cookPayout,
        date: b.date,
        missingEvidence: [
          !b.serviceStartedAt ? "service never OTP-started" : null,
          b.cookArrived !== true ? "cook arrival unrecorded" : null,
          b.hoursCompleted !== true ? "hours incomplete" : null,
        ].filter(Boolean),
      })),
    };
    // Same settled reference on two bookings = one transfer recorded twice.
    // The unique indexes should make this impossible; non-empty means look.
    const duplicateReferences = await Booking.aggregate([
      {
        $match: {
          "payout.status": "settled",
          "payout.reference": { $exists: true, $ne: "" },
        },
      },
      { $group: { _id: "$payout.reference", bookings: { $push: "$_id" }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 10 },
      { $project: { _id: 0, reference: "$_id", count: "$n", bookings: 1 } },
    ]);
    // Processed refunds with no refund.approved or refund.settled ledger row
    const processedRefundsForSummary = await Booking.find({
      "payment.refundStatus": "processed",
      "payment.testMode": { $ne: true },
    })
      .select("_id")
      .lean();
    const refundKeys = processedRefundsForSummary
      .map((b) => `refund-approve:${b._id}`)
      .concat(processedRefundsForSummary.map((b) => `refund-settled:${b._id}`));
    const loggedRefunds = await LedgerEntry.find({
      idempotencyKey: { $in: refundKeys },
    })
      .select("booking")
      .lean();
    const loggedRefundSet = new Set(loggedRefunds.map((l) => String(l.booking)));
    const missingRefundLedger = processedRefundsForSummary
      .map((b) => String(b._id))
      .filter((id) => !loggedRefundSet.has(id))
      .slice(0, 50);

    res.json({
      bookings: {
        captured: Math.round(money?.captured || 0),
        refunded: Math.round(money?.refunded || 0),
        settledPayouts: Math.round(money?.settledPayouts || 0),
        settledCount: money?.settledCount || 0,
        commissionOnSettled: Math.round(money?.commissionOnSettled || 0),
      },
      ledger: ledgerCounts,
      missingPayoutLedger,
      missingRefundLedger,
      blockedPayouts,
      duplicateReferences,
    });
  } catch (error) {
    next(error);
  }
};

// Admin: backfill missing payout.settled / refund.approved ledger rows
// (pre-ledger history or a failed ledger write — see the summaries above).
// Reconstructs each row from booking truth (amount/reference/settler/ids)
// under the SAME idempotencyKey the original operation used, so reruns are
// safe: existing keys collide and are skipped, never duplicated. Bounded
// (100/call per family); repeat until the reconciled lists are empty.
exports.reconcileMissingPayoutLedger = async (req, res, next) => {
  try {
    const LedgerEntry = require("../models/LedgerEntry");
    const settled = await Booking.find({ "payout.status": "settled" })
      .select("_id payout payment")
      .limit(100)
      .lean();
    const out = { checked: settled.length, reconciled: [], alreadyLogged: [], failed: [] };
    for (const b of settled) {
      const key = `payout:${b._id}`;
      const has = await LedgerEntry.findOne({ idempotencyKey: key }).select("_id").lean();
      if (has) {
        out.alreadyLogged.push(String(b._id));
        continue;
      }
      const r = await recordLedger({
        idempotencyKey: key,
        booking: b._id,
        type: "payout.settled",
        amount: Math.round(Number(b.payout?.amount || 0)),
        prevState: "payout:pending",
        newState: "payout:settled",
        actor: b.payout?.settledBy ? `admin:${b.payout.settledBy}` : "system",
        source: "admin",
        payoutReference: String(b.payout?.reference || ""),
        reason: "Backfilled by ledger reconciliation (original write missing)",
      });
      if (r?.recorded || r?.duplicate) out.reconciled.push(String(b._id));
      else out.failed.push(String(b._id));
    }
    // Refunds get the same backfill: a processed refund whose refund.approved
    // ledger row never landed (crash between the state commit and the ledger
    // write, or pre-ledger history). Reconstructed from booking truth under
    // the same `refund-approve:<id>` key, so reruns collide instead of
    // duplicating the economic event.
    const processedRefunds = await Booking.find({
      "payment.refundStatus": "processed",
      "payment.testMode": { $ne: true },
    })
      .select("_id payment")
      .limit(100)
      .lean();
    out.checkedRefunds = processedRefunds.length;
    out.reconciledRefunds = [];
    out.alreadyLoggedRefunds = [];
    out.failedRefunds = [];
    for (const b of processedRefunds) {
      const keyApprove = `refund-approve:${b._id}`;
      const keySettled = `refund-settled:${b._id}`;
      let hasRef = await LedgerEntry.findOne({ idempotencyKey: keyApprove }).select("_id").lean();
      if (!hasRef) {
        hasRef = await LedgerEntry.findOne({ idempotencyKey: keySettled }).select("_id").lean();
      }
      if (hasRef) {
        out.alreadyLoggedRefunds.push(String(b._id));
        continue;
      }
      const isManual = Boolean(b.payment?.refundReferenceKey || b.payment?.refundReference);
      const refKey = isManual ? keySettled : keyApprove;
      const rr = await recordLedger({
        idempotencyKey: refKey,
        booking: b._id,
        type: isManual ? "refund.settled" : "refund.approved",
        amount: Math.round(Number(b.payment?.refundAmount || 0)),
        prevState: isManual ? "refund:manual" : "refund:pending",
        newState: "refund:processed",
        actor: "system",
        source: "system",
        payoutReference: isManual ? String(b.payment?.refundReference || "") : "",
        razorpayPaymentId: b.payment?.razorpayPaymentId || "",
        razorpayRefundId: b.payment?.refundId || "",
        reason: "Backfilled by ledger reconciliation (original write missing)",
      });
      if (rr?.recorded || rr?.duplicate) out.reconciledRefunds.push(String(b._id));
      else out.failedRefunds.push(String(b._id));
    }
    res.json(out);
  } catch (error) {
    next(error);
  }
};

