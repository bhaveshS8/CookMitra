// Inbound WhatsApp webhook: lets the COOK accept or decline a booking by
// tapping the Accept/Decline buttons (or replying ACCEPT/REJECT) instead of
// opening the dashboard.
//
// Security contract:
//  - Meta subscription handshake (GET) requires WHATSAPP_WEBHOOK_VERIFY_TOKEN.
//  - Every POST must carry a valid X-Hub-Signature-256 over the RAW body,
//    keyed by WHATSAPP_APP_SECRET — unverifiable calls are refused, never
//    acted on (fail closed).
//  - A tap is authorized by the SENDER's WhatsApp number: it must match the
//    assigned cook's phone/mobile, the booking must still be `requested` and
//    inside its 5-minute window, and the state flip is an atomic conditional
//    update — exactly like the in-app accept/reject endpoints.
//  - Always answers 200 quickly for verified calls (Meta retries anything
//    slower/non-2xx); per-message failures are replied to the cook on
//    WhatsApp, never thrown into a 500.

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
  isWhatsAppEnabled,
  sendWhatsAppText,
  notifyWhatsApp,
} = require("../utils/whatsappApi");
const {
  dayBounds,
  timeToMinutes,
  intervalsOverlap,
} = require("../utils/slots");

const VERIFY_TOKEN = () => String(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "").trim();
const APP_SECRET = () => String(process.env.WHATSAPP_APP_SECRET || "").trim();

// GET /api/whatsapp/webhook — Meta subscription handshake.
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

// Verify X-Hub-Signature-256 ("sha256=<hex>") over the raw body.
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

// wa_id arrives as full international digits ("919876543210") — resolve the
// cook by matching stored phone/mobile in any common written form.
const findCookByWaId = async (waId) => {
  const digits = String(waId || "").replace(/\D/g, "");
  const core = normalizeIndianMobile(digits);
  if (!core) return null;
  const variants = [core, `91${core}`, `0${core}`, `+91${core}`];
  try {
    const user = await User.findOne({
      $or: [{ phone: { $in: variants } }, { mobile: { $in: variants } }],
    }).select("_id name phone mobile role status");
    if (!user) return null;
    if (String(user.role).toUpperCase() !== "COOK") return null;
    if (user.status && user.status !== "active") return null;
    return user;
  } catch {
    return null;
  }
};

const bookingLine = (booking) => {
  const date = booking?.date ? new Date(booking.date).toLocaleDateString("en-IN") : "";
  return `${String(booking?.serviceType || "").replace(/_/g, " ")} on ${date} ${booking?.startTime || ""}–${booking?.endTime || ""} (ID …${String(booking?._id || "").slice(-6)})`;
};

const reply = async (to, text) => {
  try {
    await sendWhatsAppText(to, text);
  } catch {
    // best-effort: the booking transition (or its refusal) already happened
  }
};

// Parse an inbound message into { action: "accept"|"reject"|null, bookingId }.
const parseInboundAction = (msg) => {
  const interactive = msg?.interactive?.button_reply;
  if (interactive?.id) {
    const m = String(interactive.id).match(/^(accept|reject):([0-9a-fA-F]{24})$/);
    if (m) return { action: m[1], bookingId: m[2] };
  }
  const text = String(msg?.text?.body || "").trim();
  if (!text) return { action: null, bookingId: null };
  const m = text.match(/^(accept|decline|reject|yes|no)\b[^\w]*([0-9a-fA-F]{24})?/i);
  if (!m) return { action: null, bookingId: null };
  const word = m[1].toLowerCase();
  return {
    action: word === "accept" || word === "yes" ? "accept" : "reject",
    bookingId: m[2] || null,
  };
};

const loadPendingForCook = async (cookId) => {
  try {
    return await Booking.find({
      cook: cookId,
      status: "requested",
      requestExpiresAt: { $gt: new Date() },
    })
      .select("_id serviceType date startTime endTime status")
      .sort({ requestExpiresAt: 1 })
      .limit(5);
  } catch {
    return [];
  }
};

