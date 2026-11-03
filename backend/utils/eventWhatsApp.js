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

const EVENT_SERVICE_ENGLISH = {
  cooking_only: "Cooking only",
  preparation_cooking: "Preparation + cooking",
  cooking_serving: "Cooking + serving",
};

const eventServiceType = (serviceType) =>
  EVENT_SERVICE_MARATHI[String(serviceType || "")] ||
  String(serviceType || "").replace(/_/g, " ") ||
  NOT_AVAILABLE;

const eventServiceTypeEnglish = (serviceType) =>
  EVENT_SERVICE_ENGLISH[String(serviceType || "")] ||
  String(serviceType || "").replace(/_/g, " ") ||
  "—";

const eventAddressParts = (event) =>
  [event?.address, event?.area, event?.landmark]
    .map((part) => String(part || "").trim())
    .filter(Boolean);

const eventAddress = (event) => eventAddressParts(event).join(", ") || NOT_AVAILABLE;

const eventUrl = (event) =>
  event?._id ? `${getFrontendBaseUrl()}/event-bookings/${event._id}` : "";

const eventCookIds = (event) => {
  const ids = [event?.cookId, ...(Array.isArray(event?.cookIds) ? event.cookIds : [])]
    .filter(Boolean)
    .map((id) => String(id?._id || id));
  return [...new Set(ids)];
};

const contactPhone = (user) => String(user?.phone || user?.mobile || "").trim();

