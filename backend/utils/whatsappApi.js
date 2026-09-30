// Automatic WhatsApp notifications via the Meta WhatsApp Business Cloud API.
//
// Setup (see docs/WHATSAPP_SETUP.md):
//   WHATSAPP_ENABLED=true
//   WHATSAPP_TOKEN=<system-user permanent token from Meta app dashboard>
//   WHATSAPP_PHONE_NUMBER_ID=<phone number ID from WhatsApp > API setup>
//
// Behavior contract (notification outage must NEVER break bookings):
//  - When unconfigured/disabled, every send resolves { ok:false, skipped:true }.
//  - Every public function catches internally and resolves (never rejects),
//    so controllers can fire-and-forget without try/catch.
//  - Invalid recipient numbers resolve { ok:false, skipped:true }.

const {
  normalizeIndianMobile,
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
  bookingUrl,
} = require("./whatsapp");

const API_VERSION = process.env.WHATSAPP_API_VERSION || "v22.0";

const getConfig = () => {
  const token = String(process.env.WHATSAPP_TOKEN || "").trim();
  const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const enabled =
    String(process.env.WHATSAPP_ENABLED || "").toLowerCase() === "true" && Boolean(token && phoneNumberId);
  return { enabled, token, phoneNumberId };
};

const isWhatsAppEnabled = () => getConfig().enabled;

const status = () => {
  const { enabled, phoneNumberId } = getConfig();
  const hasToken = Boolean(String(process.env.WHATSAPP_TOKEN || "").trim());
  return {
    // enabled === fully send-ready (flag + token + phone ID).
    enabled,
    configured: Boolean(hasToken && phoneNumberId),
    flag: String(process.env.WHATSAPP_ENABLED || "false"),
    hasToken,
    hasPhoneNumberId: Boolean(phoneNumberId),
    apiVersion: API_VERSION,
  };
};

// E.164 recipient for the Cloud API (India default).
const toE164 = (phone) => {
  const mobile = normalizeIndianMobile(phone);
  return mobile ? `91${mobile}` : null;
};