const acceptViaWhatsApp = async (cook, booking, senderE164) => {
  // Ownership: the tap only ever affects the sender's own booking.
  if (String(booking.cook) !== String(cook._id)) {
    await reply(senderE164, "This booking isn't assigned to you — please check your Cook Dashboard.");
    return { ok: false, reason: "not-owner" };
  }
  await expireBookingIfNeeded(booking);
  if (booking.status !== "requested") {
    await reply(senderE164, `This request is already ${booking.status} — no action needed. Please check your Cook Dashboard.`);
    return { ok: false, reason: `already-${booking.status}` };
  }
  if (booking.requestExpiresAt && booking.requestExpiresAt < new Date()) {
    await expireBookingIfNeeded(booking);
    await releaseCouponUsage(booking);
    try {
      await Notification.create({
        user: booking.customer,
        type: "booking_expired",
        booking: booking._id,
        message: "Your booking request expired — the cook didn't respond within 5 minutes. Please find another cook.",
      });
    } catch {
      // non-fatal
    }
    await reply(senderE164, "This request already expired (5-minute window). The slot is open again.");
    return { ok: false, reason: "expired" };
  }
  // Overlap pre-check (same rule as the dashboard endpoint).
  try {
    const { start: dayStart, end: dayEnd } = dayBounds(booking.date);
    const rivals = await Booking.find({
      cook: booking.cook,
      _id: { $ne: booking._id },
      date: { $gte: dayStart, $lte: dayEnd },
      status: { $in: ["accepted", "confirmed", "in_progress"] },
    }).select("startTime endTime status");
    const s = timeToMinutes(booking.startTime);
    const e = timeToMinutes(booking.endTime);
    const clash = (rivals || []).some((r) => {
      const rs = timeToMinutes(r.startTime);
      const re = timeToMinutes(r.endTime);
      return rs != null && re != null && intervalsOverlap(s, e, rs, re);
    });
    if (clash) {
      await reply(senderE164, "This slot was just booked by another request — please decline this one in your Cook Dashboard.");
      return { ok: false, reason: "slot-clash" };
    }
  } catch {
    await reply(senderE164, "Could not verify slot availability right now — please try again or use your Cook Dashboard.");
    return { ok: false, reason: "verify-unavailable" };
  }
  // Atomic accept claim — exactly one of (dashboard tap, WhatsApp tap) wins.
  let claimed = false;
  try {
    const claim = await Booking.updateOne(
      { _id: booking._id, status: "requested" },
      {
        $set: { status: "accepted", paymentExpiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS) },
        $push: { statusHistory: { status: "accepted", note: "Accepted by cook via WhatsApp" } },
      }
    );
    claimed = (claim.modifiedCount ?? claim.nModified ?? 0) === 1;
  } catch {
    claimed = false;
  }
  if (!claimed) {
    let latest = null;
    try {
      latest = await Booking.findById(booking._id);
    } catch {
      latest = null;
    }
    await reply(
      senderE164,
      latest && latest.status !== "requested"
        ? `This request is already ${latest.status} — no action needed.`
        : "Another accept is being processed — please check your Cook Dashboard."
    );
    return { ok: false, reason: "race-lost" };
  }
  try {
    const fresh = await Booking.findById(booking._id);
    if (fresh) booking = fresh;
  } catch {
    // non-fatal
  }
  try {
    await Notification.create({
      user: booking.customer,
      type: "booking_accepted",
      booking: booking._id,
      message: "Your booking request has been accepted! Complete payment within 5 minutes to confirm your slot.",
    });
  } catch {
    // non-fatal
  }
  notifyWhatsApp("accepted", booking);
  await reply(
    senderE164,
    `✅ Accepted! ${bookingLine(booking)}\nThe customer has 5 minutes to pay. We'll notify you here the moment payment lands.`
  );
  return { ok: true };
};

