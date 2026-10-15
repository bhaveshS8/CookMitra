// Weekly Cook Payout Management (admin): Monday–Sunday earning weeks in the
// business timezone, settled with mandatory receipt evidence.
//
// Money model (unchanged from the existing weekly-cycle flow):
// - CookPayout is the persistent per-cook-per-week record. Totals are
//   server-computed at build time from booking snapshots in paise; the
//   browser NEVER supplies amounts, cook IDs beyond the cycle id, or payment
//   status — settle only flips a server-loaded cycle through a status-guarded
//   atomic update.
// - The earning week (weekStart/weekEnd) is immutable: settling later never
//   moves a payment to another week. Completed history is always grouped by
//   earning week, never by settlement timestamp.
// - No partial payments exist in the current rules: a settlement always pays
//   the full remaining balance (settledAmount = totalPayable on success).
const fs = require("fs");
const path = require("path");
const Booking = require("../models/Booking");
const CookPayout = require("../models/CookPayout");
const { isValidPayoutReference } = require("../utils/finance");
const { round2 } = require("../utils/cookEarnings");
const { audit, notifyCook } = require("../utils/cookEarningsService");
const {
  weekRangeIST,
  weekKeyIST,
  formatWeekLabel,
} = require("../utils/weeklyPayouts");

const PENDING_STATUSES = ["pending", "under_verification", "approved"];
const PAYMENT_METHODS = ["upi", "bank_transfer", "other"];

const unlinkQuiet = (p) => {
  try {
    if (p) fs.unlinkSync(p);
  } catch {
  }
};

// Same guarded-transaction helper as the cycle controller: a real
// multi-document transaction when the deployment supports it (replica set),
// otherwise the same status-guarded conditional updates without a session.
// Either way concurrent settlements race on ONE atomic document update and
// exactly one wins.
const withFinancialTransaction = async (fn) => {
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

const serializeCycle = (cycle) => {
  const c = cycle?.toObject ? cycle.toObject() : cycle || {};
  const totalPayable = round2(c.totalPayable ?? 0);
  // Legacy cycles paid through the pre-receipt /pay endpoint carry
  // settledAmount 0 (the field did not exist there): a paid cycle with no
  // recorded partial amount is fully paid by definition.
  const settledAmount = round2(c.settledAmount || (c.status === "paid" ? totalPayable : 0));
  return {
    ...c,
    totalPayable,
    settledAmount,
    remainingPayable: c.status === "paid" ? 0 : round2(Math.max(0, totalPayable - settledAmount)),
    week: {
      start: c.weekStart,
      end: c.weekEnd,
      key: (() => {
        try {
          return weekKeyIST(c.weekStart);
        } catch {
          return null;
        }
      })(),
      label: (() => {
        try {
          return formatWeekLabel(c.weekStart);
        } catch {
          return "";
        }
      })(),
    },
  };
};

const summarize = (cycles) => {
  let totalPayableP = 0;
  let settledP = 0;
  let bookings = 0;
  const cooks = new Set();
  for (const c of cycles || []) {
    totalPayableP += Math.round(Number(c.totalPayable || 0) * 100);
    // Match serializeCycle: a paid cycle with no recorded settledAmount
    // (paid via the pre-receipt /pay endpoint) is fully paid by definition.
    const settledVal =
      Number(c.settledAmount) > 0
        ? Number(c.settledAmount)
        : c.status === "paid"
          ? Number(c.totalPayable || 0)
          : 0;
    settledP += Math.round(settledVal * 100);
    bookings += Number(c.bookingCount || 0);
    if (c.cook?._id || c.cook) cooks.add(String(c.cook?._id || c.cook));
  }
  const totalPayable = Math.round(totalPayableP) / 100;
  const settled = Math.round(settledP) / 100;
  return {
    totalPayable,
    settled,
    remaining: round2(Math.max(0, totalPayable - settled)),
    cookCount: cooks.size,
    cycleCount: (cycles || []).length,
    bookingCount: bookings,
  };
};

const resolveWeek = (req, res) => {
  const raw = req.query?.weekStart ?? req.query?.week;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const range = weekRangeIST(raw);
    if (!range) {
      res.status(400).json({ message: "Valid weekStart date is required (YYYY-MM-DD)", code: "INVALID_WEEK" });
      return null;
    }
    return range;
  }
  return weekRangeIST(new Date());
};

const queryWeekCycles = async ({ range, statuses, sort }) => {
  const cycles = await CookPayout.find({
    weekStart: { $gte: range.weekStart, $lte: range.weekEnd },
    status: { $in: statuses },
  })
    .sort(sort)
    .populate("cook", "name phone")
    .populate("settledBy", "name")
    .lean();
  return cycles;
};

