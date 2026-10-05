const mongoose = require("mongoose");
const Complaint = require("../models/Complaint");
const { paginationParams, applyPagination, sendList } = require("../utils/pagination");
const Booking = require("../models/Booking");
const Notification = require("../models/Notification");
const User = require("../models/User");

// Customer-facing service reasons (§19, SNAKE_UPPER in the API) mapped to
// the stored lowercase enum. Legacy lowercase values pass through. Returns
// null for an unrecognized customer reason (refused, never auto-refunded).
const CUSTOMER_REASON_MAP = {
  COOK_DID_NOT_ARRIVE: "cook_did_not_arrive",
  MAJOR_SERVICE_DEVIATION: "major_service_deviation",
  SERVICE_QUALITY_ISSUE: "service_quality_issue",
  UNPROFESSIONAL_BEHAVIOR: "unprofessional_behavior",
  OTHER: "other",
};
const normalizeComplaintCategory = (raw, isCustomer) => {
  const s = String(raw || "").trim();
  if (!s) return "other";
  if (CUSTOMER_REASON_MAP[s]) return CUSTOMER_REASON_MAP[s];
  const lower = s.toLowerCase();
  const allowed = [
    "behaviour", "payment", "address", "no_show", "safety", "quality",
    "hygiene", "other", "cook_did_not_arrive", "major_service_deviation",
    "service_quality_issue", "unprofessional_behavior",
  ];
  if (allowed.includes(lower)) return lower;
  return isCustomer ? null : "other";
};

