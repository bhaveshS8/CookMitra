
const crypto = require("crypto");
const Booking = require("../models/Booking");
const CookPayout = require("../models/CookPayout");
const CookEventLog = require("../models/CookEventLog");
const { paginationParams, applyPagination, sendList } = require("../utils/pagination");
const { computeCookPayout, round2, toPaise, fromPaise } = require("../utils/cookEarnings");
const {
  audit,
  notifyCook,
} = require("../utils/cookEarningsService");

// NOTE: lead, incentive, and referral programs were removed in full
// (models, routes, handlers, and UI deleted). This controller now manages
// weekly payout cycles only. Historical audit rows keep their old event
// names; see CookEventLog.

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
    // never server-local midnight. The stored weekStart is always the
    // Monday 00:00 IST instant so weekly tabs group cycles deterministically
    // no matter which weekday the caller passed.
    let weekStart = req.body?.weekStart ? new Date(req.body.weekStart) : weekMondayIST(new Date());
    let weekEnd = req.body?.weekEnd
      ? new Date(req.body.weekEnd)
      : new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(weekStart.getTime()) || Number.isNaN(weekEnd.getTime())) {
      return res.status(400).json({ message: "Valid weekStart/weekEnd dates are required" });
    }
    try {
      const { parseWeekStartIST } = require("../utils/weeklyPayouts");
      weekStart = parseWeekStartIST(weekStart) || weekStart;
    } catch {
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
    // The pre-receipt /pay endpoint never recorded amounts: persist the
    // full payable + settler so weekly tabs and audits reconcile exactly
    // like receipt-based settlements. Totals are immutable since build.
    set.settledBy = adminId;
    try {
      const pre = await CookPayout.findById(id).select("totalPayable settledAmount").lean();
      const full = round2(pre?.totalPayable ?? 0);
      if (full > 0 && !(Number(pre?.settledAmount) > 0)) set.settledAmount = full;
    } catch {
    }
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
      // Backfill settledAmount for ambiguous cycles paid before the field
      // existed: a paid cycle is fully paid by definition.
      const current = await CookPayout.findById(req.params.id).select("totalPayable settledAmount").lean();
      const backfill = current && !(Number(current.settledAmount) > 0) && Number(current.totalPayable) > 0
        ? { settledAmount: round2(current.totalPayable) }
        : {};
      updated = await CookPayout.findOneAndUpdate(
        {
          _id: req.params.id,
          status: "paid",
          $or: [{ paymentReference: "" }, { paymentReference: { $exists: false } }],
        },
        { $set: { paymentReference: reference, ...backfill } },
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
