// Cook-facing earnings APIs: GET/POST only, no financial authority.
// Every amount is computed server-side from bookings/leads/referrals.

const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const CookLead = require("../models/CookLead");
const CookIncentive = require("../models/CookIncentive");
const CookReferral = require("../models/CookReferral");
const CookPayout = require("../models/CookPayout");
const User = require("../models/User");
const cfg = require("../config/cookEarnings");
const { computeCookPayout, round2, normalizePhone } = require("../utils/cookEarnings");
const {
  ensureReferralCode,
  ensureBookingPayoutSnapshot,
  refreshIncentiveEligibility,
  countVerifiedBookings,
  referralLinkFor,
  notifyCook,
  audit,
} = require("../utils/cookEarningsService");

const dayBoundsIST = (d) => {
  const dstr = new Date(d).toISOString().slice(0, 10);
  return { day: dstr };
};
const startOfWeekMonday = (now = new Date()) => {
  const d = new Date(now);
  const day = (d.getDay() + 6) % 7; // Monday=0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
};

// GET /api/cook/earnings — overview + per-booking rows (§4).
exports.getEarnings = async (req, res, next) => {
  try {
    const cookId = req.user.id;
    const rows = await Booking.find({
      cook: cookId,
      "payment.status": "paid",
      "payment.testMode": { $ne: true },
      status: { $in: ["confirmed", "in_progress", "completed", "cancelled"] },
    })
      .populate("customer", "name")
      .sort({ createdAt: -1 })
      .lean();
    // Backfill missing snapshots (write-once; historical never recomputed).
    for (const b of rows || []) {
      if (!(b?.payoutInfo?.finalCustomerPrice > 0)) {
        try {
          await ensureBookingPayoutSnapshot(b);
        } catch {
          // non-fatal
        }
      }
    }
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    void dayBoundsIST;
    const weekStart = startOfWeekMonday(now);
    let today = 0;
    let week = 0;
    let pending = 0;
    let paid = 0;
    let lifetime = 0;
    const bookingEarnings = (rows || []).map((b) => {
      const snap =
        b.payoutInfo?.finalCustomerPrice > 0
          ? b.payoutInfo
          : (() => {
              const s = computeCookPayout(b.amount || 0);
              return {
                finalCustomerPrice: s.finalCustomerPrice,
                platformDeductionPercent: s.platformDeductionPercent,
                platformDeductionAmount: s.platformDeductionAmount,
                cookPayoutAmount: s.cookPayoutAmount,
                payoutStatus: "eligible",
              };
            })();
      const payout = Number(snap.cookPayoutAmount || b.cookPayout || 0);
      const settled = b.payout?.status === "settled" || snap.payoutStatus === "paid";
      const liveRefund =
        b.payment?.refundStatus && !["none", "rejected"].includes(b.payment.refundStatus);
      const payableRow =
        b.status === "completed" && !liveRefund && !settled && payout > 0;
      if (b.status === "completed" && !liveRefund) {
        lifetime += payout;
        if (settled) paid += payout;
        else pending += payout;
        const createdDay = new Date(b.updatedAt || b.createdAt).toISOString().slice(0, 10);
        if (createdDay === todayStr) today += payout;
        if (new Date(b.updatedAt || b.createdAt) >= weekStart) week += payout;
      }
      return {
        _id: b._id,
        bookingId: b._id,
        customer: b.customer?.name || "Customer",
        date: b.date,
        duration: b.durationHours,
        finalCustomerPrice: Number(snap.finalCustomerPrice ?? b.amount ?? 0),
        platformDeduction: Number(snap.platformDeductionAmount ?? 0),
        cookPayout: payout,
        payoutStatus:
          settled
            ? "paid"
            : liveRefund
              ? "held"
              : b.status !== "completed"
                ? "not_eligible"
                : String(snap.payoutStatus || "pending_weekly").replace("eligible", "pending_weekly"),
      };
    });
    // Bonuses: approved/paid incentives + referrals (server records only).
    const incentives = await CookIncentive.find({ cook: cookId, status: { $in: ["approved", "paid"] } })
      .select("reward status")
      .lean();
    const referrals = await CookReferral.find({ referrer: cookId, status: { $in: ["approved", "paid"] } })
      .select("reward status")
      .lean();
    const bonuses =
      (incentives || []).reduce((s, i) => s + Number(i.reward || 0), 0) +
      (referrals || []).reduce((s, r) => s + Number(r.reward || 0), 0);
    res.json({
      overview: {
        today: round2(today),
        thisWeek: round2(week),
        pending: round2(pending),
        paid: round2(paid),
        lifetime: round2(lifetime),
        bonuses: round2(bonuses),
      },
      bookings: bookingEarnings,
    });
  } catch (e) {
    next(e);
  }
};

