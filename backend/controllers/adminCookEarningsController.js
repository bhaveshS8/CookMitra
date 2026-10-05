// Admin console for leads, incentives, referrals + weekly payouts (§14).
// All routes auth + authorize("admin"). Money moves only here.

const crypto = require("crypto");
const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const CookLead = require("../models/CookLead");
const CookIncentive = require("../models/CookIncentive");
const CookReferral = require("../models/CookReferral");
const CookPayout = require("../models/CookPayout");
const { paginationParams, applyPagination, sendList } = require("../utils/pagination");
const { computeCookPayout, round2 } = require("../utils/cookEarnings");
const {
  audit,
  notifyCook,
  countVerifiedBookings,
  countVerifiedLeadsInWindow,
} = require("../utils/cookEarningsService");

// ── Leads ────────────────────────────────────────────────────────────────
exports.listAllLeads = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.cook) filter.cook = req.query.cook;
    const pg = paginationParams(req);
    const leads = await applyPagination(
      CookLead.find(filter).sort({ createdAt: -1 }).populate("cook", "name phone"),
      pg
    );
    return sendList(res, leads, pg, () => CookLead.countDocuments(filter));
  } catch (e) {
    next(e);
  }
};

const setLeadState = async ({ leadId, adminId, status, verificationStatus, reason, verified }) => {
  const lead = await CookLead.findById(leadId);
  if (!lead) return null;
  if (["verified", "rejected", "duplicate", "invalid", "converted"].includes(lead.status) && !verified) {
    // Terminal states change only via explicit re-verify path — settled stays settled.
  }
  lead.status = status;
  lead.verificationStatus = verificationStatus;
  if (reason != null) lead.rejectionReason = String(reason).slice(0, 300);
  if (verified) {
    lead.verifiedAt = new Date();
    lead.verifiedBy = adminId;
  }
  await lead.save();
  return lead;
};

exports.verifyLead = async (req, res, next) => {
  try {
    const lead = await CookLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    if (lead.status === "verified") return res.json(lead); // idempotent
    // Cross-cook duplicate check at verify time (submitted concurrently).
    const clash = await CookLead.findOne({
      _id: { $ne: lead._id },
      normalizedPhone: lead.normalizedPhone,
      status: { $in: ["verified", "converted"] },
    }).select("_id");
    if (clash) {
      lead.status = "duplicate";
      lead.verificationStatus = "rejected";
      lead.rejectionReason = "Already verified under another cook";
      await lead.save();
      return res.status(409).json({ message: "Duplicate: this customer is already verified under another cook", lead });
    }
    const updated = await setLeadState({
      leadId: lead._id, adminId: req.user.id, status: "verified", verificationStatus: "verified", verified: true,
    });
    // Refresh the cook's incentive eligibility (may newly qualify).
    try {
      const { refreshIncentiveEligibility } = require("../utils/cookEarningsService");
      await refreshIncentiveEligibility(lead.cook);
    } catch {
      // non-fatal
    }
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "lead_verified", cook: lead.cook, refId: lead._id, refModel: "CookLead", detail: `${lead.customerName} verified` });
    await notifyCook({ cookId: lead.cook, type: "lead_verified", message: `Lead for ${lead.customerName} is verified — it now counts toward your incentives.`, link: "/cook/earnings" });
    res.json(updated);
  } catch (e) {
    next(e);
  }
};

exports.rejectLead = async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || req.body?.rejectionReason || "").trim().slice(0, 300);
    if (!reason) return res.status(400).json({ message: "A rejection reason is required" });
    const lead = await CookLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    if (lead.status === "rejected") return res.json(lead);
    const updated = await setLeadState({
      leadId: lead._id, adminId: req.user.id, status: "rejected", verificationStatus: "rejected", reason,
    });
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "lead_rejected", cook: lead.cook, refId: lead._id, refModel: "CookLead", detail: reason });
    await notifyCook({ cookId: lead.cook, type: "lead_rejected", message: `Lead for ${lead.customerName} was not approved: ${reason}`, link: "/cook/earnings" });
    res.json(updated);
  } catch (e) {
    next(e);
  }
};

exports.markLeadDuplicate = async (req, res, next) => {
  try {
    const lead = await CookLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    const updated = await setLeadState({
      leadId: lead._id, adminId: req.user.id, status: "duplicate", verificationStatus: "rejected",
      reason: String(req.body?.reason || "Duplicate lead").slice(0, 300),
    });
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "lead_rejected", cook: lead.cook, refId: lead._id, refModel: "CookLead", detail: "marked duplicate" });
    res.json(updated);
  } catch (e) {
    next(e);
  }
};

