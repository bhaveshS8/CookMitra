const mongoose = require("mongoose");
const EventBooking = require("../models/EventBooking");
const EventType = require("../models/EventType");
const User = require("../models/User");
const CookProfile = require("../models/CookProfile");
const Notification = require("../models/Notification");
const EventOutbox = require("../models/EventOutbox");
const { calculateEventPrice, travelChargeForDistance, getPricingTable } = require("../utils/eventPricing");
const { paginationParams, applyPagination, sendList, HARD_CAP } = require("../utils/pagination");
const {
  enqueueEventOutbox,
  deliverOutboxEvent,
  withEventTransaction,
} = require("../utils/eventOutbox");

// Human-readable id: EVT-XXXXXX (unique).
const generateBookingId = () =>
  `EVT-${Date.now().toString(36).toUpperCase()}${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;

// Allowed status moves (§15). Assignment goes through assignCook().
const ALLOWED_TRANSITIONS = {
  pending: ["cook_assigned", "cancelled"],
  cook_assigned: ["confirmed", "cancelled"],
  confirmed: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

// ── Timezone policy ─────────────────────────────────────────────────────
// Single explicit policy: ALL booking dates/times are interpreted in
// Asia/Kolkata (IST, UTC+5:30), independent of the server's local timezone
// and the browser's timezone. Rationale: the product serves Indian home
// events; IST is the business timezone. Frontend sends YYYY-MM-DD (date
// input) + HH:MM (time input); backend compares IST calendar days.
// Same-day bookings ARE allowed (existing business rule: frontend min=today,
// backend day<today, default form value=tomorrow) — but a same-day startTime
// that has already passed in IST is rejected.
const IST_OFFSET_MIN = 330;
const toIST = (d) => new Date(d.getTime() + (d.getTimezoneOffset() + IST_OFFSET_MIN) * 60000);
const istNow = () => toIST(new Date());
const istDayStr = (d) => {
  const ist = toIST(new Date(d));
  const p = (n) => String(n).padStart(2, "0");
  return `${ist.getFullYear()}-${p(ist.getMonth() + 1)}-${p(ist.getDate())}`;
};
const istTodayStr = () => istDayStr(new Date());
const istNowMinutes = () => {
  const n = istNow();
  return n.getHours() * 60 + n.getMinutes();
};

// Strict "HH:MM" 24h clock. The old prefix regex /^(\d{1,2}):(\d{2})/ accepted
// "9:00abc", "12:34:56" and "9:00 " — now rejected.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const timeToMinutes = (t) => {
  const m = String(t || "").match(TIME_RE);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

const sameDayIST = (a, b) => istDayStr(a) === istDayStr(b);

// Session window a booking occupies: start → start + duration + extraHours.
// duration = base booked service hours (1–8); extraHours = additional hours
// billed via the extra-hour table (0–12). Effective total = duration +
// extraHours; price, UI labels, persisted fields and scheduling all use this
// interpretation. Overnight (end > 24:00) is rejected — unsupported.
const bookingWindow = (b) => {
  const s = timeToMinutes(b.startTime);
  if (s == null) return null;
  const span = (Number(b.duration) || 0) * 60 + (Number(b.extraHours) || 0) * 60;
  if (!Number.isFinite(span) || span <= 0) return null;
  return { start: s, end: s + span };
};

// Adjacent bookings (end == start) do NOT overlap — consistent boundary rule.
const windowsOverlap = (a, b) => a.start < b.end && b.start < a.end;

// §20 rule 5 — a cook cannot have overlapping bookings. Checks the cook's
// other live event bookings on the same IST day for an overlapping window.
// Live = pending (assigned ones block; unassigned have cookId null and never
// match a real cook query) + cook_assigned + confirmed + in_progress.
// Cancelled/completed never block.
const LIVE_STATUSES = ["cook_assigned", "confirmed", "in_progress", "pending"];
const findEventOverlap = async (cookId, eventDate, window, excludeId = null) => {
  const q = { cookId, bookingStatus: { $in: LIVE_STATUSES } };
  if (excludeId) q._id = { $ne: excludeId };
  const others = await EventBooking.find(q).select("eventDate startTime duration extraHours bookingId");
  return (others || []).find((o) => {
    if (!sameDayIST(o.eventDate, eventDate)) return false;
    const w = bookingWindow(o);
    return w && windowsOverlap(w, window);
  });
};

// Strict finite-number guard — rejects NaN/Infinity/booleans/empty instead of
// coercing to 0 (the old `Number(x) || 0` gave free travel on garbage input).
const strictNumber = (v) => {
  if (typeof v === "boolean" || v === "" || v == null) return NaN;
  return Number(v);
};

// Log notification failures safely: booking id only, never PII/secrets.
const logNotifyError = (bookingId, err) => {
  try {
    console.error(`[event-notify] delivery failed for booking ${bookingId || "?"}: ${err?.message || err} — outbox retry will replay it`);
  } catch {
    // never throw from logging
  }
};

// Atomic conditional status update: only succeeds when the booking is still
// at the expected version AND in one of the expected statuses. Returns the
// updated doc, or null when the booking is missing (caller maps to 404) vs
// concurrently modified (caller maps to 409). Accepts an optional transaction
// session so the mutation can commit atomically with its outbox enqueue.
const atomicBookingUpdate = async ({ bookingId, expectedVersion, expectedStatuses, set, pushHistory }, session = null) => {
  const filter = { _id: bookingId, __v: expectedVersion };
  if (expectedStatuses) filter.bookingStatus = { $in: expectedStatuses };
  const update = { $set: set, $inc: { __v: 1 } };
  if (pushHistory) update.$push = { statusHistory: pushHistory };
  const opts = { new: true };
  if (session) opts.session = session;
  return EventBooking.findOneAndUpdate(filter, update, opts);
};

// Runs a booking mutation together with its outbox enqueue: atomically on
// replica sets (withEventTransaction), sequentially otherwise. mutate(session)
// must perform the atomicBookingUpdate and the enqueueEventOutbox and return
// { updated, outboxDoc }.
const commitBookingMutation = async (mutate) => withEventTransaction(mutate);

// Immediate (in-band) delivery attempt for a freshly enqueued event.
// Preserves the existing UX timing (notices appear at once). ANY failure is
// safe: the outbox row stays pending and the worker replays it. Never throws.
const deliverOutboxBestEffort = async (outboxDoc, bookingPublicId) => {
  try {
    if (!outboxDoc) return;
    await deliverOutboxEvent(outboxDoc);
  } catch (e) {
    logNotifyError(bookingPublicId, e);
  }
};

// Durably flag a failed assignment revert for admin action: persists an
// outbox event to every active admin (retried by the worker) AND logs loudly
// with the booking id so operators can find it without the dashboard.
const flagRevertFailureForAdmins = async (bookingPublicId, detail) => {
  const logLine = `[event-revert-FAILED] booking ${bookingPublicId}: ${detail} — MANUAL REVIEW REQUIRED`;
  try {
    const admins = await User.find({ role: "ADMIN", status: "active" }).select("_id");
    if (!admins || admins.length === 0) {
      console.error(`${logLine} (no active admins to notify)`);
      return;
    }
    // Stable key per booking: repeated failures flag once, worker retries
    // delivery until an admin can see it.
    const outboxDoc = await enqueueEventOutbox({
      eventKey: `${bookingPublicId}:revert-failed`,
      bookingPublicId,
      action: "revert_failed",
      recipients: admins.map((a) => ({
        user: a._id,
        type: "general",
        message: `ACTION NEEDED: event booking ${bookingPublicId} needs manual review — ${detail}`,
      })),
    });
    console.error(logLine);
    await deliverOutboxBestEffort(outboxDoc, bookingPublicId);
  } catch (e) {
    console.error(`${logLine} (flagging failed: ${(e && e.message) || e})`);
  }
};

// Shared conditional revert for a just-written cook_assigned update.
// Verifies the EXACT assignment it intends to undo — the same booking id,
// the exact version it observed, the cook it assigned, and the cook_assigned
// status — so a reassignment or any other mutation that moved the document
// in between makes the revert miss (never undo someone else's change).
// Returns the reverted doc or null.
const revertAssignment = async ({ updated, prevCook, prevStatus, note }) =>
  EventBooking.findOneAndUpdate(
    { _id: updated._id, __v: updated.__v, bookingStatus: "cook_assigned", cookId: updated.cookId },
    {
      $set: { cookId: prevCook || null, bookingStatus: prevStatus },
      $push: { statusHistory: { status: prevStatus, note } },
      $inc: { __v: 1 },
    },
    { new: true }
  );

const classifyUpdateMiss = async (bookingId) => {
  const current = await EventBooking.findById(bookingId).select("bookingStatus");
  if (!current) return { status: 404, message: "Event booking not found" };
  return { status: 409, message: "This booking was just updated by someone else — please reload and retry." };
};

// Query-string status filter: accept ONLY a plain string from the known
// status set; anything else (objects from ?status[$ne]=x, unknown values)
// is rejected with 400 so it can never reach a Mongo filter or silently
// return an unfiltered list.
const BOOKING_STATUSES = Object.keys(ALLOWED_TRANSITIONS);
const applyStatusFilter = (filter, raw, res) => {
  if (raw === undefined) return true;
  if (typeof raw !== "string" || !BOOKING_STATUSES.includes(raw)) {
    res.status(400).json({ message: "Invalid status filter" });
    return false;
  }
  filter.bookingStatus = raw;
  return true;
};

// Customer creates a booking request — status starts at PENDING (§10).
// No cook is chosen here; price is recomputed server-side (§20 rule 10).
// customerId comes from auth (never the body); amounts/status/cook/history
// are server-generated (mass-assignment allowlist below).
exports.createEventBooking = async (req, res, next) => {
  try {
    // Explicit allowlist — any other body keys (customerId, cookId,
    // bookingStatus, statusHistory, serviceAmount, ...) are ignored.
    const {
      eventType,
      eventDate,
      startTime,
      duration,
      guestCount,
      address,
      area = "",
      landmark = "",
      foodType = "Full Meal",
      menu,
      serviceType,
      additionalCook = 0,
      extraHours = 0,
      distanceKm = 0,
      distance,
      customerNotes = "",
    } = req.body || {};

    // Event type: must match an ACTIVE catalogue entry (trimmed,
    // case-insensitive exact match — same rule as the admin duplicate guard,
    // since the unique index itself is case-sensitive). The booking stores
    // the catalogue's canonical name so "birthday" vs "Birthday" never
    // forks history. Historical labels stay plain strings so renames/deletes
    // are safe; deactivated/deleted types still cannot be booked while newly
    // created valid types work immediately.
    const eventTypeName = String(eventType || "").trim();
    if (!eventTypeName) return res.status(400).json({ message: "Event type is required" });
    const escaped = eventTypeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const catalogueEntry = await EventType.findOne({
      name: { $regex: `^${escaped}$`, $options: "i" },
      active: true,
    });
    if (!catalogueEntry) {
      return res.status(400).json({ message: "That event type is no longer available — please go back to Step 1 and pick one from the list" });
    }
    const canonicalEventType = catalogueEntry.name;
    if (!EventBooking.EVENT_SERVICES.includes(serviceType)) {
      return res.status(400).json({ message: "Valid service type is required" });
    }
    if (!EventBooking.EVENT_FOOD_TYPES.includes(foodType)) {
      return res.status(400).json({ message: "Invalid food type" });
    }

    // Date: accept YYYY-MM-DD (date input) as an IST calendar day, else fall
    // back to Date parsing with IST-day comparison. Reject past IST days.
    let eventDayStr = null;
    let day = null;
    if (typeof eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(eventDate.trim())) {
      const [y, m, d] = eventDate.trim().split("-").map(Number);
      const check = new Date(y, m - 1, d);
      if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) {
        return res.status(400).json({ message: "Valid event date is required" });
      }
      eventDayStr = eventDate.trim();
      day = new Date(y, m - 1, d, 12, 0, 0, 0); // noon local avoids DST edges
    } else {
      day = new Date(eventDate);
      if (Number.isNaN(day.getTime())) {
        return res.status(400).json({ message: "Valid event date is required" });
      }
      eventDayStr = istDayStr(day);
    }
    const todayStr = istTodayStr();
    if (eventDayStr < todayStr) {
      return res.status(400).json({ message: "Event date cannot be in the past" });
    }

    const startMin = timeToMinutes(startTime);
    if (startMin == null) {
      return res.status(400).json({ message: "Valid start time (HH:MM) is required" });
    }
    // Same-day rule: start time must still be in the future in IST.
    if (eventDayStr === todayStr && startMin <= istNowMinutes()) {
      return res.status(400).json({ message: "Start time has already passed today — please pick a later time" });
    }

    const dur = strictNumber(duration);
    if (!Number.isFinite(dur) || dur < 1 || dur > 8) {
      return res.status(400).json({ message: "Duration must be between 1 and 8 hours" });
    }
    const guests = strictNumber(guestCount);
    if (!Number.isFinite(guests) || !Number.isInteger(guests) || guests < 1 || guests > 1000) {
      return res.status(400).json({ message: "Guest count must be between 1 and 1000" });
    }
    const cooksN = strictNumber(additionalCook);
    if (!Number.isFinite(cooksN) || !Number.isInteger(cooksN) || cooksN < 0 || cooksN > 10) {
      return res.status(400).json({ message: "Additional cooks must be between 0 and 10" });
    }
    const extraN = strictNumber(extraHours);
    if (!Number.isFinite(extraN) || extraN < 0 || extraN > 12) {
      return res.status(400).json({ message: "Extra hours must be between 0 and 12" });
    }
    const distInput = distanceKm ?? distance ?? 0;
    const distN = strictNumber(distInput);
    if (!Number.isFinite(distN) || distN < 0 || distN > 100000) {
      return res.status(400).json({ message: "Distance must be between 0 and 100000 km" });
    }
    if (!address || !String(address).trim()) {
      return res.status(400).json({ message: "Address is required" });
    }
    if (!menu || !String(menu).trim()) {
      return res.status(400).json({ message: "Please enter your menu requirements" });
    }
    if (String(customerNotes || "").length > 2000) {
      return res.status(400).json({ message: "Notes are too long (max 2000 characters)" });
    }

    // Overnight guard: start + effective duration must stay within the day.
    const spanMin = dur * 60 + extraN * 60;
    if (startMin + spanMin > 24 * 60) {
      return res.status(400).json({ message: "Overnight events are not supported — please shorten the duration" });
    }

    let quote;
    try {
      quote = await calculateEventPrice({
        serviceType,
        duration: dur,
        distanceKm: distN,
        additionalCook: cooksN,
        extraHours: extraN,
      });
    } catch (e) {
      return res.status(400).json({ message: e.message || "Could not calculate price" });
    }

    // Booking insert + outbox enqueue commit together when transactions are
    // available (replica set); sequentially otherwise (same order, the crash
    // gap is logged and documented).
    const createPayload = {
      bookingId: generateBookingId(),
      customerId: req.user.id,
      eventType: canonicalEventType,
      eventDate: day,
      startTime: String(startTime),
      duration: dur,
      guestCount: guests,
      address: String(address).trim(),
      area: String(area || "").trim(),
      landmark: String(landmark || "").trim(),
      foodType,
      menu: String(menu).trim(),
      serviceType,
      additionalCook: cooksN,
      extraHours: Math.round(extraN * 100) / 100,
      distanceKm: distN,
      distanceVerified: false, // customer estimate — provisional until admin verifies
      serviceAmount: quote.serviceAmount,
      additionalCookAmount: quote.additionalCookAmount,
      extraHourAmount: quote.extraHourAmount,
      travelCharge: quote.travelCharge,
      totalAmount: quote.totalAmount,
      bookingStatus: "pending",
      customerNotes: String(customerNotes || ""),
      statusHistory: [{ status: "pending", note: "Booking request received" }],
    };
    let booking;
    let requestOutbox = null;
    let catalogueGone = false;
    try {
      const { result } = await commitBookingMutation(async (session) => {
        // Task 4 — catalogue guard (shared-document write protocol): the
        // active-type check above is a plain read, so an admin deactivating
        // the type between the check and this commit would otherwise slip
        // through. A conditional same-value write on the EventType document
        // INSIDE the transaction means: a deactivation that committed first
        // makes the filter miss (booking not created → 400), and one racing
        // mid-transaction causes a write-write conflict → retry → re-filter.
        // The guard can never activate a type (it only writes active:true to
        // docs that already are). A deactivation landing AFTER this commit
        // intentionally does NOT invalidate the booking (historical labels
        // survive catalogue changes — see EventType docs).
        const typeGuard = await EventType.findOneAndUpdate(
          { _id: catalogueEntry._id, active: true },
          { $set: { active: true, updatedAt: new Date() } },
          session ? { session } : {}
        );
        if (!typeGuard) return { updated: null, outboxDoc: null, catalogueGone: true };
        const created = session
          ? (await EventBooking.create([createPayload], { session }))[0]
          : await EventBooking.create(createPayload);
        let outboxDoc = null;
        const admins = session
          ? await User.find({ role: "ADMIN", status: "active" }).select("_id").session(session)
          : await User.find({ role: "ADMIN", status: "active" }).select("_id");
        if (admins && admins.length > 0) {
          outboxDoc = await enqueueEventOutbox(
            {
              eventKey: `${created.bookingId}:request:${created.__v}`,
              bookingId: created._id,
              bookingPublicId: created.bookingId,
              action: "request",
              recipients: admins.map((a) => ({
                user: a._id,
                type: "event_booking_request",
                message: `New event booking ${created.bookingId}: ${canonicalEventType} on ${eventDayStr} — please assign a cook.`,
              })),
            },
            session
          );
        }
        return { updated: created, outboxDoc };
      });
      booking = result.updated;
      requestOutbox = result.outboxDoc;
      catalogueGone = result.catalogueGone === true;
    } catch (e) {
      // Transaction abort / envelopes: never report success for a failed op.
      throw e;
    }

    // Deactivated between the read and the guarded commit: nothing was
    // inserted, nothing was enqueued — same honest 400 as the pre-check.
    if (catalogueGone || !booking) {
      return res.status(400).json({
        message: "That event type is no longer available — please go back to Step 1 and pick one from the list",
      });
    }

    // Immediate delivery preserves existing timing; any failure stays queued
    // for the worker — the booking response is unaffected (already committed).
    await deliverOutboxBestEffort(requestOutbox, booking.bookingId);

    res.status(201).json(booking);
  } catch (error) {
    if (error && error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    next(error);
  }
};

const populateBooking = (q) =>
  q
    .populate("customerId", "name email phone mobile")
    .populate("cookId", "name email phone mobile avatar");

exports.getMyEventBookings = async (req, res, next) => {
  try {
    const filter = { customerId: req.user.id };
    if (!applyStatusFilter(filter, req.query.status, res)) return;
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      populateBooking(EventBooking.find(filter)).sort({ eventDate: 1 }).limit(HARD_CAP),
      pg
    );
    return sendList(res, bookings, pg, () => EventBooking.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

exports.getCookEventBookings = async (req, res, next) => {
  try {
    const filter = { cookId: req.user.id };
    if (!applyStatusFilter(filter, req.query.status, res)) return;
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      populateBooking(EventBooking.find(filter)).sort({ eventDate: 1 }).limit(HARD_CAP),
      pg
    );
    return sendList(res, bookings, pg, () => EventBooking.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

exports.getAdminEventBookings = async (req, res, next) => {
  try {
    const filter = {};
    if (!applyStatusFilter(filter, req.query.status, res)) return;
    const pg = paginationParams(req);
    const bookings = await applyPagination(
      populateBooking(EventBooking.find(filter)).sort({ createdAt: -1 }).limit(HARD_CAP),
      pg
    );
    return sendList(res, bookings, pg, () => EventBooking.countDocuments(filter));
  } catch (error) {
    next(error);
  }
};

exports.getEventBookingById = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Event booking not found" });
    }
    const booking = await populateBooking(EventBooking.findById(req.params.id));
    if (!booking) return res.status(404).json({ message: "Event booking not found" });
    const role = String(req.user.role).toUpperCase();
    const mine =
      String(booking.customerId?._id || booking.customerId) === req.user.id ||
      (booking.cookId && String(booking.cookId?._id || booking.cookId) === req.user.id);
    if (role !== "ADMIN" && !mine) {
      return res.status(403).json({ message: "Not authorized for this action" });
    }
    res.json(booking);
  } catch (error) {
    next(error);
  }
};

// Cook eligibility: role COOK + active account + approved CookProfile + not
// toggled unavailable today. Never trust the frontend's approved list.
const checkCookEligible = async (cookId) => {
  const cookUser = await User.findById(cookId).select("role status name");
  if (!cookUser || String(cookUser.role).toUpperCase() !== "COOK") {
    return { ok: false, message: "Selected user is not a cook" };
  }
  if (cookUser.status !== "active") {
    return { ok: false, message: "This cook's account is not active" };
  }
  const profile = await CookProfile.findOne({ user: cookId });
  if (!profile || profile.approvalStatus !== "approved") {
    return { ok: false, message: "Only verified cooks can be assigned (§20 rule 3)" };
  }
  // Whole-day unavailable toggle (auto-resets next day): an unavailable cook
  // whose unavailableDate is still today cannot be assigned.
  if (profile.availabilityStatus === "unavailable") {
    const today = istTodayStr();
    if (!profile.unavailableDate || profile.unavailableDate >= today) {
      return { ok: false, message: "This cook is currently unavailable" };
    }
  }
  return { ok: true, cookUser };
};

// Task 2 — eligibility guard (shared-document write protocol).
// checkCookEligible() is a plain READ, so an eligibility flip landing between
// the pre-check and the assignment commit would be invisible to it — a
// transaction alone does not help because reads across documents never
// conflict. This guard instead performs CONDITIONAL, SAME-VALUE writes on the
// two eligibility source documents (User + CookProfile) INSIDE the assignment
// transaction:
//   - filter miss ⇒ eligibility already changed ⇒ assignment aborts (400);
//   - filter pass + concurrent flip ⇒ write-write conflict on that document
//     ⇒ the transaction retries on a fresh snapshot ⇒ filter re-evaluated ⇒
//     aborts when the flip landed before commit.
// Guards can never ALTER eligibility: every $set writes the value the filter
// already requires (plus updatedAt — a real changing value so the write is a
// genuine write intent for conflict detection). The explicit updatedAt bump
// on a failed guard may still commit (harmless same-value touch).
// RESIDUAL (documented): an eligibility flip landing AFTER the assignment
// commits is not covered by the guard — the existing post-commit re-check +
// auto-revert in assignCook covers that window; a flip after the re-check but
// before the response remains possible (milliseconds, admin can reassign).
// Keep these filters semantically identical to checkCookEligible() above.
const guardCookEligibilityForAssign = async (cookId, session = null) => {
  const opts = session ? { session } : {};
  const now = new Date();
  const userGuard = await User.findOneAndUpdate(
    { _id: cookId, role: { $in: ["COOK", "cook"] }, status: "active" },
    { $set: { status: "active", updatedAt: now } },
    opts
  );
  if (!userGuard) return { ok: false };
  const today = istTodayStr();
  const profileGuard = await CookProfile.findOneAndUpdate(
    {
      user: cookId,
      approvalStatus: "approved",
      $or: [
        { availabilityStatus: { $ne: "unavailable" } },
        { availabilityStatus: "unavailable", unavailableDate: { $gt: "", $lt: today } },
      ],
    },
    { $set: { approvalStatus: "approved", updatedAt: now } },
    opts
  );
  if (!profileGuard) return { ok: false };
  return { ok: true };
};

// Admin assigns a verified, available cook (§11). Only verified cooks, no
// overlapping bookings (§20 rules 3–5). Concurrency-safe: eligibility guard
// inside the transaction (see guardCookEligibilityForAssign), atomic
// conditional update (status + __v) → 409 on conflict; post-update overlap
// re-check with revert prevents overlapping double-booking from simultaneous
// requests.
exports.assignCook = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Event booking not found" });
    }
    const booking = await EventBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Event booking not found" });
    if (!["pending", "cook_assigned"].includes(booking.bookingStatus)) {
      return res.status(400).json({ message: "Only pending bookings can be assigned a cook" });
    }
    const { cookId } = req.body || {};
    if (!cookId || !mongoose.isValidObjectId(cookId)) {
      return res.status(400).json({ message: "Valid cook id is required" });
    }

    // Idempotent retry: same cook already assigned → success without duplicate
    // history or notifications.
    if (booking.bookingStatus === "cook_assigned" && String(booking.cookId) === String(cookId)) {
      const current = await populateBooking(EventBooking.findById(booking._id));
      return res.json(current);
    }

    const eligibility = await checkCookEligible(cookId);
    if (!eligibility.ok) return res.status(400).json({ message: eligibility.message });
    const { cookUser } = eligibility;

    const window = bookingWindow(booking);
    if (!window) return res.status(400).json({ message: "Booking has an invalid time window" });
    if (window.end > 24 * 60) {
      return res.status(400).json({ message: "Overnight events are not supported" });
    }
    const clash = await findEventOverlap(cookId, booking.eventDate, window, booking._id);
    if (clash) {
      return res.status(409).json({
        message: `This cook already has an event booking (${clash.bookingId || "another event"}) overlapping those hours`,
      });
    }

    const prevCook = booking.cookId;
    const prevStatus = booking.bookingStatus;
    const prevVersion = booking.__v;

    // Atomic claim + durable enqueue commit together when transactions are
    // available: only one concurrent request can win (status + version), and
    // its notifications can never be lost to a crash after commit. The
    // eligibility guard runs FIRST so an ineligible cook never reaches the
    // booking write or the enqueue (no history churn, no notices).
    let updated = null;
    let assignOutbox = null;
    let assignIneligible = null;
    await commitBookingMutation(async (session) => {
      const guard = await guardCookEligibilityForAssign(cookId, session);
      if (!guard.ok) return { updated: null, outboxDoc: null, ineligible: true };
      const u = await atomicBookingUpdate(
        {
          bookingId: booking._id,
          expectedVersion: prevVersion,
          expectedStatuses: ["pending", "cook_assigned"],
          set: { cookId, bookingStatus: "cook_assigned" },
          pushHistory: { status: "cook_assigned", note: "Cook assigned by admin" },
        },
        session
      );
      if (!u) return { updated: null, outboxDoc: null };
      const outboxDoc = await enqueueEventOutbox(
        {
          eventKey: `${u.bookingId}:assign:${u.__v}`,
          bookingId: u._id,
          bookingPublicId: u.bookingId,
          action: "assign",
          recipients: [
            {
              user: u.customerId,
              type: "event_cook_assigned",
              message: `Good news! ${cookUser.name || "A cook"} has been assigned to your ${u.eventType} on ${istDayStr(u.eventDate)}.`,
            },
            {
              user: cookId,
              type: "event_assignment",
              message: `New event assignment: ${u.eventType} on ${istDayStr(u.eventDate)}, ${u.startTime} — ${u.guestCount} guests.`,
            },
          ],
        },
        session
      );
      return { updated: u, outboxDoc };
    }).then(({ result }) => {
      updated = result.updated;
      assignOutbox = result.outboxDoc;
      assignIneligible = result.ineligible === true;
    });
    if (assignIneligible) {
      // Eligibility flipped between the pre-check and the guarded commit (or
      // was already gone when the guard ran). Fresh authoritative read for the
      // precise reason; generic fallback if it flip-flopped again.
      const fresh = await checkCookEligible(cookId);
      const message = fresh.ok
        ? "Cook eligibility changed during assignment — please reload and retry."
        : fresh.message;
      console.warn(`[event-eligibility] assign aborted for booking ${booking.bookingId}: ${message}`);
      return res.status(400).json({ message });
    }
    if (!updated) {
      console.warn(`[event-409] assign lost race for booking ${booking.bookingId} (stale version/status)`);
      const miss = await classifyUpdateMiss(booking._id);
      return res.status(miss.status).json({ message: miss.message });
    }

    // Void the enqueued success notices when this assignment does not stand
    // (revert path): a failed assignment must never produce notifications,
    // in-band or via the worker.
    const voidAssignNotices = async (reason) => {
      try {
        if (assignOutbox) {
          await EventOutbox.findOneAndUpdate(
            { eventKey: assignOutbox.eventKey },
            { $set: { status: "dead", lastError: `superseded: ${reason}`.slice(0, 500) } }
          );
          // A concurrent worker may have delivered between enqueue and this
          // void (claim → insert before the mark-dead landed). Retract any
          // such rows so a reverted assignment never leaves a misleading
          // success notice behind. No-op when delivery had not happened yet.
          try {
            await Notification.deleteMany({ eventKey: assignOutbox.eventKey });
          } catch (e) {
            logNotifyError(updated.bookingId, e);
          }
        }
      } catch (e) {
        logNotifyError(updated.bookingId, e);
      }
    };

    // Post-update overlap re-check closes the check-then-act race: two
    // simultaneous assignments for overlapping bookings on different booking
    // ids could both pass the pre-check. If a clash appeared, revert this
    // assignment (safe failure — admin retries) and report 409.
    // LIMITATION (documented): without a cross-document lock this cannot make
    // the two writes mutually exclusive — both racers may revert (zero
    // assignments stand) and each returns 409. What it DOES guarantee is that
    // no persistent double-booking survives: the later committer's re-check
    // always observes the earlier commit (primary reads), so at least one
    // side reverts. A transaction would not fix this either (different
    // documents → no write conflict under snapshot isolation).
    const postClash = await findEventOverlap(cookId, updated.eventDate, bookingWindow(updated), updated._id);
    if (postClash) {
      let reverted = null;
      try {
        reverted = await revertAssignment({
          updated,
          prevCook,
          prevStatus,
          note: "Auto-reverted: overlapping assignment detected",
        });
      } catch (e) {
        logNotifyError(updated.bookingId, e);
      }
      if (!reverted) {
        // The booking moved again before the revert landed (e.g. confirmed
        // concurrently) — the overlap may still stand. The assignment IS the
        // current DB truth, so its notices still go out; the admin conflict
        // is flagged durably for manual review. Never fail silently.
        await flagRevertFailureForAdmins(
          updated.bookingId,
          `overlap with ${postClash.bookingId || "another event"} could not be auto-reverted`
        );
        await deliverOutboxBestEffort(assignOutbox, updated.bookingId);
        return res.status(409).json({
          message: `Overlapping assignment detected but the booking changed concurrently — please reload and review manually (booking ${updated.bookingId})`,
        });
      }
      await voidAssignNotices("overlapping assignment auto-reverted");
      console.warn(`[event-revert] booking ${updated.bookingId} reverted (overlap with ${postClash.bookingId || "another event"}) — admin retry safe`);
      return res.status(409).json({
        message: `This cook already has an event booking (${postClash.bookingId || "another event"}) overlapping those hours`,
      });
    }

    // Post-update eligibility re-check: the cook's role/status/approval/
    // availability may have changed between validation and the atomic claim
    // (a transaction alone cannot guard this — reads across documents do not
    // conflict). A flip here reverts the same way as an overlap.
    // RESIDUAL: a change landing after this re-check but before the response
    // is still possible (milliseconds); consequence is bounded — the booking
    // was valid at commit, notices reflect true DB state, and the admin can
    // reassign. Eligibility writes are comparatively rare (manual admin/cook
    // actions), so the window is negligible in practice.
    const stillEligible = await checkCookEligible(cookId);
    if (!stillEligible.ok) {
      let reverted = null;
      try {
        reverted = await revertAssignment({
          updated,
          prevCook,
          prevStatus,
          note: "Auto-reverted: cook became ineligible after assignment",
        });
      } catch (e) {
        logNotifyError(updated.bookingId, e);
      }
      if (!reverted) {
        await flagRevertFailureForAdmins(updated.bookingId, "cook became ineligible; auto-revert did not land");
        await deliverOutboxBestEffort(assignOutbox, updated.bookingId);
        return res.status(409).json({
          message: `The cook became ineligible during assignment and the booking changed concurrently — please reload and review manually (booking ${updated.bookingId})`,
        });
      }
      await voidAssignNotices("cook ineligible after assignment — auto-reverted");
      console.warn(`[event-revert] booking ${updated.bookingId} reverted (cook ineligible after claim) — admin retry safe`);
      return res.status(400).json({ message: stillEligible.message });
    }

    // All post-checks passed: immediate delivery preserves existing timing;
    // any failure stays queued for the worker. No success notices exist on
    // any path above that returned early.
    await deliverOutboxBestEffort(assignOutbox, updated.bookingId);

    const populated = await populateBooking(EventBooking.findById(updated._id));
    res.json(populated);
  } catch (error) {
    if (error && error.name === "VersionError") {
      return res.status(409).json({ message: "This booking was just updated by someone else — please reload and retry." });
    }
    next(error);
  }
};

// Admin status moves (§15): cook_assigned → confirmed → in_progress → completed.
// Atomic (status + version filter) so concurrent updates cannot overwrite each
// other; history is pushed in the same operation so status and history always
// match. Frontend statusHistory is never trusted.
exports.updateEventBookingStatus = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Event booking not found" });
    }
    const booking = await EventBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Event booking not found" });
    const { status, note = "" } = req.body || {};
    // Idempotent retry: already at target → success, no duplicate history.
    if (status && booking.bookingStatus === status) {
      const current = await populateBooking(EventBooking.findById(booking._id));
      return res.json(current);
    }
    const allowed = ALLOWED_TRANSITIONS[booking.bookingStatus] || [];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({
        message: `Cannot move from ${booking.bookingStatus} to ${status || "(none)"}`,
      });
    }
    if (["confirmed", "in_progress", "completed"].includes(status) && !booking.cookId) {
      return res.status(400).json({ message: "Assign a cook before confirming this booking" });
    }
    if (String(note || "").length > 1000) {
      return res.status(400).json({ message: "Note is too long (max 1000 characters)" });
    }

    let updated = null;
    let statusOutbox = null;
    await commitBookingMutation(async (session) => {
      const u = await atomicBookingUpdate(
        {
          bookingId: booking._id,
          expectedVersion: booking.__v,
          expectedStatuses: [booking.bookingStatus],
          set: { bookingStatus: status },
          pushHistory: { status, note: String(note || "") },
        },
        session
      );
      if (!u) return { updated: null, outboxDoc: null };
      const recipients = [
        {
          user: u.customerId,
          type: "event_status",
          message: `Your event booking ${u.bookingId} is now ${status.replace(/_/g, " ").toUpperCase()}.`,
        },
      ];
      if (u.cookId) {
        recipients.push({
          user: u.cookId,
          type: "event_status",
          message: `Event booking ${u.bookingId} is now ${status.replace(/_/g, " ").toUpperCase()}.`,
        });
      }
      const outboxDoc = await enqueueEventOutbox(
        {
          eventKey: `${u.bookingId}:status:${u.__v}`,
          bookingId: u._id,
          bookingPublicId: u.bookingId,
          action: "status",
          recipients,
        },
        session
      );
      return { updated: u, outboxDoc };
    }).then(({ result }) => {
      updated = result.updated;
      statusOutbox = result.outboxDoc;
    });
    if (!updated) {
      console.warn(`[event-409] status move lost race for booking ${booking.bookingId} (stale version/status)`);
      const miss = await classifyUpdateMiss(booking._id);
      return res.status(miss.status).json({ message: miss.message });
    }

    await deliverOutboxBestEffort(statusOutbox, updated.bookingId);

    const populated = await populateBooking(EventBooking.findById(updated._id));
    res.json(populated);
  } catch (error) {
    if (error && error.name === "VersionError") {
      return res.status(409).json({ message: "This booking was just updated by someone else — please reload and retry." });
    }
    next(error);
  }
};

// Customer (own booking) or admin can cancel a live booking. Terminal states
// (completed/cancelled) cannot be cancelled; idempotent retry on an already-
// cancelled booking returns the current doc.
exports.cancelEventBooking = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Event booking not found" });
    }
    const booking = await EventBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Event booking not found" });
    const role = String(req.user.role).toUpperCase();
    const isOwner = String(booking.customerId) === req.user.id;
    if (role !== "ADMIN" && !isOwner) {
      return res.status(403).json({ message: "Not authorized for this action" });
    }
    if (booking.bookingStatus === "cancelled") {
      return res.json(booking); // idempotent retry
    }
    if (["completed"].includes(booking.bookingStatus)) {
      return res.status(400).json({ message: "This booking cannot be cancelled" });
    }

    let updated = null;
    let cancelOutbox = null;
    await commitBookingMutation(async (session) => {
      const u = await atomicBookingUpdate(
        {
          bookingId: booking._id,
          expectedVersion: booking.__v,
          expectedStatuses: ["pending", "cook_assigned", "confirmed", "in_progress"],
          set: { bookingStatus: "cancelled" },
          pushHistory: { status: "cancelled", note: role === "ADMIN" ? "Cancelled by admin" : "Cancelled by customer" },
        },
        session
      );
      if (!u) return { updated: null, outboxDoc: null };
      const recipients = [];
      const other = role === "ADMIN" ? u.customerId : null;
      if (other) {
        recipients.push({
          user: other,
          type: "event_cancelled",
          message: `Your event booking ${u.bookingId} has been cancelled by CookMitra.`,
        });
      }
      if (u.cookId) {
        recipients.push({
          user: u.cookId,
          type: "event_cancelled",
          message: `Event booking ${u.bookingId} has been cancelled.`,
        });
      }
      const outboxDoc =
        recipients.length > 0
          ? await enqueueEventOutbox(
              {
                eventKey: `${u.bookingId}:cancel:${u.__v}`,
                bookingId: u._id,
                bookingPublicId: u.bookingId,
                action: "cancel",
                recipients,
              },
              session
            )
          : null;
      return { updated: u, outboxDoc };
    }).then(({ result }) => {
      updated = result.updated;
      cancelOutbox = result.outboxDoc;
    });
    if (!updated) {
      console.warn(`[event-409] cancel lost race for booking ${booking.bookingId} (stale version/status)`);
      const miss = await classifyUpdateMiss(booking._id);
      // If it became terminal concurrently, surface a 400/409 accordingly.
      return res.status(miss.status).json({ message: miss.message });
    }

    await deliverOutboxBestEffort(cancelOutbox, updated.bookingId);

    res.json(updated);
  } catch (error) {
    if (error && error.name === "VersionError") {
      return res.status(409).json({ message: "This booking was just updated by someone else — please reload and retry." });
    }
    next(error);
  }
};

// Admin verifies/corrects the customer-estimated distance. Recomputes ONLY
// the travel charge from the current pricing table and re-totals as
// stored service + stored additional-cook + stored extra-hour + new travel.
// The original price snapshot is NEVER repriced: a later pricing-table edit
// must not silently alter a previously confirmed quote — only the travel
// component changes here. Travel stays PROVISIONAL (distanceVerified falsy)
// until this endpoint is used.
exports.verifyTravelDistance = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Event booking not found" });
    }
    const booking = await EventBooking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Event booking not found" });
    if (["completed", "cancelled"].includes(booking.bookingStatus)) {
      return res.status(400).json({ message: "Terminal bookings cannot be modified" });
    }
    const distN = strictNumber(req.body?.distanceKm);
    if (!Number.isFinite(distN) || distN < 0 || distN > 100000) {
      return res.status(400).json({ message: "Distance must be between 0 and 100000 km" });
    }
    let travelCharge;
    try {
      const table = await getPricingTable();
      travelCharge = travelChargeForDistance(table.travelSlabs, distN);
    } catch (e) {
      return res.status(400).json({ message: e.message || "Could not calculate price" });
    }
    // Preserve the stored snapshot; only travel + total move. Round travel
    // FIRST and derive the total from that exact stored value so
    // totalAmount === round(service + additionalCook + extraHour + travelCharge)
    // always holds (defensive against a fractional slab charge: the stored
    // components and the stored total can never disagree).
    const roundedTravel = Math.round(travelCharge);
    const totalAmount = Math.round(
      Number(booking.serviceAmount || 0) +
        Number(booking.additionalCookAmount || 0) +
        Number(booking.extraHourAmount || 0) +
        roundedTravel
    );
    const updated = await atomicBookingUpdate({
      bookingId: booking._id,
      expectedVersion: booking.__v,
      expectedStatuses: null, // any non-terminal (checked above; __v guards races)
      set: {
        distanceKm: distN,
        distanceVerified: true,
        travelCharge: roundedTravel,
        totalAmount,
      },
      pushHistory: null,
    });
    if (!updated) {
      const miss = await classifyUpdateMiss(booking._id);
      return res.status(miss.status).json({ message: miss.message });
    }
    const populated = await populateBooking(EventBooking.findById(updated._id));
    res.json(populated);
  } catch (error) {
    next(error);
  }
};

// Admin dashboard counts (§16): totals by status + revenue from live bookings.
// Includes an additive `outbox` summary (pending/due/dead/sent) so operators
// get retry/dead-letter visibility without a new dashboard or endpoint.
exports.getEventStats = async (req, res, next) => {
  try {
    const groups = await EventBooking.aggregate([
      { $group: { _id: "$bookingStatus", count: { $sum: 1 }, revenue: { $sum: "$totalAmount" } } },
    ]);
    const byStatus = {};
    let totalBookings = 0;
    let totalRevenue = 0;
    for (const g of groups) {
      byStatus[g._id] = { count: g.count, revenue: g.revenue };
      totalBookings += g.count;
      if (!["cancelled"].includes(g._id)) totalRevenue += g.revenue;
    }
    let outbox = { pending: 0, due: 0, dead: 0, sent: 0 };
    try {
      outbox = await require("../utils/eventOutbox").outboxSummary();
    } catch (e) {
      logNotifyError("stats", e);
    }
    res.json({ totalBookings, totalRevenue, byStatus, outbox });
  } catch (error) {
    next(error);
  }
};

// Exported for unit tests (pure helpers + eligibility re-check).
exports._test = {
  timeToMinutes,
  bookingWindow,
  windowsOverlap,
  sameDayIST,
  istTodayStr,
  istDayStr,
  ALLOWED_TRANSITIONS,
  LIVE_STATUSES,
  BOOKING_STATUSES,
  applyStatusFilter,
  checkCookEligible,
};
