
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
const { slotRange } = require("./time");

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
    enabled,
    configured: Boolean(hasToken && phoneNumberId),
    flag: String(process.env.WHATSAPP_ENABLED || "false"),
    hasToken,
    hasPhoneNumberId: Boolean(phoneNumberId),
    apiVersion: API_VERSION,
  };
};

const toE164 = (phone) => {
  const mobile = normalizeIndianMobile(phone);
  return mobile ? `91${mobile}` : null;
};

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
      const fbCode = data?.error?.code;
      const fbSubcode = data?.error?.error_subcode;
      const fbMessage = data?.error?.message || `http-${res.status}`;
      // Honor Meta 429 Retry-After so the dispatch worker backs off for
      // as long as Meta asks instead of hammering the rate limit.
      let retryAfterMs = null;
      try {
        const raw = res.headers && typeof res.headers.get === "function"
          ? res.headers.get("retry-after")
          : null;
        const secs = Number(raw);
        if (res.status === 429 && Number.isFinite(secs) && secs >= 0) {
          retryAfterMs = Math.min(secs * 1000, 15 * 60 * 1000);
        }
      } catch {
        retryAfterMs = null;
      }
      // 401 / code 190 = Meta rejected WHATSAPP_TOKEN (expired temporary
      // token, revoked system-user token, or token from a different app than
      // WHATSAPP_PHONE_NUMBER_ID). Surface an actionable hint so server logs
      // point straight at the fix instead of just "Authentication Error".
      const isAuthError = res.status === 401 || res.status === 403 || fbCode === 190;
      const hint = isAuthError
        ? " — WHATSAPP_TOKEN invalid/expired (code 190): regenerate the token in Meta (WhatsApp > API Setup for testing, or a permanent system-user token for production), put it on ONE line in backend/.env as WHATSAPP_TOKEN=<token>, and restart the backend. See docs/WHATSAPP_SETUP.md."
        : "";
      console.warn(
        `WhatsApp send failed: ${res.status} code=${fbCode ?? "?"} subcode=${fbSubcode ?? "?"} ${JSON.stringify(data).slice(0, 500)}${hint}`
      );
      return {
        ok: false,
        error: `${fbMessage}${hint}`,
        code: fbCode ?? null,
        status: res.status,
        ...(retryAfterMs != null ? { retryAfterMs } : {}),
      };
    }
    return { ok: true, id: data?.messages?.[0]?.id || null };
  } catch (err) {
    console.warn("WhatsApp send error:", err?.message || err);
    return { ok: false, error: err?.message || "network-error" };
  }
};

const sendWhatsAppText = async (toPhone, body) => {
  const to = toE164(toPhone);
  if (!isWhatsAppEnabled()) return { ok: false, skipped: true, reason: "whatsapp-disabled" };
  if (!to) return { ok: false, skipped: true, reason: "invalid-recipient" };
  if (!body || !String(body).trim()) return { ok: false, skipped: true, reason: "empty-body" };
  const text = String(body).slice(0, 4000);
  return postToMessages({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: text, preview_url: true },
  });
};

const acceptPayload = (bookingId) => `accept:${bookingId}`;
const rejectPayload = (bookingId) => `reject:${bookingId}`;

// Approved-template sender (Meta requires templates for
// business-initiated messages outside the 24-hour customer-service
// window). `bodyParams` fills the template's {{1}}..{{n}} variables.
const sendTemplateMessage = async (toPhone, templateName, lang, bodyParams = []) => {
  const to = toE164(toPhone);
  if (!isWhatsAppEnabled()) return { ok: false, skipped: true, reason: "whatsapp-disabled" };
  if (!to) return { ok: false, skipped: true, reason: "invalid-recipient" };
  const name = String(templateName || "").trim();
  if (!name) return { ok: false, skipped: true, reason: "no-template" };
  const code = String(lang || "").trim() || "en";
  const parameters = (Array.isArray(bodyParams) ? bodyParams : [])
    // Positions are sacred: {{n}} fills from the array index, so an empty
    // value must NEVER be dropped (dropping shifts every later value into
    // the wrong label — the exact "swapped fields" incident of Oct 2026).
    // Empties become the codebase's standard missing-value marker instead.
    .map((t) => {
      const s = String(t ?? "").slice(0, 100);
      return { type: "text", text: s.length > 0 ? s : "—" };
    });
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: { name, language: { code } },
  };
  if (parameters.length) {
    payload.template.components = [{ type: "body", parameters }];
  }
  return postToMessages(payload);
};

