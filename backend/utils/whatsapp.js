// Helpers to share a booking's order details + user location to the cook on WhatsApp.
// Builds a wa.me deep link with a pre-filled message. Returns null when the
// cook has no valid Indian mobile number.

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

const buildBookingWhatsAppUrl = ({ cookPhone, customerName, customerPhone, booking }) => {
  const mobile = normalizeIndianMobile(cookPhone);
  if (!mobile) return null;

  const mapsLink =
    booking?.location?.lat != null && booking?.location?.lng != null
      ? `https://www.google.com/maps?q=${booking.location.lat},${booking.location.lng}`
      : null;

  const dateStr = booking?.date ? new Date(booking.date).toLocaleDateString("en-IN") : "";

  const lines = [
    "*New Cook Mitra Booking Request*",
    `Customer: ${customerName || "Customer"}${customerPhone ? ` (${customerPhone})` : ""}`,
    `Service: ${(booking?.serviceType || "").replace(/_/g, " ")}`,
    `Date: ${dateStr} | Time: ${booking?.startTime || ""} - ${booking?.endTime || ""}`,
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

// Build a wa.me link targeting the CUSTOMER's own WhatsApp: sends their order
// details + booking confirmation (cook name/phone, venue pin). Cook live
// location tracking was removed — no live pins or tracking links here.
// Returns null when the customer has no valid number.
// After the cook ACCEPTS, this is the "booked" confirmation containing:
// cook name, cook phone number and the venue pin.
const buildCustomerWhatsAppUrl = ({ customerPhone, cookName, cookPhone, booking }) => {
  const mobile = normalizeIndianMobile(customerPhone);
  if (!mobile) return null;

  const venueMapsLink =
    booking?.location?.lat != null && booking?.location?.lng != null
      ? `https://www.google.com/maps?q=${booking.location.lat},${booking.location.lng}`
      : null;

  const dateStr = booking?.date ? new Date(booking.date).toLocaleDateString("en-IN") : "";

  const isConfirmed = ["accepted", "confirmed", "in_progress"].includes(booking?.status);
  const isPaid = booking?.payment?.status === "paid";

  const header = isPaid
    ? "*Cook Mitra Booking Confirmed \u2014 Payment Received* \u2705"
    : isConfirmed
      ? "*Cook Mitra Booking Confirmed \u2013 Cook Accepted* \uD83C\uDF89"
      : "*Cook Mitra Booking Confirmation*";

  const lines = [
    header,
    `Service: ${(booking?.serviceType || "").replace(/_/g, " ")}`,
    `Cook: ${cookName || "Assigned cook"}`,
    `Cook's number: ${cookPhone || "will be shared shortly"}`,
    `Date: ${dateStr}`,
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

  return `https://wa.me/91${mobile}?text=${encodeURIComponent(lines.join("\n"))}`;
};

// Build a wa.me link targeting the COOK's WhatsApp with the full job sheet:
// sent right after the customer's payment succeeds (cook already accepted),
// so the cook receives the customer's name, phone number and venue location
// (address + GPS pin) in one tap. Returns null for invalid cook numbers.
const buildCookJobSheetWhatsAppUrl = ({ cookPhone, customerName, customerPhone, booking }) => {
  const mobile = normalizeIndianMobile(cookPhone);
  if (!mobile) return null;

  const mapsLink =
    booking?.location?.lat != null && booking?.location?.lng != null
      ? `https://www.google.com/maps?q=${booking.location.lat},${booking.location.lng}`
      : null;

  const dateStr = booking?.date ? new Date(booking.date).toLocaleDateString("en-IN") : "";

  const addressLines = [
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
    `Date: ${dateStr} | Time: ${booking?.startTime || ""} - ${booking?.endTime || ""}`,
    `Venue: ${addressLines || booking?.address || ""}`,
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

// Build a wa.me "cooking hours complete" alarm targeted at EITHER party's own
// WhatsApp (pass the recipient's phone as toPhone). Used so both customer and
// cook get the alarm as a WhatsApp message. Returns null for invalid numbers.
const buildHoursCompleteWhatsAppUrl = ({ toPhone, booking, cookName, cookPhone, customerName }) => {
  const mobile = normalizeIndianMobile(toPhone);
  if (!mobile) return null;

  const dateStr = booking?.date ? new Date(booking.date).toLocaleDateString("en-IN") : "";
  const endStr = booking?.endTime || "";
  const completedAt = booking?.hoursCompletedAt
    ? new Date(booking.hoursCompletedAt).toLocaleString("en-IN")
    : "";

  const lines = [
    "*Cook Mitra: Cooking Hours Complete*",
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

// Build a wa.me "service complete — please rate your cook" reminder targeted
// at the CUSTOMER's own WhatsApp. Links back to the booking page where the
// review form lives. Returns null for invalid numbers.
const buildReviewWhatsAppUrl = ({ customerPhone, cookName, booking, reviewUrl }) => {
  const mobile = normalizeIndianMobile(customerPhone);
  if (!mobile) return null;

  const dateStr = booking?.date ? new Date(booking.date).toLocaleDateString("en-IN") : "";
  const link = reviewUrl || bookingUrl(booking?._id);

  const lines = [
    "*Cook Mitra: How was your meal? Please rate your cook* ⭐",
    `Cook: ${cookName || "Your cook"}`,
    `Service: ${(booking?.serviceType || "").replace(/_/g, " ")}`,
    `Date: ${dateStr}${booking?.startTime ? ` | ${booking.startTime} - ${booking.endTime || ""}` : ""}`,
  ];
  const bid = booking?._id;
  if (bid) lines.push(`Booking ID: ${bid}`);
  if (link) lines.push(`Rate here: ${link}`);
  lines.push("Your rating helps other households find great cooks. Thank you!");

  return `https://wa.me/91${mobile}?text=${encodeURIComponent(lines.join("\n"))}`;
};

module.exports = { normalizeIndianMobile, buildBookingWhatsAppUrl, buildCustomerWhatsAppUrl, buildCookJobSheetWhatsAppUrl, buildHoursCompleteWhatsAppUrl, buildReviewWhatsAppUrl, bookingUrl, FRONTEND_BASE_URL };
