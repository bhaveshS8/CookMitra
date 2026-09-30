// Helpers to share a booking's order details + user location to the cook on WhatsApp.
//
// Two layers live here:
//  1. Plain-text MESSAGE builders (build*Message) — single source of truth.
//     Used by the Meta WhatsApp Cloud API sender (utils/whatsappApi.js) to
//     push automatic notifications to the user + cook.
//  2. wa.me deep-link builders (build*WhatsAppUrl) — click-to-chat links
//     returned to the client. These delegate to (1) so both paths stay in sync.
// URL builders return null when the recipient has no valid Indian mobile number.

const FRONTEND_BASE_URL = (
  process.env.FRONTEND_URL ||
  process.env.CLIENT_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

const bookingUrl = (bookingId) =>
  bookingId ? `${FRONTEND_BASE_URL}/bookings/${bookingId}` : null;

const normalizeIndianMobile = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (/^[6-9]\d{9}$/.test(digits)) return digits;
  return null;
};

const serviceLabel = (booking) => String(booking?.serviceType || "").replace(/_/g, " ");

const dateLabel = (booking) =>
  booking?.date ? new Date(booking.date).toLocaleDateString("en-IN") : "";

const mapsPin = (booking) =>
  booking?.location?.lat != null && booking?.location?.lng != null
    ? `https://www.google.com/maps?q=${booking.location.lat},${booking.location.lng}`
    : null;

const fullVenue = (booking) => {
  const parts = [
    booking?.address || "",
    booking?.addressDetails?.flatNo || "",
    booking?.addressDetails?.society || "",
    booking?.addressDetails?.landmark || "",
    booking?.addressDetails?.city || "",
  ]
    .map((part) => String(part).trim())
    .filter(Boolean)
    .join(", ");
  return parts || booking?.address || "";
};

// ── Plain-text messages (Meta Cloud API + wa.me share one source) ────────────

// New-request alert for the COOK. Privacy: the customer's phone stays hidden
// until the cook accepts (in-app payloads redact it while `requested` too) —
// contact details unlock on accept, and the full job sheet follows payment.
// Venue stays: the cook needs it to decide within the 5-minute window.
const buildBookingRequestMessage = ({ customerName, booking }) => {
  const mapsLink = mapsPin(booking);
  const lines = [
    "*New Cook Mitra Booking Request*",
    `Customer: ${customerName || "Customer"}`,
    `Service: ${serviceLabel(booking)}`,
    `Date: ${dateLabel(booking)} | Time: ${booking?.startTime || ""} - ${booking?.endTime || ""}`,
    `Venue: ${booking?.address || ""}`,
  ];
  if (mapsLink) lines.push(`Venue pin: ${mapsLink}`);
  if (booking?.guests) lines.push(`Guests: ${booking.guests}`);
  if (booking?.durationHours) lines.push(`Duration: ${booking.durationHours} hrs`);
  if (booking?.selectedItems?.length) lines.push(`Dishes: ${booking.selectedItems.join(", ")}`);
  if (booking?.notes) lines.push(`Notes: ${booking.notes}`);
  if (booking?._id) lines.push(`Booking ID: ${booking._id}`);
  lines.push("Customer contact details unlock after you accept.");
  lines.push("Please accept it in your Cook Dashboard.");
  return lines.join("\n");
};

// After the cook ACCEPTS, this is the "booked" confirmation containing:
// cook name, cook phone number and the venue pin.
const buildCustomerConfirmationMessage = ({ cookName, cookPhone, booking }) => {
  const venueMapsLink = mapsPin(booking);
  const isConfirmed = ["accepted", "confirmed", "in_progress"].includes(booking?.status);
  const isPaid = booking?.payment?.status === "paid";

  const header = isPaid
    ? "*Cook Mitra Booking Confirmed — Payment Received* ✅"
    : isConfirmed
      ? "*Cook Mitra Booking Confirmed – Cook Accepted* 🎉"
      : "*Cook Mitra Booking Confirmation*";

  const lines = [
    header,
    `Service: ${serviceLabel(booking)}`,
    `Cook: ${cookName || "Assigned cook"}`,
    `Cook's number: ${cookPhone || "will be shared shortly"}`,
    `Date: ${dateLabel(booking)}`,
    `Service hours: ${booking?.startTime || ""} - ${booking?.endTime || ""}${booking?.durationHours ? ` (${booking.durationHours} hrs)` : ""}`,
    `Venue: ${booking?.address || ""}`,
  ];
  if (venueMapsLink) lines.push(`Your venue pin: ${venueMapsLink}`);
  if (booking?.guests) lines.push(`Guests: ${booking.guests}`);
  if (booking?.durationHours) lines.push(`Duration: ${booking.durationHours} hrs`);
  if (booking?.selectedItems?.length) lines.push(`Dishes: ${booking.selectedItems.join(", ")}`);
  if (booking?.notes) lines.push(`Notes: ${booking.notes}`);
  if (booking?._id) lines.push(`Booking ID: ${booking._id}`);
  if (booking?.status) lines.push(`Status: ${String(booking.status).toUpperCase()}`);
  return lines.join("\n");
};

