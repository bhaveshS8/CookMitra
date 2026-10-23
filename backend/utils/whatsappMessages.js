// Marathi WhatsApp message builders for the Cook Mitra booking channel.
//
// This module is the single place where Marathi customer/cook-facing
// WhatsApp copy lives (spec section 17). Every builder is generated
// dynamically from the live booking / customer / cook records — nothing
// booking-specific is hard-coded.
//
// The pre-existing English builders in ./whatsapp.js are intentionally
// left untouched (older clients/tests depend on them). New WhatsApp
// interactive flows should use the builders below.

const { FRONTEND_BASE_URL, normalizeIndianMobile } = require("./whatsapp");
const { toDevanagari } = require("./marathiText");

const SERVICE_TYPE_MARATHI = {
  cook_for_me: "माझ्यासाठी स्वयंपाक",
  cook_with_me: "माझ्यासोबत स्वयंपाक",
  teach_me: "स्वयंपाक शिकवणे",
  preparation_help: "स्वयंपाकाची तयारी",
};

const serviceTypeMarathi = (serviceType) =>
  SERVICE_TYPE_MARATHI[String(serviceType || "")] ||
  String(serviceType || "").replace(/_/g, " ") ||
  "स्वयंपाक सेवा";

const MARATHI_MONTHS = [
  "जानेवारी",
  "फेब्रुवारी",
  "मार्च",
  "एप्रिल",
  "मे",
  "जून",
  "जुलै",
  "ऑगस्ट",
  "सप्टेंबर",
  "ऑक्टोबर",
  "नोव्हेंबर",
  "डिसेंबर",
];

const MARATHI_WEEKDAYS = {
  Sunday: "रविवार",
  Monday: "सोमवार",
  Tuesday: "मंगळवार",
  Wednesday: "बुधवार",
  Thursday: "गुरुवार",
  Friday: "शुक्रवार",
  Saturday: "शनिवार",
};

const NOT_AVAILABLE = "माहिती उपलब्ध नाही";

// IST calendar parts for the booking's stored date. Returns null when the
// date is missing or invalid — callers show NOT_AVAILABLE, never a guess.
const istDateParts = (date) => {
  try {
    if (!date) return null;
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "numeric",
      year: "numeric",
      weekday: "long",
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const day = Number(get("day"));
    const month = Number(get("month"));
    const year = Number(get("year"));
    const weekday = get("weekday");
    if (!day || !month || !year || !MARATHI_WEEKDAYS[weekday]) return null;
    return { day, month, year, weekday };
  } catch {
    return null;
  }
};

// "7 ऑक्टोबर 2026" — always from the booking's IST date.
const formatMarathiDate = (date) => {
  const parts = istDateParts(date);
  if (!parts) return NOT_AVAILABLE;
  return `${parts.day} ${MARATHI_MONTHS[parts.month - 1]} ${parts.year}`;
};

// "बुधवार" — Marathi weekday calculated from the booking's IST date.
const calculateMarathiWeekday = (date) => {
  const parts = istDateParts(date);
  if (!parts) return NOT_AVAILABLE;
  return MARATHI_WEEKDAYS[parts.weekday];
};

// "बुधवार, 7 ऑक्टोबर 2026" — Marathi weekday + date in IST. Used wherever a
// cook needs the full service date (the day must never render in English).
const formatMarathiDateWithWeekday = (date) => {
  const day = formatMarathiDate(date);
  const weekday = calculateMarathiWeekday(date);
  if (day === NOT_AVAILABLE || weekday === NOT_AVAILABLE) return NOT_AVAILABLE;
  return `${weekday}, ${day}`;
};

// Marathi time-of-day words. Cooks read "सकाळी 10:00 ते दुपारी 12:00",
// never "10:00 AM - 12:00 PM".
const DAY_PERIODS = [
  { from: 0, to: 5, word: "रात्री" }, // 00:00–04:59
  { from: 5, to: 12, word: "सकाळी" }, // 05:00–11:59
  { from: 12, to: 16, word: "दुपारी" }, // 12:00–15:59
  { from: 16, to: 20, word: "संध्याकाळी" }, // 16:00–19:59
  { from: 20, to: 24, word: "रात्री" }, // 20:00–23:59
];

