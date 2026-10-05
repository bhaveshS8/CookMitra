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
const { logCancellationAudit, syncCancellationRefundStatus } = require("../utils/cancellationAudit");

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
    const cookIds = [...new Set((bookings || []).map((b) => String(b.cook?._id || b.cook)))];
    const profiles = await CookProfile.find({ user: { $in: cookIds } })
      .select("user payoutDetails")
      .lean();
    const byUser = new Map(profiles.map((p) => [String(p.user), p.payoutDetails || null]));
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
    }

    res.json(booking);
  } catch (error) {
    next(error);
  }
};

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

const matchingGatewayRefund = (items, refundAmountPaise) =>
  (items || []).find((r) => r.amountPaise === refundAmountPaise && !["failed", "cancelled"].includes(r.status)) || null;

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

exports.approveRefund = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }
    if (booking.payment?.refundStatus !== "pending") {
      return res.status(400).json({ message: "Only refunds awaiting approval can be approved", code: "REFUND_NOT_ELIGIBLE" });
    }
    const clawback = req.body?.clawback === true;
    const pre = refundApprovalCheck(booking, { clawback });
    if (!pre.ok) {
      return res.status(400).json({ message: pre.reasons[0], reasons: pre.reasons, code: "REFUND_NOT_ELIGIBLE" });
    }
    let approvedAmount = pre.amount;
    let partial = false;
    if (req.body?.amount !== undefined && (typeof req.body.amount !== "string" || req.body.amount.trim() !== "")) {
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
    const hadSettledPayout = booking.payout?.status === "settled";
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
      await syncCancellationRefundStatus(claimed._id, { refundStatus: "PROCESSED", processedAt: new Date() });
      await logCancellationAudit({
        actor: req.user.id, actorRole: "ADMIN", bookingId: claimed._id,
        event: "REFUND_PROCESSED", previousStatus: "PENDING", newStatus: "PROCESSED",
        amount: 0, reason: "Test payment — no money moved",
      });
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

    try {
      const workflow =
        settled.payment.refundStatus === "processed"
          ? "PROCESSED"
          : settled.payment.refundStatus === "failed"
            ? "FAILED"
            : "APPROVED";
      await syncCancellationRefundStatus(settled._id, {
        refundStatus: workflow,
        ...(settled.payment.refundStatus === "processed" ? { processedAt: new Date() } : {}),
      });
      await logCancellationAudit({
        actor: req.user.id, actorRole: "ADMIN", bookingId: settled._id,
        event: "REFUND_APPROVED", previousStatus: "PENDING", newStatus: workflow,
        amount: refundAmount, reason: adoptedNote || (clawback && hadSettledPayout ? "Approved with clawback" : "Admin-approved refund"),
      });
      if (settled.payment.refundStatus === "processed") {
        await logCancellationAudit({
          actor: req.user.id, actorRole: "ADMIN", bookingId: settled._id,
          event: "REFUND_PROCESSED", previousStatus: workflow, newStatus: "PROCESSED",
          amount: refundAmount, reason: settled.payment?.refundId ? `Gateway refund ${settled.payment.refundId}` : "Refund processed",
        });
      }
      if (settled.payment.refundStatus === "failed") {
        await logCancellationAudit({
          actor: req.user.id, actorRole: "ADMIN", bookingId: settled._id,
          event: "REFUND_FAILED", previousStatus: "APPROVED", newStatus: "FAILED",
          amount: refundAmount, reason: "Gateway error — queued for follow-up",
        });
      }
    } catch {
    }

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
    }
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
    }

    res.json(settled);
  } catch (error) {
    next(error);
  }
};

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
    await syncCancellationRefundStatus(rejected._id, { refundStatus: "REJECTED", adminNote: reason || "Declined by admin" });
    await logCancellationAudit({
      actor: req.user.id, actorRole: "ADMIN", bookingId: rejected._id,
      event: "REFUND_REJECTED", previousStatus: "PENDING", newStatus: "REJECTED",
      amount: Math.round(Number(rejected.payment?.refundAmount || 0)), reason: reason || "Declined by admin",
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
    }
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
    }

    res.json(rejected);
  } catch (error) {
    next(error);
  }
};

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
    if ((booking.payout?.status || "pending") !== "pending") {
      return res.status(400).json({ message: "Only pending payouts can be rejected" });
    }
    const reason = String(req.body?.reason || "").trim().slice(0, 200);
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
    }

    res.json(declined);
  } catch (error) {
    next(error);
  }
};

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
        await syncCancellationRefundStatus(adopted._id, { refundStatus: "PROCESSED", processedAt: new Date() });
        await logCancellationAudit({
          actor: req.user.id, actorRole: "ADMIN", bookingId: adopted._id,
          event: "REFUND_PROCESSED", previousStatus: String(booking.payment.refundStatus || "").toUpperCase() || "PENDING",
          newStatus: "PROCESSED", amount: approved, reason: `Gateway refund ${match.id} adopted`,
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
        }
        return res.json({ ...(adopted.toObject ? adopted.toObject() : adopted), adopted: true, refundId: match.id });
      }
    }
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
    await syncCancellationRefundStatus(closed._id, { refundStatus: "PROCESSED", reference: reference.slice(0, 120), processedAt: new Date() });
    await logCancellationAudit({
      actor: req.user.id, actorRole: "ADMIN", bookingId: closed._id,
      event: "REFUND_PROCESSED", previousStatus: String(prevStatus || "").toUpperCase() || "PENDING",
      newStatus: "PROCESSED", amount: approved, reason: `Manual settlement (ref: ${reference.slice(0, 120)})`,
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
    }

    res.json(closed);
  } catch (error) {
    next(error);
  }
};

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
      await syncCancellationRefundStatus(closed._id, { refundStatus: "PROCESSED", processedAt: new Date() });
      await logCancellationAudit({
        actor: req.user.id, actorRole: "ADMIN", bookingId: closed._id,
        event: "REFUND_PROCESSED", previousStatus: "PENDING", newStatus: "PROCESSED",
        amount: approved, reason: `Reconciliation confirmed gateway refund ${match.id}`,
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
      }
      return res.json({ adopted: true, refundId: match.id, booking: closed });
    }
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