// Sent right after the customer's payment succeeds (cook already accepted),
// so the cook receives the customer's name, phone number and venue location
// (address + GPS pin) in one tap.
const buildCookJobSheetMessage = ({ customerName, customerPhone, booking }) => {
  const mapsLink = mapsPin(booking);
  const lines = [
    "*Cook Mitra: Payment Received — Job Confirmed* ✅",
    `Customer: ${customerName || "Customer"}`,
    `Customer number: ${customerPhone || "not shared"}`,
    `Service: ${serviceLabel(booking)}`,
    `Date: ${dateLabel(booking)} | Time: ${booking?.startTime || ""} - ${booking?.endTime || ""}`,
    `Venue: ${fullVenue(booking)}`,
  ];
  if (mapsLink) lines.push(`Location pin: ${mapsLink}`);
  if (booking?.guests) lines.push(`Guests: ${booking.guests}`);
  if (booking?.durationHours) lines.push(`Duration: ${booking.durationHours} hrs`);
  if (booking?.selectedItems?.length) lines.push(`Dishes: ${booking.selectedItems.join(", ")}`);
  if (booking?.notes) lines.push(`Notes: ${booking.notes}`);
  if (booking?._id) lines.push(`Booking ID: ${booking._id}`);
  lines.push("The customer has PAID. Please reach the venue on time.");
  return lines.join("\n");
};

// "Cooking hours complete" alarm for EITHER party (pass recipient context).
const buildHoursCompleteMessage = ({ booking, cookName, cookPhone, customerName }) => {
  const endStr = booking?.endTime || "";
  const completedAt = booking?.hoursCompletedAt
    ? new Date(booking.hoursCompletedAt).toLocaleString("en-IN")
    : "";
  const lines = [
    "*Cook Mitra: Cooking Hours Complete*",
    `Service: ${serviceLabel(booking)}`,
    `Cook: ${cookName || "Assigned cook"}${cookPhone ? ` (${cookPhone})` : ""}`,
    `Customer: ${customerName || "Customer"}`,
    `Date: ${dateLabel(booking)}${endStr ? ` | Ended at: ${endStr}` : ""}`,
    `Venue: ${booking?.address || ""}`,
  ];
  const bid = booking?._id || booking?.bookingId;
  if (bid) lines.push(`Booking ID: ${bid}`);
  if (completedAt) lines.push(`Completed at: ${completedAt}`);
  lines.push("Your booked cooking hours are complete. Please review your session!");
  return lines.join("\n");
};

// "Service complete — please rate your cook" reminder for the CUSTOMER.
const buildReviewMessage = ({ cookName, booking, reviewUrl }) => {
  const link = reviewUrl || bookingUrl(booking?._id);
  const lines = [
    "*Cook Mitra: How was your meal? Please rate your cook* ⭐",
    `Cook: ${cookName || "Your cook"}`,
    `Service: ${serviceLabel(booking)}`,
    `Date: ${dateLabel(booking)}${booking?.startTime ? ` | ${booking.startTime} - ${booking.endTime || ""}` : ""}`,
  ];
  const bid = booking?._id;
  if (bid) lines.push(`Booking ID: ${bid}`);
  if (link) lines.push(`Rate here: ${link}`);
  lines.push("Your rating helps other households find great cooks. Thank you!");
  return lines.join("\n");
};

