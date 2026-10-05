
const Booking = require("../models/Booking");
const CancellationAudit = require("../models/CancellationAudit");
const Complaint = require("../models/Complaint");
const { paginationParams, applyPagination, sendList } = require("../utils/pagination");
const { logCancellationAudit, syncCancellationRefundStatus } = require("../utils/cancellationAudit");

const WORKFLOW_STATUSES = [
  "PENDING",
  "UNDER_REVIEW",
  "APPROVED",
  "PROCESSING",
  "PROCESSED",
  "HELD",
  "REJECTED",
  "FAILED",
  "NOT_APPLICABLE",
];

exports.listCancellations = async (req, res, next) => {
  try {
    const filter = {
      $or: [
        { "cancellationInfo.cancelledAt": { $exists: true } },
        { "payment.refundStatus": { $nin: ["none", null] } },
      ],
    };
    const tab = String(req.query?.tab || req.query?.status || "all").toUpperCase().replace(/-/g, "_").replace(/ /g, "_");
    const map = {
      PENDING: "PENDING",
      UNDER_REVIEW: "UNDER_REVIEW",
      APPROVED: "APPROVED",
      PROCESSING: "PROCESSING",
      PROCESSED: "PROCESSED",
      HELD: "HELD",
      REJECTED: "REJECTED",
      FAILED: "FAILED",
    };
    if (map[tab]) filter["cancellationInfo.refundStatus"] = map[tab];
    if (req.query?.cook) filter.cook = req.query.cook;
    if (req.query?.customer) filter.customer = req.query.customer;
    const pg = paginationParams(req);
    const rows = await applyPagination(
      Booking.find(filter)
        .sort({ updatedAt: -1, _id: 1 })
        .populate("customer", "name phone")
        .populate("cook", "name phone"),
      pg
    );
    const shaped = (rows || []).map((b) => {
      const o = b.toObject ? b.toObject() : b;
      const ci = o.cancellationInfo || {};
      return {
        _id: o._id,
        customer: o.customer,
        cook: o.cook,
        serviceDate: o.date,
        startTime: o.startTime,
        endTime: o.endTime,
        cancelledAt: ci.cancelledAt || null,
        cancelledBy: ci.cancelledBy || o.cancelledBy || "",
        cancellationCategory: ci.cancellationCategory || "",
        cancellationReason: ci.cancellationReason || "",
        bookingAmount: ci.bookingAmount ?? o.amount ?? 0,
        refundPercent: ci.refundPercentage ?? 0,
        grossRefund: ci.grossRefundAmount ?? 0,
        nonRefundableCharges: ci.nonRefundableCharges ?? 0,
        finalRefund: ci.finalRefundAmount ?? o.payment?.refundAmount ?? 0,
        refundStatus: ci.refundStatus || "NOT_APPLICABLE",
        paymentStatus: o.payment?.status || "pending",
        paymentRefundStatus: o.payment?.refundStatus || "none",
        serviceStatus: o.status,
        refundReference: ci.refundReference || o.payment?.refundReference || "",
        adminNote: ci.adminNote || "",
      };
    });
    return sendList(res, shaped, pg, () =>
      Booking.countDocuments(filter)
    );
  } catch (error) {
    next(error);
  }
};

exports.getCancellationDetail = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate("customer", "name email phone")
      .populate("cook", "name email phone");
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const [audits, complaints] = await Promise.all([
      CancellationAudit.find({ bookingId: booking._id }).sort({ createdAt: -1 }).lean().catch(() => []),
      Complaint.find({ booking: booking._id }).sort({ createdAt: -1 }).lean().catch(() => []),
    ]);
    res.json({ booking, audits: audits || [], complaints: complaints || [] });
  } catch (error) {
    next(error);
  }
};

const workflowAction = async ({ req, res, to, event, needReason }) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ message: "Booking not found" });
  if (!booking.cancellationInfo?.cancelledAt && (booking.payment?.refundStatus || "none") === "none") {
    return res.status(400).json({ message: "This booking has no cancellation or refund to review" });
  }
  const prev = booking.cancellationInfo?.refundStatus || "NOT_APPLICABLE";
  const reason = String(req.body?.reason || req.body?.note || "").trim().slice(0, 500);
  if (needReason && !reason) {
    return res.status(400).json({ message: "A reason/note is required" });
  }
  await syncCancellationRefundStatus(booking._id, {
    refundStatus: to,
    ...(reason ? { adminNote: reason } : {}),
  });
  await logCancellationAudit({
    actor: req.user.id,
    actorRole: "ADMIN",
    bookingId: booking._id,
    event,
    previousStatus: prev,
    newStatus: to,
    amount: Number(booking.cancellationInfo?.finalRefundAmount || booking.payment?.refundAmount || 0),
    reason,
  });
  try {
    const Notification = require("../models/Notification");
    const labels = { HELD: "put on hold", UNDER_REVIEW: "under review" };
    await Notification.create({
      user: booking.customer,
      type: to === "HELD" ? "refund_failed" : "refund_pending",
      booking: booking._id,
      message:
        to === "HELD"
          ? `Your refund of ₹${booking.cancellationInfo?.finalRefundAmount ?? booking.payment?.refundAmount ?? 0} is on hold${reason ? `: ${reason}` : ""} — our team will update you shortly.`
          : `Your refund request is ${labels[to] || "being processed"}${reason ? ` — ${reason}` : ""}.`,
    });
  } catch {
  }
  const fresh = await Booking.findById(req.params.id);
  res.json(fresh);
};

exports.holdCancellation = (req, res, next) =>
  workflowAction({ req, res, to: "HELD", event: "REFUND_HELD", needReason: true }).catch(next);

exports.reviewCancellation = (req, res, next) =>
  workflowAction({ req, res, to: "UNDER_REVIEW", event: "UNDER_REVIEW", needReason: false }).catch(next);

exports.addCancellationNote = async (req, res, next) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const note = String(req.body?.note || "").trim().slice(0, 500);
    if (!note) return res.status(400).json({ message: "A note is required" });
    const prev = booking.cancellationInfo?.refundStatus || "NOT_APPLICABLE";
    const stamped = `${new Date().toISOString().slice(0, 10)}: ${note}`;
    const prior = booking.cancellationInfo?.adminNote || "";
    await syncCancellationRefundStatus(booking._id, {
      adminNote: prior ? `${prior}\n${stamped}` : stamped,
    });
    await logCancellationAudit({
      actor: req.user.id,
      actorRole: "ADMIN",
      bookingId: booking._id,
      event: "NOTE_ADDED",
      previousStatus: prev,
      newStatus: prev,
      amount: 0,
      reason: note,
    });
    const fresh = await Booking.findById(req.params.id);
    res.json(fresh);
  } catch (error) {
    next(error);
  }
};