// Generic interactive button sender. `buttons` is an array of
// { id, title } reply buttons. Payload ids stay booking-specific
// (`accept:<id>` / `reject:<id>`); authorization always comes from the
// verified sender phone number, never from these ids.
const sendInteractiveButtons = async (toPhone, bodyText, buttons) => {
  const to = toE164(toPhone);
  if (!isWhatsAppEnabled()) return { ok: false, skipped: true, reason: "whatsapp-disabled" };
  if (!to) return { ok: false, skipped: true, reason: "invalid-recipient" };
  const text = String(bodyText || "").trim();
  if (!text) return { ok: false, skipped: true, reason: "empty-body" };
  const safeButtons = (Array.isArray(buttons) ? buttons : [])
    .filter((b) => b && b.id && b.title)
    .slice(0, 3)
    .map((b) => ({
      type: "reply",
      reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) },
    }));
  if (!safeButtons.length) return { ok: false, skipped: true, reason: "no-buttons" };
  return postToMessages({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: text.slice(0, 1024) },
      action: { buttons: safeButtons },
    },
  });
};

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
  const templateName = String(
    process.env.WHATSAPP_REQUEST_TEMPLATE ||
      // Legacy alias kept for existing .env files (see docs/WHATSAPP_SETUP.md).
      process.env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK ||
      ""
  ).trim();
  if (templateName) {
    const lang =
      String(
        process.env.WHATSAPP_REQUEST_TEMPLATE_LANG ||
          process.env.WHATSAPP_TEMPLATE_LANG_COOK_REQUEST ||
          "en"
      ).trim() || "en";
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
              { type: "text", text: `${dateStr} ${slotRange(booking?.startTime, booking?.endTime)}`.slice(0, 100) },
              { type: "text", text: bookingId.slice(-6) },
            ],
          },
        ],
      },
    });
    if (tpl.ok) return tpl;
    console.warn("WhatsApp template request failed, falling back to interactive:", tpl.error || tpl.reason);
  }
  return postToMessages(interactive);
};

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
  }
  return { cookName, cookPhone, customerName, customerPhone };
};

const sendBookingWhatsApp = async (event, booking, opts = {}) => {
  try {
    if (!isWhatsAppEnabled()) return { ok: false, skipped: true, reason: "whatsapp-disabled" };
    if (!booking) return { ok: false, skipped: true, reason: "no-booking" };
    const { cookName, cookPhone, customerName, customerPhone } = await resolveParties(booking, opts);

    let cookMessage = null;
    let customerMessage = null;

    switch (event) {
      case "request":
        // Customer copy suppressed (admin opt-out) — in-app only.
        // Cooks still get the interactive Accept/Decline request below.
        cookMessage = null;
        customerMessage = null;
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
        // Customer still gets the confirmation; the cook's job-sheet copy
        // is in-app only (admin opted out of cook WhatsApp for this event).
        cookMessage = null;
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
        // Customer still gets the completion + review nudge; the cook's
        // copy is in-app only (admin opted out of cook WhatsApp here).
        customerMessage = buildServiceCompletedMessage({ booking, cookName });
        cookMessage = null;
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
        // Customer copy suppressed (admin opt-out) — in-app only.
        // Cook still gets the "slot open again" notice below.
        customerMessage = null;
        cookMessage = buildExpiredMessage({
          booking,
          reason: "A booking request expired without a response — the slot is open again.",
        });
        break;
      default:
        return { ok: false, skipped: true, reason: "unknown-event" };
    }

    const sends = [];
    if (event === "request" && cookPhone && booking?._id) {
      sends.push(
        (async () => {
          const r = await sendCookRequestInteractive(cookPhone, { customerName, booking });
          if (r.ok) return { side: "cook", ...r };
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

const notifyWhatsApp = (event, booking, opts = {}) => {
  try {
    Promise.resolve(sendBookingWhatsApp(event, booking, opts)).catch(() => {});
  } catch {
  }
};

module.exports = {
  isWhatsAppEnabled,
  status: status,
  sendWhatsAppText,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendCookRequestInteractive,
  acceptPayload,
  rejectPayload,
  sendBookingWhatsApp,
  notifyWhatsApp,
  toE164,
};
