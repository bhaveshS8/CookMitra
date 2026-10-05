const mongoose = require("mongoose");
const CookProfile = require("../models/CookProfile");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { paginationParams, sendList, HARD_CAP } = require("../utils/pagination");
const {
  getDayWindows,
  computeStartOptions,
  localDayString,
  parseDay,
  dayBounds,
  resolveCookAvailability,
  timeToMinutes,
  intervalsOverlap,
} = require("../utils/slots");

const COOK_EDITABLE_FIELDS = [
  "bio",
  "skills",
  "experienceYears",
  "specialties",
  "serviceTypes",
  "rate",
  "serviceArea",
  "address",
  "documents",
  "aadharCardUrl",
  "panCardUrl",
  "photoUrl",
  "schedule",
  "payoutDetails",
];

const pickCookEditable = (obj) => {
  const out = {};
  for (const key of COOK_EDITABLE_FIELDS) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
};

const DOC_URL_FIELDS = ["aadharCardUrl", "panCardUrl", "photoUrl"];
const assertDocUrlsOwned = (body, ownerUserId) => {
  const { ownerIdOf } = require("../utils/storage");
  for (const key of DOC_URL_FIELDS) {
    const v = body[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || v.length > 500) {
      return `${key} must be text under 500 characters`;
    }
    if (v.startsWith("/uploads/")) {
      const owner = ownerIdOf(v);
      if (!owner || owner.toLowerCase() !== String(ownerUserId).toLowerCase()) {
        return "Document does not belong to this cook — upload it first";
      }
    } else if (!/^https:\/\/[^/]+\/.+/.test(v)) {
      return `${key} must be an uploaded document or an https link`;
    }
  }
  return null;
};
exports.getCooks = async (req, res, next) => {
  try {
    const { serviceType, serviceArea, search, date, durationHours, startTime, endTime } = req.query;
    const filter = {};

    const isAdmin = Boolean(req.user) && String(req.user.role).toUpperCase() === "ADMIN";
    if (!isAdmin) {
      filter.approvalStatus = "approved";
    }

    void serviceType;
    if (serviceArea) {
      const esc = String(serviceArea)
        .slice(0, 60)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.serviceArea = { $regex: esc, $options: "i" };
    }

    const searchText = String(search || "").trim().slice(0, 60);
    if (searchText && !isAdmin) {
      const escName = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matchedUsers = await User.find({ name: { $regex: escName, $options: "i" } })
        .select("_id")
        .limit(200)
        .lean();
      const ids = matchedUsers.map((u) => u._id);
      filter.$or = [
        { user: { $in: ids } },
        { specialties: { $regex: escName, $options: "i" } },
      ];
    }

    const userFields = !req.user
      ? "name status"
      : isAdmin
        ? "name email phone status"
        : "name status";
    const pg = paginationParams(req);
    let cookQuery = CookProfile.find(filter).populate("user", userFields).sort({ createdAt: -1 }).lean();
    if (pg.has) {
      cookQuery = cookQuery.skip(pg.skip).limit(pg.limit);
    } else {
      cookQuery = cookQuery.limit(HARD_CAP);
    }
    let cooks = await cookQuery;

    if (!req.user || String(req.user.role).toUpperCase() !== "ADMIN") {
      const flags = await Promise.all(
        cooks.map(async (cook) => {
          if (cook.user && cook.user.status === "suspended") return false;
          return resolveCookAvailability(cook);
        })
      );
      cooks = cooks.filter((_, i) => flags[i]);
    }

    if (searchText && isAdmin) {
      const searchLower = searchText.toLowerCase();
      cooks = cooks.filter(
        (cook) =>
          cook.user?.name?.toLowerCase().includes(searchLower) ||
          cook.specialties?.some((s) => s.toLowerCase().includes(searchLower))
      );
    }

    if (date) {
      const parsedDate = parseDay(date);
      if (!parsedDate || Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ message: "Invalid date" });
      }
      const { startTime: exactStartRaw, endTime: exactEndRaw } = req.query;
      let dur = null;
      if (durationHours != null && durationHours !== "") {
        dur = Number(durationHours);
        if (!Number.isFinite(dur) || dur < 0.5 || dur > 12) {
          return res.status(400).json({ message: "durationHours must be between 0.5 and 12" });
        }
      }
      let exactStart = null;
      let exactEnd = null;
      if (exactStartRaw != null || exactEndRaw != null) {
        if (!exactStartRaw || !exactEndRaw) {
          return res.status(400).json({ message: "startTime and endTime are both required" });
        }
        exactStart = timeToMinutes(String(exactStartRaw));
        exactEnd = timeToMinutes(String(exactEndRaw));
        if (exactStart == null || exactEnd == null || exactEnd <= exactStart) {
          return res.status(400).json({ message: "Invalid time slot" });
        }
        if (dur != null && Math.abs(exactEnd - exactStart - dur * 60) > 0.001) {
          return res.status(400).json({ message: "durationHours does not match startTime/endTime" });
        }
        dur = (exactEnd - exactStart) / 60;
      }
      const checks = (() => {
        const windowsPromise = getDayWindows(null, date);
        const cookIds = cooks.map((c) => c.user?._id || c.user);
        const { start, end } = require("../utils/slots").dayBounds(date);
        const Booking = require("../models/Booking");
        const { activeSlotMatch } = require("../utils/slots");
        const bookingsPromise = Booking.find({
          cook: { $in: cookIds },
          date: { $gte: start, $lte: end },
          $or: activeSlotMatch(),
        })
          .select("cook startTime endTime status")
          .lean();
        return Promise.all([windowsPromise, bookingsPromise]);
      })().then(([windows, allBookings]) => {
        const byCook = new Map();
        for (const b of allBookings || []) {
          const key = String(b.cook);
          if (!byCook.has(key)) byCook.set(key, []);
          byCook.get(key).push(b);
        }
        return cooks.map((cook) => {
          try {
            if (!windows.length) return false;
            const id = String(cook.user?._id || cook.user);
            const bookings = byCook.get(id) || [];
            if (exactStart != null) {
              const inside = windows.some((w) => {
                const ws = timeToMinutes(w.startTime);
                const we = timeToMinutes(w.endTime);
                return ws != null && we != null && ws <= exactStart && exactEnd <= we;
              });
              if (!inside) return false;
              return !bookings.some((b) => {
                const bs = timeToMinutes(b.startTime);
                const be = timeToMinutes(b.endTime);
                return bs != null && be != null && intervalsOverlap(exactStart, exactEnd, bs, be);
              });
            }
            if (dur == null) return true;
            return computeStartOptions(windows, bookings, dur).length > 0;
          } catch {
            return false;
          }
        });
      });
      const checkResults = await checks;
      cooks = cooks.filter((_, i) => checkResults[i]);
    }

    if (pg.has) {
      return sendList(res, cooks, pg, cooks.length);
    }
    res.json(cooks.length > HARD_CAP ? cooks.slice(0, HARD_CAP) : cooks);
  } catch (error) {
    next(error);
  }
};