// Complaints are preferably filed within 24h of completion (§19). Late
// reports are accepted but flagged for the reviewer.
const isLateComplaint = (booking) => {
  try {
    if (!booking || booking.status !== "completed") return false;
    const end = booking.serviceEndsAt ? new Date(booking.serviceEndsAt) : null;
    const ref = end && !Number.isNaN(end.getTime()) ? end.getTime() : new Date(booking.updatedAt || booking.createdAt).getTime();
    return Date.now() - ref > 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
};

// Either side files a complaint about the other, always anchored to one of
// their own bookings so the counterparty is derived server-side (nobody can
// file against a stranger by guessing ids):
// - cook → about the customer of their booking (customer id optional for
//   legacy standalone filings backed by a real past booking);
// - customer → about the cook of their booking (booking required).
exports.createComplaint = async (req, res, next) => {
  try {
    const { booking: bookingId, customer: customerId, category, message } = req.body;
    const isCustomer = String(req.user.role).toUpperCase() === "CUSTOMER";

    let customer = customerId || null;
    let cook = isCustomer ? req.user.id : null;
    let booking = null;
    if (bookingId) {
      booking = await Booking.findById(bookingId);
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }
      if (isCustomer) {
        // A customer can only complain about their own booking's cook.
        if (booking.customer.toString() !== req.user.id) {
          return res.status(403).json({ message: "Not authorized" });
        }
        cook = booking.cook.toString();
        customer = booking.customer.toString();
      } else {
        if (booking.cook.toString() !== req.user.id) {
          return res.status(403).json({ message: "Not authorized" });
        }
        customer = booking.customer.toString();
      }
    }
    if (isCustomer && !booking) {
      return res
        .status(400)
        .json({ message: "Complaints must be tied to one of your bookings" });
    }
    if (!isCustomer && !customer) {
      return res.status(400).json({ message: "A customer or booking is required" });
    }
    if (!cook) {
      return res.status(400).json({ message: "A cook is required" });
    }
    // Standalone customer ids must belong to someone this cook actually served
    // — otherwise a cook could file complaints against strangers by guessing
    // user ids (the booking path above already enforces the link).
    if (!isCustomer && !booking) {
      if (!mongoose.Types.ObjectId.isValid(String(customer))) {
        return res.status(400).json({ message: "Invalid customer id" });
      }
      const linked = await Booking.exists({ cook: req.user.id, customer });
      if (!linked) {
        return res.status(400).json({
          message: "No booking found with this customer — complaints need a booking",
        });
      }
    }

    // Customer service-complaint reasons (§19) are validated server-side;
    // unsupported reasons are refused (never auto-refunded — §21).
    const mappedCategory = normalizeComplaintCategory(category, isCustomer);
    if (isCustomer && category && !mappedCategory) {
      return res.status(400).json({ message: "Please choose a valid complaint reason." });
    }
    // Duplicate guard (§33): one open/in-review complaint per booking per
    // filer — a second filing on the same booking returns the existing one.
    if (booking) {
      try {
        const dup = await Complaint.findOne({
          booking: booking._id,
          filedBy: isCustomer ? "customer" : "cook",
          status: { $in: ["open", "in_review"] },
        }).select("_id");
        if (dup) {
          return res.status(409).json({ message: "A complaint for this booking is already under review.", code: "DUPLICATE_COMPLAINT" });
        }
      } catch {
        // non-fatal: fall through and create
      }
    }

    const complaint = await Complaint.create({
      filedBy: isCustomer ? "customer" : "cook",
      cook,
      customer,
      booking: booking ? booking._id : null,
      category: mappedCategory || "other",
      message: String(message || "").trim(),
      reportedLate: isLateComplaint(booking),
    });

    // Alert every admin (non-fatal — the complaint itself already succeeded).
    try {
      // Match both UPPERCASE (spec) and legacy lowercase stored roles.
      const admins = await User.find({ role: { $in: ["ADMIN", "admin"] } }).select("_id");
      const filerUser = await User.findById(req.user.id).select("name");
      await Notification.create(
        admins.map((a) => ({
          user: a._id,
          type: "general",
          booking: booking ? booking._id : null,
          link: "/admin/complaints",
          message: `New ${isCustomer ? "customer" : "cook"} complaint from ${
            filerUser?.name || (isCustomer ? "a customer" : "a cook")
          } — ${complaint.category}. Please review.`,
        }))
      );
    } catch {
      // non-fatal
    }
    // Receipt for the filer (best-effort) — otherwise filing feels like a
    // black hole until an admin resolves it.
    try {
      await Notification.create({
        user: req.user.id,
        type: "complaint_received",
        booking: booking ? booking._id : null,
        message: "Your complaint has been received — our team will review it shortly.",
      });
    } catch {
      // non-fatal
    }
    // The other side is informed that a complaint was raised (§27) — cooks
    // hear about customer complaints on their bookings and vice versa.
    try {
      const otherId = isCustomer ? cook : customer;
      if (otherId && String(otherId) !== String(req.user.id)) {
        await Notification.create({
          user: otherId,
          type: "complaint_received",
          booking: booking ? booking._id : null,
          message: isCustomer
            ? "A customer raised a service complaint on one of your bookings — our team will review it and contact you if needed."
            : "A cook raised an issue on one of your bookings — our team will review it and contact you if needed.",
        });
      }
    } catch {
      // non-fatal
    }
    // Audit trail (§26).
    try {
      const { logCancellationAudit } = require("../utils/cancellationAudit");
      await logCancellationAudit({
        actor: req.user.id,
        actorRole: isCustomer ? "CUSTOMER" : "COOK",
        bookingId: booking ? booking._id : complaint.booking,
        event: "COMPLAINT_SUBMITTED",
        previousStatus: "",
        newStatus: "open",
        amount: 0,
        reason: `${complaint.category}: ${String(complaint.message || "").slice(0, 200)}`,
      });
    } catch {
      // non-fatal
    }

    res.status(201).json(complaint);
  } catch (error) {
    next(error);
  }
};

