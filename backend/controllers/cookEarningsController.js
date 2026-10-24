
const Booking = require("../models/Booking");
const CookPayout = require("../models/CookPayout");
const cfg = require("../config/cookEarnings");
const { computeCookPayout, toPaise, fromPaise } = require("../utils/cookEarnings");
const {
  ensureBookingPayoutSnapshot,
} = require("../utils/cookEarningsService");

const { istDayString, istMidnight, istWeekday } = require("../utils/time");
// IST Monday 00:00 as an instant (business week, matching istDayString).
const startOfWeekMondayIST = (now = new Date()) => {
  const midnight = istMidnight(now);
  if (!midnight) return null;
  const daysBack = (istWeekday(now) + 6) % 7; // Monday=0
  return new Date(midnight.getTime() - daysBack * 24 * 60 * 60 * 1000);
};

exports.getEarnings = async (req, res, next) => {
  try {
    const cookId = req.user.id;
    // Bound the response for cooks with very long histories. Totals are
    // computed over the same bounded window; totalBookings + truncated tell
    // the client when older history exists beyond this response.
    const limit = Math.min(
      Math.max(Number(req.query?.limit) || 500, 1),
      1000
    );
    const totalBookings = await Booking.countDocuments({
      cook: cookId,
      "payment.status": "paid",
      "payment.testMode": { $ne: true },
      status: { $in: ["confirmed", "in_progress", "completed", "cancelled"] },
    });
    const rows = await Booking.find({
      cook: cookId,
      "payment.status": "paid",
      "payment.testMode": { $ne: true },
      status: { $in: ["confirmed", "in_progress", "completed", "cancelled"] },
    })
      .populate("customer", "name")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    for (let i = 0; i < (rows || []).length; i += 1) {
      const b = rows[i];
      if (!(b?.payoutInfo?.finalCustomerPrice > 0)) {
        try {
          // Use the persisted snapshot immediately so per-row payout
          // statuses (approved/held/paid) are current on this same load
          // instead of lagging one refresh behind the database write.
          const updated = await ensureBookingPayoutSnapshot(b);
          if (updated && updated._id) {
            rows[i] = typeof updated.toObject === "function" ? updated.toObject() : updated;
          }
        } catch {
        }
      }
    }
    const now = new Date();
    const todayStr = istDayString(now);
    const weekStart = startOfWeekMondayIST(now);
    // Integer-paise accumulators (see utils/cookEarnings toPaise/fromPaise).
    let todayP = 0;
    let weekP = 0;
    let pendingP = 0;
    let paidP = 0;
    let lifetimeP = 0;
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
      // An unresolved financial dispute holds the row out of earned totals,
      // matching payoutEligibleForCycle / cycle construction.
      const disputed = Boolean(b.payoutInfo?.disputed || b.payoutInfo?.underVerification);
      if (b.status === "completed" && !liveRefund && !disputed) {
        const payoutP = toPaise(payout);
        lifetimeP += payoutP;
        if (settled) paidP += payoutP;
        else pendingP += payoutP;
        // Bucket by immutable service date (IST calendar), never by
        // updatedAt: admin approvals, holds and read-side snapshot writes
        // all bump updatedAt, which previously dragged old bookings into
        // "today"/"this week" on every refresh.
        const stamp = b.date || b.createdAt;
        const createdDay = stamp ? istDayString(stamp) : null;
        if (createdDay && createdDay === todayStr) todayP += payoutP;
        if (stamp && weekStart && new Date(stamp) >= weekStart) weekP += payoutP;
      }
      return {
        _id: b._id,
        bookingId: b._id,
        customer: b.customer?.name || "Customer",
        date: b.date,
        duration: b.durationHours,
        finalCustomerPrice: Number(snap.finalCustomerPrice ?? b.amount ?? 0),
        platformDeduction: Number(snap.platformDeductionAmount ?? 0),
        platformDeductionPercent: Number(
          snap.platformDeductionPercent ?? cfg.deductionPercentage
        ),
        cookPayout: payout,
        payoutStatus:
          settled
            ? "paid"
            : liveRefund || disputed
              ? "held"
              : b.status !== "completed"
                ? "not_eligible"
                : String(snap.payoutStatus || "pending_weekly").replace("eligible", "pending_weekly"),
      };
    });
    res.json({
      overview: {
        today: fromPaise(todayP),
        thisWeek: fromPaise(weekP),
        pending: fromPaise(pendingP),
        paid: fromPaise(paidP),
        lifetime: fromPaise(lifetimeP),
      },
      bookings: bookingEarnings,
      totalBookings,
      truncated: totalBookings > bookingEarnings.length,
    });
  } catch (e) {
    next(e);
  }
};

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
