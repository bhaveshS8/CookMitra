// Shared booking state-transition helpers.
//
// These used to live in controllers/bookingController.js. They are defined
// here so the website controller AND the WhatsApp channel (shared accept
// service + webhook controller) execute byte-for-byte the same expiry,
// refund-queueing and coupon-release rules. bookingController re-exports
// everything below, so existing `require("./bookingController")`
// call-sites keep working unchanged.

const mongoose = require("mongoose");
const Booking = require("../models/Booking");
const Notification = require("../models/Notification");
const realtime = require("../utils/realtime");
const { notifyWhatsApp } = require("../utils/whatsappApi");

const REQUEST_WINDOW_MS = 5 * 60 * 1000;
const PAYMENT_WINDOW_MS = 5 * 60 * 1000;

const dbReady = () => {
  try {
    return mongoose.connection && mongoose.connection.readyState === 1;
  } catch {
    return false;
  }
};

const queueRefundForApproval = (booking, reason, amountOverride) => {
  const pay = booking.payment || {};
  if (pay.status !== "paid" || pay.testMode) return 0;
  if (pay.refundStatus && pay.refundStatus !== "none") return 0;
  let amount;
  if (amountOverride != null) {
    amount = Math.round(Number(amountOverride) * 100) / 100;
  } else {
    amount = Math.round(Number(pay.paidAmount || booking.amount || 0));
  }
  if (!(amount > 0)) return 0;
  booking.payment.refundStatus = "pending";
  booking.payment.refundAmount = amount;
  booking.statusHistory.push({
    status: booking.status,
    note: `Refund of ₹${amount} queued for admin approval (${reason})`,
  });
  return amount;
};

const releaseCouponUsage = async (booking) => {
  try {
    if (!booking?.couponCode || !booking?.customer) return;
    if (booking.couponReleased === true) return;
    if (booking._id && dbReady()) {
      try {
        const claimed = await Booking.updateOne(
          { _id: booking._id, couponReleased: { $ne: true } },
          { $set: { couponReleased: true } }
        );
        if ((claimed.modifiedCount ?? claimed.nModified ?? 0) !== 1) return;
      } catch {
      }
    }
    const Coupon = require("../models/Coupon");
    await Coupon.updateOne(
      { code: String(booking.couponCode).toUpperCase() },
      { $inc: { usedCount: -1 }, $pull: { usedBy: booking.customer } }
    );
    await Coupon.updateOne(
      { code: String(booking.couponCode).toUpperCase(), usedCount: { $lt: 0 } },
      { $set: { usedCount: 0 } }
    );
    if (booking && typeof booking.save === "function" && booking.couponReleased !== undefined) {
      try {
        booking.couponReleased = true;
      } catch {
      }
    }
    try {
      if (booking?._id) {
        await Booking.updateOne({ _id: booking._id }, { $set: { couponReleased: true } });
      }
    } catch {
    }
  } catch {
  }
};

