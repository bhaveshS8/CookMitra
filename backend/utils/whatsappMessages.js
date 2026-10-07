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

const { FRONTEND_BASE_URL } = require("./whatsapp");

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

const formatServiceDate = (booking) => {
  try {
    if (!booking?.date) return "";
    return new Date(booking.date).toLocaleDateString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
};

const formatClock = (value) => {
  try {
    if (!value) return "";
    if (/^\d{1,2}:\d{2}/.test(String(value))) return String(value).slice(0, 5);
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString("en-IN", {
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return String(value || "");
  }
};

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
  const joined = parts.join(", ");
  return joined || "—";
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
      ? String(booking.startTime).trim().slice(0, 5)
      : "";
  const endTime =
    booking?.endTime != null && String(booking.endTime).trim() !== ""
      ? String(booking.endTime).trim().slice(0, 5)
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
  return [
    "🍳 नवीन Cook Mitra बुकिंग विनंती",
    "",
    `👤 ग्राहक: ${name}`,
    "",
    `📅 तारीख: ${serviceDate}`,
    `📆 वार: ${weekday}`,
    "",
    `🕐 वेळ: ${timeLine}`,
    `⏱️ कालावधी: ${durationLine}`,
    "",
    "📍 ठिकाण:",
    address,
    "",
    `👥 व्यक्ती: ${guests}`,
    "",
    notes ? "📝 सूचना:" : "📝 सूचना: नाही",
    ...(notes ? [notes] : []),
    "",
    "कृपया खालील पर्याय निवडा:",
  ].join("\n");
};

const buildCookBookingScheduledMessage = ({ booking, cookName, customerName, bookingUrl } = {}) =>
  [
    "✅ Cook Mitra — बुकिंग निश्चित झाली!",
    "",
    `नमस्कार ${cookName || "कुक"} 🙏`,
    "",
    "तुमची बुकिंग यशस्वीपणे निश्चित झाली आहे.",
    "",
    `👤 ग्राहक: ${customerName || "ग्राहक"}`,
    `📅 तारीख: ${formatServiceDate(booking)}`,
    `⏰ वेळ: ${booking?.startTime || ""} ते ${booking?.endTime || ""}`,
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
    "📝 अतिरिक्त माहिती:",
    formatNotes(booking),
    "",
    `💰 तुमचे मानधन: ₹${formatPayout(booking)}`,
    "",
    "कृपया दिलेल्या वेळेवर ग्राहकाच्या पत्त्यावर पोहोचा.",
    "",
    "📌 बुकिंग तपशील:",
    bookingUrl || bookingUrlFor(booking?._id),
    "",
    "— Cook Mitra",
  ].join("\n");

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
    `⏰ वेळ: ${booking?.startTime || ""} ते ${booking?.endTime || ""}`,
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
  buildBookingRequestMessage,
  buildCookBookingScheduledMessage,
  buildCustomerBookingConfirmedMessage,
  buildBookingExpiredMessage,
  buildBookingAlreadyAcceptedMessage,
  buildBookingCancelledMessage,
  buildBookingRejectedMessage,
  buildPaymentExpiredMessage,
  bookingUrlFor,
};
