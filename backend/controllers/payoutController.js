// Cook payout settlement + refund console — admin-only ledger operations.
//
// Every paid booking records the cook's 75% in Booking.payout (status
// "pending"). Nothing paid the cook until an admin makes an actual UPI/bank
// transfer outside the app and records the reference here. This module gives
// that flow one console: a pending queue with the cook's payout details,
// history, per-cook statements, and a failed-refund follow-up queue.
const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const { paginationParams, applyPagination, sendList } = require("../utils/pagination");
const { razorpay: razorpayClient, isConfigured: razorpayConfigured } = require("../config/razorpay");
const {
  payoutEligibility,
  refundApprovalCheck,
  maxRefundable,
  isValidPayoutReference,
  recordLedger,
} = require("../utils/finance");

// Test payments carry no real money — they must never enter the payout
// queue. Real gateway/webhook payments (paid + not testMode) do — but only
// once the service is actually rendered: booking `completed` AND cooking
// hours flagged complete. Upcoming (confirmed/in_progress) and cancelled
// bookings never enter the queue — settling those would release the cook's
// share for an unrendered session (a cancelled session is refunded to the
// customer instead). Zero-value rows carry no money and are excluded so a
// free booking can never look payable.
const pendingFilter = () => ({
  "payment.status": "paid",
  "payment.testMode": { $ne: true },
  status: "completed",
  hoursCompleted: true,
  cookPayout: { $gt: 0 },
  "payout.status": "pending",
});