// Complaints the logged-in user filed (either role).
exports.getMyComplaints = async (req, res, next) => {
  try {
    const filter = {
      filedBy: String(req.user.role).toUpperCase() === "CUSTOMER" ? "customer" : "cook",
    };
    if (filter.filedBy === "customer") {
      filter.customer = req.user.id;
    } else {
      filter.cook = req.user.id;
    }
    const pg = paginationParams(req);
    // Await here (not inside sendList): the phone strip below must run on the
    // resolved documents in both paged and unpaged modes.
    const complaints = await applyPagination(
      Complaint.find(filter)
        .populate(filter.filedBy === "customer" ? "cook" : "customer", "name phone")
        .populate("booking", "date serviceType startTime endTime status")
        .sort({ createdAt: -1 }),
      pg
    );
    // Phone privacy (S-06): the booking API hides counterparty phones while a
    // booking is still "requested" (pre-accept). A complaint anchored to such
    // a booking must not leak the number through this endpoint — strip it
    // unless the linked booking reached an accepted-or-later state. Legacy
    // standalone filings (no booking populated) fail closed as well.
    const rows = Array.isArray(complaints) ? complaints : [];
    for (const c of rows) {
      const status = c?.booking?.status;
      const contactAllowed = status && status !== "requested";
      if (contactAllowed) continue;
      const other = filter.filedBy === "customer" ? c?.cook : c?.customer;
      if (other && typeof other === "object") {
        try {
          other.phone = undefined;
        } catch {
          // non-fatal: leave the document untouched
        }
      }
    }
    return sendList(res, complaints, pg, () => Complaint.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

// Every complaint, newest first (admin triage queue).
exports.getAllComplaints = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status && ["open", "in_review", "resolved", "rejected"].includes(req.query.status)) {
      filter.status = req.query.status;
    }
    const pg = paginationParams(req);
    const complaints = await applyPagination(
      Complaint.find(filter)
        .populate("cook", "name phone")
        .populate("customer", "name phone")
        .populate("booking", "date serviceType startTime endTime status address")
        .sort({ createdAt: -1 }),
      pg
    );
    return sendList(res, complaints, pg, () => Complaint.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

// Admin moves a complaint through open → in_review → resolved/rejected,
// optionally leaving an internal note (also shared back with the cook).
exports.updateComplaintStatus = async (req, res, next) => {
  try {
    const complaint = await Complaint.findById(req.params.id);
    if (!complaint) {
      return res.status(404).json({ message: "Complaint not found" });
    }
    const { status, adminNote } = req.body;
    if (status && !["open", "in_review", "resolved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    if (status) complaint.status = status;
    if (adminNote !== undefined) complaint.adminNote = String(adminNote || "").trim().slice(0, 2000);
    await complaint.save();

    // Tell the filer when their complaint is resolved or rejected.
    if (["resolved", "rejected"].includes(complaint.status)) {
      try {
        const notifyUserId = complaint.filedBy === "customer" ? complaint.customer : complaint.cook;
        await Notification.create({
          user: notifyUserId,
          type: "complaint_resolved",
          booking: complaint.booking || null,
          message:
            complaint.status === "resolved"
              ? "Your complaint has been resolved by our team. Thank you for reporting."
              : "Your complaint was reviewed and closed. Contact support if you need more help.",
        });
      } catch {
        // non-fatal
      }
      try {
        const { logCancellationAudit } = require("../utils/cancellationAudit");
        await logCancellationAudit({
          actor: req.user.id,
          actorRole: "ADMIN",
          bookingId: complaint.booking || undefined,
          event: "COMPLAINT_RESOLVED",
          previousStatus: "",
          newStatus: complaint.status,
          amount: 0,
          reason: String(complaint.adminNote || complaint.status).slice(0, 500),
        });
      } catch {
        // non-fatal
      }
    }

    const populated = await Complaint.findById(complaint._id)
      .populate("cook", "name phone")
      .populate("customer", "name phone")
      .populate("booking", "date serviceType startTime endTime status address");
    res.json(populated);
  } catch (error) {
    next(error);
  }
};
