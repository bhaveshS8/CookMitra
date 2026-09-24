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

// Fields a cook may set on their own profile. Everything else
// (approvalStatus, rating, user) is admin-managed and must NOT be writable
// via the generic create/update handlers — otherwise a cook could
// self-approve, inflate their rating, or reassign the profile's owner.
// (Unknown keys like a legacy `liveLocation` are dropped by the whitelist.)
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
  // Working hours + blocked dates the cook publishes (schedule-aware slot
  // engine reads these). updatedAt is set server-side below, never trusted
  // from the body.
  "schedule",
  // Where the cook's 75% is paid — UPI id / bank details. Only the last 4
  // digits of an account are ever stored.
  "payoutDetails",
];

const pickCookEditable = (obj) => {
  const out = {};
  for (const key of COOK_EDITABLE_FIELDS) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
};

// Document URLs in the private pipeline are always relative /uploads paths
// whose filename embeds the OWNER cook's user id. A cook must not be able to
// claim another cook's file (or an arbitrary path) by writing a foreign URL
// into their own profile — every /uploads/ doc URL saved must belong to them.
// Returns an error message string, or null when all URLs check out.
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
      // Absolute URLs (Google avatars, CDN) must be plain https links —
      // never data:/javascript:/relative escapes that reach odd parsers.
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

    // Every cook offers ALL service types: the serviceType query param is
    // accepted for URL compatibility but no longer filters the list —
    // customers pick a service and see every approved cook, since all cooks
    // can perform any service. (The value never reaches Mongoose, so the old
    // ?serviceType[$ne]=x injection concern is moot.)
    void serviceType;
    // Escape user input before $regex (no ReDoS / pattern injection) + cap.
    if (serviceArea) {
      const esc = String(serviceArea)
        .slice(0, 60)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.serviceArea = { $regex: esc, $options: "i" };
    }

    // Name search pushed into Mongo (not in-memory over every cook): match
    // via the populated user through an aggregation-friendly two-step —
    // first resolve matching user ids (indexed name prefix), then filter.
    // Capped to 200 ids so a one-letter query can't fan out unbounded.
    const searchText = String(search || "").trim().slice(0, 60);
    if (searchText && !isAdmin) {
      const escName = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matchedUsers = await User.find({ name: { $regex: escName, $options: "i" } })
        .select("_id")
        .limit(200)
        .lean();
      const ids = matchedUsers.map((u) => u._id);
      // Specialties live on the profile — $or user-match OR specialty-match.
      filter.$or = [
        { user: { $in: ids } },
        { specialties: { $regex: escName, $options: "i" } },
      ];
    }

    // Contact PII: guests see discovery fields only; signed-in users see
    // the same (cook phones are shared post-accept via booking payloads —
    // nothing in discovery UI consumes them); admins see email too.
    const userFields = !req.user
      ? "name status"
      : isAdmin
        ? "name email phone status"
        : "name status";
    // Server-side paging FIRST (bounded in Mongo): without ?page=&limit= the
    // legacy full-array path applies (HARD_CAP 500). With params we skip/limit
    // at the DB so 1000-user browsing never loads the whole collection.
    const pg = paginationParams(req);
    let cookQuery = CookProfile.find(filter).populate("user", userFields).sort({ createdAt: -1 });
    if (pg.has) {
      cookQuery = cookQuery.skip(pg.skip).limit(pg.limit);
    } else {
      // Legacy array response: cap the DB read at the same HARD_CAP the
      // response applies, so an un-paged call can never stream the whole
      // collection into memory under load.
      cookQuery = cookQuery.limit(HARD_CAP);
    }
    let cooks = await cookQuery;

    // Hide cooks whose account was blocked or deleted by an admin so they
    // can no longer be discovered or booked by customers. Admins still see
    // everything so they can manage the accounts. Also hide cooks who have
    // toggled themselves "unavailable" (auto-reset the next day).
    if (!req.user || String(req.user.role).toUpperCase() !== "ADMIN") {
      const flags = await Promise.all(
        cooks.map(async (cook) => {
          if (cook.user && cook.user.status === "suspended") return false;
          return resolveCookAvailability(cook);
        })
      );
      cooks = cooks.filter((_, i) => flags[i]);
    }

    // Admin free-text search (name/specialty) still needs the in-memory pass —
    // the DB-level filter above already handled the public case.
    if (searchText && isAdmin) {
      const searchLower = searchText.toLowerCase();
      cooks = cooks.filter(
        (cook) =>
          cook.user?.name?.toLowerCase().includes(searchLower) ||
          cook.specialties?.some((s) => s.toLowerCase().includes(searchLower))
      );
    }

    // Availability filter: hide cooks with nothing bookable on the date.
    // date alone -> at least one open window; date + durationHours -> at
    // least one free start option after subtracting existing bookings;
    // date + startTime + endTime -> that exact window must be free (so a cook
    // busy 10:00-13:00 never shows for a 10:00-13:00 search).
    // BATCHED: one availability lookup + one bookings lookup for the whole
    // page (not 2 queries per cook), then pure in-memory math per cook.
    if (date) {
      // Local-midnight parse like the slot engine — new Date("YYYY-MM-DD")
      // is UTC midnight and validates/wraps to the wrong local day.
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
      // Exact-window mode: validate the requested interval up front.
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
        // Windows are universal (08:00-20:00) — compute once, reuse per cook.
        // Bookings differ per cook but one $in query beats N round trips.
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
              // The exact [startTime, endTime] must sit inside one open window
              // and overlap no existing booking.
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
      // Await ONCE (the promise is shared, awaiting per-item would re-wrap it).
      const checkResults = await checks;
      cooks = cooks.filter((_, i) => checkResults[i]);
    }

    // Post-filter paging response: when ?page=&limit= was used the DB already
    // bounded the page; total counts the filtered page-set (documented inline).
    // Without params the legacy full-array path applies (HARD_CAP 500).
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
    // Guests and signed-in non-admins see discovery fields only (no contact
    // PII); see getCooks. Phones arrive post-accept via booking payloads.
    const userFields = !req.user ? "name status" : isAdmin ? "name email phone" : "name";
    // Accept either a CookProfile id (/cooks/:id pages) or a User id
    // (e.g. dashboard "View Cook Profile" links over populated cooks).
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
    // Unapproved / suspended cooks are invisible to the public (the listing
    // filters them too) — the admin dossier endpoint covers admin access.
    if (!isAdmin && (cook.approvalStatus !== "approved" || cook.user?.status === "suspended")) {
      return res.status(404).json({ message: "Cook profile not found" });
    }
    res.json(cook);
  } catch (error) {
    next(error);
  }
};

