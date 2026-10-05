
const CancellationAudit = require("../models/CancellationAudit");
const Booking = require("../models/Booking");

const logCancellationAudit = async ({
  actor,
  actorRole,
  bookingId,
  refundId = "",
  event,
  previousStatus = "",
  newStatus = "",
  amount = 0,
  reason = "",
  metadata,
}) => {
  try {
    await CancellationAudit.create({
      actor: actor || null,
      actorRole: actorRole || "",
      bookingId,
      refundId,
      event,
      previousStatus,
      newStatus,
      amount,
      reason: String(reason || "").slice(0, 500),
      ...(metadata !== undefined ? { metadata } : {}),
    });
    return true;
  } catch {
    return false;
  }
};

const syncCancellationRefundStatus = async (
  bookingId,
  { refundStatus, reference, processedAt, adminNote }
) => {
  try {
    const set = {};
    if (refundStatus) set["cancellationInfo.refundStatus"] = refundStatus;
    if (reference !== undefined) set["cancellationInfo.refundReference"] = String(reference).slice(0, 120);
    if (processedAt) set["cancellationInfo.refundProcessedAt"] = processedAt;
    if (adminNote !== undefined) set["cancellationInfo.adminNote"] = String(adminNote).slice(0, 500);
    if (!Object.keys(set).length) return false;
    await Booking.updateOne({ _id: bookingId }, { $set: set });
    return true;
  } catch {
    return false;
  }
};

module.exports = { logCancellationAudit, syncCancellationRefundStatus };
