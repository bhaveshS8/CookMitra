
const Booking = require("../models/Booking");
const CookProfile = require("../models/CookProfile");
const CookLead = require("../models/CookLead");
const CookIncentive = require("../models/CookIncentive");
const CookReferral = require("../models/CookReferral");
const CookEventLog = require("../models/CookEventLog");
const Notification = require("../models/Notification");
const cfg = require("../config/cookEarnings");
const {
  computeCookPayout,
  round2,
  normalizePhone,
  generateReferralCode,
  referralLinkFor,
} = require("./cookEarnings");

const audit = async ({ actor, actorRole, event, cook, refId, refModel, detail }) => {
  try {
    await CookEventLog.create({ actor, actorRole, event, cook, refId, refModel, detail });
  } catch {
  }
};

const notifyCook = async ({ cookId, type, message, booking, link, whatsapp }) => {
  try {
    await Notification.create({ user: cookId, type, message, booking: booking || null, link: link || "" });
  } catch {
  }
  // These notices stay in-app only — never push them to the cook's
  // WhatsApp (admin decision: cooks check the earnings screen; WhatsApp
  // is reserved for time-sensitive booking ops + payouts).
  // Pass { whatsapp: true } explicitly to override for a specific call.
  // Suppressed: rejections (spam-safe) + the info-only earnings updates
  // the admin opted out of: lead_submitted, lead_verified,
  // incentive_qualified, incentive_approved, incentive_held,
  // referral_approved.
  if (whatsapp === false) return;
  if (whatsapp !== true) {
    if (
      type === "incentive_rejected" ||
      type === "lead_rejected" ||
      type === "lead_submitted" ||
      type === "lead_verified" ||
      type === "incentive_qualified" ||
      type === "incentive_approved" ||
      type === "incentive_held" ||
      type === "referral_approved"
    )
      return;
  }
  try {
    const { sendWhatsAppText } = require("./whatsappApi");
    const User = require("../models/User");
    const u = await User.findById(cookId).select("phone mobile").lean();
    const phone = u?.phone || u?.mobile;
    if (phone) await sendWhatsAppText(phone, `Cook Mitra: ${message}`);
  } catch {
  }
};

const ensureReferralCode = async (cookUserId, cookName) => {
  let profile = await CookProfile.findOne({ user: cookUserId });
  if (!profile) return null;
  if (profile.referralCode) return profile;
  for (let i = 0; i < 3; i++) {
    const code = generateReferralCode(cookName || "COOK");
    try {
      profile = await CookProfile.findOneAndUpdate(
        { user: cookUserId, $or: [{ referralCode: "" }, { referralCode: { $exists: false } }] },
        { $set: { referralCode: code } },
        { new: true }
      );
      if (profile?.referralCode) return profile;
      const fresh = await CookProfile.findOne({ user: cookUserId });
      if (fresh?.referralCode) return fresh;
    } catch (e) {
      if (e?.code !== 11000) throw e;
    }
  }
  return CookProfile.findOne({ user: cookUserId });
};

const ensureBookingPayoutSnapshot = async (booking) => {
  if (!booking) return booking;
  if (booking.payoutInfo?.finalCustomerPrice > 0 && booking.payoutInfo?.cookPayoutAmount > 0) {
    return booking;
  }
  const regular = round2(booking.slabPrice ?? booking.amount ?? 0);
  const discount = round2(booking.discount ?? 0);
  const final = round2(booking.amount ?? Math.max(0, regular - discount));
  if (!(final > 0)) return booking;
  const split = computeCookPayout(final);
  try {
    const updated = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        $or: [
          { "payoutInfo.finalCustomerPrice": { $exists: false } },
          { "payoutInfo.finalCustomerPrice": 0 },
          { "payoutInfo.cookPayoutAmount": 0 },
        ],
      },
      {
        $set: {
          "payoutInfo.regularPrice": regular,
          "payoutInfo.discountAmount": discount,
          "payoutInfo.finalCustomerPrice": split.finalCustomerPrice,
          "payoutInfo.platformDeductionPercent": split.platformDeductionPercent,
          "payoutInfo.platformDeductionAmount": split.platformDeductionAmount,
          "payoutInfo.cookPayoutAmount": split.cookPayoutAmount,
          "payoutInfo.payoutStatus": booking?.payoutInfo?.payoutStatus || "eligible",
          "payoutInfo.payoutEligibleAt": booking?.payoutInfo?.payoutEligibleAt || new Date(),
        },
      },
      { new: true }
    );
    return updated || booking;
  } catch {
    return booking;
  }
};