// Admin-only: full cook dossier — profile + contact/address/documents,
// every booking (customer + service address + hours), and earnings/hours
// summary (total + per service). Accepts a CookProfile id or a User id.
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

    // Customer ratings for each service (one per booking max) + full list.
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
      // Never expose service-start OTP secrets through the admin overview —
      // admins manage the profile, they never need the customer OTP. StartedAt
      // /EndsAt evidence fields are kept (operational, not secret).
      delete obj.serviceOtp;
      delete obj.serviceOtpGeneratedAt;
      delete obj.serviceOtpAttempts;
      delete obj.serviceOtpLockedUntil;
      return { ...obj, review: reviewByBookingId[b._id.toString()] || null };
    });

    // Earnings count ONLY real captured payments (status "paid" with a
    // received gateway payment id). Pending amounts never count — and neither
    // does test-mode/dev money, which carries a synthetic pay_test_* id and
    // must not inflate the admin earnings picture (payout queue already
    // excludes testMode the same way).
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
    // Keep legacy `bio` and renamed `skills` in sync — old clients send only
    // bio, the new form sends skills.
    if (body.skills != null && body.bio == null) body.bio = body.skills;
    if (body.bio != null && body.skills == null) body.skills = body.bio;
    const profile = await CookProfile.create({
      user: req.user.id,
      // New profiles always start "pending" until an admin approves them —
      // approvalStatus can never come from the request body.
      approvalStatus: "pending",
      ...body,
    });
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
    // Whitelist-only: admin-managed fields (approvalStatus, rating, user) can
    // never be written through the generic profile editor.
    const body = pickCookEditable(req.body);
    const docErr = assertDocUrlsOwned(body, req.user.id);
    if (docErr) {
      return res.status(400).json({ message: docErr });
    }
    if (body.skills != null && body.bio == null) body.bio = body.skills;
    if (body.bio != null && body.skills == null) body.skills = body.bio;
    // Server-stamped audit times — a client cannot forge these. Guard the
    // type first: assigning a property on a non-object schedule (string,
    // number) would throw a TypeError and 500 instead of a clean 400.
    if (body.schedule !== undefined) {
      if (typeof body.schedule !== "object" || body.schedule === null || Array.isArray(body.schedule)) {
        return res.status(400).json({ message: "Schedule must be an object" });
      }
      body.schedule.updatedAt = new Date();
    }
    if (body.payoutDetails !== undefined) {
      // Payout destinations are money-critical: format-validated, normalized
      // and history-trailed server-side (the cook form only hints at formats).
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
    // Advisory change trail (best-effort): a destination swapped right before
    // settlement stays auditable. Settlements additionally freeze their own
    // copy on the booking, so history here is defense in depth.
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
        // non-fatal: the save above already succeeded
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

    // Accept either a CookProfile id (/cooks/:id pages) or a User id, consistent
    // with getCook / getCookReviews / getCookAdminOverview. Availability.cook
    // stores the user id, so a bare profile id would otherwise match nothing.
    let cookId = req.params.id;
    let profile = null;
    try {
      profile = await CookProfile.findById(cookId).select("user availabilityStatus unavailableDate approvalStatus");
      if (profile?.user) cookId = profile.user.toString();
    } catch {
      // not a profile id — fall through and use the param as a user id
    }
    if (!profile) {
      profile = await CookProfile.findOne({ user: cookId }).select(
        "availabilityStatus unavailableDate approvalStatus"
      );
    }

    // A cook who has toggled "unavailable" exposes no bookable slots until they
    // become available again on their own OR the next day begins.
    if (profile && !(await resolveCookAvailability(profile))) {
      return res.json([]);
    }

    // Mirror getCook: unapproved / suspended cooks expose no public slots.
    // The cook themself and admins still see the raw list.
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
      // IST business-day range (F-08) — matches how slots are stored.
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

// Cook uploads ID verification files (Aadhaar / PAN / photo).
// Expects multipart/form-data with fields: aadhar, pan, photo (each max 1).
// Returns relative URLs { aadharCardUrl, panCardUrl, photoUrl } which the
// client then saves via POST / PUT cook profile.
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

// Cook toggles themselves between "available" and "unavailable". While
// unavailable they are hidden from all booking until they toggle back OR the
// next day begins (auto reset handled by resolveCookAvailability on read).
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
        // Record the local day we went unavailable so the next-day auto reset
        // has an expiry to compare against.
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

// Admin uploads verification docs ON BEHALF of a cook (e.g. files received
// over email/WhatsApp). Same multipart fields as the cook self-upload
// (aadhar, pan, photo — at least one), but the files are attached straight
// onto the cook's profile here instead of being returned as URLs, and the
// cook is notified. :id may be a CookProfile id OR the cook's User id.
exports.adminUploadCookDocs = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid cook id" });
    }

    // Resolve the profile: accept a CookProfile id or the cook's User id.
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

    // F-02 fix: multer names every file after the UPLOADER (req.user.id —
    // here the admin). Re-own each file to the cook BEFORE attaching, so the
    // filename owner segment, the static gate, and the signed-URL gate all see
    // the cook. On any failure the just-uploaded files are removed and the
    // request fails instead of attaching wrong-owner documents.
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
          // best-effort cleanup
        }
      }
      return res.status(500).json({ message: "Could not store the uploaded documents. Please try again." });
    }
    if (!Object.keys(urls).length) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    // Attach only the fields actually uploaded — never wipe the others.
    Object.assign(profile, urls);
    await profile.save();

    // Let the cook know their documents were added by support.
    try {
      await Notification.create({
        user: profile.user,
        type: "general",
        message: "An admin added your verification documents. Please check your profile.",
      });
    } catch {
      // A failed notification must not fail the upload.
    }

    res.json(profile);
  } catch (error) {
    next(error);
  }
};