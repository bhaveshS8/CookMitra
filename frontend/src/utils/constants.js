export const SERVICE_DETAILS = {
  cook_for_me: {
    label: "Cook for Me",
    description: "Sit back and host your guests while our expert cook handles full meal preparation at your kitchen.",
    icon: "ChefHat",
    badgeColor: "#FFF7ED",
    textColor: "#C2410C",
  },
  cook_with_me: {
    label: "Cook With Me",
    description: "Team up with an experienced home chef to prepare traditional sweets and savories together.",
    icon: "Users",
    badgeColor: "#F0FDF4",
    textColor: "#15803D",
  },
  teach_me: {
    label: "Teach Me",
    description: "Learn time-honored techniques, family secrets, and proper consistency for intricate festive dishes.",
    icon: "GraduationCap",
    badgeColor: "#EFF6FF",
    textColor: "#1D4ED8",
  },
  preparation_help: {
    label: "Preparation Help",
    description: "Get dedicated assistance with dough kneading, chakli pressing, modak shaping, and deep frying.",
    icon: "HandHelping",
    badgeColor: "#FAF5FF",
    textColor: "#7E22CE",
  },
};

export const formatCurrency = (amount) => {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount || 0);
};

// Festive-launch price list (mirror of backend/utils/pricing.js — the
// server recomputes every amount, this is display + preview only).
// Whole-hour 1–4 sessions, one flat price for every cook and service.
export const LAUNCH_SLAB_PRICES = { 1: 199, 2: 349, 3: 499, 4: 649 };
export const COMMISSION_RATE = 0.25;

export const slabPriceForDuration = (hours) => {
  const h = Number(hours);
  if (!Number.isInteger(h) || LAUNCH_SLAB_PRICES[h] == null) return null;
  return LAUNCH_SLAB_PRICES[h];
};

export const formatDate = (dateStr) => {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

// Local "today" as YYYY-MM-DD for date-picker defaults / mins.
// toISOString() is UTC and leaks the wrong day between 00:00–05:29 IST.
export const localTodayStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Local "tomorrow" as YYYY-MM-DD for date-picker mins / defaults.
export const localTomorrowStr = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// 12-hour clock label for an "HH:MM" (or "HH:MM:SS") time string.
// "14:30" -> "2:30 PM", "00:15" -> "12:15 AM"; anything unparsable passes
// through untouched. Times are stored as 24h strings everywhere, so every
// user-facing screen formats through this.
export const formatTime12 = (time) => {
  const m = String(time || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return String(time || "");
  let h = Number(m[1]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ap}`;
};

// "10:00","13:00" -> "10:00 AM – 1:00 PM" (separator customisable).
export const formatTimeRange12 = (start, end, sep = "–") =>
  start && end ? `${formatTime12(start)} ${sep} ${formatTime12(end)}` : "";

// Parse a booking's ISO date string back into a local YYYY-MM-DD string.
// Slicing the ISO string directly fails if the backend is not in UTC,
// because a local midnight Date saves as e.g. 18:30Z the previous day.
export const getLocalDateStr = (isoString) => {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// "Today" / "Tomorrow" badge label for imminent bookings.
// `today` (YYYY-MM-DD) defaults to the current local day; screens pass
// their live value from useLocalDay() so badges flip over correctly at
// midnight without waiting for a refetch.
export const dayTagLabel = (booking, today = localTodayStr()) => {
  const day = getLocalDateStr(booking?.date);
  if (!day || !today) return null;
  if (day === today) return "Today";
  const next = new Date(`${today}T00:00:00`);
  next.setDate(next.getDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  if (day === `${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())}`) {
    return "Tomorrow";
  }
  return null;
};

// Google Maps navigation URL for a booking: precise GPS pin when
// available, otherwise falls back to the text address search.
export const mapsNavigateUrl = (booking) => {
  const lat = booking?.location?.lat;
  const lng = booking?.location?.lng;
  if (typeof lat === "number" && typeof lng === "number") {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  }
  if (booking?.address) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      booking.address
    )}`;
  }
  return null;
};