exports.getCook = async (req, res, next) => {
  try {
    const isAdmin = Boolean(req.user) && String(req.user.role).toUpperCase() === "ADMIN";
    const userFields = !req.user ? "name status" : isAdmin ? "name email phone" : "name";
    let cook = null;
    try {
      cook = await CookProfile.findById(req.params.id).populate(
        "user",
        userFields
      );
    } catch {
      cook = null;
    }
    if (!cook) {
      cook = await CookProfile.findOne({ user: req.params.id }).populate(
        "user",
        userFields
      );
    }
    if (!cook) {
      return res.status(404).json({ message: "Cook profile not found" });
    }
    if (!isAdmin && (cook.approvalStatus !== "approved" || cook.user?.status === "suspended")) {
      return res.status(404).json({ message: "Cook profile not found" });
    }
    res.json(cook);
  } catch (error) {
    next(error);
  }
};

exports.getCookAdminOverview = async (req, res, next) => {
  try {
    let profile = null;
    try {
      profile = await CookProfile.findById(req.params.id).populate(
        "user",
        "name email phone status"
      );
    } catch {
      profile = null;
    }
    if (!profile) {
      profile = await CookProfile.findOne({ user: req.params.id }).populate(
        "user",
        "name email phone status"
      );
    }
    if (!profile) {
      return res.status(404).json({ message: "Cook profile not found" });
    }

    const Booking = require("../models/Booking");
    const bookings = await Booking.find({ cook: profile.user._id })
      .populate("customer", "name email phone")
      .sort({ createdAt: -1 });

    let reviews = [];
    let reviewByBookingId = {};
    try {
      const Review = require("../models/Review");
      reviews = await Review.find({ cook: profile.user._id })
        .populate("customer", "name")
        .populate("booking", "date serviceType startTime endTime status")
        .sort({ createdAt: -1 });
      reviewByBookingId = Object.fromEntries(
        reviews.map((r) => [
          r.booking?._id?.toString() || r.booking?.toString(),
          r.toObject ? r.toObject() : r,
        ])
      );
    } catch {
      reviews = [];
      reviewByBookingId = {};
    }
    const bookingsWithReviews = bookings.map((b) => {
      const obj = b.toObject ? b.toObject() : b;
      delete obj.serviceOtp;
      delete obj.serviceOtpGeneratedAt;
      delete obj.serviceOtpAttempts;
      delete obj.serviceOtpLockedUntil;
      return { ...obj, review: reviewByBookingId[b._id.toString()] || null };
    });

    const earnedOf = (b) =>
      b?.payment?.status === "paid" &&
      b?.payment?.razorpayPaymentId &&
      !b?.payment?.testMode
        ? Number(b?.payment?.paidAmount || 0)
        : 0;
    const CURRENT_STATUSES = ["requested", "accepted", "confirmed", "in_progress"];
    const completed = bookings.filter((b) => b.status === "completed");

    const earningsByService = {};
    for (const b of completed) {
      const key = b.serviceType || "unknown";
      if (!earningsByService[key]) {
        earningsByService[key] = { count: 0, earnings: 0, hours: 0 };
      }
      earningsByService[key].count += 1;
      earningsByService[key].earnings += earnedOf(b);
      earningsByService[key].hours += Number(b.durationHours || 0);
    }

    res.json({
      profile,
      bookings: bookingsWithReviews,
      reviews: reviews.map((r) => (r.toObject ? r.toObject() : r)),
      summary: {
        totalBookings: bookings.length,
        completedCount: completed.length,
        currentCount: bookings.filter((b) => CURRENT_STATUSES.includes(b.status)).length,
        totalEarnings: completed.reduce((s, b) => s + earnedOf(b), 0),
        totalHours: completed.reduce((s, b) => s + Number(b.durationHours || 0), 0),
        earningsByService,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.createCookProfile = async (req, res, next) => {
  try {
    const existingProfile = await CookProfile.findOne({ user: req.user.id });
    if (existingProfile) {
      return res.status(400).json({ message: "Cook profile already exists" });
    }

    const body = pickCookEditable(req.body);
    const docErr = assertDocUrlsOwned(body, req.user.id);
    if (docErr) {
      return res.status(400).json({ message: docErr });
    }
    if (body.skills != null && body.bio == null) body.bio = body.skills;
    if (body.bio != null && body.skills == null) body.skills = body.bio;
    const profile = await CookProfile.create({
      user: req.user.id,
      approvalStatus: "pending",
      ...body,
    });
    try {
      const { generateReferralCode } = require("../utils/cookEarnings");
      const CookReferral = require("../models/CookReferral");
      const me = await User.findById(req.user.id).select("name").lean();
      for (let i = 0; i < 3; i++) {
        try {
          profile.referralCode = generateReferralCode(me?.name || "COOK");
          profile.incentiveEnrolledAt = profile.incentiveEnrolledAt || new Date();
          const ref = await CookReferral.findOne({ referredCook: req.user.id }).select("referrer").lean();
          if (ref?.referrer) profile.referredBy = ref.referrer;
          await profile.save();
          break;
        } catch (e) {
          if (e?.code !== 11000) break;
        }
      }
      try {
        const { ensureIncentives } = require("../utils/cookEarningsService");
        await ensureIncentives(req.user.id);
      } catch {
      }
    } catch {
    }
    res.status(201).json(profile);
  } catch (error) {
    next(error);
  }
};

exports.getMyProfile = async (req, res, next) => {
  try {
    const profile = await CookProfile.findOne({ user: req.user.id }).populate(
      "user",
      "name email phone"
    );
    if (!profile) {
      return res.status(404).json({ message: "Cook profile not found" });
    }
    res.json(profile);
  } catch (error) {
    next(error);
  }
};

exports.updateCookProfile = async (req, res, next) => {
  try {
    const body = pickCookEditable(req.body);
    const docErr = assertDocUrlsOwned(body, req.user.id);
    if (docErr) {
      return res.status(400).json({ message: docErr });
    }
    if (body.skills != null && body.bio == null) body.bio = body.skills;
    if (body.bio != null && body.skills == null) body.skills = body.bio;
    if (body.schedule !== undefined) {
      if (typeof body.schedule !== "object" || body.schedule === null || Array.isArray(body.schedule)) {
        return res.status(400).json({ message: "Schedule must be an object" });
      }
      body.schedule.updatedAt = new Date();
    }
    if (body.payoutDetails !== undefined) {
      const { validatePayoutDetails } = require("../utils/finance");
      const { ok, reasons, normalized } = validatePayoutDetails(body.payoutDetails);
      if (!ok) {
        return res.status(400).json({ message: reasons[0], reasons });
      }
      body.payoutDetails = normalized;
    }
    const profile = await CookProfile.findOneAndUpdate(
      { user: req.user.id },
      body,
      { new: true, runValidators: true }
    );
    if (!profile) {
      return res.status(404).json({ message: "Cook profile not found" });
    }
    if (body.payoutDetails !== undefined) {
      try {
        const d = profile.payoutDetails || {};
        await CookProfile.updateOne(
          { user: req.user.id },
          {
            $push: {
              payoutDetailsHistory: {
                $each: [
                  {
                    method: d.method || "",
                    upiId: d.upiId || "",
                    holderName: d.holderName || "",
                    bankName: d.bankName || "",
                    accountLast4: d.accountLast4 || "",
                    ifsc: d.ifsc || "",
                    changedAt: new Date(),
                  },
                ],
                $slice: -20,
              },
            },
          }
        );
      } catch {
      }
    }
    res.json(profile);
  } catch (error) {
    next(error);
  }
};

exports.updateApprovalStatus = async (req, res, next) => {
  try {
    const profile = await CookProfile.findByIdAndUpdate(
      req.params.id,
      { approvalStatus: req.body.status },
      { new: true, runValidators: true }
    );
    if (!profile) {
      return res.status(404).json({ message: "Cook profile not found" });
    }

    const Notification = require("../models/Notification");
    await Notification.create({
      user: profile.user,
      type: req.body.status === "approved" ? "profile_approved" : "profile_rejected",
      message:
        req.body.status === "approved"
          ? "Your cook profile has been approved!"
          : "Your cook profile has been rejected.",
    });

    res.json(profile);
  } catch (error) {
    next(error);
  }
};

exports.getAvailableSlots = async (req, res, next) => {
  try {
    const Availability = require("../models/Availability");
    const CookProfile = require("../models/CookProfile");
    const { parseDay } = require("../utils/slots");
    const { date } = req.query;

    let cookId = req.params.id;
    let profile = null;
    try {
      profile = await CookProfile.findById(cookId).select("user availabilityStatus unavailableDate approvalStatus");
      if (profile?.user) cookId = profile.user.toString();
    } catch {
    }
    if (!profile) {
      profile = await CookProfile.findOne({ user: cookId }).select(
        "availabilityStatus unavailableDate approvalStatus"
      );
    }

    if (profile && !(await resolveCookAvailability(profile))) {
      return res.json([]);
    }

    const viewerAdmin = req.user && String(req.user.role).toUpperCase() === "ADMIN";
    const viewerSelf = req.user?.id != null && String(req.user.id) === String(cookId);
    if (profile && !viewerAdmin && !viewerSelf) {
      let suspended = false;
      try {
        const cookUser = await User.findById(cookId).select("status");
        suspended = cookUser?.status === "suspended";
      } catch {
        suspended = false;
      }
      if (profile.approvalStatus !== "approved" || suspended) {
        return res.json([]);
      }
    }

    const filter = { cook: cookId, status: "available" };
    if (date) {
      const bounds = dayBounds(date);
      if (!bounds) {
        return res.status(400).json({ message: "Invalid date" });
      }
      filter.date = { $gte: bounds.start, $lte: bounds.end };
    }

    const slots = await Availability.find(filter).sort({ date: 1, startTime: 1 });
    res.json(slots);
  } catch (error) {
    next(error);
  }
};

exports.uploadCookDocs = async (req, res, next) => {
  try {
    const urls = {};
    if (req.files?.aadhar?.[0]) {
      urls.aadharCardUrl = `/uploads/cook-docs/${req.files.aadhar[0].filename}`;
    }
    if (req.files?.pan?.[0]) {
      urls.panCardUrl = `/uploads/cook-docs/${req.files.pan[0].filename}`;
    }
    if (req.files?.photo?.[0]) {
      urls.photoUrl = `/uploads/cook-docs/${req.files.photo[0].filename}`;
    }
    if (!Object.keys(urls).length) {
      return res.status(400).json({ message: "No files uploaded" });
    }
    res.json(urls);
  } catch (error) {
    next(error);
  }
};

exports.toggleAvailability = async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (status !== "available" && status !== "unavailable") {
      return res.status(400).json({ message: "Status must be 'available' or 'unavailable'" });
    }

    const profile = await CookProfile.findOneAndUpdate(
      { user: req.user.id },
      {
        availabilityStatus: status,
        unavailableDate: status === "unavailable" ? localDayString() : "",
      },
      { new: true }
    );
    if (!profile) {
      return res.status(404).json({ message: "Cook profile not found" });
    }
    res.json(profile);
  } catch (error) {
    next(error);
  }
};

exports.adminUploadCookDocs = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid cook id" });
    }

    let profile = await CookProfile.findById(id);
    if (!profile) {
      const cookUser = await User.findOne({ _id: id, role: "COOK" });
      if (cookUser) {
        profile = await CookProfile.findOne({ user: cookUser._id });
      }
    }
    if (!profile) {
      return res.status(404).json({ message: "Cook profile not found" });
    }

    const uploaded = [
      ...(req.files?.aadhar || []),
      ...(req.files?.pan || []),
      ...(req.files?.photo || []),
    ];
    const reownToCook = (file) => {
      const fs = require("fs");
      const path = require("path");
      const { uploadDir } = require("../utils/storage");
      const parts = String(file.filename).split("_");
      parts[1] = String(profile.user);
      const owned = parts.join("_");
      if (owned !== file.filename) {
        fs.renameSync(path.join(uploadDir, file.filename), path.join(uploadDir, owned));
      }
      return owned;
    };
    const urls = {};
    try {
      if (req.files?.aadhar?.[0]) {
        urls.aadharCardUrl = `/uploads/cook-docs/${reownToCook(req.files.aadhar[0])}`;
      }
      if (req.files?.pan?.[0]) {
        urls.panCardUrl = `/uploads/cook-docs/${reownToCook(req.files.pan[0])}`;
      }
      if (req.files?.photo?.[0]) {
        urls.photoUrl = `/uploads/cook-docs/${reownToCook(req.files.photo[0])}`;
      }
    } catch (err) {
      const fs = require("fs");
      const path = require("path");
      const { uploadDir } = require("../utils/storage");
      for (const f of uploaded) {
        try {
          fs.unlinkSync(path.join(uploadDir, f.filename));
        } catch {
        }
      }
      return res.status(500).json({ message: "Could not store the uploaded documents. Please try again." });
    }
    if (!Object.keys(urls).length) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    Object.assign(profile, urls);
    await profile.save();

    try {
      await Notification.create({
        user: profile.user,
        type: "general",
        message: "An admin added your verification documents. Please check your profile.",
      });
    } catch {
    }

    res.json(profile);
  } catch (error) {
    next(error);
  }
};