const express = require("express");
const router = express.Router();
const { auth, authorize } = require("../middleware/auth");
const Booking = require("../models/Booking");

// Admin booking analytics for the dashboard Analytics tab.
// One endpoint, several Mongo aggregations — no caching needed (admin-only,
// low traffic). Every booked-demand stat (volume, hours, revenue, averages,
// top cooks/customers/areas) excludes bookings that never reached a cook's
// calendar: rejected, expired, cancelled. "Active" holds what's currently
// in-flight (requested + accepted + confirmed + in_progress).

const REAL_MATCH = { status: { $nin: ["rejected", "expired", "cancelled"] } };

router.get("/bookings", auth, authorize("admin"), async (req, res, next) => {
  try {
    // Overview: status counts separate from milestone totals. The milestone
    // cards (total bookings, completed, active, lost) count only real-demand
    // bookings; the status heatmap still slices across ALL bookings so admins
    // can see how much demand was lost to cancelled/expired/rejected.
    const allStatus = await Booking.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { _id: 0, status: "$_id", count: 1 } },
    ]);
    const byStatus = Object.fromEntries(allStatus.map((r) => [r.status, r.count]));
    const totalBookings =
      (byStatus.requested || 0) +
      (byStatus.accepted || 0) +
      (byStatus.confirmed || 0) +
      (byStatus.completed || 0) +
      (byStatus.in_progress || 0);
    const statusCounts = allStatus.reduce(
      (acc, r) => ({ ...acc, [r.status]: r.count }),
      { requested: 0, accepted: 0, confirmed: 0, completed: 0, cancelled: 0, expired: 0, rejected: 0 }
    );

    const [ moneyAgg, hoursAgg, topAreas, topCooks, topCustomers, byHours, byMonth ] =
      await Promise.all([
        Booking.aggregate([
          { $match: { "payment.status": "paid" } },
          {
            $group: {
              _id: null,
              paidBookings: { $sum: 1 },
              revenue: { $sum: "$amount" },
              commission: { $sum: "$commission" },
              cookPayouts: { $sum: "$cookPayout" },
            },
          },
        ]),
        Booking.aggregate([
          { $match: REAL_MATCH },
          { $group: { _id: null, hours: { $sum: "$durationHours" } } },
        ]),
        Booking.aggregate([
          { $match: REAL_MATCH },
          {
            $group: {
              _id: { $ifNull: ["$addressDetails.city", ""] },
              bookings: { $sum: 1 },
              revenue: { $sum: "$amount" },
            },
          },
          { $match: { _id: { $ne: "" } } },
          { $sort: { bookings: -1 } },
          { $limit: 8 },
          { $project: { _id: 0, area: "$_id", bookings: 1, revenue: 1 } },
        ]),
        Booking.aggregate([
          { $match: REAL_MATCH },
          {
            $group: {
              _id: "$cook",
              bookings: { $sum: 1 },
              revenue: { $sum: "$amount" },
              hours: { $sum: "$durationHours" },
            },
          },
          { $sort: { bookings: -1 } },
          { $limit: 8 },
          { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
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
              name: { $arrayElemAt: ["$user.name", 0] },
              photoUrl: { $arrayElemAt: ["$profile.photoUrl", 0] },
              bookings: 1,
              revenue: 1,
              hours: 1,
            },
          },
        ]),
        Booking.aggregate([
          { $match: REAL_MATCH },
          {
            $group: {
              _id: "$customer",
              bookings: { $sum: 1 },
              revenue: { $sum: "$amount" },
            },
          },
          { $sort: { bookings: -1 } },
          { $limit: 8 },
          { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
          {
            $project: {
              _id: 0,
              name: { $arrayElemAt: ["$user.name", 0] },
              bookings: 1,
              revenue: 1,
            },
          },
        ]),
        Booking.aggregate([
          { $match: { ...REAL_MATCH, durationHours: { $ne: null } } },
          { $group: { _id: "$durationHours", bookings: { $sum: 1 } } },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, hours: "$_id", bookings: 1 } },
        ]),
        Booking.aggregate([
          { $match: REAL_MATCH },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m", date: "$date" } },
              bookings: { $sum: 1 },
              revenue: { $sum: "$amount" },
            },
          },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, month: "$_id", bookings: 1, revenue: 1 } },
        ]),
      ]);

    // moneyAgg is an aggregation array (empty when nothing is paid yet).
    const money = moneyAgg[0] || {
      paidBookings: 0,
      revenue: 0,
      commission: 0,
      cookPayouts: 0,
    };

    res.json({
      totals: {
        totalBookings,
        statusCounts,
        completed: byStatus.completed || 0,
        active:
          (byStatus.requested || 0) +
          (byStatus.accepted || 0) +
          (byStatus.confirmed || 0) +
          (byStatus.in_progress || 0),
        lost:
          (byStatus.cancelled || 0) +
          (byStatus.expired || 0) +
          (byStatus.rejected || 0),
        paidBookings: money.paidBookings,
        revenue: money.revenue,
        commission: money.commission,
        cookPayouts: money.cookPayouts,
        totalHours: hoursAgg[0]?.hours || 0,
        avgValue:
          money.paidBookings > 0 ? Math.round(money.revenue / money.paidBookings) : 0,
      },
      topAreas,
      topCooks,
      topCustomers,
      byHours,
      byMonth,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;