const formatEnglishDate = (date) => {
  try {
    const d = date instanceof Date ? date : new Date(date);
    if (!date || Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(d);
  } catch {
    return "—";
  }
};

const resolveEventCookContacts = async (event) => {
  const contacts = [];
  for (const id of eventCookIds(event)) {
    const cook = await User.findById(id)
      .select("name phone mobile role status")
      .lean();
    if (!cook) continue;
    const profile = await CookProfile.findOne({ user: cook._id })
      .select("approvalStatus")
      .lean();
    // The User schema has no separate WhatsApp-number field. Use the same
    // stored contact the existing booking WhatsApp channel uses; Meta is the
    // final authority on whether that number is reachable on WhatsApp.
    const phone = contactPhone(cook);
    contacts.push({
      id: String(cook._id),
      name: cook.name || "कुक",
      phone,
      deliverable:
        String(cook.role).toUpperCase() === "COOK" &&
        cook.status === "active" &&
        profile?.approvalStatus === "approved" &&
        Boolean(phone),
    });
  }
  return contacts;
};

const resolveEventCustomerContact = async (event) => {
  if (!event?.customerId) return null;
  const id = event.customerId?._id || event.customerId;
  const customer = await User.findById(id).select("name phone mobile").lean();
  if (!customer) return null;
  return {
    id: String(customer._id),
    name: String(customer.name || "").trim() || "Customer",
    phone: contactPhone(customer),
  };
};

const resolveEventContacts = async (event) => {
  const [cooks, customer] = await Promise.all([
    resolveEventCookContacts(event),
    resolveEventCustomerContact(event),
  ]);
  return { cooks, customer };
};

const cookContactLines = (cooks) =>
  (Array.isArray(cooks) ? cooks : []).map(
    (cook) => `- ${cook.name || NOT_AVAILABLE}: ${cook.phone || NOT_AVAILABLE}`
  );

const buildEventCookConfirmedMessage = ({ event, cookName, customer, cooks } = {}) => {
  const bookingId = event?.bookingId || event?._id || "";
  const eventName = event?.customEventType || event?.eventType || NOT_AVAILABLE;
  const date = event?.eventDate ? formatMarathiDate(event.eventDate) : NOT_AVAILABLE;
  const startTime = event?.startTime ? to12h(event.startTime) : NOT_AVAILABLE;
  const duration = Number(event?.duration || 0) + Number(event?.extraHours || 0);
  const amount = Math.round(Number(event?.payment?.paidAmount || event?.totalAmount || 0));
  const address = eventAddress(event);
  const addressText = eventAddressParts(event).join(", ");
  const mapLink = addressText ? mapsDirLink({ address: addressText }) : null;
  const cookLines = cookContactLines(cooks);

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
    `ग्राहक: ${customer?.name || NOT_AVAILABLE}`,
    `ग्राहक संपर्क: ${customer?.phone || NOT_AVAILABLE}`,
    ...(cookLines.length ? ["", "इव्हेंटसाठी नियुक्त कुक:", ...cookLines] : []),
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

const buildEventCustomerConfirmedMessage = ({ event, customerName, cooks } = {}) => {
  const bookingId = event?.bookingId || event?._id || "—";
  const eventName = event?.customEventType || event?.eventType || "—";
  const date = event?.eventDate ? formatEnglishDate(event.eventDate) : "—";
  const startTime = event?.startTime ? to12h(event.startTime) : "—";
  const duration = Number(event?.duration || 0) + Number(event?.extraHours || 0);
  const amount = Math.round(Number(event?.payment?.paidAmount || event?.totalAmount || 0));
  const address = eventAddress(event);
  const addressText = eventAddressParts(event).join(", ");
  const mapLink = addressText ? mapsDirLink({ address: addressText }) : null;
  const cookLines = cookContactLines(cooks);

  return [
    `Hi ${customerName || "there"},`,
    "",
    `Your payment of ₹${amount || "—"} for event booking ${bookingId} is confirmed.`,
    "",
    "Assigned cook(s):",
    ...(cookLines.length ? cookLines : ["- —"]),
    "",
    `Event: ${eventName}`,
    `Date: ${date}`,
    `Time: ${startTime}`,
    `Duration: ${duration > 0 ? `${duration} hours` : "—"}`,
    `Guests: ${event?.guestCount ?? "—"}`,
    `Service: ${eventServiceTypeEnglish(event?.serviceType)}`,
    "",
    "Menu:",
    String(event?.menu || "").trim() || "—",
    "",
    `Address: ${address}`,
    ...(mapLink ? [`Map: ${mapLink}`] : []),
    `Distance: ${event?.distanceKm ?? "—"} km`,
    "",
    `Total paid: ₹${amount || "—"}`,
    ...(eventUrl(event) ? ["", `Booking details: ${eventUrl(event)}`] : []),
    "",
    "— Cook Mitra",
  ].join("\n");
};

const resolveEventCookContact = async (event) => {
  if (!event?.cookId) return null;
  const contact = (await resolveEventCookContacts({ cookId: event.cookId }))[0];
  if (!contact?.deliverable) return null;
  return { name: contact.name, phone: contact.phone };
};

const sendEventCookConfirmed = async (event) => {
  try {
    const { cooks, customer } = await resolveEventContacts(event);
    const deliverable = cooks.filter((cook) => cook.deliverable);
    if (!deliverable.length) return { ok: false, skipped: true, reason: "no-cook-contact" };
    const results = [];
    for (const cook of deliverable) {
      const body = buildEventCookConfirmedMessage({
        event,
        cookName: cook.name,
        customer,
        cooks,
      });
      results.push(await whatsappApi.sendWhatsAppText(cook.phone, body));
    }
    let customerResult = null;
    if (customer?.phone) {
      const body = buildEventCustomerConfirmedMessage({
        event,
        customerName: customer.name,
        cooks,
      });
      customerResult = await whatsappApi.sendWhatsAppText(customer.phone, body);
    }
    const failed = results.find((result) => !result?.ok);
    if (failed) {
      return {
        ok: false,
        error: failed.error || "event-whatsapp-failed",
        results,
        customer: customerResult,
      };
    }
    return {
      ok: true,
      sent: results.length + (customerResult?.ok ? 1 : 0),
      results,
      customer: customerResult,
    };
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
  buildEventCustomerConfirmedMessage,
  resolveEventCookContact,
  resolveEventCookContacts,
  resolveEventCustomerContact,
  resolveEventContacts,
  sendEventCookConfirmed,
  notifyEventCookConfirmed,
};
