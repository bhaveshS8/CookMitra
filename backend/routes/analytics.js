const express = require("express");
const router = express.Router();
const { auth, authorize } = require("../middleware/auth");
const Booking = require("../models/Booking");
const {
  KNOWN_STATUSES,
  ACTIVE_STATUSES,
  LOST_STATUSES,
  SETTLED_REFUND_STATUSES,
  TIMEZONE,
  classifyStatus,
  normalizeCity,
  displayCity,
  validateAnalyticsQuery,
  enumerateMonths,
} = require("../utils/analytics");

// Security: auth + authorize("admin") enforced here (frontend hiding is not
// security). ?from/?to/?dateField are strictly validated — no raw Mongo

const ALLOWED_DATE_FIELDS = new Set(["service", "created"]);

const buildScopeMatch = (filter) => {
  // All-time scope (no from/to, only dateField) must match everything.
  // Previously `{ date: { $gte: null, $lt: null } }` matched nothing, so
  // the default "All Time" view (which always sends dateField) showed 0s.
  if (!filter || filter.from == null || filter.toExclusive == null) return {};
  const field = filter.dateField === "created" ? "createdAt" : "date";
  return { [field]: { $gte: filter.from, $lt: filter.toExclusive } };
};

router.get("/bookings", auth, authorize("admin"), async (req, res, next) => {
  try {
    let range = null;
    try {
      const q = {
        from: req.query.from,
        to: req.query.to,
        dateField: req.query.dateField,
      };
      if (
        (q.from == null || String(q.from).trim() === "" || String(q.from) === "all") &&
        (q.to == null || String(q.to).trim() === "" || String(q.to) === "all")
      ) {
        range = null;
      } else {
        range = validateAnalyticsQuery(q);
      }
      if (req.query.dateField != null && String(req.query.dateField).trim() !== "") {
        const f = String(req.query.dateField).trim().toLowerCase();
        if (!ALLOWED_DATE_FIELDS.has(f)) {
          return res.status(400).json({ message: "dateField must be 'service' or 'created'" });
        }
        if (!range) range = { from: null, toExclusive: null, dateField: f };
        else range.dateField = f;
      }
    } catch (e) {
      return res.status(e.status || 400).json({ message: e.message || "Invalid date filter" });
    }

    const scopeMatch = buildScopeMatch(range);
    const hasScope = Object.keys(scopeMatch).length > 0;
    const matchStage = hasScope ? [{ $match: scopeMatch }] : [];

    // Unpaid cancelled bookings are neither shown nor tracked: exclude them
    // from status counts (money facets are already paid-only).
    const visibilityStage = {
      $match: {
        $or: [{ status: { $ne: "cancelled" } }, { status: "cancelled", "payment.status": "paid" }],
      },
    };

    const facetResult = await Booking.aggregate([
      visibilityStage,
      ...matchStage,
      {
        $facet: {
          statusCounts: [
            { $group: { _id: "$status", count: { $sum: 1 } } },
            { $project: { _id: 0, status: "$_id", count: 1 } },
          ],
          money: [
            {
              $match: {
                "payment.status": "paid",
                "payment.testMode": { $ne: true },
              },
            },
            {
              $group: {
                _id: null,
                paidBookings: { $sum: 1 },
                grossCollected: { $sum: { $ifNull: ["$payment.paidAmount", "$amount"] } },
                discounts: { $sum: { $ifNull: ["$discount", 0] } },
                commissionGross: { $sum: { $ifNull: ["$commission", 0] } },
                cookGross: { $sum: { $ifNull: ["$cookPayout", 0] } },
                refunded: {
                  $sum: {
                    $cond: [
                      { $in: ["$payment.refundStatus", SETTLED_REFUND_STATUSES] },
                      { $ifNull: ["$payment.refundAmount", 0] },
                      0,
                    ],
                  },
                },
              },
            },
          ],
          paidPayouts: [
            {
              $match: {
                "payment.status": "paid",
                "payment.testMode": { $ne: true },
                "payout.status": "settled",
              },
            },
            {
              $group: {
                _id: null,
                cookPaid: { $sum: { $ifNull: ["$payout.amount", 0] } },
                settledCount: { $sum: 1 },
              },
            },
          ],
          pendingPayoutEntitlement: [
            {
              $match: {
                status: "completed",
                "payment.status": "paid",
                "payment.testMode": { $ne: true },
                "payout.status": "pending",
                "payment.refundStatus": { $in: ["none", "rejected"] },
              },
            },
            {
              $group: {
                _id: null,
                pendingGross: { $sum: { $ifNull: ["$payment.paidAmount", "$amount"] } },
                pendingCookGross: { $sum: { $ifNull: ["$cookPayout", 0] } },
                pendingCommissionGross: { $sum: { $ifNull: ["$commission", 0] } },
                pendingCount: { $sum: 1 },
              },
            },
          ],
          hours: [
            {
              $group: {
                _id: null,
                scheduledHours: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ["$durationHours", 1] },
                          { $lte: ["$durationHours", 4] },
                        ],
                      },
                      "$durationHours",
                      0,
                    ],
                  },
                },
                scheduledCount: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ["$durationHours", 1] },
                          { $lte: ["$durationHours", 4] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                completedHours: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$status", "completed"] },
                          { $gte: ["$durationHours", 1] },
                          { $lte: ["$durationHours", 4] },
                        ],
                      },
                      "$durationHours",
                      0,
                    ],
                  },
                },
              },
            },
          ],
          areas: [
            {
              $group: {
                _id: {
                  $toLower: {
                    $trim: { input: { $ifNull: ["$addressDetails.city", ""] } },
                  },
                },
                bookings: { $sum: 1 },
                gross: { $sum: { $ifNull: ["$amount", 0] } },
              },
            },
            { $match: { _id: { $ne: "" } } },
            { $sort: { bookings: -1 } },
            { $limit: 8 },
            { $project: { _id: 0, key: "$_id", bookings: 1, gross: 1 } },
          ],
          cooks: [
            {
              $match: {
                cook: { $ne: null },
              },
            },
            {
              $group: {
                _id: "$cook",
                bookings: { $sum: 1 },
                gross: { $sum: { $ifNull: ["$amount", 0] } },
                hours: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ["$durationHours", 1] },
                          { $lte: ["$durationHours", 4] },
                        ],
                      },
                      "$durationHours",
                      0,
                    ],
                  },
                },
                refunded: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $in: ["$payment.refundStatus", SETTLED_REFUND_STATUSES] },
                          { $ne: ["$payment.testMode", true] },
                        ],
                      },
                      { $ifNull: ["$payment.refundAmount", 0] },
                      0,
                    ],
                  },
                },
                paidGross: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$payment.status", "paid"] },
                          { $ne: ["$payment.testMode", true] },
                        ],
                      },
                      { $ifNull: ["$payment.paidAmount", "$amount"] },
                      0,
                    ],
                  },
                },
              },
            },
            { $sort: { bookings: -1 } },
            { $limit: 8 },
            {
              $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "user",
              },
            },
            {
              $lookup: {
                from: "cookprofiles",
                localField: "_id",
                foreignField: "user",
                as: "profile",
              },
            },
            {
              $project: {
                _id: 0,
                cookId: "$_id",
                name: { $arrayElemAt: ["$user.name", 0] },
                photoUrl: { $arrayElemAt: ["$profile.photoUrl", 0] },
                bookings: 1,
                hours: 1,
                gross: 1,
                refunded: 1,
                paidGross: 1,
              },
            },
          ],
          customers: [
            {
              $match: {
                customer: { $ne: null },
              },
            },
            {
              $group: {
                _id: "$customer",
                bookings: { $sum: 1 },
                gross: { $sum: { $ifNull: ["$amount", 0] } },
                paidGross: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$payment.status", "paid"] },
                          { $ne: ["$payment.testMode", true] },
                        ],
                      },
                      { $ifNull: ["$payment.paidAmount", "$amount"] },
                      0,
                    ],
                  },
                },
                refunded: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $in: ["$payment.refundStatus", SETTLED_REFUND_STATUSES] },
                          { $ne: ["$payment.testMode", true] },
                        ],
                      },
                      { $ifNull: ["$payment.refundAmount", 0] },
                      0,
                    ],
                  },
                },
              },
            },
            { $sort: { bookings: -1 } },
            { $limit: 8 },
            {
              $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "user",
              },
            },
            {
              $project: {
                _id: 0,
                customerId: "$_id",
                name: { $arrayElemAt: ["$user.name", 0] },
                bookings: 1,
                gross: 1,
                paidGross: 1,
                refunded: 1,
              },
            },
          ],
          durations: [
            {
              $match: {
                durationHours: { $gte: 1, $lte: 4 },
              },
            },
            {
              $group: { _id: "$durationHours", bookings: { $sum: 1 } },
            },
            { $sort: { _id: 1 } },
            { $project: { _id: 0, hours: "$_id", bookings: 1 } },
          ],
          months: [
            {
              $group: {
                _id: {
                  $dateToString: {
                    format: "%Y-%m",
                    date: "$date",
                    timezone: TIMEZONE,
                  },
                },
                bookings: { $sum: 1 },
                gross: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ["$payment.status", "paid"] },
                          { $ne: ["$payment.testMode", true] },
                        ],
                      },
                      { $ifNull: ["$payment.paidAmount", "$amount"] },
                      0,
                    ],
                  },
                },
                refunded: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $in: ["$payment.refundStatus", SETTLED_REFUND_STATUSES] },
                          { $ne: ["$payment.testMode", true] },
                        ],
                      },
                      { $ifNull: ["$payment.refundAmount", 0] },
                      0,
                    ],
                  },
                },
              },
            },
            { $sort: { _id: 1 } },
            {
              $project: {
                _id: 0,
                month: "$_id",
                bookings: 1,
                gross: 1,
                refunded: 1,
              },
            },
          ],
        },
      },
    ]);

    const facet = (facetResult && facetResult[0]) || {};
    const statusRows = facet.statusCounts || [];
    const byStatus = {};
    for (const s of KNOWN_STATUSES) byStatus[s] = 0;
    byStatus.unknown = 0;
    let totalBookings = 0;
    const unknownStatuses = [];
    for (const r of statusRows) {
      const key = r && r.status != null ? String(r.status) : "";
      const count = Math.max(0, Math.round(Number(r.count) || 0));
      totalBookings += count;
      if (KNOWN_STATUSES.includes(key)) {
        byStatus[key] += count;
      } else {
        byStatus.unknown += count;
        if (key) unknownStatuses.push({ status: key, count });
        else unknownStatuses.push({ status: "(missing)", count });
      }
    }
    if (process.env.NODE_ENV !== "test" && byStatus.unknown > 0) {
      console.warn(
        `[analytics] unknown booking status encountered: ${unknownStatuses
          .map((u) => `${u.status}×${u.count}`)
          .join(", ")}`
      );
    }

    const active = ACTIVE_STATUSES.reduce((a, s) => a + (byStatus[s] || 0), 0);
    const completed = byStatus.completed || 0;
    const lost = LOST_STATUSES.reduce((a, s) => a + (byStatus[s] || 0), 0);

    const m = facet.money && facet.money[0];
    const rint = (v) => {
      const n = Math.round(Number(v) || 0);
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    };
    const paidBookings = m ? Math.max(0, Math.round(Number(m.paidBookings) || 0)) : 0;
    const grossCollected = m ? rint(m.grossCollected) : 0;
    const discounts = m ? rint(m.discounts) : 0;
    const commissionGross = m ? rint(m.commissionGross) : 0;
    const cookGross = m ? rint(m.cookGross) : 0;
    const refunds = m ? rint(m.refunded) : 0;
    const netCollected = Math.max(0, grossCollected - refunds);
    let platformEarnings = 0;
    let cookEarnings = 0;
    if (grossCollected > 0 && netCollected > 0) {
      platformEarnings = Math.round((commissionGross * netCollected) / grossCollected);
      platformEarnings = Math.max(0, Math.min(platformEarnings, netCollected));
      cookEarnings = netCollected - platformEarnings;
    } else if (grossCollected > 0 && netCollected === 0) {
      platformEarnings = 0;
      cookEarnings = 0;
    }
    const avgBookingValue =
      paidBookings > 0 ? Math.round(netCollected / paidBookings) : 0;

    const pp = facet.paidPayouts && facet.paidPayouts[0];
    const cookPaid = pp ? rint(pp.cookPaid) : 0;
    const settledPayoutCount = pp ? Math.max(0, Math.round(Number(pp.settledCount) || 0)) : 0;

    const pe = facet.pendingPayoutEntitlement && facet.pendingPayoutEntitlement[0];
    let cookPending = 0;
    let pendingPayoutCount = 0;
    if (pe) {
      cookPending = Math.max(0, rint(pe.pendingCookGross));
      pendingPayoutCount = Math.max(0, Math.round(Number(pe.pendingCount) || 0));
    }

    const h = facet.hours && facet.hours[0];
    const scheduledHours = h ? Math.max(0, Number(h.scheduledHours) || 0) : 0;
    const completedHours = h ? Math.max(0, Number(h.completedHours) || 0) : 0;
    const scheduledCount = h ? Math.max(0, Math.round(Number(h.scheduledCount) || 0)) : 0;
    const avgDuration =
      scheduledCount > 0 ? Math.round((scheduledHours / scheduledCount) * 100) / 100 : 0;

    const unpaidBookings = Math.max(0, totalBookings - paidBookings);

    const pct = (num, den) => {
      if (!(den > 0)) return 0;
      return Math.round((num / den) * 1000) / 10;
    };
    const eligibleForCompletion = totalBookings - (byStatus.rejected || 0);
    const completionRate = pct(completed, totalBookings);
    const cancellationRate = pct(byStatus.cancelled || 0, totalBookings);
    const expirationRate = pct(byStatus.expired || 0, totalBookings);
    const unattendedRate = pct(byStatus.unattended || 0, totalBookings);
    const lostRate = pct(lost, totalBookings);

    const topAreas = (facet.areas || []).map((r) => ({
      area: displayCity(r.key),
      key: r.key,
      bookings: Math.max(0, Math.round(Number(r.bookings) || 0)),
      revenue: Math.max(0, Math.round(Number(r.gross) || 0)),
    }));

    const topCooks = (facet.cooks || []).map((r) => ({
      cookId: r.cookId != null ? String(r.cookId) : null,
      name: r.name || "Unknown cook",
      photoUrl: r.photoUrl || "",
      bookings: Math.max(0, Math.round(Number(r.bookings) || 0)),
      hours: Math.max(0, Number(r.hours) || 0),
      revenue: Math.max(0, Math.round(Number(r.paidGross) || 0)),
      refunded: Math.max(0, Math.round(Number(r.refunded) || 0)),
      netRevenue: Math.max(
        0,
        Math.round(Number(r.paidGross) || 0) - Math.round(Number(r.refunded) || 0)
      ),
    }));

    const topCustomers = (facet.customers || []).map((r) => ({
      customerId: r.customerId != null ? String(r.customerId) : null,
      name: r.name || "Unknown customer",
      bookings: Math.max(0, Math.round(Number(r.bookings) || 0)),
      revenue: Math.max(0, Math.round(Number(r.paidGross) || 0)),
      refunded: Math.max(0, Math.round(Number(r.refunded) || 0)),
      netRevenue: Math.max(
        0,
        Math.round(Number(r.paidGross) || 0) - Math.round(Number(r.refunded) || 0)
      ),
    }));

    const byHours = (facet.durations || []).map((r) => ({
      hours: Number(r.hours),
      bookings: Math.max(0, Math.round(Number(r.bookings) || 0)),
    }));

    const monthRows = facet.months || [];
    const monthMap = new Map(
      monthRows.map((r) => [
        String(r.month),
        {
          month: String(r.month),
          bookings: Math.max(0, Math.round(Number(r.bookings) || 0)),
          gross: Math.max(0, Math.round(Number(r.gross) || 0)),
          refunded: Math.max(0, Math.round(Number(r.refunded) || 0)),
        },
      ])
    );
    let monthlyTrend = [];
    if (range && range.fromStr && range.toStr) {
      const startKey = (() => {
        const d = new Date(range.from.getTime());
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: TIMEZONE,
          year: "numeric",
          month: "2-digit",
        }).formatToParts(d);
        const get = (t) => (parts.find((p) => p.type === t) || {}).value;
        return `${get("year")}-${get("month")}`;
      })();
      const endKey = (() => {
        const d = new Date(range.toExclusive.getTime() - 1);
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: TIMEZONE,
          year: "numeric",
          month: "2-digit",
        }).formatToParts(d);
        const get = (t) => (parts.find((p) => p.type === t) || {}).value;
        return `${get("year")}-${get("month")}`;
      })();
      const keys = enumerateMonths(startKey, endKey);
      monthlyTrend = keys.map((k) => {
        const row = monthMap.get(k) || { month: k, bookings: 0, gross: 0, refunded: 0 };
        return {
          month: k,
          bookings: row.bookings,
          revenue: Math.max(0, row.gross - row.refunded),
          gross: row.gross,
          refunded: row.refunded,
        };
      });
    } else {
      const keys = [...monthMap.keys()].sort().slice(-24);
      monthlyTrend = keys.map((k) => {
        const row = monthMap.get(k);
        return {
          month: k,
          bookings: row.bookings,
          revenue: Math.max(0, row.gross - row.refunded),
          gross: row.gross,
          refunded: row.refunded,
        };
      });
    }

    const statusBreakdown = KNOWN_STATUSES.map((s) => ({
      status: s,
      count: byStatus[s] || 0,
      pct: pct(byStatus[s] || 0, totalBookings),
    }));
    if (byStatus.unknown > 0) {
      statusBreakdown.push({
        status: "unknown",
        count: byStatus.unknown,
        pct: pct(byStatus.unknown, totalBookings),
      });
    }

    const dateDimension =
      (range && range.dateField) || "service";

    res.json({
      meta: {
        generatedAt: new Date().toISOString(),
        timezone: TIMEZONE,
        currency: "INR",
        dateDimension,
        dateDimensionMeaning:
          dateDimension === "created"
            ? "Metrics scoped by booking creation date (createdAt)"
            : "Metrics scoped by scheduled service date (Booking.date)",
        filters: range
          ? {
              from: range.fromStr || null,
              to: range.toStr || null,
              dateField: dateDimension,
            }
          : { from: null, to: null, dateField: dateDimension },
        unknownStatuses,
      },
      totals: {
        bookings: {
          total: totalBookings,
          byStatus: { ...byStatus },
          active,
          completed,
          lost,
          unattended: byStatus.unattended || 0,
        },
        operational: {
          total: totalBookings,
          requested: byStatus.requested || 0,
          accepted: byStatus.accepted || 0,
          confirmed: byStatus.confirmed || 0,
          inProgress: byStatus.in_progress || 0,
          completed,
          cancelled: byStatus.cancelled || 0,
          expired: byStatus.expired || 0,
          rejected: byStatus.rejected || 0,
          unattended: byStatus.unattended || 0,
          unknown: byStatus.unknown || 0,
          active,
          lost,
          completionRate,
          cancellationRate,
          expirationRate,
          unattendedRate,
          lostRate,
        },
        financial: {
          paidBookings,
          unpaidBookings,
          grossCollected,
          discounts,
          refunds,
          netCollected,
          platformEarnings,
          cookEarnings,
          cookPaid,
          cookPending,
          settledPayoutCount,
          pendingPayoutCount,
          avgBookingValue,
        },
        service: {
          scheduledHours,
          completedHours,
          avgDuration,
          scheduledCount,
        },
        totalBookings,
        statusCounts: { ...byStatus },
        active,
        completed,
        lost,
        paidBookings,
        revenue: netCollected,
        grossCollected,
        refunds,
        netCollected,
        commission: platformEarnings,
        cookPayouts: cookEarnings,
        cookPaid,
        cookPending,
        totalHours: scheduledHours,
        completedHours,
        avgValue: avgBookingValue,
      },
      statusBreakdown,
      areas: topAreas,
      topAreas,
      cooks: topCooks,
      topCooks,
      customers: topCustomers,
      topCustomers,
      durationBreakdown: byHours,
      byHours,
      monthlyTrend,
      byMonth: monthlyTrend,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