// ── Incentives ───────────────────────────────────────────────────────────
exports.listIncentives = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.cook) filter.cook = req.query.cook;
    if (req.query.code) filter.code = String(req.query.code).toUpperCase();
    const pg = paginationParams(req);
    const rows = await applyPagination(
      CookIncentive.find(filter).sort({ createdAt: -1 }).populate("cook", "name phone"),
      pg
    );
    // Attach live server-computed counts (display aid; stored counts update on verify).
    const enriched = await Promise.all(
      (rows || []).map(async (r) => {
        const o = r.toObject ? r.toObject() : r;
        try {
          o.liveVerifiedCount = await countVerifiedLeadsInWindow(o.cook?._id || o.cook, o.startDate, o.endDate);
        } catch {
          o.liveVerifiedCount = o.verifiedLeadCount;
        }
        return o;
      })
    );
    return sendList(res, enriched, pg, () => CookIncentive.countDocuments(filter));
  } catch (e) {
    next(e);
  }
};

exports.approveIncentive = async (req, res, next) => {
  try {
    const inc = await CookIncentive.findById(req.params.id);
    if (!inc) return res.status(404).json({ message: "Incentive not found" });
    if (inc.status === "approved" || inc.status === "paid") return res.json(inc);
    // Backend re-validates qualification (§9) — frontend can never approve.
    const live = await countVerifiedLeadsInWindow(inc.cook, inc.startDate, inc.endDate);
    const expired = new Date() > new Date(inc.endDate);
    if (live < inc.target || expired) {
      return res.status(400).json({ message: `Not qualified: ${live}/${inc.target} verified leads${expired ? " (window expired)" : ""}`, code: "INCENTIVE_NOT_QUALIFIED" });
    }
    inc.verifiedLeadCount = live;
    inc.eligible = true;
    inc.status = "approved";
    inc.approvedAt = new Date();
    inc.approvedBy = req.user.id;
    await inc.save();
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "incentive_approved", cook: inc.cook, refId: inc._id, refModel: "CookIncentive", detail: `${inc.code} ₹${inc.reward} approved` });
    await notifyCook({ cookId: inc.cook, type: "incentive_approved", message: `Incentive approved: ${inc.code} — ₹${inc.reward} will be included in your payout.`, link: "/cook/earnings" });
    res.json(inc);
  } catch (e) {
    next(e);
  }
};

exports.rejectIncentive = async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || "").trim().slice(0, 300);
    if (!reason) return res.status(400).json({ message: "A rejection reason is required" });
    const inc = await CookIncentive.findById(req.params.id);
    if (!inc) return res.status(404).json({ message: "Incentive not found" });
    if (["paid"].includes(inc.status)) return res.status(400).json({ message: "Paid incentives cannot be rejected" });
    inc.status = "rejected";
    inc.rejectionReason = reason;
    await inc.save();
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "incentive_rejected", cook: inc.cook, refId: inc._id, refModel: "CookIncentive", detail: reason });
    await notifyCook({ cookId: inc.cook, type: "incentive_rejected", message: `Incentive ${inc.code} was not approved: ${reason}`, link: "/cook/earnings" });
    res.json(inc);
  } catch (e) {
    next(e);
  }
};

exports.holdIncentive = async (req, res, next) => {
  try {
    const inc = await CookIncentive.findById(req.params.id);
    if (!inc) return res.status(404).json({ message: "Incentive not found" });
    inc.status = "held";
    if (req.body?.reason) inc.rejectionReason = String(req.body.reason).slice(0, 300);
    await inc.save();
    await notifyCook({ cookId: inc.cook, type: "incentive_rejected", message: `Incentive ${inc.code} is on hold — our team will review it shortly.`, link: "/cook/earnings" });
    res.json(inc);
  } catch (e) {
    next(e);
  }
};

// ── Referrals ────────────────────────────────────────────────────────────
exports.listReferrals = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const pg = paginationParams(req);
    const rows = await applyPagination(
      CookReferral.find(filter).sort({ createdAt: -1 }).populate("referrer", "name").populate("referredCook", "name"),
      pg
    );
    const enriched = await Promise.all(
      (rows || []).map(async (r) => {
        const o = r.toObject ? r.toObject() : r;
        try {
          o.liveVerifiedBookings = await countVerifiedBookings(o.referredCook?._id || o.referredCook);
        } catch {
          o.liveVerifiedBookings = o.verifiedBookings;
        }
        return o;
      })
    );
    return sendList(res, enriched, pg, () => CookReferral.countDocuments(filter));
  } catch (e) {
    next(e);
  }
};

