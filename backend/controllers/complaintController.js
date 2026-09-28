const mongoose = require("mongoose");
const Complaint = require("../models/Complaint");
const { paginationParams, applyPagination, sendList } = require("../utils/pagination");
const Booking = require("../models/Booking");
const Notification = require("../models/Notification");
const User = require("../models/User");

// Cook files a complaint about a customer. When a booking id is supplied,
// the booking must belong to the cook and the customer is derived from it
// (so a cook can never file against a stranger by guessing ids).
exports.createComplaint = async (req, res, next) => {
  try {
    const { booking: bookingId, customer: customerId, category, message } = req.body;

    let customer = customerId || null;
    let booking = null;
    if (bookingId) {
      booking = await Booking.findById(bookingId);
      if (!booking) {
        return res.status(404).json({ message: "Booking not found" });
      }
      if (booking.cook.toString() !== req.user.id) {
        return res.status(403).json({ message: "Not authorized" });
      }
      customer = booking.customer.toString();
    }
    if (!customer) {
      return res.status(400).json({ message: "A customer or booking is required" });
    }
    // Standalone customer ids must belong to someone this cook actually served
    // — otherwise a cook could file complaints against strangers by guessing
    // user ids (the booking path above already enforces the link).
    if (!booking) {
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

    const complaint = await Complaint.create({
      cook: req.user.id,
      customer,
      booking: booking ? booking._id : null,
      category: category || "other",
      message: String(message || "").trim(),
    });

    // Alert every admin (non-fatal — the complaint itself already succeeded).
    try {
      // Match both UPPERCASE (spec) and legacy lowercase stored roles.
      const admins = await User.find({ role: { $in: ["ADMIN", "admin"] } }).select("_id");
      const cookUser = await User.findById(req.user.id).select("name");
      await Notification.create(
        admins.map((a) => ({
          user: a._id,
          type: "general",
          message: `New cook complaint from ${cookUser?.name || "a cook"} — ${complaint.category}. Please review.`,
        }))
      );
    } catch {
      // non-fatal
    }

    res.status(201).json(complaint);
  } catch (error) {
    next(error);
  }
};

// Complaints filed by the logged-in cook.
exports.getMyComplaints = async (req, res, next) => {
  try {
    const filter = { cook: req.user.id };
    const pg = paginationParams(req);
    const complaints = await applyPagination(
      Complaint.find(filter)
        .populate("customer", "name phone")
        .populate("booking", "date serviceType startTime endTime status")
        .sort({ createdAt: -1 }),
      pg
    );
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

    // Tell the cook when their complaint is resolved or rejected.
    if (["resolved", "rejected"].includes(complaint.status)) {
      try {
        await Notification.create({
          user: complaint.cook,
          type: "general",
          message:
            complaint.status === "resolved"
              ? "Your complaint has been resolved by our team. Thank you for reporting."
              : "Your complaint was reviewed and closed. Contact support if you need more help.",
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
