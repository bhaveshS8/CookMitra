
const crypto = require("crypto");
const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const CookLead = require("../models/CookLead");
const CookIncentive = require("../models/CookIncentive");
const CookReferral = require("../models/CookReferral");
const CookPayout = require("../models/CookPayout");
const CookEventLog = require("../models/CookEventLog");
const { paginationParams, applyPagination, sendList } = require("../utils/pagination");
const { computeCookPayout, round2, toPaise, fromPaise } = require("../utils/cookEarnings");
const {
  audit,
  notifyCook,
  countVerifiedBookings,
  countVerifiedLeadsInWindow,
} = require("../utils/cookEarningsService");

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
  // Atomic conditional write: concurrent verify/reject/duplicate actions on
  // the same lead serialize here; callers distinguish won/lost via the
  // returned document. Admin override between states is allowed (the admin
  // panel offers every action on every row for corrections) and audited.
  const update = { status, verificationStatus };
  if (reason != null) update.rejectionReason = String(reason).slice(0, 300);
  if (verified) {
    update.verifiedAt = new Date();
    update.verifiedBy = adminId;
  }
  const lead = await CookLead.findByIdAndUpdate(leadId, { $set: update }, { new: true });
  return lead;
};

exports.verifyLead = async (req, res, next) => {
  try {
    const lead = await CookLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    if (lead.status === "verified" || lead.status === "converted") return res.json(lead); // idempotent
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
    try {
      const { refreshIncentiveEligibility } = require("../utils/cookEarningsService");
      await refreshIncentiveEligibility(lead.cook);
    } catch {
    }
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "lead_verified", cook: lead.cook, refId: lead._id, refModel: "CookLead", detail: `${lead.customerName} verified` });
    await notifyCook({ cookId: lead.cook, type: "lead_verified", message: `Lead for ${lead.customerName} is verified — it now counts toward your incentives.`, link: "/cook/earnings", whatsapp: false });
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
    try {
      // A rejected lead stops counting toward incentives immediately —
      // don't wait for the cook's next earnings refresh to recount.
      const { refreshIncentiveEligibility } = require("../utils/cookEarningsService");
      await refreshIncentiveEligibility(updated.cook);
    } catch {
    }
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "lead_rejected", cook: lead.cook, refId: lead._id, refModel: "CookLead", detail: reason });
    // In-app only — same no-WhatsApp-on-rejection rule as incentives.
    await notifyCook({ cookId: lead.cook, type: "lead_rejected", message: `Lead for ${lead.customerName} was not approved: ${reason}`, link: "/cook/earnings", whatsapp: false });
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
    try {
      const { refreshIncentiveEligibility } = require("../utils/cookEarningsService");
      await refreshIncentiveEligibility(updated.cook);
    } catch {
    }
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "lead_rejected", cook: lead.cook, refId: lead._id, refModel: "CookLead", detail: "marked duplicate" });
    res.json(updated);
  } catch (e) {
    next(e);
  }
};

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
    const live = await countVerifiedLeadsInWindow(inc.cook, inc.startDate, inc.endDate);
    const expired = new Date() > new Date(inc.endDate);
    if (live < inc.target || expired) {
      return res.status(400).json({ message: `Not qualified: ${live}/${inc.target} verified leads${expired ? " (window expired)" : ""}`, code: "INCENTIVE_NOT_QUALIFIED" });
    }
    // Atomic approve: concurrent approvals race on this single update and
    // exactly one winner emits the audit/notification.
    const now = new Date();
    const updated = await CookIncentive.findOneAndUpdate(
      { _id: inc._id, status: { $nin: ["approved", "paid"] } },
      { $set: { verifiedLeadCount: live, eligible: true, status: "approved", approvedAt: now, approvedBy: req.user.id } },
      { new: true }
    );
    if (!updated) {
      const current = await CookIncentive.findById(inc._id);
      if (current && (current.status === "approved" || current.status === "paid")) return res.json(current);
      return res.status(409).json({ message: "This incentive was just updated — please refresh" });
    }
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "incentive_approved", cook: updated.cook, refId: updated._id, refModel: "CookIncentive", detail: `${updated.code} ₹${updated.reward} approved` });
    await notifyCook({ cookId: updated.cook, type: "incentive_approved", message: `Incentive approved: ${updated.code} — ₹${updated.reward} will be included in your payout.`, link: "/cook/earnings", whatsapp: false });
    res.json(updated);
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
    if (inc.status === "rejected") return res.json(inc); // idempotent: no duplicate cook spam
    // Atomic reject so concurrent rejects emit exactly one audit/notification.
    const updated = await CookIncentive.findOneAndUpdate(
      { _id: inc._id, status: { $nin: ["paid", "rejected"] } },
      { $set: { status: "rejected", rejectionReason: reason } },
      { new: true }
    );
    if (!updated) {
      const current = await CookIncentive.findById(inc._id);
      if (current && current.status === "rejected") return res.json(current);
      if (current && current.status === "paid") return res.status(400).json({ message: "Paid incentives cannot be rejected" });
      return res.status(409).json({ message: "This incentive was just updated — please refresh" });
    }
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "incentive_rejected", cook: updated.cook, refId: updated._id, refModel: "CookIncentive", detail: reason });
    // In-app notification only — notifyCook() deliberately skips WhatsApp
    // for incentive_rejected (see utils/cookEarningsService.js).
    await notifyCook({ cookId: updated.cook, type: "incentive_rejected", message: `Incentive ${updated.code} was not approved: ${reason}`, link: "/cook/earnings", whatsapp: false });
    res.json(updated);
  } catch (e) {
    next(e);
  }
};

