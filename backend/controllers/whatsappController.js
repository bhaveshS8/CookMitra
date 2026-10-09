// Security contract:

const crypto = require("crypto");
const Booking = require("../models/Booking");
const User = require("../models/User");
const Notification = require("../models/Notification");
const {
  expireBookingIfNeeded,
  queueRefundForApproval,
  releaseCouponUsage,
  REQUEST_WINDOW_MS,
  PAYMENT_WINDOW_MS,
} = require("./bookingController");
const { normalizeIndianMobile } = require("../utils/whatsapp");
const {
  acceptBookingForCook,
  rejectBookingForCook,
} = require("../services/bookingAcceptService");
const marathi = require("../utils/whatsappMessages");
const {
  isWhatsAppEnabled,
  sendWhatsAppText,
  notifyWhatsApp,
} = require("../utils/whatsappApi");
const {
  dayBounds,
  timeToMinutes,
  intervalsOverlap,
} = require("../utils/slots");
const { slotRange } = require("../utils/time");

const VERIFY_TOKEN = () =>
  String(
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN || ""
  ).trim();
const APP_SECRET = () => String(process.env.WHATSAPP_APP_SECRET || "").trim();

exports.verifyWebhook = (req, res) => {
  try {
    const mode = String(req.query?.["hub.mode"] || "");
    const token = String(req.query?.["hub.verify_token"] || "");
    const challenge = String(req.query?.["hub.challenge"] || "");
    const expected = VERIFY_TOKEN();
    if (mode === "subscribe" && expected && token === expected && challenge) {
      return res.status(200).send(challenge);
    }
    return res.status(403).json({ message: "Webhook verification failed" });
  } catch {
    return res.status(403).json({ message: "Webhook verification failed" });
  }
};

const signaturesEqual = (a, b) => {
  try {
    const ba = Buffer.from(String(a), "utf8");
    const bb = Buffer.from(String(b), "utf8");
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
};

const verifySignature = (raw, header) => {
  const secret = APP_SECRET();
  if (!secret || !raw || !Buffer.isBuffer(raw)) return false;
  const sig = String(header || "");
  if (!sig.startsWith("sha256=") || sig.length < 10) return false;
  let expected;
  try {
    expected = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
  } catch {
    return false;
  }
  return signaturesEqual(expected, sig);
};

const LOOKUP_TIMEOUT_MS = 1500;
const timedLookup = async (promise) => {
  try {
    const winner = await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), LOOKUP_TIMEOUT_MS)),
    ]);
    return winner && winner.__timeout ? null : winner;
  } catch {
    return null;
  }
};

const findCookByWaId = async (waId) => {
  const digits = String(waId || "").replace(/\D/g, "");
  const core = normalizeIndianMobile(digits);
  if (!core) return null;
  const variants = [core, `91${core}`, `0${core}`, `+91${core}`];
  const isCookAccount = (user) => {
    if (!user) return false;
    if (String(user.role).toUpperCase() !== "COOK") return false;
    if (user.status && user.status !== "active") return false;
    return true;
  };
  const exact = await timedLookup(
    (async () => {
      try {
        const user = await User.findOne({
          $or: [{ phone: { $in: variants } }, { mobile: { $in: variants } }],
        }).select("_id name phone mobile role status");
        return user || null;
      } catch {
        return null;
      }
    })()
  );
  if (exact && isCookAccount(exact)) return exact;
  // Fallback: stored numbers may carry formatting (spaces, dashes) that
  // defeats exact matching. Compare digit-normalized values instead so a
  // legitimate cook is never silently dropped at identification time.
  const cooks = await timedLookup(
    (async () => {
      try {
        return await User.find({ role: "COOK" }).select("_id name phone mobile role status").lean();
      } catch {
        return null;
      }
    })()
  );
  for (const c of cooks || []) {
    const stored = normalizeIndianMobile(String(c?.phone || "")) || normalizeIndianMobile(String(c?.mobile || ""));
    if (stored && stored === core && isCookAccount(c)) return c;
  }
  return null;
};

const bookingLine = (booking) => {
  const date = booking?.date ? new Date(booking.date).toLocaleDateString("en-IN") : "";
  return `${String(booking?.serviceType || "").replace(/_/g, " ")} on ${date} ${slotRange(booking?.startTime, booking?.endTime)} (ID …${String(booking?._id || "").slice(-6)})`;
};

const reply = async (to, text) => {
  try {
    await sendWhatsAppText(to, text);
  } catch {
  }
};