// Normalize an Indian mobile number to 10 digits (or null if invalid)
export const normalizeIndianMobile = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (/^[6-9]\d{9}$/.test(digits)) return digits;
  return null;
};

// Build a wa.me deep link that sends the order details to the USER's own
// WhatsApp. Returns null when the user has no valid number. After cook
// ACCEPTS, this is the booked confirmation with cook name + cook number.
// (Cook live-location tracking was removed — no live pins or tracking links.)
export const bookingCustomerWhatsAppUrl = ({ customerPhone, cookName, cookPhone, booking }) => {
  const mobile = normalizeIndianMobile(customerPhone);
  if (!mobile) return null;

  const venueMapsLink =
    booking?.location?.lat != null && booking?.location?.lng != null
      ? `https://www.google.com/maps?q=${booking.location.lat},${booking.location.lng}`
      : null;

  const isConfirmed = ["accepted", "confirmed", "in_progress"].includes(booking?.status);
  const isPaid = booking?.payment?.status === "paid";
  const header = isPaid
    ? "Cook Mitra Booking Confirmed — Payment Received ✅"
    : isConfirmed
      ? "Cook Mitra Booking Confirmed – Cook Accepted 🎉"
      : "Cook Mitra Booking Confirmation";

  const lines = [
    header,
    `Service: ${(booking?.serviceType || "").replace(/_/g, " ")}`,
    `Cook: ${cookName || "Assigned cook"}`,
    `Cook's number: ${cookPhone || "will be shared shortly"}`,
    `Date: ${booking?.date ? new Date(booking.date).toLocaleDateString() : ""}`,
    `Service hours: ${formatTimeRange12(booking?.startTime, booking?.endTime, "-")}${booking?.durationHours ? ` (${booking.durationHours} hrs)` : ""}`,
    `Venue: ${booking?.address || ""}`,
  ];
  if (venueMapsLink) lines.push(`Your venue pin: ${venueMapsLink}`);
  if (booking?.guests) lines.push(`Guests: ${booking.guests}`);
  if (booking?.durationHours) lines.push(`Duration: ${booking.durationHours} hrs`);
  if (booking?.selectedItems?.length) lines.push(`Dishes: ${booking.selectedItems.join(", ")}`);
  if (booking?.notes) lines.push(`Notes: ${booking.notes}`);
  if (booking?._id) lines.push(`Booking ID: ${booking._id}`);
  if (booking?.status) lines.push(`Status: ${String(booking.status).toUpperCase()}`);

  return `https://wa.me/91${mobile}?text=${encodeURIComponent(lines.join("\n"))}`;
};

// wa.me "service complete — please rate your cook" reminder for the
// customer's own WhatsApp, with a link to the booking review page.
export const bookingReviewWhatsAppUrl = ({ customerPhone, cookName, booking, reviewUrl }) => {
  const mobile = normalizeIndianMobile(customerPhone);
  if (!mobile) return null;

  const link =
    reviewUrl ||
    (booking?._id && typeof window !== "undefined"
      ? `${window.location.origin}/bookings/${booking._id}`
      : null);

  const lines = [
    "Cook Mitra: How was your meal? Please rate your cook ⭐",
    `Cook: ${cookName || "Your cook"}`,
    `Service: ${(booking?.serviceType || "").replace(/_/g, " ")}`,
    `Date: ${booking?.date ? new Date(booking.date).toLocaleDateString() : ""}`,
  ];
  if (booking?._id) lines.push(`Booking ID: ${booking._id}`);
  if (link) lines.push(`Rate here: ${link}`);
  lines.push("Your rating helps other households find great cooks. Thank you!");

  return `https://wa.me/91${mobile}?text=${encodeURIComponent(lines.join("\n"))}`;
};

// Effective service window: once the cook verifies the OTP the scheduled
// start/end are redefined from the actual clock (serviceStartedAt →
// serviceEndsAt = start + booked duration). Prefers the live clock so legacy
// bookings (stored endTime not yet redefined) still display real times.
const clockHM = (d) => {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
};