exports.holdIncentive = async (req, res, next) => {
  try {
    const inc = await CookIncentive.findById(req.params.id);
    if (!inc) return res.status(404).json({ message: "Incentive not found" });
    // Paid rewards are terminal: holding them would misrepresent settled money.
    if (inc.status === "paid") return res.status(400).json({ message: "Paid incentives cannot be held" });
    if (inc.status === "held") return res.json(inc); // idempotent
    const update = { status: "held" };
    if (req.body?.reason) update.rejectionReason = String(req.body.reason).slice(0, 300);
    const updated = await CookIncentive.findOneAndUpdate(
      { _id: inc._id, status: { $ne: "paid" } },
      { $set: update },
      { new: true }
    );
    if (!updated) {
      const current = await CookIncentive.findById(inc._id);
      if (current && current.status === "paid") return res.status(400).json({ message: "Paid incentives cannot be held" });
      if (current && current.status === "held") return res.json(current);
      return res.status(409).json({ message: "This incentive was just updated — please refresh" });
    }
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "incentive_held", cook: updated.cook, refId: updated._id, refModel: "CookIncentive", detail: updated.rejectionReason || "held for review" });
    await notifyCook({ cookId: updated.cook, type: "incentive_held", message: `Incentive ${updated.code} is on hold — our team will review it shortly.`, link: "/cook/earnings", whatsapp: false });
    res.json(updated);
  } catch (e) {
    next(e);
  }
};

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
    // Atomic approve: concurrent approvals emit exactly one audit/notification.
    const now = new Date();
    const updated = await CookReferral.findOneAndUpdate(
      { _id: ref._id, status: { $nin: ["approved", "paid"] } },
      { $set: { verifiedBookings: live, status: "approved", approvedAt: now, approvedBy: req.user.id } },
      { new: true }
    );
    if (!updated) {
      const current = await CookReferral.findById(ref._id);
      if (current && (current.status === "approved" || current.status === "paid")) return res.json(current);
      return res.status(409).json({ message: "This referral was just updated — please refresh" });
    }
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "referral_approved", cook: updated.referrer, refId: updated._id, refModel: "CookReferral", detail: `₹${updated.reward} approved (${live} bookings)` });
    await notifyCook({ cookId: updated.referrer, type: "referral_approved", message: `Referral reward approved: ₹${updated.reward} — your referred cook completed ${live} verified bookings.`, link: "/cook/earnings", whatsapp: false });
    res.json(updated);
  } catch (e) {
    next(e);
  }
};

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