const buildAcceptedMessage = ({ cookName, cookPhone, booking, forCook = false, customerName }) => {
  if (forCook) {
    return [
      "*Cook Mitra: You accepted a booking* ✅",
      `Customer: ${customerName || "Customer"}`,
      `Service: ${serviceLabel(booking)}`,
      `Date: ${dateLabel(booking)} | Time: ${booking?.startTime || ""} - ${booking?.endTime || ""}`,
      `Venue: ${booking?.address || ""}`,
      booking?._id ? `Booking ID: ${booking._id}` : null,
      "The customer has 5 minutes to complete payment. Please keep this slot free.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "*Cook Mitra: Your booking was accepted!* 🎉",
    `Cook: ${cookName || "Your cook"}`,
    `Cook's number: ${cookPhone || "will be shared shortly"}`,
    `Service: ${serviceLabel(booking)}`,
    `Date: ${dateLabel(booking)} | Time: ${booking?.startTime || ""} - ${booking?.endTime || ""}`,
    booking?._id ? `Booking ID: ${booking._id}` : null,
    "Please complete payment within 5 minutes to confirm your slot.",
  ]
    .filter(Boolean)
    .join("\n");
};

const buildRejectedMessage = ({ booking, refundNote }) => {
  return [
    "*Cook Mitra: Booking request declined*",
    `Service: ${serviceLabel(booking)}`,
    `Date: ${dateLabel(booking)}${booking?.startTime ? ` | ${booking.startTime} - ${booking.endTime || ""}` : ""}`,
    booking?._id ? `Booking ID: ${booking._id}` : null,
    "Your booking request was declined by the cook. Please try another cook or slot.",
    refundNote || null,
  ]
    .filter(Boolean)
    .join("\n");
};

const buildCancelledMessage = ({ booking, cancelledBy, refundNote }) => {
  const who =
    cancelledBy === "cook"
      ? "The cook cancelled this booking."
      : cancelledBy === "admin"
        ? "Our support team cancelled this booking."
        : "This booking was cancelled.";
  return [
    "*Cook Mitra: Booking cancelled*",
    `Service: ${serviceLabel(booking)}`,
    `Date: ${dateLabel(booking)}${booking?.startTime ? ` | ${booking.startTime} - ${booking.endTime || ""}` : ""}`,
    booking?._id ? `Booking ID: ${booking._id}` : null,
    who,
    refundNote || null,
  ]
    .filter(Boolean)
    .join("\n");
};

const buildRescheduledMessage = ({ booking, oldDate, oldStart, oldEnd }) => {
  const lines = [
    "*Cook Mitra: Booking rescheduled* 📅",
    `Service: ${serviceLabel(booking)}`,
  ];
  if (oldDate || oldStart) {
    lines.push(`Old slot: ${oldDate || ""}${oldStart ? ` | ${oldStart} - ${oldEnd || ""}` : ""}`);
  }
  lines.push(`New slot: ${dateLabel(booking)} | ${booking?.startTime || ""} - ${booking?.endTime || ""}`);
  if (booking?._id) lines.push(`Booking ID: ${booking._id}`);
  lines.push("Please note the new date and time.");
  return lines.join("\n");
};

const buildExpiredMessage = ({ booking, reason }) => {
  return [
    "*Cook Mitra: Booking request expired* ⏰",
    `Service: ${serviceLabel(booking)}`,
    `Date: ${dateLabel(booking)}${booking?.startTime ? ` | ${booking.startTime} - ${booking.endTime || ""}` : ""}`,
    booking?._id ? `Booking ID: ${booking._id}` : null,
    reason || "The cook did not respond within 5 minutes. Please find another cook.",
  ]
    .filter(Boolean)
    .join("\n");
};

const buildServiceStartedMessage = ({ booking, cookName, forCook = false }) => {
  if (forCook) {
    return [
      "*Cook Mitra: Service started* 🍳",
      `Service: ${serviceLabel(booking)} | ${booking?.startTime || ""} - ${booking?.endTime || ""}`,
      booking?._id ? `Booking ID: ${booking._id}` : null,
      "Your service clock is running. Enjoy the session!",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "*Cook Mitra: Your service has started!* 🍳",
    `Cook ${cookName || "your cook"} has started the session.`,
    `Service: ${serviceLabel(booking)} | ${booking?.startTime || ""} - ${booking?.endTime || ""}`,
    booking?._id ? `Booking ID: ${booking._id}` : null,
    "The cooking hours are now being counted. Enjoy your meal!",
  ]
    .filter(Boolean)
    .join("\n");
};

const buildServiceCompletedMessage = ({ booking, cookName, forCook = false }) => {
  if (forCook) {
    return [
      "*Cook Mitra: Service marked complete* ✅",
      `Service: ${serviceLabel(booking)}`,
      `Date: ${dateLabel(booking)}`,
      booking?._id ? `Booking ID: ${booking._id}` : null,
      "The customer has been asked to rate the session. Thank you!",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "*Cook Mitra: Service complete!* ✅",
    `${cookName || "Your cook"} finished your session.`,
    `Service: ${serviceLabel(booking)}`,
    `Date: ${dateLabel(booking)}`,
    booking?._id ? `Booking ID: ${booking._id}` : null,
    "Please rate your cook — your rating helps other households. Thank you!",
  ]
    .filter(Boolean)
    .join("\n");
};

// ── wa.me deep links (delegate to the message builders above) ────────────────

const buildBookingWhatsAppUrl = ({ cookPhone, customerName, booking }) => {
  const mobile = normalizeIndianMobile(cookPhone);
  if (!mobile) return null;
  const text = buildBookingRequestMessage({ customerName, booking });
  return `https://wa.me/91${mobile}?text=${encodeURIComponent(text)}`;
};

// Build a wa.me link targeting the CUSTOMER's own WhatsApp: sends their order
// details + booking confirmation (cook name/phone, venue pin). Cook live
// location tracking was removed — no live pins or tracking links here.
// Returns null when the customer has no valid number.
const buildCustomerWhatsAppUrl = ({ customerPhone, cookName, cookPhone, booking }) => {
  const mobile = normalizeIndianMobile(customerPhone);
  if (!mobile) return null;
  const text = buildCustomerConfirmationMessage({ cookName, cookPhone, booking });
  return `https://wa.me/91${mobile}?text=${encodeURIComponent(text)}`;
};

// Build a wa.me link targeting the COOK's WhatsApp with the full job sheet:
// sent right after the customer's payment succeeds (cook already accepted),
// so the cook receives the customer's name, phone number and venue location
// (address + GPS pin) in one tap. Returns null for invalid cook numbers.
const buildCookJobSheetWhatsAppUrl = ({ cookPhone, customerName, customerPhone, booking }) => {
  const mobile = normalizeIndianMobile(cookPhone);
  if (!mobile) return null;
  const text = buildCookJobSheetMessage({ customerName, customerPhone, booking });
  return `https://wa.me/91${mobile}?text=${encodeURIComponent(text)}`;
};

// Build a wa.me "cooking hours complete" alarm targeted at EITHER party's own
// WhatsApp (pass the recipient's phone as toPhone). Used so both customer and
// cook get the alarm as a WhatsApp message. Returns null for invalid numbers.
const buildHoursCompleteWhatsAppUrl = ({ toPhone, booking, cookName, cookPhone, customerName }) => {
  const mobile = normalizeIndianMobile(toPhone);
  if (!mobile) return null;
  const text = buildHoursCompleteMessage({ booking, cookName, cookPhone, customerName });
  return `https://wa.me/91${mobile}?text=${encodeURIComponent(text)}`;
};

// Build a wa.me "service complete — please rate your cook" reminder targeted
// at the CUSTOMER's own WhatsApp. Links back to the booking page where the
// review form lives. Returns null for invalid numbers.
const buildReviewWhatsAppUrl = ({ customerPhone, cookName, booking, reviewUrl }) => {
  const mobile = normalizeIndianMobile(customerPhone);
  if (!mobile) return null;
  const text = buildReviewMessage({ cookName, booking, reviewUrl });
  return `https://wa.me/91${mobile}?text=${encodeURIComponent(text)}`;
};

module.exports = {
  normalizeIndianMobile,
  buildBookingWhatsAppUrl,
  buildCustomerWhatsAppUrl,
  buildCookJobSheetWhatsAppUrl,
  buildHoursCompleteWhatsAppUrl,
  buildReviewWhatsAppUrl,
  bookingUrl,
  FRONTEND_BASE_URL,
  // Plain-text messages (Meta Cloud API sender):
  buildBookingRequestMessage,
  buildCustomerConfirmationMessage,
  buildCookJobSheetMessage,
  buildHoursCompleteMessage,
  buildReviewMessage,
  buildAcceptedMessage,
  buildRejectedMessage,
  buildCancelledMessage,
  buildRescheduledMessage,
  buildExpiredMessage,
  buildServiceStartedMessage,
  buildServiceCompletedMessage,
};
