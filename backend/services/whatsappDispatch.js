// WhatsApp dispatcher — event-based fan-out for booking lifecycle events.
//
//   booking requested  ->  notifyWhatsAppEvent("booking.requested", ...)
//   booking accepted   ->  notifyWhatsAppEvent("booking.accepted", ...)
//   booking confirmed  ->  notifyWhatsAppEvent("booking.confirmed", ...)
//
// The booking controller only emits events; all message building lives in
// utils/whatsappMessages.js and all Meta API calls go through
// utils/whatsappApi.js. Dispatcher failures NEVER fail the booking
// transaction — sends are best-effort and recorded per booking/per cook
// (Booking.whatsappDispatch) so a failed Meta call stays `failed` /
// retryable and a `sent` entry makes retries idempotent.

const Booking = require("../models/Booking");
const User = require("../models/User");
const { normalizeIndianMobile } = require("../utils/whatsapp");
const { slotRange } = require("../utils/time");
const {
  isWhatsAppEnabled,
  sendInteractiveButtons,
  sendTemplateMessage,
  sendWhatsAppText,
  acceptPayload,
  rejectPayload,
} = require("../utils/whatsappApi");
const marathi = require("../utils/whatsappMessages");

const REQUEST_KIND = "request";
const SCHEDULED_KIND = "scheduled";
const CONFIRMED_KIND = "confirmed";

// Model calls must fail fast: unit tests and degraded environments run
// without a live DB (mongoose buffers operations), and a stalled lookup
// must never stall a webhook or a booking response.
const DB_TIMEOUT_MS = 1500;
const withDbTimeout = async (promise, fallback = null) => {
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => setTimeout(() => resolve(fallback), DB_TIMEOUT_MS)),
    ]);
  } catch {
    return fallback;
  }
};

const dispatchOf = (booking) => (Array.isArray(booking?.whatsappDispatch) ? booking.whatsappDispatch : []);

const findDispatchEntry = (booking, cookId, kind) => {
  const want = String(cookId || "");
  return dispatchOf(booking).find(
    (e) => String(e?.cook || "") === want && String(e?.kind || "") === String(kind)
  );
};

const isSent = (booking, cookId, kind) => findDispatchEntry(booking, cookId, kind)?.status === "sent";

const markDispatch = async (bookingId, cookId, kind, patch) => {
  try {
    if (!bookingId || !cookId) return;
    const now = new Date();
    const entry = {
      cook: cookId,
      kind,
      status: patch.status || "pending",
      messageId: patch.messageId || "",
      attempts: patch.attempts || 0,
      sentAt: patch.status === "sent" ? patch.sentAt || now : patch.sentAt,
      lastAttemptAt: patch.lastAttemptAt || now,
      error: patch.error ? String(patch.error).slice(0, 500) : "",
    };
    // Try to update an existing entry in place; otherwise push a new one.
    const updated = await withDbTimeout(
      Booking.updateOne(
        { _id: bookingId, whatsappDispatch: { $elemMatch: { cook: cookId, kind } } },
        {
          $set: {
            "whatsappDispatch.$.status": entry.status,
            "whatsappDispatch.$.messageId": entry.messageId,
            "whatsappDispatch.$.attempts": entry.attempts,
            "whatsappDispatch.$.lastAttemptAt": entry.lastAttemptAt,
            "whatsappDispatch.$.error": entry.error,
            ...(entry.sentAt ? { "whatsappDispatch.$.sentAt": entry.sentAt } : {}),
          },
        }
      )
    );
    if ((updated?.modifiedCount ?? updated?.nModified ?? 0) !== 1) {
      await withDbTimeout(
        Booking.updateOne({ _id: bookingId }, { $push: { whatsappDispatch: entry } })
      );
    }
  } catch {
    // Delivery bookkeeping must never break the booking flow.
  }
};

const loadFreshBooking = async (bookingId) => {
  try {
    const fresh = await withDbTimeout(Booking.findById(bookingId));
    return fresh || null;
  } catch {
    return null;
  }
};

const resolveCookPhones = async (userIds) => {
  const byId = new Map();
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  if (!ids.length) return byId;
  try {
    const users = await withDbTimeout(
      User.find({ _id: { $in: ids } })
        .select("phone mobile name")
        .lean(),
      []
    );
    for (const u of users || []) {
      const phone = u?.phone || u?.mobile || null;
      if (phone && normalizeIndianMobile(phone)) {
        byId.set(String(u._id), { phone, name: u?.name || "" });
      }
    }
  } catch {
    // Phone resolution failure -> those cooks are skipped, booking survives.
  }
  return byId;
};