// GET /api/cook/payouts — weekly payout cycles (§5).
exports.getPayouts = async (req, res, next) => {
  try {
    const cycles = await CookPayout.find({ cook: req.user.id })
      .sort({ weekStart: -1 })
      .lean();
    res.json(cycles);
  } catch (e) {
    next(e);
  }
};

exports.getPayoutById = async (req, res, next) => {
  try {
    const c = await CookPayout.findOne({ _id: req.params.id, cook: req.user.id })
      .populate("bookings", "date amount durationHours status customer")
      .lean();
    if (!c) return res.status(404).json({ message: "Payout not found" });
    res.json(c);
  } catch (e) {
    next(e);
  }
};

// GET /api/cook/incentives + /progress — server-computed (§8/§9).
exports.getIncentives = async (req, res, next) => {
  try {
    const list = await refreshIncentiveEligibility(req.user.id);
    const slabs = [
      { leads: 10, reward: 500 },
      { leads: 20, reward: 1000 },
      { leads: 30, reward: 1500 },
      { leads: 50, reward: 2500 },
    ];
    res.json({ incentives: list, slabs });
  } catch (e) {
    next(e);
  }
};

exports.getIncentiveProgress = async (req, res, next) => {
  try {
    const list = await refreshIncentiveEligibility(req.user.id);
    res.json(
      (list || []).map((i) => ({
        code: i.code,
        target: i.target,
        verifiedLeadCount: i.verifiedLeadCount,
        remaining: Math.max(0, i.target - i.verifiedLeadCount),
        startDate: i.startDate,
        endDate: i.endDate,
        deadline: i.endDate,
        status: i.status,
        eligible: i.eligible,
        reward: i.reward,
        approvedAt: i.approvedAt || null,
        paidAt: i.paidAt || null,
      }))
    );
  } catch (e) {
    next(e);
  }
};

const LEAD_SERVICES = ["cook_for_me", "cook_with_me", "teach_me", "preparation_help", "other"];

// POST /api/cook/leads (§7).
exports.createLead = async (req, res, next) => {
  try {
    const cookId = req.user.id;
    const customerName = String(req.body?.customerName || req.body?.name || "").trim().slice(0, 80);
    const mobileRaw = String(req.body?.mobileNumber || req.body?.mobile || req.body?.phone || "").trim();
    const location = String(req.body?.location || "").trim().slice(0, 120);
    const requiredService = LEAD_SERVICES.includes(req.body?.requiredService)
      ? req.body.requiredService
      : "other";
    if (!customerName) return res.status(400).json({ message: "Customer name is required" });
    if (!location) return res.status(400).json({ message: "Location is required" });
    const normalized = normalizePhone(mobileRaw);
    if (!normalized) return res.status(400).json({ message: "Enter a valid 10-digit mobile number" });
    // Fraud guard (§15): same phone already claimed by ANY cook (verified or
    // pending) cannot be claimed again; same cook+phone unique index backs this.
    const clash = await CookLead.findOne({ normalizedPhone: normalized })
      .select("cook status")
      .lean();
    if (clash) {
      if (String(clash.cook) === String(cookId)) {
        return res.status(409).json({ message: "You have already submitted this customer lead", code: "DUPLICATE_LEAD" });
      }
      return res.status(409).json({ message: "This customer was already referred by another cook", code: "LEAD_ALREADY_CLAIMED" });
    }
    const idem = String(req.body?.idempotencyKey || req.body?.clientKey || "").trim().slice(0, 120);
    let lead;
    try {
      lead = await CookLead.create({
        cook: cookId,
        customerName,
        mobileNumber: normalized,
        normalizedPhone: normalized,
        location,
        requiredService,
        preferredDate: req.body?.preferredDate ? new Date(req.body.preferredDate) : undefined,
        preferredDuration: req.body?.preferredDuration ? Number(req.body.preferredDuration) : undefined,
        notes: String(req.body?.notes || "").trim().slice(0, 500),
        submittedBy: cookId,
        status: "submitted",
        verificationStatus: "pending",
        ...(idem ? { idempotencyKey: `${cookId}:${idem}` } : {}),
      });
    } catch (e) {
      if (e?.code === 11000) {
        return res.status(409).json({ message: "This lead was already submitted — please refresh", code: "DUPLICATE_LEAD" });
      }
      throw e;
    }
    await audit({ actor: cookId, actorRole: "COOK", event: "lead_created", cook: cookId, refId: lead._id, refModel: "CookLead", detail: `${customerName} ${normalized}` });
    await notifyCook({ cookId, type: "lead_submitted", message: `Lead for ${customerName} submitted — our team will verify it shortly.`, link: "/cook/earnings" });
    res.status(201).json(lead);
  } catch (e) {
    next(e);
  }
};