const countVerifiedBookings = async (cookUserId) =>
  Booking.countDocuments({
    cook: cookUserId,
    status: "completed",
    "payment.status": "paid",
    "payment.testMode": { $ne: true },
    cookArrived: true,
    serviceStartedAt: { $exists: true, $ne: null },
  });

const ensureIncentives = async (cookUserId) => {
  const profile = await CookProfile.findOne({ user: cookUserId });
  let start = profile?.incentiveEnrolledAt || profile?.createdAt || new Date();
  if (!profile?.incentiveEnrolledAt && profile) {
    try {
      await CookProfile.updateOne(
        { user: cookUserId, incentiveEnrolledAt: { $exists: false } },
        { $set: { incentiveEnrolledAt: start } }
      );
    } catch {
    }
  }
  const existing = await CookIncentive.find({ cook: cookUserId }).select("code").lean();
  const have = new Set((existing || []).map((e) => e.code));
  const missing = cfg.incentives.filter((i) => !have.has(i.code));
  for (const inc of missing) {
    const startDate = new Date(start);
    const endDate = new Date(startDate.getTime() + inc.days * 24 * 60 * 60 * 1000);
    try {
      await CookIncentive.create({
        cook: cookUserId,
        code: inc.code,
        target: inc.targetLeads,
        timeLimitDays: inc.days,
        reward: inc.reward,
        startDate,
        endDate,
        cumulative: cfg.cumulative,
        idempotencyKey: `inc:${cookUserId}:${inc.code}`,
      });
    } catch (e) {
      if (e?.code !== 11000) throw e;
    }
  }
  return CookIncentive.find({ cook: cookUserId }).sort({ target: 1 }).lean();
};

const countVerifiedLeadsInWindow = async (cookUserId, startDate, endDate) =>
  CookLead.countDocuments({
    cook: cookUserId,
    status: "verified",
    verificationStatus: "verified",
    verifiedAt: { $gte: startDate, $lte: endDate },
  });

const refreshIncentiveEligibility = async (cookUserId, now = new Date()) => {
  const incentives = await ensureIncentives(cookUserId);
  const out = [];
  for (const inc of incentives) {
    const verifiedLeadCount = await countVerifiedLeadsInWindow(inc.cook, inc.startDate, inc.endDate);
    const expired = now > new Date(inc.endDate);
    const eligible = verifiedLeadCount >= inc.target && !expired;
    let status = inc.status;
    if (["approved", "paid", "rejected", "held"].includes(status)) {
      out.push({ ...inc, verifiedLeadCount, eligible });
      continue; // terminal-ish states are admin-managed
    }
    if (eligible && status === "in_progress") status = "qualified";
    else if (expired && status === "in_progress" && verifiedLeadCount < inc.target) status = "expired";
    else if (!eligible && status === "qualified") status = "in_progress";
    const update = { verifiedLeadCount, eligible };
    if (status !== inc.status) update.status = status;
    try {
      await CookIncentive.updateOne({ _id: inc._id }, { $set: update });
    } catch {
    }
    if (eligible && inc.status === "in_progress") {
      await audit({
        event: "incentive_qualified",
        cook: cookUserId,
        refId: inc._id,
        refModel: "CookIncentive",
        detail: `${inc.code} qualified with ${verifiedLeadCount}/${inc.target} verified leads`,
      });
      await notifyCook({
        cookId: cookUserId,
        type: "incentive_qualified",
        message: `Incentive target reached: ${verifiedLeadCount}/${inc.target} verified leads (${inc.code}, ₹${inc.reward}). Awaiting admin approval.`,
        link: "/cook/earnings",
        whatsapp: false,
      });
    }
    out.push({ ...inc, verifiedLeadCount, eligible, status });
  }
  return out;
};

module.exports = {
  audit,
  notifyCook,
  ensureReferralCode,
  ensureBookingPayoutSnapshot,
  countVerifiedBookings,
  ensureIncentives,
  countVerifiedLeadsInWindow,
  refreshIncentiveEligibility,
  referralLinkFor,
  normalizePhone,
};