// Cook payout queue: every completed paid booking whose 75% is not yet
// settled, oldest first (fairness — cooks see their oldest money first).
// Includes the cook's saved payout details so the admin can copy the UPI id
// / read the bank last-4 without opening another page.
exports.getPayoutQueue = async (req, res, next) => {
  try {
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      Booking.find(pendingFilter())
        .sort({ date: 1, createdAt: 1 })
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
      Booking.find(filter).sort({ "payout.settledAt": -1 }).populate("cook", "name phone"),
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
      return res.status(400).json({ message: reasons[0], reasons });
    }
    // One transfer, one record: a reference that already settled another
    // booking is a double-entry until proven otherwise.
    const dup = await Booking.findOne({ "payout.reference": reference, "payout.status": "settled" }).select("_id");
    if (dup && String(dup._id) !== String(existing._id)) {
      return res.status(409).json({ message: "This reference already settled another payout — use the unique UPI/bank transaction id" });
    }
    // Freeze who is being paid: the cook's CURRENT destination details.
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
        { _id: existing._id, "payout.status": "pending" },
        {
          $set: {
            "payout.status": "settled",
            "payout.settledAt": new Date(),
            "payout.reference": reference,
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
      // Lost the reference-uniqueness race between the check above and the
      // claim: another booking settled with this reference first.
      if (e?.code === 11000) {
        return res.status(409).json({ message: "This reference already settled another payout — use the unique UPI/bank transaction id" });
      }
      throw e;
    }
    if (!booking) {
      const fresh = await Booking.findById(req.params.id);
      if (fresh?.payout?.status === "settled") return res.json(fresh);
      return res.status(409).json({ message: "Payout is already being processed — please refresh." });
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
    const statement = rows.reduce(
      (acc, b) => {
        acc.bookings += 1;
        acc.gross += b.amount || 0;
        acc.commission += b.commission || 0;
        acc.earnings += b.cookPayout || 0;
        if (b.payout?.status === "settled") {
          acc.settled += b.payout.amount || b.cookPayout || 0;
        } else if (b.payout?.status === "pending") {
          // "Pending" means releasable money: only a completed service with
          // completed service hours can ever be settled, and never while a
          // customer refund for the same money is live. Upcoming or
          // cancelled rows stay in history but hold no payable amount.
          const liveRefund = b.payment?.refundStatus
            && !["none", "rejected"].includes(b.payment.refundStatus);
          if (b.status === "completed" && b.hoursCompleted === true && !liveRefund) {
            acc.pending += b.cookPayout || 0;
            acc.pendingCount += 1;
          }
        }
        return acc;
      },
      { bookings: 0, gross: 0, commission: 0, earnings: 0, settled: 0, pending: 0, pendingCount: 0 }
    );

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

// Admin refund queue: refund requests awaiting a decision ("pending"), rows
// mid-approval ("processing" — a crashed approve must stay visible, never
// vanish), plus bookings whose approved refund failed or needs a manual
// transfer, so support never has to query the DB by hand.
exports.getRefundQueue = async (req, res, next) => {
  try {
    const filter = {
      "payment.refundStatus": { $in: ["pending", "processing", "failed", "manual"] },
      "payment.testMode": { $ne: true },
    };
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      Booking.find(filter)
        .sort({ updatedAt: -1 })
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
      return res.status(400).json({ message: "Only refunds awaiting approval can be approved" });
    }
    // Validate BEFORE claiming: amount caps, test-mode routing, and the
    // settled-payout clawback gate are all pure checks on the queued state.
    const clawback = req.body?.clawback === true;
    const pre = refundApprovalCheck(booking, { clawback });
    if (!pre.ok) {
      return res.status(400).json({ message: pre.reasons[0], reasons: pre.reasons });
    }
    // Exactly one approver survives: concurrent approves lose here with a
    // safe 400 instead of double-charging the gateway.
    const claimed = await Booking.findOneAndUpdate(
      { _id: booking._id, "payment.refundStatus": "pending" },
      { $set: { "payment.refundStatus": "processing" } },
      { new: true }
    );
    if (!claimed) {
      return res.status(400).json({ message: "This refund is already being processed — please refresh." });
    }
    if (claimed.payment?.testMode) {
      claimed.payment.refundStatus = "processed";
      claimed.payment.refundedAt = claimed.payment.refundedAt || new Date();
      claimed.statusHistory.push({
        status: claimed.status,
        note: "Test-payment refund approved (no real money moved)",
      });
      await claimed.save();
      await recordLedger({
        idempotencyKey: `refund-approve:${claimed._id}`,
        booking: claimed._id,
        type: "refund.approved",
        amount: 0,
        prevState: "refund:pending",
        newState: "refund:processed",
        actor: `admin:${req.user.id}`,
        source: "admin",
        reason: "Test payment — no money moved",
      });
      return res.json(claimed);
    }
    const refundAmount = pre.amount;
    if (claimed.payment?.razorpayPaymentId && razorpayConfigured && razorpayClient) {
      try {
        const refund = await razorpayClient.payments.refund(claimed.payment.razorpayPaymentId, {
          amount: refundAmount * 100,
          speed: "normal",
          notes: { booking: String(claimed._id), reason: "admin_approved" },
        });
        claimed.payment.refundId = refund?.id || "";
        claimed.payment.refundStatus = "processed";
        claimed.payment.refundAmount = refundAmount;
        claimed.payment.refundedAt = new Date();
      } catch {
        claimed.payment.refundStatus = "failed";
        claimed.payment.refundAmount = refundAmount;
      }
    } else {
      claimed.payment.refundStatus = "manual";
      claimed.payment.refundAmount = refundAmount;
    }
    claimed.statusHistory.push({
      status: claimed.status,
      note: `Refund of ₹${refundAmount} approved by admin (${claimed.payment.refundStatus})` +
        (clawback ? " — clawback required: cook payout was already settled, recover from the cook" : ""),
    });
    await claimed.save();

    await recordLedger({
      idempotencyKey: `refund-approve:${claimed._id}`,
      booking: claimed._id,
      type: "refund.approved",
      amount: refundAmount,
      prevState: "refund:pending",
      newState: `refund:${claimed.payment.refundStatus}`,
      actor: `admin:${req.user.id}`,
      source: "admin",
      razorpayOrderId: claimed.payment?.razorpayOrderId || "",
      razorpayPaymentId: claimed.payment?.razorpayPaymentId || "",
      razorpayRefundId: claimed.payment?.refundId || "",
      reason: clawback ? "Approved with clawback (payout already settled)" : "Admin-approved refund",
    });

    try {
      const Notification = require("../models/Notification");
      const approved =
        claimed.payment.refundStatus === "processed" || claimed.payment.refundStatus === "manual";
      await Notification.create({
        user: claimed.customer,
        type: "refund_processed",
        booking: claimed._id,
        message: approved
          ? `Your refund of ₹${refundAmount} has been approved — it reaches your account in 5–7 business days.`
          : "Your approved refund hit a gateway error — our team is following up and will notify you.",
      });
    } catch {
      // non-fatal
    }

    res.json(claimed);
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
    booking.payment.refundStatus = "rejected";
    booking.statusHistory.push({
      status: booking.status,
      note: `Refund request declined by admin${reason ? `: ${reason}` : ""}`,
    });
    await booking.save();
    await recordLedger({
      idempotencyKey: `refund-reject:${booking._id}`,
      booking: booking._id,
      type: "refund.rejected",
      amount: Math.round(Number(booking.payment?.refundAmount || 0)),
      prevState: "refund:pending",
      newState: "refund:rejected",
      actor: `admin:${req.user.id}`,
      source: "admin",
      reason: reason || "Declined by admin",
    });

    try {
      const Notification = require("../models/Notification");
      await Notification.create({
        user: booking.customer,
        type: "refund_processed",
        booking: booking._id,
        message: `Your refund request for ₹${booking.payment?.refundAmount || booking.amount} was declined by our team${reason ? `: ${reason}` : ""}. Please contact support if you need help.`,
      });
    } catch {
      // non-fatal
    }

    res.json(booking);
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
    if (booking.payout?.status !== "pending") {
      return res.status(400).json({ message: "Only pending payouts can be rejected" });
    }
    const reason = String(req.body?.reason || "").trim().slice(0, 200);
    booking.payout.status = "not_applicable";
    booking.statusHistory.push({
      status: booking.status,
      note: `Cook payout ₹${booking.cookPayout} declined by admin${reason ? `: ${reason}` : ""}`,
    });
    await booking.save();
    await recordLedger({
      idempotencyKey: `payout-reject:${booking._id}`,
      booking: booking._id,
      type: "payout.rejected",
      amount: Math.round(Number(booking.cookPayout || 0)),
      prevState: "payout:pending",
      newState: "payout:not_applicable",
      actor: `admin:${req.user.id}`,
      source: "admin",
      reason: reason || "Declined by admin",
    });

    try {
      const Notification = require("../models/Notification");
      await Notification.create({
        user: booking.cook,
        type: "payout_settled",
        booking: booking._id,
        message: `Your payout for the ${
          booking.date
            ? new Date(booking.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
            : ""
        } session was declined by our team${reason ? `: ${reason}` : ""}. Please contact support if you need help.`,
      });
    } catch {
      // non-fatal
    }

    res.json(booking);
  } catch (error) {
    next(error);
  }
};

// Admin: mark a failed gateway refund as manually settled (the money left
// via bank/UPI outside Razorpay). Also the recovery path for a "processing"
// row stuck by a crashed approval: the admin verifies the gateway dashboard
// by hand, then closes it here. An optional amount must exactly match the
// approved figure — manual settlement can never exceed it.
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
    if (!reference) {
      return res.status(400).json({ message: "A transfer reference is required" });
    }
    const approved = Math.round(Number(booking.payment.refundAmount || booking.amount || 0));
    if (req.body?.amount !== undefined && req.body?.amount !== "") {
      const stated = Math.round(Number(req.body.amount));
      if (!Number.isFinite(stated) || stated !== approved) {
        return res.status(400).json({ message: `Settled amount must equal the approved ₹${approved}` });
      }
    }
    booking.payment.refundStatus = "processed";
    booking.payment.refundedAt = booking.payment.refundedAt || new Date();
    booking.statusHistory.push({
      status: booking.status,
      note: `Refund of ₹${booking.payment.refundAmount || booking.amount} settled manually (ref: ${reference.slice(0, 120)})`,
    });
    await booking.save();
    await recordLedger({
      idempotencyKey: `refund-settled:${booking._id}`,
      booking: booking._id,
      type: "refund.settled",
      amount: approved,
      prevState: "refund:manual",
      newState: "refund:processed",
      actor: `admin:${req.user.id}`,
      source: "admin",
      payoutReference: reference.slice(0, 120),
      reason: "Manual settlement recorded",
    });

    try {
      const Notification = require("../models/Notification");
      await Notification.create({
        user: booking.customer,
        type: "refund_processed",
        booking: booking._id,
        message: `Your refund of ₹${booking.payment.refundAmount || booking.amount} has been processed.`,
      });
    } catch {
      // non-fatal
    }

    res.json(booking);
  } catch (error) {
    next(error);
  }
};

// Admin reconciliation: booking-aggregate money truth (source of record)
// cross-checked against ledger entry counts. Any mismatch surfaces here for
// manual review — the console never silently drifts from the books.
exports.getLedgerSummary = async (req, res, next) => {
  try {
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
                    { $ne: ["$payment.testMode", true] },
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
                { $in: ["$payment.refundStatus", ["processed", "manual"]] },
                { $ifNull: ["$payment.refundAmount", 0] },
                0,
              ],
            },
          },
          settledPayouts: {
            $sum: {
              $cond: [
                { $eq: ["$payout.status", "settled"] },
                { $ifNull: ["$payout.amount", 0] },
                0,
              ],
            },
          },
          settledCount: {
            $sum: { $cond: [{ $eq: ["$payout.status", "settled"] }, 1, 0] },
          },
          commissionOnSettled: {
            $sum: {
              $cond: [
                { $eq: ["$payout.status", "settled"] },
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
    });
  } catch (error) {
    next(error);
  }
};

