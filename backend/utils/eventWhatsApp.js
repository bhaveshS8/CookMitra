const User = require("../models/User");
const CookProfile = require("../models/CookProfile");
const whatsappApi = require("./whatsappApi");
const {
  NOT_AVAILABLE,
  formatMarathiDate,
  mapsDirLink,
} = require("./whatsappMessages");
const { getFrontendBaseUrl } = require("./whatsapp");
const { to12h } = require("./time");

const EVENT_SERVICE_MARATHI = {
  cooking_only: "फक्त स्वयंपाक",
  preparation_cooking: "तयारी + स्वयंपाक",
  cooking_serving: "स्वयंपाक + सर्व्हिंग",
};

const eventServiceType = (serviceType) =>
  EVENT_SERVICE_MARATHI[String(serviceType || "")] ||
  String(serviceType || "").replace(/_/g, " ") ||
  NOT_AVAILABLE;

const eventAddressParts = (event) =>
  [event?.address, event?.area, event?.landmark]
    .map((part) => String(part || "").trim())
    .filter(Boolean);

const eventAddress = (event) => eventAddressParts(event).join(", ") || NOT_AVAILABLE;

const eventUrl = (event) =>
  event?._id ? `${getFrontendBaseUrl()}/event-bookings/${event._id}` : "";

const buildEventCookConfirmedMessage = ({ event, cookName } = {}) => {
  const bookingId = event?.bookingId || event?._id || "";
  const eventName = event?.customEventType || event?.eventType || NOT_AVAILABLE;
  const date = event?.eventDate ? formatMarathiDate(event.eventDate) : NOT_AVAILABLE;
  const startTime = event?.startTime ? to12h(event.startTime) : NOT_AVAILABLE;
  const duration = Number(event?.duration || 0) + Number(event?.extraHours || 0);
  const amount = Math.round(Number(event?.payment?.paidAmount || event?.totalAmount || 0));
  const address = eventAddress(event);
  const addressText = eventAddressParts(event).join(", ");
  const mapLink = addressText ? mapsDirLink({ address: addressText }) : null;

  return [
    `नमस्कार ${cookName || "कुक"},`,
    "",
    "पेमेंट प्राप्त झाले — इव्हेंट बुकिंग कन्फर्म झाले आहे.",
    "",
    `बुकिंग आयडी: ${bookingId || NOT_AVAILABLE}`,
    `इव्हेंट: ${eventName}`,
    `तारीख: ${date}`,
    `वेळ: ${startTime}`,
    `कालावधी: ${duration > 0 ? `${duration} तास` : NOT_AVAILABLE}`,
    `पाहुणे: ${event?.guestCount ?? NOT_AVAILABLE}`,
    `सेवा: ${eventServiceType(event?.serviceType)}`,
    "",
    "मेनू:",
    String(event?.menu || "").trim() || NOT_AVAILABLE,
    "",
    `पत्ता: ${address}`,
    ...(mapLink ? [`नकाशा: ${mapLink}`] : []),
    `अंतर: ${event?.distanceKm ?? NOT_AVAILABLE} किमी`,
    "",
    `एकूण पेमेंट: ₹${amount || NOT_AVAILABLE}`,
    "",
    "कृपया वेळेवर पोहोचा.",
    ...(eventUrl(event) ? ["", `बुकिंग तपशील: ${eventUrl(event)}`] : []),
    "",
    "— Cook Mitra",
  ].join("\n");
};

const resolveEventCookContact = async (event) => {
  if (!event?.cookId) return null;
  const cook = await User.findById(event.cookId)
    .select("name phone mobile role status")
    .lean();
  if (!cook || String(cook.role).toUpperCase() !== "COOK" || cook.status !== "active") {
    return null;
  }
  const profile = await CookProfile.findOne({ user: cook._id })
    .select("approvalStatus")
    .lean();
  if (!profile || profile.approvalStatus !== "approved") return null;
  // The User schema has no separate WhatsApp-number field. Use the same
  // stored contact the existing booking WhatsApp channel uses; Meta is the
  // final authority on whether that number is reachable on WhatsApp.
  const phone = String(cook.phone || cook.mobile || "").trim();
  if (!phone) return null;
  return { name: cook.name || "कुक", phone };
};

const sendEventCookConfirmed = async (event) => {
  try {
    const contact = await resolveEventCookContact(event);
    if (!contact) return { ok: false, skipped: true, reason: "no-cook-contact" };
    const body = buildEventCookConfirmedMessage({ event, cookName: contact.name });
    return await whatsappApi.sendWhatsAppText(contact.phone, body);
  } catch (error) {
    console.warn(
      `[event-whatsapp] confirmation send failed for ${event?.bookingId || event?._id || "unknown"}: ${String(
        error?.message || error
      ).slice(0, 200)}`
    );
    return { ok: false, error: error?.message || "event-whatsapp-failed" };
  }
};

const notifyEventCookConfirmed = (event) => {
  Promise.resolve(sendEventCookConfirmed(event)).catch(() => {});
};

module.exports = {
  buildEventCookConfirmedMessage,
  resolveEventCookContact,
  sendEventCookConfirmed,
  notifyEventCookConfirmed,
};