export const effectiveServiceWindow = (obj) => {
  const start = obj?.serviceStartedAt ? clockHM(obj.serviceStartedAt) : obj?.startTime || null;
  const end = obj?.serviceEndsAt
    ? clockHM(obj.serviceEndsAt)
    : obj?.serviceStartedAt && obj?.durationHours
      ? (() => {
          const s = new Date(obj.serviceStartedAt);
          if (Number.isNaN(s.getTime())) return obj?.endTime || null;
          return clockHM(new Date(s.getTime() + Math.round(Number(obj.durationHours) * 60) * 60 * 1000));
        })()
      : obj?.endTime || null;
  return { startTime: start, endTime: end };
};

// IST wall time → UTC instant (F-08): Asia/Kolkata has no DST so +05:30 is
// exact. The backend stores booking days as IST-midnight instants; resolving
// the slot from IST parts keeps the cutoff/countdown identical in every
// browser timezone (server-local setHours drifted by hours abroad).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istDayParts = (input) => {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return { y: Number(get("year")), mo: Number(get("month")), d: Number(get("day")) };
  } catch {
    return null;
  }
};
const istSlotInstant = (dateInput, hm) => {
  const m = String(hm || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  let y;
  let mo;
  let d;
  if (typeof dateInput === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
    const dm = dateInput.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    y = Number(dm[1]);
    mo = Number(dm[2]);
    d = Number(dm[3]);
  } else {
    const p = istDayParts(dateInput);
    if (!p || !Number.isInteger(p.y)) return null;
    y = p.y;
    mo = p.mo;
    d = p.d;
  }
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MS);
};

// Session end datetime. Prefers the live service clock (serviceEndsAt, set
// when the cook verifies the OTP), then the server-resolved `sessionEnd`
// (returned by the booking endpoints, computed by the backend from its own
// live clock), and only then the static date + endTime slot. `sessionEnd` is
// a fixed instant so it never goes stale — honoring it keeps every screen on
// the identical countdown. Accepts a booking payload.
export const sessionEndDate = (obj) => {
  if (obj?.serviceEndsAt) {
    const live = new Date(obj.serviceEndsAt);
    if (!Number.isNaN(live.getTime())) return live;
  }
  if (obj?.sessionEnd) {
    const resolved = new Date(obj.sessionEnd);
    if (!Number.isNaN(resolved.getTime())) return resolved;
  }
  const date = obj?.date;
  if (!date) return null;
  const endTime = obj?.endTime;
  if (!endTime) return null;
  return istSlotInstant(date, endTime);
};

// Session start datetime: prefers the actual service clock (serviceStartedAt)
// over the static schedule, mirroring sessionEndDate so the UI gates on real
// times once the OTP is verified.
export const sessionStartDate = (obj) => {
  if (obj?.serviceStartedAt) {
    const live = new Date(obj.serviceStartedAt);
    if (!Number.isNaN(live.getTime())) return live;
  }
  const date = obj?.date;
  if (!date) return null;
  const startTime = obj?.startTime;
  if (!startTime) return null;
  return istSlotInstant(date, startTime);
};

// Cancel lock: customers and cooks may call off a
// booking only until 30 minutes before the service start time. Unknown
// start ⇒ unlocked (the backend enforces the same rule — this only hides
// the button so users aren't offered a doomed action).
export const CANCEL_LOCK_MINUTES = 30;
export const isCancelLocked = (obj, now = Date.now()) => {
  const start = sessionStartDate(obj);
  if (!start) return false;
  return now >= start.getTime() - CANCEL_LOCK_MINUTES * 60 * 1000;
};

// True when the session is under way: the cook verified the OTP
// (serviceStartedAt set) OR now ≥ date + startTime. Unknown start ⇒ false,
// matching how hours-complete treats an unknown end.
export const hasServiceHoursStarted = (obj) => {
  if (obj?.serviceStartedAt) return true;
  const start = sessionStartDate(obj);
  return !!start && Date.now() >= start.getTime();
};