exports.approveReferral = async (req, res, next) => {
  try {
    const ref = await CookReferral.findById(req.params.id);
    if (!ref) return res.status(404).json({ message: "Referral not found" });
    if (ref.status === "approved" || ref.status === "paid") return res.json(ref);
    const live = await countVerifiedBookings(ref.referredCook);
    if (live < ref.bookingTarget) {
      return res.status(400).json({ message: `Not qualified: ${live}/${ref.bookingTarget} verified bookings`, code: "REFERRAL_NOT_QUALIFIED" });
    }
    ref.verifiedBookings = live;
    ref.status = "approved";
    ref.approvedAt = new Date();
    ref.approvedBy = req.user.id;
    await ref.save();
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "referral_approved", cook: ref.referrer, refId: ref._id, refModel: "CookReferral", detail: `₹${ref.reward} approved (${live} bookings)` });
    await notifyCook({ cookId: ref.referrer, type: "referral_approved", message: `Referral reward approved: ₹${ref.reward} — your referred cook completed ${live} verified bookings.`, link: "/cook/earnings" });
    res.json(ref);
  } catch (e) {
    next(e);
  }
};

// ── Weekly payouts ───────────────────────────────────────────────────────
exports.listCookPayouts = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.cook) filter.cook = req.query.cook;
    const pg = paginationParams(req);
    const rows = await applyPagination(
      CookPayout.find(filter).sort({ weekStart: -1 }).populate("cook", "name phone"),
      pg
    );
    return sendList(res, rows, pg, () => CookPayout.countDocuments(filter));
  } catch (e) {
    next(e);
  }
};