const expireBookingIfNeeded = async (booking) => {
  try {
    const now = new Date();
    if (
      booking.status === "requested" &&
      booking.requestExpiresAt &&
      booking.requestExpiresAt < now
    ) {
      if (dbReady() && booking._id) {
        let expiredClaimed = false;
        try {
          const claim = await Booking.updateOne(
            { _id: booking._id, status: "requested", requestExpiresAt: { $lt: now } },
            {
              $set: { status: "expired" },
              $push: { statusHistory: { status: "expired", note: "Cook did not respond within 5 minutes" } },
            }
          );
          expiredClaimed = (claim.modifiedCount ?? claim.nModified ?? 0) === 1;
        } catch {
          expiredClaimed = false;
        }
        if (!expiredClaimed) {
          try {
            const latest = await Booking.findById(booking._id);
            if (latest && latest.status !== "requested") {
              booking.status = latest.status;
              return booking;
            }
          } catch {
          }
          return null;
        }
        booking.status = "expired";
        booking.statusHistory.push({
          status: "expired",
          note: "Cook did not respond within 5 minutes",
        });
      } else {
        booking.status = "expired";
        booking.statusHistory.push({
          status: "expired",
          note: "Cook did not respond within 5 minutes",
        });
        await booking.save();
      }
      await releaseCouponUsage(booking);
      let expiredRefundNote = "";
      try {
        const queued = queueRefundForApproval(booking, "request_expired");
        if (queued > 0) {
          if (dbReady() && booking._id) {
            try {
              await Booking.updateOne(
                { _id: booking._id, "payment.refundStatus": "none" },
                {
                  $set: { "payment.refundStatus": "pending", "payment.refundAmount": queued },
                  $push: {
                    statusHistory: {
                      status: booking.status,
                      note: `Refund of ₹${queued} queued for admin approval (request_expired)`,
                    },
                  },
                }
              );
            } catch {
            }
          } else {
            await booking.save();
          }
          expiredRefundNote = ` A refund of ₹${queued} has been requested — our team will review it shortly.`;
        } else if (booking.payment?.testMode && booking.payment?.status === "paid") {
          expiredRefundNote = " (Test payment — no real money moved.)";
        }
      } catch {
      }
      try {
        await Notification.create({
          user: booking.customer,
          type: "booking_expired",
          booking: booking._id,
          message: `Your booking request expired — the cook didn't respond within 5 minutes. Please find another cook.${expiredRefundNote}`,
        });
      } catch {
      }
      try {
        await Notification.create({
          user: booking.cook,
          type: "booking_expired",
          booking: booking._id,
          message: "A booking request expired without a response — the slot is open again.",
        });
      } catch {
      }
      notifyWhatsApp("expired", booking);
      try {
        realtime.emit("booking_expired", {
          bookingId: String(booking._id),
          customerId: String(booking.customer),
        });
      } catch {
      }
      return booking;
    }
    if (
      booking.status === "accepted" &&
      booking.payment?.status !== "paid" &&
      booking.paymentExpiresAt &&
      booking.paymentExpiresAt < now
    ) {
      // Unpaid slot-release is never shown nor tracked: the booking is
      // permanently removed (coupon released, notifications purged, doc
      // deleted). No CancellationAudit, no refund, no WhatsApp, no in-app
      // notification is kept for it.
      const destroyUnpaidReleased = async () => {
        try {
          await releaseCouponUsage(booking);
        } catch {
        }
        if (booking?._id && dbReady()) {
          try {
            await Notification.deleteMany({ booking: booking._id });
          } catch {
          }
          try {
            await Booking.deleteOne({ _id: booking._id });
          } catch {
          }
        }
        booking.status = "cancelled";
        booking.__deletedUnpaidCancelled = true;
      };
      if (dbReady() && booking._id) {
        let releasedClaimed = false;
        try {
          const claim = await Booking.updateOne(
            {
              _id: booking._id,
              status: "accepted",
              "payment.status": { $ne: "paid" },
              paymentExpiresAt: { $lt: now },
            },
            {
              $set: { status: "cancelled" },
              $push: {
                statusHistory: {
                  status: "cancelled",
                  note: "Payment not completed within 5 minutes — slot released",
                },
              },
            }
          );
          releasedClaimed = (claim.modifiedCount ?? claim.nModified ?? 0) === 1;
        } catch {
          releasedClaimed = false;
        }
        if (!releasedClaimed) {
          try {
            const latest = await Booking.findById(booking._id);
            if (!latest) {
              booking.status = "cancelled";
              booking.__deletedUnpaidCancelled = true;
              return booking;
            }
            if (latest && (latest.status !== "accepted" || latest.payment?.status === "paid")) {
              booking.status = latest.status;
              return booking;
            }
          } catch {
          }
          return null;
        }
        try {
          booking.statusHistory.push({
            status: "cancelled",
            note: "Payment not completed within 5 minutes — slot released",
          });
        } catch {
        }
        await destroyUnpaidReleased();
      } else {
        try {
          booking.status = "cancelled";
          booking.statusHistory.push({
            status: "cancelled",
            note: "Payment not completed within 5 minutes — slot released",
          });
        } catch {
          booking.status = "cancelled";
        }
        try {
          if (typeof booking.save === "function") await booking.save();
        } catch {
        }
        await destroyUnpaidReleased();
      }
      return booking;
    }
  } catch {
  }
  return null;
};

module.exports = {
  REQUEST_WINDOW_MS,
  PAYMENT_WINDOW_MS,
  dbReady,
  queueRefundForApproval,
  releaseCouponUsage,
  expireBookingIfNeeded,
};