// True when the customer may rate the booking. Mirrors the backend rule
// (reviewController.createReview): completed, hours-complete, or session end
// passed — but never requests the cook didn't accept or dead bookings.
// Use as: show the form while `isReviewable(b) && !b.review`; the submitted
// card takes over once `b.review` exists.
export const isReviewable = (booking) => {
  if (!booking) return false;
  if (["requested", "rejected", "cancelled", "expired"].includes(booking.status)) return false;
  if (booking.status === "completed" || booking.hoursCompleted === true) return true;
  const end = sessionEndDate(booking);
  return !!end && Date.now() >= end.getTime();
};

// Human countdown: "2h 15m left" / "Overdue by 10m" / null when unknown
export const formatRemaining = (endDate, now = Date.now()) => {
  if (!endDate || Number.isNaN(endDate.getTime())) return null;
  const diff = endDate.getTime() - now;
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const label = h > 0 ? `${h}h ${m}m` : `${m} min`;
  return diff >= 0 ? `${label} left` : `Overdue by ${label}`;
};

// Short audible alarm (3 beeps via Web Audio, no assets). Resolves when done.
// Browsers may block audio before user interaction — callers must try/catch.
export const playAlarmSound = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const times = [0, 0.35, 0.7];
    times.forEach((t, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.value = i === 2 ? 880 : 660;
      const start = ctx.currentTime + t;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.5, start + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
      osc.start(start);
      osc.stop(start + 0.32);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch {
    // silent fallback: visual banner + toast still notify
  }
};

// wa.me "cooking hours complete" alarm for EITHER party's own WhatsApp.
// Pass the recipient's phone as toPhone. Null for invalid numbers.
export const hoursCompleteWhatsAppUrl = ({ toPhone, booking, cookName, cookPhone, customerName }) => {
  const mobile = normalizeIndianMobile(toPhone);
  if (!mobile) return null;

  const dateStr = booking?.date ? new Date(booking.date).toLocaleDateString() : "";
  const endStr = booking?.endTime || "";
  const completedAt = booking?.hoursCompletedAt ? new Date(booking.hoursCompletedAt).toLocaleString() : "";

  const lines = [
    "Cook Mitra: Cooking Hours Complete",
    `Service: ${(booking?.serviceType || "").replace(/_/g, " ")}`,
    `Cook: ${cookName || "Assigned cook"}${cookPhone ? ` (${cookPhone})` : ""}`,
    `Customer: ${customerName || "Customer"}`,
    `Date: ${dateStr}${endStr ? ` | Ended at: ${endStr}` : ""}`,
    `Venue: ${booking?.address || ""}`,
  ];
  const bid = booking?._id || booking?.bookingId;
  if (bid) lines.push(`Booking ID: ${bid}`);
  if (completedAt) lines.push(`Completed at: ${completedAt}`);
  lines.push("Your booked cooking hours are complete. Please review your session!");

  return `https://wa.me/91${mobile}?text=${encodeURIComponent(lines.join("\n"))}`;
};

// Haversine distance in km between two {lat,lng} points (null when unknown)
export const distanceKm = (a, b) => {
  if (a?.lat == null || a?.lng == null || b?.lat == null || b?.lng == null) return null;
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const aa =
    s1 * s1 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * s2 * s2;
  return 2 * R * Math.asin(Math.sqrt(aa));
};

// Human "x min ago" for ISO dates
export const timeAgo = (iso) => {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
};

// OpenStreetMap embed URL (no API key) showing cook + venue pins.
// OSM embed supports a single marker param, so we center on the midpoint and
// mark the cook position; venue is listed alongside with its own link.
export const osmEmbedUrl = (cookLoc, venueLoc) => {
  const pts = [cookLoc, venueLoc].filter((p) => p?.lat != null && p?.lng != null);
  if (!pts.length) return null;
  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const pad = 0.02;
  const bbox = `${Math.min(...lngs) - pad},${Math.min(...lats) - pad},${Math.max(...lngs) + pad},${Math.max(...lats) + pad}`;
  const mark = cookLoc?.lat != null ? cookLoc : venueLoc;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${mark.lat},${mark.lng}`;
};

// Build a wa.me deep link that shares full order details + venue pin
// with the cook on WhatsApp. Returns null when the cook has no valid number.
export const bookingWhatsAppUrl = ({ cookPhone, customerName, customerPhone, booking }) => {
  const mobile = normalizeIndianMobile(cookPhone);
  if (!mobile) return null;

  const mapsLink =
    booking?.location?.lat != null && booking?.location?.lng != null
      ? `https://www.google.com/maps?q=${booking.location.lat},${booking.location.lng}`
      : null;

  const lines = [
    "New Cook Mitra Booking Request",
    `Customer: ${customerName || "Customer"}${customerPhone ? ` (${customerPhone})` : ""}`,
    `Service: ${(booking?.serviceType || "").replace(/_/g, " ")}`,
    `Date: ${booking?.date ? new Date(booking.date).toLocaleDateString() : ""} | Time: ${formatTimeRange12(booking?.startTime, booking?.endTime, "-")}`,
    `Venue: ${booking?.address || ""}`,
  ];
  if (mapsLink) lines.push(`Venue pin: ${mapsLink}`);
  if (booking?.guests) lines.push(`Guests: ${booking.guests}`);
  if (booking?.durationHours) lines.push(`Duration: ${booking.durationHours} hrs`);
  if (booking?.selectedItems?.length) lines.push(`Dishes: ${booking.selectedItems.join(", ")}`);
  if (booking?.notes) lines.push(`Notes: ${booking.notes}`);
  if (booking?._id) lines.push(`Booking ID: ${booking._id}`);
  lines.push("Please accept it in your Cook Dashboard.");

  return `https://wa.me/91${mobile}?text=${encodeURIComponent(lines.join("\n"))}`;
};

// Client mirror of the backend `buildCookJobSheetWhatsAppUrl`: wa.me deep link
// targeting the COOK's WhatsApp with the post-payment job sheet — customer
// name, phone number and venue location (address + GPS pin). Used as the
// fallback when a server response didn't include `cookWhatsappUrl`. Returns
// null when the cook has no valid number.
export const bookingCookJobWhatsAppUrl = ({ cookPhone, customerName, customerPhone, booking }) => {
  const mobile = normalizeIndianMobile(cookPhone);
  if (!mobile) return null;

  const mapsLink =
    booking?.location?.lat != null && booking?.location?.lng != null
      ? `https://www.google.com/maps?q=${booking.location.lat},${booking.location.lng}`
      : null;

  const addressParts = [
    booking?.address || "",
    booking?.addressDetails?.flatNo || "",
    booking?.addressDetails?.society || "",
    booking?.addressDetails?.landmark || "",
    booking?.addressDetails?.city || "",
  ]
    .map((part) => String(part).trim())
    .filter(Boolean)
    .join(", ");

  const lines = [
    "*Cook Mitra: Payment Received — Job Confirmed* ✅",
    `Customer: ${customerName || "Customer"}`,
    `Customer number: ${customerPhone || "not shared"}`,
    `Service: ${(booking?.serviceType || "").replace(/_/g, " ")}`,
    `Date: ${booking?.date ? new Date(booking.date).toLocaleDateString() : ""} | Time: ${formatTimeRange12(booking?.startTime, booking?.endTime, "-")}`,
    `Venue: ${addressParts || booking?.address || ""}`,
  ];
  if (mapsLink) lines.push(`Location pin: ${mapsLink}`);
  if (booking?.guests) lines.push(`Guests: ${booking.guests}`);
  if (booking?.durationHours) lines.push(`Duration: ${booking.durationHours} hrs`);
  if (booking?.selectedItems?.length) lines.push(`Dishes: ${booking.selectedItems.join(", ")}`);
  if (booking?.notes) lines.push(`Notes: ${booking.notes}`);
  if (booking?._id) lines.push(`Booking ID: ${booking._id}`);
  lines.push("The customer has PAID. Please reach the venue on time.");

  return `https://wa.me/91${mobile}?text=${encodeURIComponent(lines.join("\n"))}`;
};