exports.listLeads = async (req, res, next) => {
  try {
    const leads = await CookLead.find({ cook: req.user.id }).sort({ createdAt: -1 }).lean();
    res.json(leads);
  } catch (e) {
    next(e);
  }
};

exports.getLead = async (req, res, next) => {
  try {
    const lead = await CookLead.findOne({ _id: req.params.id, cook: req.user.id }).lean();
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    res.json(lead);
  } catch (e) {
    next(e);
  }
};

// GET /api/cook/referral — code, link, stats (§12/§17).
exports.getReferralInfo = async (req, res, next) => {
  try {
    const me = await User.findById(req.user.id).select("name").lean();
    const profile = await ensureReferralCode(req.user.id, me?.name);
    const referrals = await CookReferral.find({ referrer: req.user.id })
      .populate("referredCook", "name")
      .sort({ createdAt: -1 })
      .lean();
    // Live verified-booking counts (server-computed).
    for (const r of referrals) {
      try {
        r.liveVerifiedBookings = await countVerifiedBookings(r.referredCook?._id || r.referredCook);
      } catch {
        r.liveVerifiedBookings = r.verifiedBookings;
      }
    }
    const successful = (referrals || []).filter((r) => ["approved", "paid"].includes(r.status)).length;
    res.json({
      referralCode: profile?.referralCode || "",
      referralLink: profile?.referralCode ? referralLinkFor(profile.referralCode) : "",
      totalReferrals: (referrals || []).length,
      totalSuccessfulReferrals: successful,
      reward: cfg.referralReward,
      bookingTarget: cfg.referralBookingTarget,
      referrals,
    });
  } catch (e) {
    next(e);
  }
};

exports.listReferrals = async (req, res, next) => {
  try {
    const referrals = await CookReferral.find({ referrer: req.user.id })
      .populate("referredCook", "name")
      .sort({ createdAt: -1 })
      .lean();
    for (const r of referrals) {
      try {
        r.liveVerifiedBookings = await countVerifiedBookings(r.referredCook?._id || r.referredCook);
      } catch {
        r.liveVerifiedBookings = r.verifiedBookings;
      }
    }
    res.json(referrals);
  } catch (e) {
    next(e);
  }
};

// POST /api/cook/referral/regenerate — allowed only before any referral exists
// (ownership can never change after the first claim, §12).
exports.regenerateReferral = async (req, res, next) => {
  try {
    const used = await CookReferral.countDocuments({ referrer: req.user.id });
    if (used > 0) {
      return res.status(400).json({ message: "Referral code cannot be changed after it has been used" });
    }
    const me = await User.findById(req.user.id).select("name").lean();
    const code = generateReferralCode(me?.name || "COOK");
    try {
      await CookProfile.updateOne({ user: req.user.id }, { $set: { referralCode: code } });
    } catch (e) {
      if (e?.code === 11000) return res.status(409).json({ message: "Please try again" });
      throw e;
    }
    res.json({ referralCode: code, referralLink: referralLinkFor(code) });
  } catch (e) {
    next(e);
  }
};