// POST /api/admin/cook-payouts/build { cookId, weekStart?, weekEnd? }
// Collects eligible bookings into one idempotent weekly cycle (§3/§5).
exports.buildCookPayout = async (req, res, next) => {
  try {
    const cookId = String(req.body?.cookId || req.body?.cook || "");
    if (!/^[0-9a-fA-F]{24}$/.test(cookId)) {
      return res.status(400).json({ message: "Valid cookId is required" });
    }
    const weekStart = req.body?.weekStart ? new Date(req.body.weekStart) : weekMonday(new Date());
    const weekEnd = req.body?.weekEnd
      ? new Date(req.body.weekEnd)
      : new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);
    const idem = `cycle:${cookId}:${weekStart.toISOString().slice(0, 10)}:${weekEnd.toISOString().slice(0, 10)}`;
    const existing = await CookPayout.findOne({ idempotencyKey: idem });
    if (existing) return res.json({ ...existing.toObject(), alreadyExists: true });
    // Eligible bookings: completed + paid + verified, held ones excluded.
    const candidates = await Booking.find({
      cook: cookId,
      status: "completed",
      "payment.status": "paid",
      "payment.testMode": { $ne: true },
      "payment.refundStatus": { $in: ["none", "rejected"] },
      hoursCompleted: true,
      cookPayout: { $gt: 0 },
      $or: [
        { "payoutInfo.payoutStatus": { $in: ["eligible", "pending_weekly"] } },
        { "payoutInfo.payoutStatus": { $exists: false } },
      ],
    }).lean();
    const eligible = (candidates || []).filter(
      (b) => !b?.payoutInfo?.disputed && !b?.payoutInfo?.underVerification && b?.payout?.status !== "settled"
    );
    if (!eligible.length) {
      return res.status(400).json({ message: "No eligible bookings for this cook in the selected week", code: "NO_ELIGIBLE_BOOKINGS" });
    }
    let gross = 0;
    let deductions = 0;
    let earnings = 0;
    for (const b of eligible) {
      const final = round2(b.payoutInfo?.finalCustomerPrice > 0 ? b.payoutInfo.finalCustomerPrice : b.amount || 0);
      const split = computeCookPayout(final);
      gross = round2(gross + split.finalCustomerPrice);
      deductions = round2(deductions + split.platformDeductionAmount);
      earnings = round2(earnings + split.cookPayoutAmount);
    }
    const payoutRef = `CP-${cookId.slice(-4).toUpperCase()}-${weekStart.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    let cycle;
    try {
      cycle = await CookPayout.create({
        cook: cookId,
        weekStart,
        weekEnd,
        payoutRef,
        bookings: eligible.map((b) => b._id),
        bookingCount: eligible.length,
        grossCustomerValue: gross,
        totalDeductions: deductions,
        cookEarnings: earnings,
        bonuses: 0,
        referralEarnings: 0,
        totalPayable: round2(earnings),
        status: "pending",
        idempotencyKey: idem,
      });
    } catch (e) {
      if (e?.code === 11000) {
        const dup = await CookPayout.findOne({ idempotencyKey: idem });
        if (dup) return res.json({ ...dup.toObject(), alreadyExists: true });
      }
      throw e;
    }
    // Pin bookings to this cycle (only those still unclaimed — atomic guard
    // against two cycles claiming the same booking).
    await Booking.updateMany(
      {
        _id: { $in: eligible.map((b) => b._id) },
        $or: [
          { "payoutInfo.payoutStatus": { $in: ["eligible", "pending_weekly"] } },
          { "payoutInfo.payoutStatus": { $exists: false } },
        ],
      },
      { $set: { "payoutInfo.payoutStatus": "pending_weekly", "payoutInfo.payoutCycleRef": payoutRef } }
    );
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "payout_approved", cook: cookId, refId: cycle._id, refModel: "CookPayout", detail: `Cycle ${payoutRef}: ${eligible.length} bookings, ₹${round2(earnings)}` });
    res.status(201).json(cycle);
  } catch (e) {
    next(e);
  }
};

const weekMonday = (now = new Date()) => {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
};

const transitionCycle = async ({ id, adminId, to, allowedFrom, extra = {}, event, message }) => {
  const cycle = await CookPayout.findById(id);
  if (!cycle) return { error: 404 };
  if (!allowedFrom.includes(cycle.status)) {
    return { error: 409, message: `Cannot move payout from ${cycle.status} to ${to}` };
  }
  Object.assign(cycle, extra, { status: to });
  if (to === "approved") {
    cycle.approvedAt = new Date();
    cycle.approvedBy = adminId;
  }
  if (to === "paid") {
    cycle.paidAt = new Date();
    cycle.paymentDate = new Date();
  }
  await cycle.save();
  // Mirror onto member bookings (payoutInfo only — never touches booking.payout ledger).
  const bookingStatus = to === "paid" ? "paid" : to === "approved" ? "approved" : to === "held" ? "held" : undefined;
  if (bookingStatus) {
    await Booking.updateMany(
      { _id: { $in: cycle.bookings } },
      {
        $set: {
          "payoutInfo.payoutStatus": bookingStatus,
          ...(to === "paid" ? { "payoutInfo.payoutProcessedAt": new Date() } : {}),
          ...(extra.holdReason ? { "payoutInfo.payoutHoldReason": extra.holdReason } : {}),
        },
      }
    );
  }
  await audit({ actor: adminId, actorRole: "ADMIN", event, cook: cycle.cook, refId: cycle._id, refModel: "CookPayout", detail: `${cycle.payoutRef} → ${to}` });
  if (message) await notifyCook({ cookId: cycle.cook, type: event === "payout_paid" ? "payout_paid" : event === "payout_held" ? "payout_held" : "payout_approved", message, link: "/cook/earnings" });
  return { cycle };
};

exports.approveCookPayout = async (req, res, next) => {
  try {
    const { cycle, error, message } = await transitionCycle({
      id: req.params.id, adminId: req.user.id, to: "approved",
      allowedFrom: ["pending", "under_verification", "held"],
      event: "payout_approved",
      message: "Your weekly payout was approved — payment will follow shortly.",
    });
    if (error === 404) return res.status(404).json({ message: "Payout not found" });
    if (error === 409) return res.status(409).json({ message });
    res.json(cycle);
  } catch (e) {
    next(e);
  }
};

exports.payCookPayout = async (req, res, next) => {
  try {
    const reference = String(req.body?.reference || req.body?.paymentReference || "").trim().slice(0, 120);
    if (reference.length < 4) return res.status(400).json({ message: "A payment reference is required" });
    // Global uniqueness of the payment reference (double-payment prevention).
    const dup = await CookPayout.findOne({ paymentReference: reference, status: "paid" }).select("_id");
    if (dup && String(dup._id) !== String(req.params.id)) {
      return res.status(409).json({ message: "This reference already paid another cycle", code: "DUPLICATE_PAYOUT_REFERENCE" });
    }
    let result;
    try {
      result = await transitionCycle({
        id: req.params.id, adminId: req.user.id, to: "paid",
        allowedFrom: ["approved"],
        extra: { paymentReference: reference },
        event: "payout_paid",
        message: `Your weekly payout was paid (ref: ${reference}).`,
      });
    } catch (e) {
      if (e?.code === 11000) return res.status(409).json({ message: "This payout was just paid — please refresh" });
      throw e;
    }
    const { cycle, error, message } = result;
    if (error === 404) return res.status(404).json({ message: "Payout not found" });
    if (error === 409) return res.status(409).json({ message });
    res.json(cycle);
  } catch (e) {
    next(e);
  }
};

exports.holdCookPayout = async (req, res, next) => {
  try {
    const reason = String(req.body?.reason || req.body?.holdReason || "").trim().slice(0, 300);
    if (!reason) return res.status(400).json({ message: "A hold reason is required" });
    const { cycle, error, message } = await transitionCycle({
      id: req.params.id, adminId: req.user.id, to: "held",
      allowedFrom: ["pending", "under_verification", "approved"],
      extra: { holdReason: reason },
      event: "payout_held",
      message: `Your weekly payout is on hold: ${reason} — it will move to a later cycle after resolution.`,
    });
    if (error === 404) return res.status(404).json({ message: "Payout not found" });
    if (error === 409) return res.status(409).json({ message });
    res.json(cycle);
  } catch (e) {
    next(e);
  }
};