const ignoredIds = (booking) => new Set((booking?.ignoredBy || []).map((id) => String(id)));

// Cheap re-validation of the backend eligibility rules for broadcast
// fan-out (mirrors GET /bookings/cook/requests): approved profile,
// active cook account, requested service offered. Window/slot checks
// stay with the caller (findEligibleCooks); acceptance re-validates
// everything atomically. Direct-assigned cooks skip this — the
// assignment itself is the authorization.
const isBroadcastEligibleForDispatch = async (booking, cookId) => {
  try {
    const [profile, account] = await Promise.all([
      withDbTimeout(
        (() => {
          try {
            const CookProfile = require("../models/CookProfile");
            return CookProfile.findOne({ user: cookId });
          } catch {
            return null;
          }
        })(),
        null
      ),
      withDbTimeout(
        (() => {
          try {
            return User.findById(cookId).select("role status").lean();
          } catch {
            return null;
          }
        })(),
        null
      ),
    ]);
    if (!profile || profile.approvalStatus !== "approved") return false;
    if (account) {
      if (account.role && String(account.role).toUpperCase() !== "COOK") return false;
      if (account.status && account.status !== "active") return false;
    }
    if (
      Array.isArray(profile.serviceTypes) &&
      profile.serviceTypes.length > 0 &&
      booking?.serviceType &&
      !profile.serviceTypes.includes(booking.serviceType)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

// Retryability of a Meta send outcome. 429 / 5xx / network-level failures
// are transient (safe to retry with backoff); auth errors, invalid
// recipients and validation skips are permanent. The durable dispatch
// worker (services/bookingDispatchJobs.js) uses this to decide between
// `retrying` and a terminal state.
const isRetryableResult = (res) => {
  if (!res || res.ok) return false;
  if (typeof res.retryable === "boolean") return res.retryable;
  if (res.skipped) return false;
  const status = Number(res.status);
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (!Number.isFinite(status) || status === 0) {
    return /timeout|timed out|econn|enet|eai_again|socket|fetch failed|network/i.test(
      String(res.error || res.reason || "")
    );
  }
  return false;
};

// Send one Marathi booking-request with Accept/Decline buttons.
// Cold-start path first: when WHATSAPP_REQUEST_TEMPLATE(_FOR_COOK) is set,
// the approved template (params built ONLY by templateParamsForBooking()
// in reading order [customer, date, weekday, time, duration, address]) is
// tried first — templates are deliverable outside the 24h customer-service
// window where interactive free-form fails async with 131047. On template
// failure/misconfiguration it falls back to the interactive button message
// built ONLY by buildBookingRequestMessage() from named live fields. Only
// a Meta-accepted message marks delivery `sent`; anything else stays
// retryable.
// Param order override: comma-separated names from
// customer | date | weekday | time | duration | address.
// Default matches the approved `new_booking_request` (mr) template whose
// {{1}}..{{6}} placeholders sit in reading order next to the labels
// customer, date dd/mm/yyyy, weekday, time-range, duration-hours (" तास"
// is hardcoded in the template after the duration marker), address.
// Verify from ONE live delivery: each label's value must equal the booking
// field above — e.g. "वार" shows the Marathi weekday, never a number.
// Override with WHATSAPP_TEMPLATE_PARAM_ORDER only if your template's
// markers genuinely differ, e.g.
// WHATSAPP_TEMPLATE_PARAM_ORDER=customer,date,address,weekday,time,duration
const DEFAULT_TEMPLATE_PARAM_ORDER = ["customer", "date", "weekday", "time", "duration", "address"];
const templateParamOrder = () => {
  try {
    const raw = String(process.env.WHATSAPP_TEMPLATE_PARAM_ORDER || "").trim();
    if (!raw) return DEFAULT_TEMPLATE_PARAM_ORDER;
    const known = new Set(DEFAULT_TEMPLATE_PARAM_ORDER);
    const clean = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((p) => known.has(p));
    if (!clean.length) return DEFAULT_TEMPLATE_PARAM_ORDER;
    // Append any missing slots so no value is ever dropped.
    for (const k of DEFAULT_TEMPLATE_PARAM_ORDER) if (!clean.includes(k)) clean.push(k);
    return clean;
  } catch {
    return DEFAULT_TEMPLATE_PARAM_ORDER;
  }
};

const templateParamsForBooking = (booking, customerName) => {
  // Param order matches the approved `new_booking_request` (mr) example:
  // [customer, date dd/mm/yyyy, weekday, time-range, duration-hours, address].
  // sendTemplateMessage truncates each to 100 chars.
  try {
    const d = booking?.date ? new Date(booking.date) : null;
    let dateStr = "";
    try {
      if (d && !Number.isNaN(d.getTime())) {
        const parts = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Kolkata",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        }).format(d);
        dateStr = String(parts || "");
      }
    } catch {
      dateStr = "";
    }
    const start = String(booking?.startTime || "").slice(0, 5);
    const end = String(booking?.endTime || "").slice(0, 5);
    const timeRange = slotRange(start, end) || start || end || "";
    const duration = booking?.durationHours != null ? String(booking.durationHours) : "";
    const address = String(booking?.address || "").trim();
    let weekday = "";
    try {
      weekday = marathi.calculateMarathiWeekday(booking?.date) || "";
    } catch {
      weekday = "";
    }
    if (weekday === "माहिती उपलब्ध नाही") weekday = "";
    const byName = {
      customer: String(customerName || "ग्राहक"),
      date: dateStr,
      weekday,
      time: timeRange,
      duration,
      address,
    };
    return templateParamOrder().map((k) => byName[k] ?? "");
  } catch {
    return [String(customerName || "ग्राहक")];
  }
};

// A template failure with a client/config status (bad name, bad token)
// will fail identically for every cook in the fan-out — retrying it per
// cook wastes one Meta call each. Callers pass a shared `fanoutState`
// ({ templateBroken: false }); once set, remaining cooks skip straight
// to interactive. Transient failures (429/5xx/network) never set it.
const isTemplateConfigFailure = (tpl) => {
  if (!tpl || tpl.ok) return false;
  const status = Number(tpl.status);
  if (status === 401 || status === 403) return true;
  if (status === 400) return true;
  return /no-template|template/i.test(String(tpl.error || tpl.reason || ""));
};

const sendRequestToCook = async (booking, cookId, cookName, cookPhone, customerName, opts = {}) => {
  const bookingId = String(booking._id);
  const fanoutState = opts.fanoutState || null;
  const log = (msg, extra) =>
    console.warn(`[whatsapp:request] booking=${bookingId} cook=${cookId} ${msg}`, extra || "");
  const bodyText = marathi.buildBookingRequestMessage({ booking, customerName });
  await markDispatch(bookingId, cookId, REQUEST_KIND, { status: "sending", attempts: 1 });
  // Cold-start path: cooks outside the 24h customer-service window cannot
  // receive interactive free-form messages (Meta fails async with 131047
  // Re-engagement). Try the approved template first when configured —
  // templates are deliverable outside the window and carry Accept/Decline
  // quick replies. Fall back to interactive for warm cooks / misconfigured
  // template names so current behavior is preserved.
  const templateName = String(
    process.env.WHATSAPP_REQUEST_TEMPLATE ||
      process.env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK ||
      ""
  ).trim();
  if (templateName && !(fanoutState && fanoutState.templateBroken)) {
    const lang = String(
      process.env.WHATSAPP_REQUEST_TEMPLATE_LANG ||
        process.env.WHATSAPP_TEMPLATE_LANG_COOK_REQUEST ||
        "mr"
    ).trim() || "mr";
    try {
      const tpl = await sendTemplateMessage(
        cookPhone,
        templateName,
        lang,
        templateParamsForBooking(booking, customerName)
      );
      if (tpl?.ok) {
        await markDispatch(bookingId, cookId, REQUEST_KIND, {
          status: "sent",
          messageId: tpl.id || "",
          attempts: 1,
        });
        return { ...(tpl || {}), retryable: false };
      }
      if (fanoutState && isTemplateConfigFailure(tpl) && !tpl.retryAfterMs) {
        fanoutState.templateBroken = true;
        log("template misconfigured, skipping template for remaining cooks", tpl?.error || tpl?.reason || "");
      } else {
        log("template request failed, falling back to interactive", tpl?.error || tpl?.reason || "");
      }
    } catch (err) {
      log("template request error, falling back to interactive", err?.message || err);
    }
  }
  const raw = await sendInteractiveButtons(cookPhone, bodyText, [
    { id: acceptPayload(bookingId), title: marathi.ACCEPT_BUTTON_TITLE },
    { id: rejectPayload(bookingId), title: marathi.REJECT_BUTTON_TITLE },
  ]);
  // Annotate retryability (and Meta's Retry-After) so callers — the
  // durable worker in particular — can decide retry vs terminal state
  // without re-parsing provider error text.
  const res = raw && typeof raw === "object"
    ? { ...raw, retryable: isRetryableResult(raw) }
    : raw;
  if (res?.ok) {
    await markDispatch(bookingId, cookId, REQUEST_KIND, {
      status: "sent",
      messageId: res.id || "",
      attempts: 1,
    });
  } else if (!res?.skipped) {
    log("button message failed", res?.error || res?.reason || "");
    await markDispatch(bookingId, cookId, REQUEST_KIND, {
      status: "failed",
      attempts: 1,
      error: res?.error || res?.reason || "send-failed",
    });
  } else if (res?.reason === "invalid-recipient" || res?.reason === "empty-body") {
    log("button message skipped", res?.reason || "");
    await markDispatch(bookingId, cookId, REQUEST_KIND, {
      status: "failed",
      attempts: 1,
      error: res?.reason || "skipped",
    });
  }
  return res;
};

// One-line structured log per fan-out exit (booking id + reason only —
// no phone numbers, message bodies, or customer data). The durable worker
// persists the same reason codes on the DispatchJob, so incidents are
// diagnosable from logs or the admin endpoint without reading MongoDB.
const fanoutLog = (bookingId, stage, reason, extra) => {
  try {
    console.warn(
      `[whatsapp:dispatch] booking=${bookingId || "?"} stage=${stage} reason=${reason}${extra ? ` ${extra}` : ""}`
    );
  } catch {
  }
};

// Fan-out: send the Marathi booking request to every eligible cook.
// `eligibleCooks` uses the same shape as findEligibleCooks():
// [{ profile, userId }]. For direct-cook bookings only the assigned cook
// is contacted. Never throws.
const fanOutBookingRequest = async (booking, eligibleCooks, opts = {}) => {
  try {
    if (!booking?._id) {
      fanoutLog(null, "fanout", "no-booking");
      return { ok: false, reason: "no-booking" };
    }
    if (!isWhatsAppEnabled()) {
      fanoutLog(booking._id, "fanout", "whatsapp-disabled");
      return { ok: false, skipped: true, reason: "whatsapp-disabled" };
    }
    const fresh = (await loadFreshBooking(booking._id)) || booking;
    if (!fresh || fresh.status !== "requested") {
      fanoutLog(booking._id, "fanout", "not-requested", `status=${fresh?.status || "missing"}`);
      return { ok: false, reason: "not-requested", status: fresh?.status || null };
    }
    const ignored = ignoredIds(fresh);
    const assignedCook = fresh.cook ? String(fresh.cook) : null;

    let targets = eligibleCooks || [];
    if (assignedCook) {
      targets = targets.filter((c) => String(c?.userId || "") === assignedCook);
      if (!targets.length) targets = [{ userId: assignedCook }];
    } else {
      targets = targets.filter((c) => c?.userId && !ignored.has(String(c.userId)));
    }
    if (!targets.length) {
      fanoutLog(booking._id, "fanout", "no-recipients", `eligible=${(eligibleCooks || []).length}`);
      return { ok: false, reason: "no-recipients" };
    }

    const phones = await resolveCookPhones(targets.map((c) => c.userId));
    const results = [];
    // Shared across this fan-out only: avoids one wasted template call per
    // remaining cook when the template itself is misconfigured.
    const fanoutState = { templateBroken: false };
    for (const target of targets) {
      const cookId = String(target.userId);
      try {
        if (ignored.has(cookId)) continue;
        const latest = (await loadFreshBooking(booking._id)) || fresh;
        if (!latest || latest.status !== "requested") break;
        if (isSent(latest, cookId, REQUEST_KIND)) {
          results.push({ cookId, skipped: true, reason: "already-sent" });
          continue;
        }
        if (!assignedCook) {
          // eslint-disable-next-line no-await-in-loop
          const eligible = await isBroadcastEligibleForDispatch(latest, cookId);
          if (!eligible) {
            await markDispatch(booking._id, cookId, REQUEST_KIND, {
              status: "failed",
              attempts: 1,
              error: "cook-not-eligible",
            });
            results.push({ cookId, ok: false, reason: "cook-not-eligible" });
            continue;
          }
        }
        const contact = phones.get(cookId);
        if (!contact) {
          await markDispatch(booking._id, cookId, REQUEST_KIND, {
            status: "failed",
            attempts: 1,
            error: "no-whatsapp-number",
          });
          results.push({ cookId, ok: false, reason: "no-whatsapp-number" });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const r = await sendRequestToCook(
          latest,
          cookId,
          target?.profile?.user?.name || contact.name || undefined,
          contact.phone,
          opts.customerName,
          { fanoutState }
        );
        results.push({ cookId, ...r });
      } catch (err) {
        results.push({ cookId, ok: false, error: err?.message || "dispatch-error" });
      }
    }
    const sent = results.filter((r) => r?.ok).length;
    const retryAfterMs = results.reduce(
      (m, r) => (Number.isFinite(r?.retryAfterMs) ? Math.max(m, r.retryAfterMs) : m),
      0
    );
    // Per-booking dispatch summary: intended vs attempted vs outcomes.
    // `eligible` is the FULL eligible set — never truncated.
    const summary = {
      eligible: targets.length,
      attempted: results.length,
      sent,
      failed: results.filter((r) => !r?.ok && !r?.skipped).length,
      skipped: results.filter((r) => r?.skipped).length,
      noPhone: results.filter((r) =>
        /no-whatsapp-number|invalid-recipient/i.test(String(r?.error || r?.reason || ""))
      ).length,
      ineligible: results.filter((r) =>
        /cook-not-eligible/i.test(String(r?.error || r?.reason || ""))
      ).length,
    };
    fanoutLog(
      booking._id,
      "fanout",
      sent > 0 ? "completed" : "all-failed",
      `eligible=${summary.eligible} attempted=${summary.attempted} sent=${sent} failed=${summary.failed} skipped=${summary.skipped}`
    );
    return {
      ok: results.some((r) => r.ok),
      results,
      summary,
      ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
    };
  } catch (err) {
    fanoutLog(booking?._id, "fanout", "dispatch-error", String(err?.message || "").slice(0, 120));
    return { ok: false, error: err?.message || "dispatch-error" };
  }
};

// Cook scheduled message (requested -> accepted -> paid). Idempotent per cook.
// Gate: sent only after payment is done — the cook gets this job sheet once
// the booking is real money, never on bare acceptance.
const sendCookScheduledMessage = async (booking, opts = {}) => {
  try {
    if (!booking?._id || !booking?.cook) return { ok: false, reason: "no-cook" };
    if (!isWhatsAppEnabled()) return { ok: false, skipped: true, reason: "whatsapp-disabled" };
    const cookId = String(booking.cook);
    const fresh = (await loadFreshBooking(booking._id)) || booking;
    if (isSent(fresh, cookId, SCHEDULED_KIND)) return { ok: true, skipped: true, reason: "already-sent" };
    const paid = String(fresh?.payment?.status || booking?.payment?.status || "").toLowerCase() === "paid";
    if (!paid) return { ok: false, skipped: true, reason: "payment-pending" };
    const phones = await resolveCookPhones([cookId]);
    const contact = phones.get(cookId);
    if (!contact) return { ok: false, reason: "no-whatsapp-number" };
    let cookName = opts.cookName || contact.name || "";
    let customerName = opts.customerName || "";
    try {
      if (!customerName && fresh.customer) {
        const customer = await withDbTimeout(
          User.findById(fresh.customer).select("name").lean()
        );
        if (customer?.name) customerName = customer.name;
      }
    } catch {
    }
    const text = marathi.buildCookBookingScheduledMessage({
      booking: fresh,
      cookName,
      customerName,
      bookingUrl: opts.bookingUrl,
    });
    await markDispatch(booking._id, cookId, SCHEDULED_KIND, { status: "sending", attempts: 1 });
    const res = await sendWhatsAppText(contact.phone, text);
    if (res?.ok) {
      await markDispatch(booking._id, cookId, SCHEDULED_KIND, {
        status: "sent",
        messageId: res.id || "",
        attempts: 1,
      });
    } else if (!res?.skipped) {
      await markDispatch(booking._id, cookId, SCHEDULED_KIND, {
        status: "failed",
        attempts: 1,
        error: res?.error || res?.reason || "send-failed",
      });
    }
    return res;
  } catch (err) {
    return { ok: false, error: err?.message || "dispatch-error" };
  }
};

// Customer confirmed message (accepted -> confirmed, payment verified).
// Never carries the service OTP.
const sendCustomerConfirmedMessage = async (booking, opts = {}) => {
  try {
    if (!booking?._id) return { ok: false, reason: "no-booking" };
    if (!isWhatsAppEnabled()) return { ok: false, skipped: true, reason: "whatsapp-disabled" };
    let cookName = opts.cookName || "";
    let customerName = opts.customerName || "";
    let customerPhone = opts.customerPhone || "";
    try {
      const tasks = [];
      if ((!cookName || !customerName || !customerPhone) && booking) {
        if (booking.cook && !cookName) {
          tasks.push(
            withDbTimeout(
              User.findById(booking.cook)
                .select("name")
                .lean()
                .then((u) => ({ side: "cook", u }))
                .catch(() => ({ side: "cook", u: null })),
              { side: "cook", u: null }
            )
          );
        }
        if (booking.customer && (!customerName || !customerPhone)) {
          tasks.push(
            withDbTimeout(
              User.findById(booking.customer)
                .select("name phone mobile")
                .lean()
                .then((u) => ({ side: "customer", u }))
                .catch(() => ({ side: "customer", u: null })),
              { side: "customer", u: null }
            )
          );
        }
      }
      const rows = await Promise.all(tasks);
      for (const { side, u } of rows) {
        if (!u) continue;
        if (side === "cook" && !cookName && u.name) cookName = u.name;
        if (side === "customer") {
          if (!customerName && u.name) customerName = u.name;
          if (!customerPhone) customerPhone = u.phone || u.mobile || "";
        }
      }
    } catch {
    }
    if (!customerPhone || !normalizeIndianMobile(customerPhone)) {
      return { ok: false, reason: "no-whatsapp-number" };
    }
    const text = marathi.buildCustomerBookingConfirmedMessage({
      booking,
      cookName,
      customerName,
      paidAmount: opts.paidAmount,
      bookingUrl: opts.bookingUrl,
    });
    return sendWhatsAppText(customerPhone, text);
  } catch (err) {
    return { ok: false, error: err?.message || "dispatch-error" };
  }
};

// Cook payment-expiry notice (accepted but customer never paid).
const sendPaymentExpiredCookNotice = async (booking) => {
  try {
    if (!booking?._id || !booking?.cook) return { ok: false, reason: "no-cook" };
    if (!isWhatsAppEnabled()) return { ok: false, skipped: true, reason: "whatsapp-disabled" };
    const cookId = String(booking.cook);
    const phones = await resolveCookPhones([cookId]);
    const contact = phones.get(cookId);
    if (!contact) return { ok: false, reason: "no-whatsapp-number" };
    return sendWhatsAppText(contact.phone, marathi.buildPaymentExpiredMessage({}));
  } catch (err) {
    return { ok: false, error: err?.message || "dispatch-error" };
  }
};

// Event entry-point (spec section 18). Fire-and-forget safe: never throws.
const notifyWhatsAppEvent = (event, booking, opts = {}) => {
  try {
    const run = async () => {
      try {
        if (event === "booking.requested") {
          await fanOutBookingRequest(booking, opts.eligibleCooks || [], {
            customerName: opts.customerName,
          });
        } else if (event === "booking.accepted") {
          await sendCookScheduledMessage(booking, opts);
        } else if (event === "booking.confirmed") {
          await sendCustomerConfirmedMessage(booking, opts);
        } else if (event === "booking.payment-expired") {
          await sendPaymentExpiredCookNotice(booking);
        }
      } catch {
      }
    };
    Promise.resolve(run()).catch(() => {});
  } catch {
  }
};

module.exports = {
  REQUEST_KIND,
  SCHEDULED_KIND,
  CONFIRMED_KIND,
  isRetryableResult,
  fanOutBookingRequest,
  sendCookScheduledMessage,
  sendCustomerConfirmedMessage,
  sendPaymentExpiredCookNotice,
  notifyWhatsAppEvent,
  findDispatchEntry,
  isSent,
  templateParamOrder,
};