// "15:30" -> "संध्याकाळी 3:30". Unparseable input passes through unchanged.
const formatMarathiTime = (value) => {
  const raw = String(value || "").trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return raw;
  const h24 = Number(m[1]);
  const minutes = Number(m[2]);
  if (!Number.isInteger(h24) || h24 < 0 || h24 > 23 || minutes < 0 || minutes > 59) {
    return raw;
  }
  const period = (DAY_PERIODS.find((p) => h24 >= p.from && h24 < p.to) || DAY_PERIODS[0]).word;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${period} ${h12}:${m[2]}`;
};

// "सकाळी 10:00 ते दुपारी 12:00"; an empty side collapses gracefully.
const formatMarathiSlotRange = (start, end) => {
  const s = formatMarathiTime(start);
  const e = formatMarathiTime(end);
  if (s && e) return `${s} ते ${e}`;
  return s || e || "";
};

// "बुधवार, 7 ऑक्टोबर 2026" — always rendered in IST (the business timezone),
// so the cook never sees a date shifted by the server's local timezone.
const formatServiceDate = (booking) => formatMarathiDateWithWeekday(booking?.date);

const formatAddress = (booking) => {
  const parts = [
    booking?.address || "",
    booking?.addressDetails?.flatNo || "",
    booking?.addressDetails?.society || "",
    booking?.addressDetails?.landmark || "",
    booking?.addressDetails?.city || "",
  ]
    .map((part) => String(part).trim())
    .filter(Boolean);
  // De-dup: detail fields often repeat the full address text verbatim, and a
  // saved address may be in the other script ("Sunshine" vs "सनशाईन"). Compare
  // the Devanagari display forms so cross-script duplicates collapse too.
  const out = [];
  const key = (s) => toDevanagari(String(s)).toLowerCase();
  for (const p of parts) {
    const low = key(p);
    if (out.some((q) => key(q).includes(low) || low.includes(key(q)))) continue;
    out.push(p);
  }
  const joined = out.join(", ");
  return joined || "—";
};

// Cook-facing display form: the same saved address, rendered in Devanagari.
// Google Maps still receives the original text via formatAddress().
const formatAddressMarathi = (booking) => toDevanagari(formatAddress(booking));

// Tappable Google Maps directions link to the venue — the cook taps and
// starts navigation directly. Prefers the stored GPS pin (exact
// coordinates), falls back to the address when no coordinates exist. Only
// uses the booking's own saved location — never invents coordinates/address.
const mapsDirLink = (booking) => {
  try {
    const lat = booking?.location?.lat;
    const lng = booking?.location?.lng;
    if (lat != null && lng != null && String(lat) !== "" && String(lng) !== "") {
      return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    }
    const addr = formatAddress(booking);
    if (addr && addr !== "—") {
      return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}`;
    }
    return null;
  } catch {
    return null;
  }
};

const formatNotes = (booking) => {
  const notes = String(booking?.notes || "").trim();
  return notes || "—";
};

const formatPayout = (booking) => {
  const payout = Number(booking?.cookPayout ?? booking?.payoutInfo?.cookPayoutAmount ?? 0);
  return Number.isFinite(payout) ? String(Math.round(payout)) : "—";
};

const bookingUrlFor = (bookingId) =>
  bookingId ? `${FRONTEND_BASE_URL}/bookings/${bookingId}` : "—";

// Interactive reply-button titles (spec section 3). Button `id` payloads
// stay `accept:<bookingId>` / `reject:<bookingId>` (see utils/whatsappApi)
// so existing parsers keep working; only the display titles are Marathi.
const ACCEPT_BUTTON_TITLE = "✅ बुकिंग स्वीकारा";
const REJECT_BUTTON_TITLE = "❌ नकार द्या";

