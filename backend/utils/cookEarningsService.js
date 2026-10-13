
const Booking = require("../models/Booking");
const CookEventLog = require("../models/CookEventLog");
const Notification = require("../models/Notification");
const {
  computeCookPayout,
  round2,
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
  // The lead/incentive/referral notice types below are retained so any
  // historical re-send still stays suppressed (those programs are removed,
  // but old notifications may still be re-queued by ops tooling).
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
    // Atomic read-side snapshot: the payoutStatus / payoutEligibleAt fields
    // use the DATABASE's current values ($ifNull) rather than this request's
    // possibly-stale in-memory copy, so a concurrent admin approve/hold/pay
    // can never be rolled back to "eligible" by a cook refreshing My Earnings.
    // Financial fields are deterministic from the immutable booking amount.
    const updated = await Booking.findOneAndUpdate(
      {
        _id: booking._id,
        $or: [
          { "payoutInfo.finalCustomerPrice": { $exists: false } },
          { "payoutInfo.finalCustomerPrice": 0 },
          { "payoutInfo.cookPayoutAmount": 0 },
        ],
      },
      [
        {
          $set: {
            "payoutInfo.regularPrice": regular,
            "payoutInfo.discountAmount": discount,
            "payoutInfo.finalCustomerPrice": split.finalCustomerPrice,
            "payoutInfo.platformDeductionPercent": split.platformDeductionPercent,
            "payoutInfo.platformDeductionAmount": split.platformDeductionAmount,
            "payoutInfo.cookPayoutAmount": split.cookPayoutAmount,
            "payoutInfo.payoutStatus": { $ifNull: ["$payoutInfo.payoutStatus", "eligible"] },
            "payoutInfo.payoutEligibleAt": { $ifNull: ["$payoutInfo.payoutEligibleAt", new Date()] },
          },
        },
      ],
      { new: true }
    );
    return updated || booking;
  } catch (e) {
    try {
      console.error(`ensureBookingPayoutSnapshot failed for booking ${booking?._id}:`, e?.message || e);
    } catch {
    }
    return booking;
  }
};

module.exports = {
  audit,
  notifyCook,
  ensureBookingPayoutSnapshot,
};