const seenMessageBefore = async (wamid) => {
  if (!wamid) return false;
  try {
    const WebhookEvent = require("../models/WebhookEvent");
    await WebhookEvent.create({ key: `wa:${wamid}`, event: "whatsapp.inbound" });
    return false;
  } catch (e) {
    return e?.code === 11000;
  }
};

// Keyword fallback for taps/text that carry no booking id (Marathi button
// titles, approved-template quick replies). Template payloads are free-form
// static strings from WhatsApp Manager ("Accept", "ACCEPT_BOOKING", ...),
// so latin matching is normalized (case/punctuation-insensitive) instead of
// \b-anchored. Marathi matches by substring (uses \b-unfriendly Devanagari).
const parseKeywordAction = (s) => {
  const t = String(s || "").trim();
  if (!t) return null;
  if (/स्वीकार/.test(t)) return "accept";
  if (/नकार/.test(t)) return "reject";
  const norm = t.toLowerCase().replace(/[^a-z]/g, "");
  if (/^accept/.test(norm) || norm === "yes") return "accept";
  if (/^(decline|reject)/.test(norm) || norm === "no") return "reject";
  return null;
};

const parseInboundAction = (msg) => {
  const interactive = msg?.interactive?.button_reply;
  if (interactive?.id || interactive?.title) {
    const m = String(interactive.id || "").match(/^(accept|reject):([0-9a-fA-F]{24})$/);
    if (m) return { action: m[1], bookingId: m[2] };
    // Fallback: Marathi-titled buttons or clients echoing title as id.
    const kw = parseKeywordAction(interactive.id) || parseKeywordAction(interactive.title);
    if (kw) return { action: kw, bookingId: null };
  }
  // Approved-template quick-reply taps (WHATSAPP_REQUEST_TEMPLATE path):
  // Meta delivers `{ type: "button", button: { payload, text } }` where the
  // payload is the static string configured in WhatsApp Manager — it never
  // carries a booking id, so resolution falls through to the cook's pending
  // list (1 pending = act directly, N = list, 0 = "no pending").
  const btn = msg?.button;
  if (btn && (btn.payload || btn.text)) {
    const kw = parseKeywordAction(btn.payload) || parseKeywordAction(btn.text);
    if (kw) return { action: kw, bookingId: null };
  }
  const text = String(msg?.text?.body || "").trim();
  if (!text) return { action: null, bookingId: null };
  const mm = text.match(/^स्वीकार[^\w]*([0-9a-fA-F]{24})?/) || text.match(/^नकार[^\w]*([0-9a-fA-F]{24})?/);
  if (mm) return { action: /^स्वीकार/.test(text) ? "accept" : "reject", bookingId: mm[1] || null };
  const m = text.match(/^(accept|decline|reject|yes|no)\b[^\w]*([0-9a-fA-F]{24})?/i);
  if (!m) return { action: null, bookingId: null };
  const word = m[1].toLowerCase();
  return {
    action: word === "accept" || word === "yes" ? "accept" : "reject",
    bookingId: m[2] || null,
  };
};