// Booking-request message — EXACT field allowlist, named mapping only:
//   customerName  = customer.name
//   serviceDate   = booking.date            (Marathi "7 ऑक्टोबर 2026")
//   weekday       = calculateMarathiWeekday(booking.date)
//   startTime     = booking.startTime
//   endTime       = booking.endTime
//   durationHours = booking.durationHours
//   address       = booking.address
//   guests        = booking.guests
//   notes         = booking.notes
// No other booking information is displayed. Missing notes shows
// "📝 सूचना: नाही"; any other missing field shows "माहिती उपलब्ध नाही".
// Values are never borrowed from another field.
const buildBookingRequestMessage = ({ booking, customerName } = {}) => {
  const name =
    customerName != null && String(customerName).trim() !== ""
      ? String(customerName).trim()
      : NOT_AVAILABLE;
  const serviceDate = booking?.date ? formatMarathiDate(booking.date) : NOT_AVAILABLE;
  const weekday = booking?.date ? calculateMarathiWeekday(booking.date) : NOT_AVAILABLE;
  const startTime =
    booking?.startTime != null && String(booking.startTime).trim() !== ""
      ? formatMarathiTime(String(booking.startTime).trim())
      : "";
  const endTime =
    booking?.endTime != null && String(booking.endTime).trim() !== ""
      ? formatMarathiTime(String(booking.endTime).trim())
      : "";
  const timeLine = startTime && endTime ? `${startTime} ते ${endTime}` : NOT_AVAILABLE;
  const durationHours =
    booking?.durationHours != null && String(booking.durationHours).trim() !== ""
      ? String(booking.durationHours).trim()
      : "";
  const durationLine = durationHours ? `${durationHours} तास` : NOT_AVAILABLE;
  const address =
    booking?.address != null && String(booking.address).trim() !== ""
      ? String(booking.address).trim()
      : NOT_AVAILABLE;
  const guests =
    booking?.guests != null && String(booking.guests).trim() !== ""
      ? String(booking.guests).trim()
      : NOT_AVAILABLE;
  const notes =
    booking?.notes != null && String(booking.notes).trim() !== ""
      ? String(booking.notes).trim()
      : "";
  const bookingId =
    booking?._id != null && String(booking._id).trim() !== ""
      ? String(booking._id).trim()
      : "";
  const isPaid = String(booking?.payment?.status || "").toLowerCase() === "paid";
  return [
    "🍳 नवीन Cook Mitra बुकिंग विनंती",
    "",
    `👤 ग्राहक: ${name}`,
    "",
    `📋 बुकिंग क्रमांक: ${bookingId || NOT_AVAILABLE}`,
    `🍽️ सेवा: ${serviceTypeMarathi(booking?.serviceType)}`,
    "",
    `📅 तारीख: ${serviceDate}`,
    `📆 वार: ${weekday}`,
    "",
    `🕐 वेळ: ${timeLine}`,
    `⏱️ कालावधी: ${durationLine}`,
    "",
    "📍 ठिकाण:",
    toDevanagari(address),
    "",
    `👥 व्यक्ती: ${guests}`,
    "",
    notes ? "📝 सूचना:" : "📝 सूचना: नाही",
    ...(notes ? [notes] : []),
    "",
    ...(isPaid
      ? [
          "💳 पेमेंट स्थिती: ग्राहकाने आधीच पेमेंट केले आहे.",
          "स्वीकारल्यास पुन्हा पेमेंटची आवश्यकता नाही.",
          "",
        ]
      : []),
    "कृपया खालील पर्याय निवडा:",
  ].join("\n");
};

// Cook confirmation (booking is confirmed and paid). This is the single
// copy used for EVERY service type (cook_for_me, cook_with_me, teach_me,
// preparation_help) and every confirmation path (customer payment, 100%
// coupon, replacement cook, admin assignment, gateway webhook):
//   👤 customer, 📞 customer contact, 📅 date (IST), ⏰ time, ⏱️ duration,
//   👥 guests, 📍 full address, 🗺️ Google Maps directions, 📝 notes.
// The customer's number is shared only here (post-confirmation job sheet),
// never in the pre-accept request. Missing values show NOT_AVAILABLE —
// never a blank line, never a guess.
const buildCookBookingScheduledMessage = ({ booking, cookName, customerName, customerPhone, bookingUrl } = {}) => {
  const dirLink = mapsDirLink(booking);
  const bookingId =
    booking?._id != null && String(booking._id).trim() !== ""
      ? String(booking._id).trim()
      : "";
  const durationHours =
    booking?.durationHours != null && String(booking.durationHours).trim() !== ""
      ? String(booking.durationHours).trim()
      : "";
  const durationLine = durationHours ? `${durationHours} तास` : NOT_AVAILABLE;
  const guests =
    booking?.guests != null && String(booking.guests).trim() !== ""
      ? String(booking.guests).trim()
      : NOT_AVAILABLE;
  const timeLine = formatMarathiSlotRange(booking?.startTime, booking?.endTime) || NOT_AVAILABLE;
  const contactNumber = normalizeIndianMobile(customerPhone) || NOT_AVAILABLE;
  return [
    `नमस्कार ${cookName || "कुक"} 🙏`,
    "",
    "तुमची बुकिंग यशस्वीपणे निश्चित झाली आहे.",
    "",
    `📋 बुकिंग क्रमांक: ${bookingId || NOT_AVAILABLE}`,
    `👤 ग्राहक: ${customerName || "ग्राहक"}`,
    `📞 ग्राहक संपर्क: ${contactNumber}`,
    `📅 तारीख: ${formatServiceDate(booking)}`,
    `⏰ वेळ: ${timeLine}`,
    `⏱️ कालावधी: ${durationLine}`,
    "",
    `👥 व्यक्ती: ${guests}`,
    "",
    "📍 पत्ता:",
    formatAddressMarathi(booking),
    ...(dirLink ? ["", "🗺️ रस्ता पहा (Google Maps):", dirLink] : []),
    "",
    "📝 अतिरिक्त माहिती:",
    formatNotes(booking),
    "",
    "💳 पेमेंट स्थिती: ग्राहकाने आधीच पेमेंट केले आहे. पुन्हा पेमेंट घेऊ नका.",
    "",
    "कृपया दिलेल्या वेळेवर ग्राहकाच्या पत्त्यावर पोहोचा.",
    "",
    "— Cook Mitra",
  ].join("\n");
};