const rejectViaWhatsApp = async (cook, booking, senderE164) => {
  if (String(booking.cook) !== String(cook._id)) {
    await reply(senderE164, "This booking isn't assigned to you — please check your Cook Dashboard.");
    return { ok: false, reason: "not-owner" };
  }
  await expireBookingIfNeeded(booking);
  if (booking.status !== "requested") {
    await reply(senderE164, `This request is already ${booking.status} — no action needed.`);
    return { ok: false, reason: `already-${booking.status}` };
  }
  let claimed = false;
  try {
    const claim = await Booking.updateOne(
      { _id: booking._id, status: "requested" },
      {
        $set: { status: "rejected" },
        $push: { statusHistory: { status: "rejected", note: "Declined by cook via WhatsApp" } },
      }
    );
    claimed = (claim.modifiedCount ?? claim.nModified ?? 0) === 1;
  } catch {
    claimed = false;
  }
  if (!claimed) {
    await reply(senderE164, "This request was just handled — please check your Cook Dashboard.");
    return { ok: false, reason: "race-lost" };
  }
  try {
    const fresh = await Booking.findById(booking._id);
    if (fresh) booking = fresh;
  } catch {
    // non-fatal
  }
  let refundNote = "";
  try {
    const queued = queueRefundForApproval(booking, "booking_rejected");
    if (queued > 0) {
      try {
        await Booking.updateOne(
          { _id: booking._id, "payment.refundStatus": "none" },
          {
            $set: { "payment.refundStatus": "pending", "payment.refundAmount": queued },
            $push: {
              statusHistory: {
                status: booking.status,
                note: `Refund of ₹${queued} queued for admin approval (booking_rejected)`,
              },
            },
          }
        );
      } catch {
        // non-fatal
      }
      refundNote = ` A refund of ₹${queued} has been requested — our team will review it shortly.`;
    }
  } catch {
    // non-fatal
  }
  try {
    await releaseCouponUsage(booking);
  } catch {
    // non-fatal
  }
  try {
    await Notification.create({
      user: booking.customer,
      type: "booking_rejected",
      booking: booking._id,
      message: `Your booking request has been rejected.${refundNote}`,
    });
  } catch {
    // non-fatal
  }
  notifyWhatsApp("rejected", booking, { refundNote: refundNote || undefined });
  await reply(senderE164, `Declined. ${bookingLine(booking)}\nYour slot stays open.`);
  return { ok: true };
};

const handleOneMessage = async (msg) => {
  try {
    const from = String(msg?.from || "");
    const senderE164 = from.replace(/\D/g, "") || null;
    const { action, bookingId } = parseInboundAction(msg);
    if (!action) {
      // Unknown text — only help cooks; everyone else gets silence (no spam).
      const cook = senderE164 ? await findCookByWaId(senderE164) : null;
      if (cook && senderE164) {
        await reply(
          senderE164,
          "To decide on a booking, tap Accept ✅ or Decline ❌ on its request message, or reply ACCEPT / DECLINE here."
        );
      }
      return { ok: false, reason: "unrecognized" };
    }
    const cook = senderE164 ? await findCookByWaId(senderE164) : null;
    if (!cook) {
      // Unknown or non-cook sender — stay silent (no user enumeration).
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
        const list = pending
          .map((b) => `• ${bookingLine(b)}`)
          .join("\n");
        await reply(
          senderE164,
          `You have ${pending.length} pending requests — please tap Accept/Decline on the exact request message:\n${list}`
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

// POST /api/whatsapp/webhook — Meta delivery (messages + status updates).
// Requires the RAW body (mounted via express.raw in server.js) for signature
// verification. Always 200 for verified calls so Meta stops retrying.
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
    for (const entry of event?.entry || []) {
      for (const change of entry?.changes || []) {
        const value = change?.value || {};
        // Ignore our own echoes / status callbacks — only inbound messages act.
        for (const msg of value?.messages || []) {
          if (msg?.from) messages.push(msg);
        }
      }
    }
    const results = [];
    for (const msg of messages) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await handleOneMessage(msg));
    }
    return res.status(200).json({ received: true, handled: results.filter((r) => r.ok).length });
  } catch (err) {
    console.warn("WhatsApp webhook error:", err?.message || err);
    return res.status(200).json({ received: true, handled: 0 });
  }
};

// Exported for unit tests.
exports.__test = { verifySignature, parseInboundAction, findCookByWaId, handleOneMessage };