// Low-level Graph API post. Never throws — always resolves a result object.
const postToMessages = async (payload) => {
  const { enabled, token, phoneNumberId } = getConfig();
  if (!enabled) return { ok: false, skipped: true, reason: "whatsapp-disabled" };
  try {
    const res = await fetch(`https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("WhatsApp send failed:", res.status, JSON.stringify(data).slice(0, 500));
      return { ok: false, error: data?.error?.message || `http-${res.status}` };
    }
    return { ok: true, id: data?.messages?.[0]?.id || null };
  } catch (err) {
    console.warn("WhatsApp send error:", err?.message || err);
    return { ok: false, error: err?.message || "network-error" };
  }
};

// Low-level text send. Never throws — always resolves a result object.
const sendWhatsAppText = async (toPhone, body) => {
  const to = toE164(toPhone);
  if (!isWhatsAppEnabled()) return { ok: false, skipped: true, reason: "whatsapp-disabled" };
  if (!to) return { ok: false, skipped: true, reason: "invalid-recipient" };
  if (!body || !String(body).trim()) return { ok: false, skipped: true, reason: "empty-body" };
  // WhatsApp text limit is 4096 chars — truncate defensively.
  const text = String(body).slice(0, 4000);
  return postToMessages({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: text, preview_url: true },
  });
};

// Interactive booking request for the COOK with tap-to-decide buttons.
// Button payloads carry the booking id (accept:<id> / reject:<id>) so the
// inbound webhook can authorize the tap against that exact booking.
// Free-form interactive messages deliver inside the 24h customer-service
// window; for cold starts set WHATSAPP_REQUEST_TEMPLATE (+_LANG) to an
// approved template carrying the same wording — the template path is used
// first and falls back to interactive when Meta rejects it.
const acceptPayload = (bookingId) => `accept:${bookingId}`;
const rejectPayload = (bookingId) => `reject:${bookingId}`;

const sendCookRequestInteractive = async (cookPhone, { customerName, booking }) => {
  const to = toE164(cookPhone);
  if (!isWhatsAppEnabled()) return { ok: false, skipped: true, reason: "whatsapp-disabled" };
  if (!to) return { ok: false, skipped: true, reason: "invalid-recipient" };
  if (!booking?._id) return { ok: false, skipped: true, reason: "no-booking" };
  const bookingId = String(booking._id);
  const bodyText = buildBookingRequestMessage({ customerName, booking });
  const interactive = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText.slice(0, 1024) },
      action: {
        buttons: [
          { type: "reply", reply: { id: acceptPayload(bookingId), title: "Accept ✅" } },
          { type: "reply", reply: { id: rejectPayload(bookingId), title: "Decline ❌" } },
        ],
      },
    },
  };
  const templateName = String(process.env.WHATSAPP_REQUEST_TEMPLATE || "").trim();
  if (templateName) {
    const lang = String(process.env.WHATSAPP_REQUEST_TEMPLATE_LANG || "en").trim() || "en";
    const dateStr = booking?.date ? new Date(booking.date).toLocaleDateString("en-IN") : "";
    const tpl = await postToMessages({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: lang },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: String(customerName || "Customer").slice(0, 100) },
              { type: "text", text: String(booking?.serviceType || "").replace(/_/g, " ").slice(0, 100) },
              { type: "text", text: `${dateStr} ${booking?.startTime || ""}-${booking?.endTime || ""}`.slice(0, 100) },
              { type: "text", text: bookingId.slice(-6) },
            ],
          },
        ],
      },
    });
    // Template approved + in-window: done. Otherwise (e.g. 132000 template
    // not found, 131030 window rules) fall through to interactive below.
    if (tpl.ok) return tpl;
    console.warn("WhatsApp template request failed, falling back to interactive:", tpl.error || tpl.reason);
  }
  return postToMessages(interactive);
};

// Resolve display names + phones for both parties. Accepts explicit overrides
// (controllers that already loaded the users) and falls back to a User lookup.
// Never throws — missing data resolves to nulls (that side is then skipped).
const resolveParties = async (booking, opts = {}) => {
  let cookName = opts.cookName || null;
  let cookPhone = opts.cookPhone || null;
  let customerName = opts.customerName || null;
  let customerPhone = opts.customerPhone || null;
  try {
    const needCook = !cookName || !cookPhone;
    const needCustomer = !customerName || !customerPhone;
    if ((needCook || needCustomer) && booking) {
      const User = require("../models/User");
      const tasks = [];
      if (needCook && booking.cook) {
        tasks.push(
          User.findById(booking.cook)
            .select("name phone mobile")
            .lean()
            .then((u) => ({ side: "cook", u }))
            .catch(() => ({ side: "cook", u: null }))
        );
      }
      if (needCustomer && booking.customer) {
        tasks.push(
          User.findById(booking.customer)
            .select("name phone mobile")
            .lean()
            .then((u) => ({ side: "customer", u }))
            .catch(() => ({ side: "customer", u: null }))
        );
      }
      const rows = await Promise.all(tasks);
      for (const { side, u } of rows) {
        if (!u) continue;
        const phone = u.phone || u.mobile || null;
        if (side === "cook") {
          if (!cookName && u.name) cookName = u.name;
          if (!cookPhone && phone) cookPhone = phone;
        } else {
          if (!customerName && u.name) customerName = u.name;
          if (!customerPhone && phone) customerPhone = phone;
        }
      }
    }
  } catch {
    // non-fatal: send with whatever we have
  }
  return { cookName, cookPhone, customerName, customerPhone };
};

// Central dispatcher for every booking lifecycle event.
//   event: request | accepted | rejected | confirmed | started |
//          hours_complete | completed | review | cancelled | rescheduled | expired
// Resolves when both sends settle. Never rejects.
const sendBookingWhatsApp = async (event, booking, opts = {}) => {
  try {
    if (!isWhatsAppEnabled()) return { ok: false, skipped: true, reason: "whatsapp-disabled" };
    if (!booking) return { ok: false, skipped: true, reason: "no-booking" };
    const { cookName, cookPhone, customerName, customerPhone } = await resolveParties(booking, opts);

    let cookMessage = null;
    let customerMessage = null;

    switch (event) {
      case "request":
        // Cook side is sent as interactive buttons (see sends below) —
        // cookMessage stays null so the plain-text path doesn't double-send.
        cookMessage = null;
        customerMessage = [
          "*Cook Mitra: Booking request sent* ✅",
          `Service: ${String(booking?.serviceType || "").replace(/_/g, " ")}`,
          `Date: ${booking?.date ? new Date(booking.date).toLocaleDateString("en-IN") : ""}${booking?.startTime ? ` | ${booking.startTime} - ${booking.endTime || ""}` : ""}`,
          booking?._id ? `Booking ID: ${booking._id}` : null,
          "The cook has 5 minutes to accept. We will notify you on WhatsApp the moment they respond.",
        ]
          .filter(Boolean)
          .join("\n");
        break;
      case "accepted":
        customerMessage = buildAcceptedMessage({ cookName, cookPhone, booking });
        if (opts.notifyCook) {
          cookMessage = buildAcceptedMessage({ booking, customerName, forCook: true });
        }
        break;
      case "rejected":
        customerMessage = buildRejectedMessage({ booking, refundNote: opts.refundNote });
        break;
      case "confirmed":
        cookMessage = buildCookJobSheetMessage({ customerName, customerPhone, booking });
        customerMessage = buildCustomerConfirmationMessage({ cookName, cookPhone, booking });
        break;
      case "started":
        customerMessage = buildServiceStartedMessage({ booking, cookName });
        cookMessage = buildServiceStartedMessage({ booking, forCook: true });
        break;
      case "hours_complete":
        customerMessage = buildHoursCompleteMessage({ booking, cookName, cookPhone, customerName });
        cookMessage = buildHoursCompleteMessage({ booking, cookName, cookPhone, customerName });
        break;
      case "completed":
        customerMessage = buildServiceCompletedMessage({ booking, cookName });
        cookMessage = buildServiceCompletedMessage({ booking, forCook: true });
        break;
      case "review": {
        const link = opts.reviewUrl || bookingUrl(booking?._id);
        customerMessage = buildReviewMessage({ cookName, booking, reviewUrl: link });
        break;
      }
      case "cancelled":
        cookMessage = buildCancelledMessage({ booking, cancelledBy: opts.cancelledBy, refundNote: opts.refundNote });
        customerMessage = buildCancelledMessage({ booking, cancelledBy: opts.cancelledBy, refundNote: opts.refundNote });
        break;
      case "rescheduled":
        cookMessage = buildRescheduledMessage({
          booking,
          oldDate: opts.oldDate,
          oldStart: opts.oldStart,
          oldEnd: opts.oldEnd,
        });
        customerMessage = buildRescheduledMessage({
          booking,
          oldDate: opts.oldDate,
          oldStart: opts.oldStart,
          oldEnd: opts.oldEnd,
        });
        break;
      case "expired":
        customerMessage = buildExpiredMessage({ booking, reason: opts.reason });
        cookMessage = buildExpiredMessage({
          booking,
          reason: "A booking request expired without a response — the slot is open again.",
        });
        break;
      default:
        return { ok: false, skipped: true, reason: "unknown-event" };
    }

    const sends = [];
    // Booking requests go to the cook as an interactive Accept/Decline
    // message; everything else stays plain text.
    if (event === "request" && cookPhone && booking?._id) {
      sends.push(
        (async () => {
          const r = await sendCookRequestInteractive(cookPhone, { customerName, booking });
          if (r.ok) return { side: "cook", ...r };
          // Interactive unsupported here (or template rejected and no
          // fallback) — degrade to the plain-text request, never silence.
          const text = buildBookingRequestMessage({ customerName, booking });
          return { side: "cook", ...(await sendWhatsAppText(cookPhone, text)) };
        })()
      );
    } else if (cookMessage && cookPhone) {
      sends.push(sendWhatsAppText(cookPhone, cookMessage).then((r) => ({ side: "cook", ...r })));
    }
    if (customerMessage && customerPhone)
      sends.push(sendWhatsAppText(customerPhone, customerMessage).then((r) => ({ side: "customer", ...r })));
    if (!sends.length) return { ok: false, skipped: true, reason: "no-recipients" };
    const results = await Promise.all(sends);
    return { ok: results.some((r) => r.ok), results };
  } catch (err) {
    console.warn("sendBookingWhatsApp error:", err?.message || err);
    return { ok: false, error: err?.message || "dispatch-error" };
  }
};

// Fire-and-forget wrapper for controllers: schedules the send without
// delaying the HTTP response and swallows every failure.
const notifyWhatsApp = (event, booking, opts = {}) => {
  try {
    Promise.resolve(sendBookingWhatsApp(event, booking, opts)).catch(() => {});
  } catch {
    // never let notification scheduling throw into request handling
  }
};

module.exports = {
  isWhatsAppEnabled,
  status: status,
  sendWhatsAppText,
  sendCookRequestInteractive,
  acceptPayload,
  rejectPayload,
  sendBookingWhatsApp,
  notifyWhatsApp,
  toE164,
};