const buildCustomerBookingConfirmedMessage = ({ booking, cookName, customerName, paidAmount, bookingUrl } = {}) => {
  const amount =
    paidAmount ?? booking?.payment?.paidAmount ?? booking?.amount ?? "—";
  return [
    "🎉 Cook Mitra — तुमची बुकिंग निश्चित झाली!",
    "",
    `नमस्कार ${customerName || "ग्राहक"} 🙏`,
    "",
    "तुमची बुकिंग यशस्वीपणे निश्चित झाली आहे.",
    "",
    `👩‍🍳 कुक: ${cookName || "नियुक्त कुक"}`,
    `📅 तारीख: ${formatServiceDate(booking)}`,
    `⏰ वेळ: ${formatMarathiSlotRange(booking?.startTime, booking?.endTime) || "माहिती उपलब्ध नाही"}`,
    `⏱️ कालावधी: ${booking?.durationHours ?? ""} तास`,
    "",
    "🍽️ सेवा:",
    serviceTypeMarathi(booking?.serviceType),
    "",
    `👥 व्यक्ती: ${booking?.guests ?? ""}`,
    "",
    "📍 पत्ता:",
    formatAddress(booking),
    "",
    `💰 एकूण रक्कम: ₹${amount}`,
    "",
    "तुमचा कुक दिलेल्या वेळेनुसार तुमच्या पत्त्यावर येईल.",
    "",
    "🔐 सेवा सुरू करण्यासाठी आवश्यक OTP वेबसाइटवर उपलब्ध असेल.",
    "",
    "📌 बुकिंग तपशील:",
    bookingUrl || bookingUrlFor(booking?._id),
    "",
    "धन्यवाद!",
    "Cook Mitra",
  ].join("\n");
};

const buildBookingExpiredMessage = ({ booking } = {}) =>
  [
    "⏳ Cook Mitra — बुकिंग विनंती कालबाह्य",
    "",
    "ही बुकिंग विनंती आता कालबाह्य झाली आहे. ⏳",
    "",
    `🍽️ सेवा: ${serviceTypeMarathi(booking?.serviceType)}`,
    `📅 तारीख: ${formatServiceDate(booking)}`,
  ]
    .filter(Boolean)
    .join("\n");

const buildBookingAlreadyAcceptedMessage = ({ booking } = {}) =>
  [
    "🙏 Cook Mitra",
    "",
    "हे बुकिंग आधीच दुसऱ्या कुकने स्वीकारले आहे. 🙏",
    "",
    `🍽️ सेवा: ${serviceTypeMarathi(booking?.serviceType)}`,
    `📅 तारीख: ${formatServiceDate(booking)}`,
  ]
    .filter(Boolean)
    .join("\n");

const buildBookingCancelledMessage = ({} = {}) =>
  ["Cook Mitra", "", "ग्राहकाने ही बुकिंग रद्द केली आहे."].join("\n");