// GET /api/admin/cook-payouts/weekly/pending?weekStart=YYYY-MM-DD
// Cooks with outstanding eligible balances for the selected earning week.
exports.getWeeklyPending = async (req, res, next) => {
  try {
    const range = resolveWeek(req, res);
    if (!range) return;
    const cycles = await queryWeekCycles({
      range,
      statuses: PENDING_STATUSES,
      sort: { weekStart: 1, totalPayable: -1 },
    });
    res.json({
      week: { start: range.weekStart, end: range.weekEnd, label: formatWeekLabel(range.weekStart) },
      totals: summarize(cycles),
      records: cycles.map(serializeCycle),
    });
  } catch (e) {
    next(e);
  }
};

// GET /api/admin/cook-payouts/weekly/completed?weekStart=YYYY-MM-DD
// Settled payouts for the selected EARNING week (grouped by earning week,
// never re-bucketed by settlement timestamp).
exports.getWeeklyCompleted = async (req, res, next) => {
  try {
    const range = resolveWeek(req, res);
    if (!range) return;
    const cycles = await queryWeekCycles({
      range,
      statuses: ["paid"],
      sort: { paidAt: -1, paymentDate: -1, _id: -1 },
    });
    const totals = summarize(cycles);
    res.json({
      week: { start: range.weekStart, end: range.weekEnd, label: formatWeekLabel(range.weekStart) },
      totals: { ...totals, totalPaid: totals.settled },
      records: cycles.map(serializeCycle),
    });
  } catch (e) {
    next(e);
  }
};