// Full pending list for a cook replying by text (no booking id).
// Deliberately uncapped: every live request must be visible/countable.
// Callers truncate only the displayed lines (WhatsApp text limit), never
// the underlying list.
const PENDING_FETCH_BOUND = 200;
const loadPendingForCook = async (cookId) => {
  try {
    const now = new Date();
    const [direct, broadcast] = await Promise.all([
      Booking.find({
        cook: cookId,
        status: "requested",
        requestExpiresAt: { $gt: now },
      })
        .select("_id serviceType date startTime endTime status")
        .sort({ requestExpiresAt: 1 })
        .limit(PENDING_FETCH_BOUND),
      Booking.find({
        cook: null,
        status: "requested",
        requestExpiresAt: { $gt: now },
        ignoredBy: { $ne: cookId },
      })
        .select("_id serviceType date startTime endTime status")
        .sort({ requestExpiresAt: 1 })
        .limit(PENDING_FETCH_BOUND),
    ]);
    const seen = new Set();
    const merged = [];
    for (const b of [...(direct || []), ...(broadcast || [])]) {
      const key = String(b?._id || "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(b);
    }
    return merged;
  } catch {
    return [];
  }
};

const resolveNamesForReply = async (booking, cook) => {
  let cookName = cook?.name || "";
  let customerName = "";
  try {
    if (booking?.customer) {
      const customer = await User.findById(booking.customer).select("name").lean();
      if (customer?.name) customerName = customer.name;
    }
  } catch {
  }
  return { cookName, customerName };
};

const acceptViaWhatsApp = async (cook, booking, senderE164) => {
  // The verified sender phone number determines the cook. The button
  // payload only identifies the booking — never the authorization.
  const senderTail = String(senderE164 || "").replace(/\D/g, "").slice(-4) || "????";
  const prevStatus = booking?.status || "unknown";
  console.log(
    `[whatsapp:accept] booking=${booking?._id} sender=...${senderTail} cook=${cook?._id} prev=${prevStatus} source=whatsapp`
  );
  let result = null;
  try {
    result = await acceptBookingForCook({
      bookingId: booking._id,
      cookId: cook._id,
      source: "whatsapp",
    });
  } catch (err) {
    let latest = null;
    try {
      latest = await Booking.findById(booking._id);
    } catch {
      latest = null;
    }
    const current = latest || booking;
    console.log(
      `[whatsapp:accept] booking=${booking?._id} cook=${cook?._id} refused reason=${err?.code || err?.statusCode || "error"} status=${current?.status} source=whatsapp`
    );
    if (err?.statusCode === 404) {
      await reply(senderE164, "This booking isn't assigned to you — please check your Cook Dashboard.");
      return { ok: false, reason: "not-owner" };
    }
    if (err?.code === "BOOKING_IGNORED_BY_YOU") {
      await reply(
        senderE164,
        ["You already ignored this request — please check your Cook Dashboard for live ones.", "", marathi.buildBookingRejectedMessage({ booking: current })].join("\n")
      );
      return { ok: false, reason: "ignored" };
    }
    if (String(current?.status || "") === "cancelled") {
      await reply(senderE164, marathi.buildBookingCancelledMessage({}));
      return { ok: false, reason: "cancelled" };
    }
    if (
      String(current?.status || "") === "expired" ||
      (current?.requestExpiresAt && current.requestExpiresAt < new Date())
    ) {
      await reply(senderE164, marathi.buildBookingExpiredMessage({ booking: current }));
      return { ok: false, reason: "expired" };
    }
    if (String(current?.status || "") === "accepted") {
      await reply(
        senderE164,
        ["This request is already accepted — no action needed.", "", marathi.buildBookingAlreadyAcceptedMessage({ booking: current })].join("\n")
      );
      return { ok: false, reason: "race-lost" };
    }
    if (err?.code === "SLOT_UNAVAILABLE" || err?.code === "COOK_NOT_ELIGIBLE") {
      await reply(senderE164, err?.message || "This request can no longer be accepted.");
      return { ok: false, reason: String(err?.code || "ineligible").toLowerCase().replace(/_/g, "-") };
    }
    await reply(
      senderE164,
      `This request is already ${current?.status || "handled"} — no action needed. Please check your Cook Dashboard.`
    );
    return { ok: false, reason: `already-${current?.status || "handled"}` };
  }
  let fresh = result?.booking || booking;
  try {
    const latest = await Booking.findById(booking._id);
    if (latest) fresh = latest;
  } catch {
  }
  if (result?.alreadyAccepted) {
    // Idempotent redelivery: state already reflects this cook — no
    // duplicate assignment, payment window, or notifications.
    await reply(
      senderE164,
      [`This request is already accepted — no action needed. ✅ Accepted! ${bookingLine(fresh)}`, "", marathi.buildBookingAlreadyAcceptedMessage({ booking: fresh })].join("\n")
    );
    return { ok: true, alreadyAccepted: true };
  }
  const { customerName } = await resolveNamesForReply(fresh, cook);
  console.log(
    `[whatsapp:accept] booking=${booking?._id} cook=${cook?._id} prev=${prevStatus} new=${fresh?.status} assigned=${fresh?.cook} already=${result?.alreadyAccepted === true} source=whatsapp`
  );
  // Success reply (§11): live booking data, accepted only — never claimed
  // as payment-confirmed. English lead line kept for dashboard parity.
  const confirmLines = [
    `✅ Accepted! ${bookingLine(fresh)}`,
    "",
    "✅ बुकिंग स्वीकारली!",
    "",
    "ही बुकिंग तुमच्या नावावर निश्चित करण्यात आली आहे.",
    "",
    `ग्राहक: ${customerName || "ग्राहक"}`,
    `तारीख: ${marathi.formatMarathiDate(fresh?.date)}`,
    `वेळ: ${slotRange(fresh?.startTime, fresh?.endTime) || "माहिती उपलब्ध नाही"}`,
    "",
    "कृपया Cook Mitra वेबसाइट/अॅपवर बुकिंगचे पुढील तपशील पहा.",
  ];
  await reply(senderE164, confirmLines.join("\n"));
  return { ok: true };
};

const rejectViaWhatsApp = async (cook, booking, senderE164) => {
  // Broadcast declines are ignores (status stays requested so other
  // cooks can accept). Direct-assigned declines reject the request.
  // Both go through the shared rejection service.
  let result = null;
  try {
    result = await rejectBookingForCook({
      bookingId: booking._id,
      cookId: cook._id,
      source: "whatsapp",
    });
  } catch (err) {
    let latest = null;
    try {
      latest = await Booking.findById(booking._id);
    } catch {
      latest = null;
    }
    const current = latest || booking;
    if (err?.statusCode === 404) {
      await reply(senderE164, "This booking isn't assigned to you — please check your Cook Dashboard.");
      return { ok: false, reason: "not-owner" };
    }
    await reply(senderE164, `This request is already ${current?.status || "handled"} — no action needed.`);
    return { ok: false, reason: `already-${current?.status || "handled"}` };
  }
  let fresh = result?.booking || booking;
  try {
    const latest = await Booking.findById(booking._id);
    if (latest) fresh = latest;
  } catch {
  }
  if (result?.ignored) {
    await reply(
      senderE164,
      [`Ignored. ${bookingLine(fresh)}\nOther cooks can still accept it.`, "", marathi.buildBookingRejectedMessage({ booking: fresh })].join("\n")
    );
    return { ok: true, ignored: true };
  }
  await reply(
    senderE164,
    [`Declined. ${bookingLine(fresh)}\nYour slot stays open.`, "", marathi.buildBookingRejectedMessage({ booking: fresh })].join("\n")
  );
  return { ok: true };
};

// Delivery receipts (Meta `statuses` callbacks). Maps Meta's per-message
// lifecycle onto the matching whatsappDispatch entry by Meta message id:
// sent -> delivered -> read, or failed (terminal, with upstream code).
// Advances monotonically so out-of-order/duplicate callbacks can never
// regress or duplicate visible state. Unknown ids (customer messages,
// confirmations, other templates) are ignored — only fan-out entries with
// a persisted messageId are tracked. Never throws.
const DELIVERY_RANK = { sent: 1, delivered: 2, read: 3, deleted: 3, failed: 4 };
const KNOWN_DELIVERY = new Set(Object.keys(DELIVERY_RANK));

const sanitizeUpstreamError = (status) => {
  try {
    const errs = Array.isArray(status?.errors) ? status.errors : [];
    const first = errs[0] || {};
    const code = first.code != null ? String(first.code) : "";
    const title = String(first.title || first.message || "").slice(0, 120);
    const detail = [code && `code=${code}`, title].filter(Boolean).join(" ");
    return detail.slice(0, 200);
  } catch {
    return "";
  }
};

const applyDeliveryStatus = async (st) => {
  try {
    const wamid = String(st?.id || "").trim();
    const state = String(st?.status || "").trim().toLowerCase();
    if (!wamid || !KNOWN_DELIVERY.has(state)) return { ok: false, reason: "unrecognized" };
    let doc = null;
    try {
      doc = await Booking.findOne({ "whatsappDispatch.messageId": wamid }).select(
        "_id whatsappDispatch"
      );
    } catch {
      return { ok: false, reason: "database_error" };
    }
    if (!doc) return { ok: false, reason: "unknown-message" };
    const entry = (doc.whatsappDispatch || []).find((e) => String(e?.messageId || "") === wamid);
    if (!entry) return { ok: false, reason: "unknown-message" };
    const prevRank = DELIVERY_RANK[String(entry.deliveryStatus || "").toLowerCase()] || 0;
    const nextRank = DELIVERY_RANK[state];
    const upstream = state === "failed" ? sanitizeUpstreamError(st) : "";
    if (state !== "failed" && nextRank <= prevRank) {
      return { ok: true, skipped: true, reason: "stale" };
    }
    try {
      const set = {
        "whatsappDispatch.$.deliveryStatus": state,
        "whatsappDispatch.$.deliveryUpdatedAt": new Date(),
      };
      if (upstream) set["whatsappDispatch.$.error"] = upstream;
      await Booking.updateOne(
        { _id: doc._id, "whatsappDispatch.messageId": wamid },
        { $set: set }
      );
    } catch {
      return { ok: false, reason: "database_error" };
    }
    if (state === "failed") {
      console.warn(
        `[whatsapp:delivery] booking=${doc._id} state=failed upstream=${upstream || "unknown"}`
      );
    }
    return { ok: true, state };
  } catch {
    return { ok: false, reason: "handler-error" };
  }
};

const handleOneMessage = async (msg) => {
  try {
    const from = String(msg?.from || "");
    const senderE164 = from.replace(/\D/g, "") || null;
    const { action, bookingId } = parseInboundAction(msg);
    if (!action) {
      // Unrecognized text (not ACCEPT/DECLINE) — stay silent by design
      // (admin opt-out: no instruction spam on the cook's WhatsApp).
      // The cook acts via the Accept/Decline buttons or the dashboard.
      return { ok: false, reason: "unrecognized" };
    }
    const cook = senderE164 ? await findCookByWaId(senderE164) : null;
    if (!cook) {
      return { ok: false, reason: "unknown-sender" };
    }
    let booking = null;
    if (bookingId) {
      try {
        booking = await Booking.findById(bookingId);
      } catch {
        booking = null;
      }
      if (!booking) {
        await reply(senderE164, "Couldn't find that booking — please use your Cook Dashboard.");
        return { ok: false, reason: "not-found" };
      }
    } else {
      const pending = await loadPendingForCook(cook._id);
      if (!pending.length) {
        await reply(senderE164, "You have no pending booking requests right now.");
        return { ok: false, reason: "none-pending" };
      }
      if (pending.length > 1) {
        // WhatsApp text messages cap at 4096 chars: show the first lines
        // plus an exact remainder count — the total is never understated.
        const SHOWN = 10;
        const shown = pending.slice(0, SHOWN);
        const list = shown
          .map((b) => `• ${bookingLine(b)}`)
          .join("\n");
        const more = pending.length > shown.length
          ? `\n…and ${pending.length - shown.length} more.`
          : "";
        await reply(
          senderE164,
          `You have ${pending.length} pending requests — please tap Accept/Decline on the exact request message:\n${list}${more}`
        );
        return { ok: false, reason: "ambiguous" };
      }
      try {
        booking = await Booking.findById(pending[0]._id);
      } catch {
        booking = null;
      }
      if (!booking) {
        await reply(senderE164, "Couldn't load that booking — please use your Cook Dashboard.");
        return { ok: false, reason: "not-found" };
      }
    }
    if (action === "accept") return acceptViaWhatsApp(cook, booking, senderE164);
    return rejectViaWhatsApp(cook, booking, senderE164);
  } catch (err) {
    console.warn("WhatsApp inbound handling error:", err?.message || err);
    return { ok: false, reason: "handler-error" };
  }
};

exports.handleInbound = async (req, res) => {
  try {
    if (!isWhatsAppEnabled() && !APP_SECRET()) {
      return res.status(200).json({ received: false, reason: "whatsapp-unconfigured" });
    }
    const raw = req.body && Buffer.isBuffer(req.body) ? req.body : null;
    if (!verifySignature(raw, req.headers["x-hub-signature-256"])) {
      return res.status(401).json({ message: "Invalid webhook signature" });
    }
    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(200).json({ received: false, reason: "bad-json" });
    }
    const messages = [];
    const statuses = [];
    for (const entry of event?.entry || []) {
      for (const change of entry?.changes || []) {
        const value = change?.value || {};
        for (const msg of value?.messages || []) {
          if (msg?.from) messages.push(msg);
        }
        for (const st of value?.statuses || []) {
          if (st?.id) statuses.push(st);
        }
      }
    }
    const results = [];
    for (const msg of messages) {
      if (msg?.id && (await seenMessageBefore(msg.id))) {
        results.push({ ok: false, reason: "duplicate" });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      results.push(await handleOneMessage(msg));
    }
    let statusUpdates = 0;
    const statusReasons = [];
    for (const st of statuses) {
      // eslint-disable-next-line no-await-in-loop
      const r = await applyDeliveryStatus(st);
      if (r.ok && !r.skipped) statusUpdates += 1;
      statusReasons.push(r.state || r.reason || "ok");
    }
    const handled = results.filter((r) => r.ok).length;
    console.log(
      `[whatsapp:webhook] messages=${messages.length} handled=${handled} reasons=${results.map((r) => r.reason || "ok").join(",")} statuses=${statuses.length} updated=${statusUpdates} states=${statusReasons.join(",")}`
    );
    return res.status(200).json({ received: true, handled, statusUpdates });
  } catch (err) {
    console.warn("WhatsApp webhook error:", err?.message || err);
    return res.status(200).json({ received: true, handled: 0 });
  }
};

exports.__test = { verifySignature, parseInboundAction, findCookByWaId, handleOneMessage, applyDeliveryStatus };