// Cook-side cancellation notice (Marathi). Variants:
//   cook     = assigned cook cancelled → replacement search is on
//   customer = customer cancelled
//   admin    = support team cancelled
// Anything else falls back to the customer-cancelled line. Only depends on
// live booking fields; missing date shows NOT_AVAILABLE, never a guess.
const buildCookCancelledMessage = ({ booking, cancelledBy } = {}) => {
  const by = String(cancelledBy || "").toLowerCase();
  const who =
    by === "cook"
      ? "कुकने हे बुकिंग रद्द केले आहे."
      : by === "admin"
        ? "आमच्या सपोर्ट टीमने हे बुकिंग रद्द केले आहे."
        : "ग्राहकाने ही बुकिंग रद्द केली आहे.";
  const bookingId =
    booking?._id != null && String(booking._id).trim() !== ""
      ? String(booking._id).trim()
      : "";
  const lines = [
    "🍳 Cook Mitra — बुकिंग रद्द",
    "",
    who,
    "",
    `📋 बुकिंग क्रमांक: ${bookingId || NOT_AVAILABLE}`,
    `📅 तारीख: ${formatServiceDate(booking)}`,
  ];
  if (by === "cook") {
    const isPaid = String(booking?.payment?.status || "").toLowerCase() === "paid";
    lines.push(
      "",
      "आम्ही बदली कुक शोधत आहोत — कृपया तुमच्या कुक डॅशबोर्डवर लक्ष ठेवा."
    );
    if (isPaid) {
      lines.push(
        "",
        "💳 या बुकिंगचे पेमेंट आधीच झाले आहे; पुन्हा पेमेंटची आवश्यकता नाही."
      );
    }
  }
  return lines.join("\n");
};

// Cook-side acceptance acknowledgement (Marathi): the cook just accepted;
// the customer completes payment within minutes. Used for the admin
// accept-on-behalf cook copy.
const buildCookAcceptedMessage = ({ booking, customerName } = {}) => {
  const bookingId =
    booking?._id != null && String(booking._id).trim() !== ""
      ? String(booking._id).trim()
      : "";
  return [
    "✅ Cook Mitra — तुम्ही बुकिंग स्वीकारले आहे",
    "",
    `👤 ग्राहक: ${customerName || "ग्राहक"}`,
    `🍽️ सेवा: ${serviceTypeMarathi(booking?.serviceType)}`,
    `📅 तारीख: ${formatServiceDate(booking)}`,
    `📋 बुकिंग क्रमांक: ${bookingId || NOT_AVAILABLE}`,
    "",
    "ग्राहक ५ मिनिटांत पेमेंट पूर्ण करेल. कृपया हा वेळ राखून ठेवा.",
  ].join("\n");
};

const buildBookingRejectedMessage = ({ booking } = {}) =>
  [
    "Cook Mitra",
    "",
    "तुम्ही ही बुकिंग विनंती नाकारली आहे.",
    "",
    `🍽️ सेवा: ${serviceTypeMarathi(booking?.serviceType)}`,
    `📅 तारीख: ${formatServiceDate(booking)}`,
    "",
    "इतर कुक अजूनही ही विनंती स्वीकारू शकतात.",
  ].join("\n");

const buildPaymentExpiredMessage = ({} = {}) =>
  ["⏳ Cook Mitra", "", "⏳ ही बुकिंग पेमेंट न झाल्यामुळे कालबाह्य झाली आहे."].join(
    "\n"
  );

module.exports = {
  SERVICE_TYPE_MARATHI,
  serviceTypeMarathi,
  ACCEPT_BUTTON_TITLE,
  REJECT_BUTTON_TITLE,
  NOT_AVAILABLE,
  formatMarathiDate,
  calculateMarathiWeekday,
  formatMarathiDateWithWeekday,
  formatMarathiTime,
  formatMarathiSlotRange,
  formatAddressMarathi,
  toDevanagari,
  buildBookingRequestMessage,
  buildCookBookingScheduledMessage,
  buildCustomerBookingConfirmedMessage,
  buildBookingExpiredMessage,
  buildBookingAlreadyAcceptedMessage,
  buildBookingCancelledMessage,
  buildCookCancelledMessage,
  buildCookAcceptedMessage,
  buildBookingRejectedMessage,
  buildPaymentExpiredMessage,
  bookingUrlFor,
  mapsDirLink,
};