// POST /api/admin/cook-payouts/payouts/:id/settle-weekly (multipart)
// Fields: paymentMethod (upi|bank_transfer|other, required),
// reference (required, unique transfer id), receipt (required photo file).
//
// Ordering guarantee: the proof file is already on disk (multer) before this
// runs; the cycle flips to paid ONLY inside the guarded atomic update. Any
// failure deletes the just-uploaded file and returns an error — the pending
// balance is never lost and success is never reported falsely.
exports.settleWeeklyPayout = async (req, res, next) => {
  const uploadedPath = req.file?.path || null;
  const fail = (status, message, code) => {
    unlinkQuiet(uploadedPath);
    return res.status(status).json({ message, ...(code ? { code } : {}) });
  };
  try {
    const paymentMethod = String(req.body?.paymentMethod || "").trim().toLowerCase();
    const reference = String(req.body?.reference || req.body?.paymentReference || "").trim();
    if (!PAYMENT_METHODS.includes(paymentMethod)) {
      return fail(400, "Choose a payment method: UPI, bank transfer, or other", "INVALID_PAYMENT_METHOD");
    }
    if (!isValidPayoutReference(reference)) {
      return fail(
        400,
        "Enter a valid transaction/reference ID (4–120 characters: letters, digits, spaces and . - _ /)",
        "INVALID_REFERENCE"
      );
    }
    if (!req.file) {
      return fail(400, "A receipt/proof photo is required to settle a payout", "RECEIPT_REQUIRED");
    }

    const cycle = await CookPayout.findById(req.params.id);
    if (!cycle) {
      return fail(404, "Payout not found", "PAYOUT_NOT_FOUND");
    }
    if (cycle.status === "paid") {
      // Idempotent replay: already settled — drop the duplicate upload and
      // report the existing settlement, never a second payment.
      unlinkQuiet(uploadedPath);
      const current = await CookPayout.findById(cycle._id)
        .populate("cook", "name phone")
        .populate("settledBy", "name")
        .lean();
      return res.json({ ...serializeCycle(current), alreadySettled: true });
    }
    if (!PENDING_STATUSES.includes(cycle.status)) {
      return fail(
        409,
        `This payout is ${cycle.status} — only pending or approved payouts can be settled`,
        "CANNOT_SETTLE_STATUS"
      );
    }

    // Application-level duplicate-reference check (the unique DB index is
    // the final arbiter under races; 11000 below maps to the same 409).
    const dup = await CookPayout.findOne({
      paymentReference: reference,
      status: "paid",
      _id: { $ne: cycle._id },
    }).select("_id");
    if (dup) {
      return fail(
        409,
        "This transaction ID already settled another payout — use the unique UPI/bank transaction ID",
        "DUPLICATE_PAYOUT_REFERENCE"
      );
    }

    // Server-side verification (never trust the browser): the cycle's
    // bookings must not have been settled through the per-booking rail.
    const ownedIds = (cycle.bookings || []).map(String);
    if (ownedIds.length) {
      const settledElsewhere = await Booking.countDocuments({
        _id: { $in: cycle.bookings },
        "payout.status": "settled",
      });
      if (settledElsewhere > 0) {
        return fail(
          409,
          "Some bookings in this cycle were settled individually — refresh and rebuild the cycle before settling",
          "BOOKINGS_SETTLED_ELSEWHERE"
        );
      }
    }

    const receiptUrl = `/uploads/cook-docs/${path.basename(uploadedPath)}`;
    const now = new Date();
    const startedFrom = cycle.status;
    const amount = round2(cycle.totalPayable ?? 0);
    if (!(amount > 0)) {
      return fail(400, "This payout has no payable amount", "NOTHING_PAYABLE");
    }

    let out;
    try {
      out = await withFinancialTransaction(async (session) => {
        const copts = session ? { session, new: true } : { new: true };
        // Re-check inside the transaction: a legacy per-booking settlement
        // racing between our pre-check and this write must abort the cycle
        // instead of double-paying the same bookings.
        if ((cycle.bookings || []).length) {
          const sopts = session ? { session } : {};
          const raced = await Booking.countDocuments(
            { _id: { $in: cycle.bookings }, "payout.status": "settled" },
            sopts
          );
          if (raced > 0) return { raceElsewhere: true };
        }
        // THE atomic gate: exactly one concurrent settle can move this
        // cycle out of its pending-family status; losers match nothing.
        const updated = await CookPayout.findOneAndUpdate(
          { _id: cycle._id, status: { $in: PENDING_STATUSES } },
          {
            $set: {
              status: "paid",
              paymentMethod,
              paymentReference: reference,
              receiptUrl,
              settledBy: req.user.id,
              settledAmount: amount,
              paidAt: now,
              paymentDate: now,
            },
          },
          copts
        );
        if (!updated) return { miss: true };
        if ((updated.bookings || []).length) {
          const bopts = session ? { session } : {};
          await Booking.updateMany(
            {
              _id: { $in: updated.bookings },
              "payoutInfo.payoutStatus": { $ne: "paid" },
              "payout.status": { $ne: "settled" },
            },
            { $set: { "payoutInfo.payoutStatus": "paid", "payoutInfo.payoutProcessedAt": now } },
            bopts
          );
        }
        return { updated };
      });
    } catch (e) {
      if (e?.code === 11000) {
        return fail(
          409,
          "This transaction ID already settled another payout — use the unique UPI/bank transaction ID",
          "DUPLICATE_PAYOUT_REFERENCE"
        );
      }
      throw e;
    }

    if (out?.miss) {
      const current = await CookPayout.findById(cycle._id).select("status").lean();
      if (current?.status === "paid") {
        unlinkQuiet(uploadedPath);
        const full = await CookPayout.findById(cycle._id)
          .populate("cook", "name phone")
          .populate("settledBy", "name")
          .lean();
        return res.json({ ...serializeCycle(full), alreadySettled: true });
      }
      return fail(409, "This payout is already being settled — please refresh", "SETTLEMENT_RACE_LOST");
    }
    if (out?.raceElsewhere) {
      return fail(
        409,
        "Some bookings in this cycle were settled individually — refresh and rebuild the cycle before settling",
        "BOOKINGS_SETTLED_ELSEWHERE"
      );
    }

    const settled = out.updated;
    const detailBase = `${settled.payoutRef}: ₹${amount} via ${paymentMethod} (ref: ${reference})`;
    try {
      if (startedFrom !== "approved") {
        await audit({
          actor: req.user.id,
          actorRole: "ADMIN",
          event: "payout_approved",
          cook: settled.cook,
          refId: settled._id,
          refModel: "CookPayout",
          detail: `${settled.payoutRef} approved as part of weekly settlement`,
        });
      }
      await audit({
        actor: req.user.id,
        actorRole: "ADMIN",
        event: "payout_paid",
        cook: settled.cook,
        refId: settled._id,
        refModel: "CookPayout",
        detail: `${detailBase} — receipt ${path.basename(uploadedPath)}`,
      });
    } catch {
      // Auditing must never fail a financially-committed settlement; the
      // cycle + bookings are already durably paid.
    }
    try {
      await notifyCook({
        cookId: settled.cook,
        type: "payout_paid",
        message: `Your weekly payout of ₹${amount} was paid (ref: ${reference}).`,
        link: "/cook/earnings",
      });
    } catch {
    }

    const full = await CookPayout.findById(settled._id)
      .populate("cook", "name phone")
      .populate("settledBy", "name")
      .lean();
    res.json(serializeCycle(full));
  } catch (e) {
    // Persistence failed AFTER the proof was stored: remove the orphan file
    // and report the error — never a false success, balance stays pending.
    unlinkQuiet(req.file?.path || uploadedPath);
    next(e);
  }
};
