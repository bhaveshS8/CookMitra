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
    const now = new Date();
    const [direct, broadcast] = await Promise.all([
      Booking.find({
        cook: cookId,
        status: "requested",
        requestExpiresAt: { $gt: now },
      })
        .select("_id serviceType date startTime endTime status")
        .sort({ requestExpiresAt: 1 })
        .limit(5),
      Booking.find({
        cook: null,
        status: "requested",
        requestExpiresAt: { $gt: now },
        ignoredBy: { $ne: cookId },
      })
        .select("_id serviceType date startTime endTime status")
        .sort({ requestExpiresAt: 1 })
        .limit(5),
    ]);
    const seen = new Set();
    const merged = [];
    for (const b of [...(direct || []), ...(broadcast || [])]) {
      const key = String(b?._id || "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(b);
    }
    return merged.slice(0, 5);
  } catch {
    return [];
  }
};

const acceptViaWhatsApp = async (cook, booking, senderE164) => {
  const isBroadcast = !booking.cook;
  if (!isBroadcast && String(booking.cook) !== String(cook._id)) {
    await reply(senderE164, "This booking isn't assigned to you — please check your Cook Dashboard.");
    return { ok: false, reason: "not-owner" };
  }
  if (isBroadcast && Array.isArray(booking.ignoredBy) && booking.ignoredBy.map(String).includes(String(cook._id))) {
    await reply(senderE164, "You already ignored this request — please check your Cook Dashboard for live ones.");
    return { ok: false, reason: "ignored" };
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
    }
    await reply(senderE164, "This request already expired (5-minute window). The slot is open again.");
    return { ok: false, reason: "expired" };
  }
  try {
    const { start: dayStart, end: dayEnd } = dayBounds(booking.date);
    const rivals = await Booking.find({
      cook: isBroadcast ? cook._id : booking.cook,
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
  let claimed = false;
  try {
    const claimFilter = { _id: booking._id, status: "requested", requestExpiresAt: { $gt: new Date() } };
    const claimUpdate = {
      $set: { status: "accepted", paymentExpiresAt: new Date(Date.now() + PAYMENT_WINDOW_MS) },
      $push: { statusHistory: { status: "accepted", note: "Accepted by cook via WhatsApp" } },
    };
    if (isBroadcast) {
      claimFilter.cook = null;
      claimUpdate.$set.cook = cook._id;
    } else {
      claimFilter.cook = cook._id;
    }
    const claim = await Booking.updateOne(claimFilter, claimUpdate);
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
  }
  try {
    await Notification.create({
      user: booking.customer,
      type: "booking_accepted",
      booking: booking._id,
      message: "Your booking request has been accepted! Complete payment within 5 minutes to confirm your slot.",
    });
  } catch {
  }
  notifyWhatsApp("accepted", booking);
  await reply(
    senderE164,
    `✅ Accepted! ${bookingLine(booking)}\nThe customer has 5 minutes to pay. We'll notify you here the moment payment lands.`
  );
  return { ok: true };
};

const rejectViaWhatsApp = async (cook, booking, senderE164) => {
  const isBroadcast = !booking.cook;
  if (!isBroadcast && String(booking.cook) !== String(cook._id)) {
    await reply(senderE164, "This booking isn't assigned to you — please check your Cook Dashboard.");
    return { ok: false, reason: "not-owner" };
  }
  await expireBookingIfNeeded(booking);
  if (booking.status !== "requested") {
    await reply(senderE164, `This request is already ${booking.status} — no action needed.`);
    return { ok: false, reason: `already-${booking.status}` };
  }
  if (isBroadcast) {
    try {
      await Booking.updateOne(
        { _id: booking._id, status: "requested" },
        { $addToSet: { ignoredBy: cook._id } }
      );
    } catch {
    }
    await reply(senderE164, `Ignored. ${bookingLine(booking)}\nOther cooks can still accept it.`);
    return { ok: true, ignored: true };
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
      }
      refundNote = ` A refund of ₹${queued} has been requested — our team will review it shortly.`;
    }
  } catch {
  }
  try {
    await releaseCouponUsage(booking);
  } catch {
  }
  try {
    await Notification.create({
      user: booking.customer,
      type: "booking_rejected",
      booking: booking._id,
      message: `Your booking request has been rejected.${refundNote}`,
    });
  } catch {
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
        for (const msg of value?.messages || []) {
          if (msg?.from) messages.push(msg);
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
    return res.status(200).json({ received: true, handled: results.filter((r) => r.ok).length });
  } catch (err) {
    console.warn("WhatsApp webhook error:", err?.message || err);
    return res.status(200).json({ received: true, handled: 0 });
  }
};

exports.__test = { verifySignature, parseInboundAction, findCookByWaId, handleOneMessage };