exports.buildCookPayout = async (req, res, next) => {
  try {
    const cookId = String(req.body?.cookId || req.body?.cook || "");
    if (!/^[0-9a-fA-F]{24}$/.test(cookId)) {
      return res.status(400).json({ message: "Valid cookId is required" });
    }
    // IST business-week boundaries (matching the cook earnings overview),
    // never server-local midnight.
    const weekStart = req.body?.weekStart ? new Date(req.body.weekStart) : weekMondayIST(new Date());
    const weekEnd = req.body?.weekEnd
      ? new Date(req.body.weekEnd)
      : new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(weekStart.getTime()) || Number.isNaN(weekEnd.getTime())) {
      return res.status(400).json({ message: "Valid weekStart/weekEnd dates are required" });
    }
    const idem = `cycle:${cookId}:${weekStart.toISOString().slice(0, 10)}:${weekEnd.toISOString().slice(0, 10)}`;
    const existing = await CookPayout.findOne({ idempotencyKey: idem });
    if (existing) return res.json({ ...existing.toObject(), alreadyExists: true });
    // Only NEVER-claimed bookings are candidates. Previously-claimed
    // (pending_weekly / approved / paid / held) rows are excluded so a
    // second build — same week or an overlapping range — can never assign
    // one booking to two payable cycles.
    const claimFilter = {
      cook: cookId,
      status: "completed",
      "payment.status": "paid",
      "payment.testMode": { $ne: true },
      "payment.refundStatus": { $in: ["none", "rejected"] },
      hoursCompleted: true,
      $or: [
        { cookPayout: { $gt: 0 } },
        { "payoutInfo.cookPayoutAmount": { $gt: 0 } },
      ],
      $and: [
        {
          $or: [
            { "payoutInfo.payoutStatus": "eligible" },
            { "payoutInfo.payoutStatus": { $exists: false } },
          ],
        },
        {
          $or: [
            { "payoutInfo.payoutCycleRef": { $exists: false } },
            { "payoutInfo.payoutCycleRef": "" },
          ],
        },
      ],
      "payout.status": { $ne: "settled" },
    };
    const candidates = await Booking.find(claimFilter).lean();
    const eligible = (candidates || []).filter(
      (b) => !b?.payoutInfo?.disputed && !b?.payoutInfo?.underVerification && b?.payout?.status !== "settled"
    );
    if (!eligible.length) {
      return res.status(400).json({ message: "No eligible bookings for this cook in the selected week", code: "NO_ELIGIBLE_BOOKINGS" });
    }
    const payoutRef = `CP-${cookId.slice(-4).toUpperCase()}-${weekStart.toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    // Claim-then-create: stamp the bookings to this cycle FIRST with a
    // still-eligible guard, so a concurrent build racing on the same stale
    // read cannot claim the same rows. Totals are computed from the rows
    // actually claimed, never from the pre-race candidate list.
    const eligibleIds = eligible.map((b) => b._id);
    await Booking.updateMany(
      {
        _id: { $in: eligibleIds },
        $or: [
          { "payoutInfo.payoutStatus": "eligible" },
          { "payoutInfo.payoutStatus": { $exists: false } },
        ],
        $and: [
          {
            $or: [
              { "payoutInfo.payoutCycleRef": { $exists: false } },
              { "payoutInfo.payoutCycleRef": "" },
            ],
          },
        ],
      },
      { $set: { "payoutInfo.payoutStatus": "pending_weekly", "payoutInfo.payoutCycleRef": payoutRef } }
    );
    const claimed = await Booking.find({ "payoutInfo.payoutCycleRef": payoutRef }).lean();
    if (!claimed.length) {
      return res.status(409).json({ message: "These bookings were just claimed by another payout cycle — please refresh", code: "BOOKINGS_ALREADY_CLAIMED" });
    }
    // Integer-paise accumulators so cycle totals reconcile exactly with
    // the sum of their booking snapshots (see toPaise/fromPaise).
    let grossP = 0;
    let deductionsP = 0;
    let earningsP = 0;
    for (const b of claimed) {
      // Prefer the persisted snapshot (the same numbers the cook's earnings
      // overview shows); recompute only when no snapshot exists.
      const hasSnap = Number(b.payoutInfo?.finalCustomerPrice) > 0;
      const final = round2(hasSnap ? b.payoutInfo.finalCustomerPrice : b.amount || 0);
      const split = hasSnap
        ? {
            finalCustomerPrice: round2(b.payoutInfo.finalCustomerPrice),
            platformDeductionAmount: round2(b.payoutInfo.platformDeductionAmount ?? 0),
            cookPayoutAmount: round2(b.payoutInfo.cookPayoutAmount ?? 0),
          }
        : computeCookPayout(final);
      grossP += toPaise(split.finalCustomerPrice);
      deductionsP += toPaise(split.platformDeductionAmount);
      earningsP += toPaise(split.cookPayoutAmount);
    }
    const gross = fromPaise(grossP);
    const deductions = fromPaise(deductionsP);
    const earnings = fromPaise(earningsP);
    let cycle;
    try {
      cycle = await CookPayout.create({
        cook: cookId,
        weekStart,
        weekEnd,
        payoutRef,
        bookings: claimed.map((b) => b._id),
        bookingCount: claimed.length,
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
      // Release our claim on ANY create failure so bookings are never left
      // permanently claimed by a cycle that does not exist: a retry then
      // finds them eligible again instead of NO_ELIGIBLE_BOOKINGS.
      await Booking.updateMany(
        { "payoutInfo.payoutCycleRef": payoutRef },
        { $set: { "payoutInfo.payoutStatus": "eligible", "payoutInfo.payoutCycleRef": "" } }
      );
      if (e?.code === 11000) {
        // Lost the idempotency race: the winning cycle remains the sole
        // owner of these bookings.
        const dup = await CookPayout.findOne({ idempotencyKey: idem });
        if (dup) return res.json({ ...dup.toObject(), alreadyExists: true });
      }
      throw e;
    }
    await audit({ actor: req.user.id, actorRole: "ADMIN", event: "payout_created", cook: cookId, refId: cycle._id, refModel: "CookPayout", detail: `Cycle ${payoutRef}: ${claimed.length} bookings, ₹${round2(earnings)}` });
    res.status(201).json(cycle);
  } catch (e) {
    next(e);
  }
};

// IST Monday 00:00 as an instant (same business-week rule as the cook
// earnings overview). The previous local-midnight version split weeks on a
// different boundary than the overview's thisWeek total.
const weekMondayIST = (now = new Date()) => {
  try {
    const { istMidnight, istWeekday } = require("../utils/time");
    const midnight = istMidnight(now);
    if (midnight) {
      const daysBack = (istWeekday(now) + 6) % 7; // Monday=0
      return new Date(midnight.getTime() - daysBack * 24 * 60 * 60 * 1000);
    }
  } catch {
  }
  return weekMonday(now);
};

const weekMonday = (now = new Date()) => {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
};

const withFinancialTransaction = async (fn) => {
  // Multi-document transaction when the deployment supports it (replica
  // set); otherwise the same guarded conditional updates run without a
  // session. Either way callers must use status-guarded updates — never
  // application-level read-then-write — so concurrent admin requests yield
  // exactly one successful financial transition.
  const mongoose = require("mongoose");
  let session = null;
  try {
    session = await mongoose.startSession();
  } catch {
    session = null;
  }
  if (!session) return fn(null);
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (e) {
    if (/replica set|transaction numbers/i.test(String(e?.message || ""))) {
      return fn(null); // standalone MongoDB: transaction aborted, retry plainly
    }
    throw e;
  } finally {
    try {
      await session.endSession();
    } catch {
    }
  }
};

const transitionCycle = async ({ id, adminId, to, allowedFrom, extra = {}, event, message }) => {
  const now = new Date();
  const set = { ...extra, status: to };
  if (to === "approved") {
    set.approvedAt = now;
    set.approvedBy = adminId;
  }
  if (to === "paid") {
    set.paidAt = now;
    set.paymentDate = now;
  }
  const bookingStatus = to === "paid" ? "paid" : to === "approved" ? "approved" : to === "held" ? "held" : undefined;
  // Booking-level guards: "paid" is terminal and must never be downgraded
  // by a later hold/approve; approve never touches already-paid rows.
  const bookingGuard =
    to === "paid"
      ? { "payoutInfo.payoutStatus": { $ne: "paid" } }
      : to === "approved"
        ? { "payoutInfo.payoutStatus": { $nin: ["approved", "paid"] } }
        : to === "held"
          ? { "payoutInfo.payoutStatus": { $ne: "paid" } }
          : null;
  const out = await withFinancialTransaction(async (session) => {
    const copts = session ? { session, new: true } : { new: true };
    // Atomic conditional transition: concurrent approves/pays race on this
    // single document update and exactly one wins; the loser sees no match.
    const cycle = await CookPayout.findOneAndUpdate(
      { _id: id, status: { $in: allowedFrom } },
      { $set: set },
      copts
    );
    if (!cycle) return { miss: true };
    if (bookingStatus && (cycle.bookings || []).length) {
      const bopts = session ? { session } : {};
      await Booking.updateMany(
        { _id: { $in: cycle.bookings }, ...bookingGuard },
        {
          $set: {
            "payoutInfo.payoutStatus": bookingStatus,
            ...(to === "paid" ? { "payoutInfo.payoutProcessedAt": now } : {}),
            ...(extra.holdReason ? { "payoutInfo.payoutHoldReason": extra.holdReason } : {}),
          },
        },
        bopts
      );
    }
    return { cycle };
  });
  if (out?.miss) {
    const current = await CookPayout.findById(id).select("status").lean();
    if (!current) return { error: 404 };
    return { error: 409, message: `Cannot move payout from ${current.status} to ${to}` };
  }
  const { cycle } = out;
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

// Operational repair for a partially completed transition: converge the
// cycle's bookings to the cycle's CURRENT status without moving money,
// touching the payment reference, or emitting a new paid/approved event.
// Only ever writes the booking-level payoutStatus forward to the owning
// cycle's status (paid/approved/held); rows already there are untouched,
// so concurrent or repeated calls are idempotent. It can never revert a
// paid cycle, un-pay bookings, or record a second payment.
//
// PAYMENT-EVIDENCE RULE (manual-disbursement model: the transfer happens
// out-of-band and the admin records the external UPI/bank reference):
// a `paid` cycle WITH a non-empty paymentReference is treated as
// payment-evidenced; a `paid` cycle WITHOUT one is AMBIGUOUS (possibly
// marked paid before transfer completion) and is refused here — bookings
// stay untouched and no paid audit is backfilled until an admin verifies
// the transfer and records the reference via recordPayoutReference.
exports.syncCycleBookings = async (req, res, next) => {
  try {
    const out = await withFinancialTransaction(async (session) => {
      const sopts = session ? { session } : {};
      const q = CookPayout.findById(req.params.id).lean();
      if (session) q.session(session);
      const cycle = await q;
      if (!cycle) return { error: 404 };
      const target =
        cycle.status === "paid" ? "paid" : cycle.status === "approved" ? "approved" : cycle.status === "held" ? "held" : null;
      if (!target) {
        return { error: 409, message: `Nothing to sync while payout is ${cycle.status}`, code: "SYNC_NOT_APPLICABLE" };
      }
      if (target === "paid" && !String(cycle.paymentReference || "").trim()) {
        return {
          error: 409,
          message: "Payment evidence missing: this cycle is marked paid but carries no payment reference. Verify the transfer out-of-band, record the reference, then sync again.",
          code: "PAYMENT_EVIDENCE_MISSING",
        };
      }
      const ids = cycle.bookings || [];
      const now = new Date();
      let matched = 0;
      let synced = 0;
      if (ids.length) {
        // Never steal: only rows this cycle owns (no ref or our ref) and
        // not already settled elsewhere converge. Paid rows are terminal
        // and are never downgraded by an approved/held sync.
        const r = await Booking.updateMany(
          {
            _id: { $in: ids },
            "payoutInfo.payoutStatus": target === "paid" ? { $ne: "paid" } : { $nin: [target, "paid"] },
            $or: [
              { "payoutInfo.payoutCycleRef": { $exists: false } },
              { "payoutInfo.payoutCycleRef": "" },
              { "payoutInfo.payoutCycleRef": cycle.payoutRef },
            ],
          },
          {
            $set: {
              "payoutInfo.payoutStatus": target,
              ...(target === "paid" ? { "payoutInfo.payoutProcessedAt": now } : {}),
            },
          },
          sopts
        );
        matched = r?.matchedCount ?? 0;
        synced = r?.modifiedCount ?? 0;
      }
      const skipped = ids.length - matched;
      // Forensic invariant: every payment-evidenced paid cycle carries
      // exactly one payout_paid audit. If the original pay died after
      // flipping the cycle but before auditing, record the missing event
      // NOW (timestamped now, detail says so) — never a second one.
      // Gated on synced > 0: MongoDB executes each updateMany atomically,
      // so among concurrent repairs exactly one flips rows and only that
      // one backfills — duplicate backfills are structurally impossible,
      // in transaction and fallback modes alike.
      let backfilledPaid = false;
      if (target === "paid" && synced > 0) {
        const cq = CookEventLog.countDocuments({ event: "payout_paid", refId: cycle._id });
        if (session) cq.session(session);
        if ((await cq) === 0) {
          await CookEventLog.create(
            [
              {
                actor: req.user.id,
                actorRole: "ADMIN",
                event: "payout_paid",
                cook: cycle.cook,
                refId: cycle._id,
                refModel: "CookPayout",
                detail: `${cycle.payoutRef} paid (ref: ${cycle.paymentReference}) — recorded during post-failure booking sync; original pay attempt failed mid-write`,
              },
            ],
            sopts
          );
          backfilledPaid = true;
        }
      }
      // Audit the repair only when it changed or backfilled something, so
      // concurrent no-op repairs cannot pile up duplicate audit entries.
      if (synced > 0 || backfilledPaid) {
        await CookEventLog.create(
          [
            {
              actor: req.user.id,
              actorRole: "ADMIN",
              event: "payout_bookings_synced",
              cook: cycle.cook,
              refId: cycle._id,
              refModel: "CookPayout",
              detail: `${cycle.payoutRef} bookings → ${target} (${synced} synced of ${ids.length}, ${skipped} skipped)`,
            },
          ],
          sopts
        );
      }
      return {
        cycle: { _id: cycle._id, payoutRef: cycle.payoutRef, status: cycle.status, cook: cycle.cook },
        bookingStatus: target,
        bookingsTotal: ids.length,
        alreadySynced: matched - synced,
        skipped,
        synced,
        backfilledPaid,
      };
    });
    if (out?.error === 404) return res.status(404).json({ message: "Payout not found" });
    if (out?.error === 409) return res.status(409).json({ message: out.message, ...(out.code ? { code: out.code } : {}) });
    res.json(out);
  } catch (e) {
    next(e);
  }
};

// Attach out-of-band-verified payment evidence to an AMBIGUOUS paid cycle
// (status paid, no payment reference). This is the deliberate,
// separately-audited act that turns "marked paid" into "payment confirmed":
// allowed only on paid cycles with an empty reference, the reference must
// be unique among paid cycles, and it can never overwrite existing
// evidence. After this, syncCycleBookings may converge the bookings.
exports.recordPayoutReference = async (req, res, next) => {
  try {
    const reference = String(req.body?.reference || req.body?.paymentReference || "").trim().slice(0, 120);
    if (reference.length < 4) return res.status(400).json({ message: "A payment reference is required" });
    const dup = await CookPayout.findOne({ paymentReference: reference, status: "paid" }).select("_id");
    if (dup) {
      return res.status(409).json({ message: "This reference already paid another cycle", code: "DUPLICATE_PAYOUT_REFERENCE" });
    }
    let updated = null;
    try {
      updated = await CookPayout.findOneAndUpdate(
        {
          _id: req.params.id,
          status: "paid",
          $or: [{ paymentReference: "" }, { paymentReference: { $exists: false } }],
        },
        { $set: { paymentReference: reference } },
        { new: true }
      );
    } catch (e) {
      if (e?.code === 11000) return res.status(409).json({ message: "This reference already paid another cycle", code: "DUPLICATE_PAYOUT_REFERENCE" });
      throw e;
    }
    if (!updated) {
      const current = await CookPayout.findById(req.params.id).select("status paymentReference").lean();
      if (!current) return res.status(404).json({ message: "Payout not found" });
      if (current.status !== "paid") {
        return res.status(409).json({ message: "A payment reference can only be recorded on a paid payout", code: "REFERENCE_NOT_APPLICABLE" });
      }
      return res.status(409).json({ message: "This payout already carries a payment reference — evidence is never overwritten", code: "REFERENCE_ALREADY_SET" });
    }
    await audit({
      actor: req.user.id,
      actorRole: "ADMIN",
      event: "payout_paid",
      cook: updated.cook,
      refId: updated._id,
      refModel: "CookPayout",
      detail: `${updated.payoutRef} payment confirmed with ref ${reference} after out-of-band verification`,
    });
    res.json(updated);
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
