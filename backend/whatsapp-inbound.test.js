process.env.WHATSAPP_ENABLED = "true";
process.env.WHATSAPP_TOKEN = "test_token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.WHATSAPP_APP_SECRET = "test_app_secret_abc";
process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "test_verify_token_xyz";

const crypto = require("crypto");
const Booking = require("./models/Booking");
const User = require("./models/User");
const Notification = require("./models/Notification");
const ctrl = require("./controllers/whatsappController");

let passes = 0, failures = 0;
const check = (n, ok, d) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`);
  ok ? passes++ : failures++;
};

const BID = "507f1f77bcf86cd799439011";
const COOK_ID = "507f1f77bcf86cd799439013";
const CUST_ID = "507f1f77bcf86cd799439012";
const COOK_WA = "919876543210";

const mkBooking = (over = {}) => ({
  _id: BID,
  customer: CUST_ID,
  cook: COOK_ID,
  serviceType: "cook_for_me",
  date: new Date(Date.now() + 864e5),
  startTime: "10:00",
  endTime: "12:00",
  durationHours: 2,
  address: "Pune",
  amount: 349,
  status: "requested",
  statusHistory: [],
  requestExpiresAt: new Date(Date.now() + 300e3),
  payment: { status: "pending" },
  save: async function () { return this; },
  ...over,
});
const chainResult = (result) => {
  const q = {
    select: () => q,
    sort: () => q,
    limit: async () => result,
    lean: async () => result,
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return q;
};
const mockFind = (pendings = [], rivals = []) => (filter) =>
  chainResult(filter && filter.status === "requested" ? pendings : rivals);
const cookUser = { _id: COOK_ID, name: "Priya", phone: "9876543210", mobile: "9876543210", role: "COOK", status: "active" };

const savedFindById = Booking.findById;
const savedFindOne = Booking.findOne;
const savedFind = Booking.find;
const savedUpdateOne = Booking.updateOne;
const savedUserFindOne = User.findOne;
const savedUserFindById = User.findById;
const savedNotifCreate = Notification.create;
const restoreAll = () => {
  Booking.findById = savedFindById;
  Booking.findOne = savedFindOne;
  Booking.find = savedFind;
  Booking.updateOne = savedUpdateOne;
  User.findOne = savedUserFindOne;
  User.findById = savedUserFindById;
  Notification.create = savedNotifCreate;
};

const sent = [];
global.fetch = async (url, opts) => {
  sent.push(JSON.parse(opts.body));
  return { ok: true, json: async () => ({ messages: [{ id: "wamid.x" }] }) };
};

const sign = (raw) =>
  `sha256=${crypto.createHmac("sha256", process.env.WHATSAPP_APP_SECRET).update(raw).digest("hex")}`;
const inboundBody = (messages) =>
  Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages } }] }] }));
const buttonMsg = (from, id) => ({ from, id: "wamid.in", type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: id } } });
const textMsg = (from, body) => ({ from, id: "wamid.in", type: "text", text: { body } });
const postInbound = async (raw, sig) => {
  const r = { statusCode: 200, body: null, status(c) { this.statusCode = c; return r; }, json(b) { this.body = b; return r; } };
  await ctrl.handleInbound({ body: raw, headers: { "x-hub-signature-256": sig } }, r);
  return r;
};
const textsTo = (e164) => sent.filter((s) => s.to === e164 && s.type === "text").map((s) => s.text.body).join("\n");

(async () => {
  try {
    {
      const out = [];
      const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; } };
      ctrl.verifyWebhook({ query: { "hub.mode": "subscribe", "hub.verify_token": "test_verify_token_xyz", "hub.challenge": "CHAL123" } }, res);
      out.push(res.statusCode === 200 && res.body === "CHAL123");
      const res2 = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; } };
      ctrl.verifyWebhook({ query: { "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "CHAL123" } }, res2);
      out.push(res2.statusCode === 403);
      check("handshake accepts token / refuses impostor", out.every(Boolean), out.join(","));
    }

    {
      sent.length = 0;
      let touched = false;
      Booking.findById = async () => { touched = true; return null; };
      const raw = inboundBody([buttonMsg(COOK_WA, `accept:${BID}`)]);
      const r = await postInbound(raw, "sha256=deadbeef");
      check("forged webhook -> 401", r.statusCode === 401, `s=${r.statusCode}`);
      check("forged webhook touches nothing", touched === false && sent.length === 0, `touched=${touched}`);
    }
    {
      const raw = inboundBody([buttonMsg(COOK_WA, `accept:${BID}`)]);
      const r = await postInbound(raw, null);
      check("missing signature -> 401", r.statusCode === 401, `s=${r.statusCode}`);
    }

    const mockParties = () => {
      User.findOne = () => ({ select: async () => cookUser });
      User.findById = () => ({ select: async () => ({ name: "N", phone: "9000000001" }) });
    };
    const notifs = [];
    Notification.create = async (d) => { notifs.push(d); return d; };

    {
      sent.length = 0; notifs.length = 0;
      const doc = mkBooking();
      mockParties();
      Booking.findById = async () => doc;
      Booking.find = mockFind();
      let claimed = false;
      Booking.updateOne = async (filter, update) => {
        if (filter.status === "requested" && doc.status === "requested") {
          claimed = true;
          doc.status = "accepted";
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
      };
      const raw = inboundBody([buttonMsg(COOK_WA, `accept:${BID}`)]);
      const r = await postInbound(raw, sign(raw));
      const cookTexts = textsTo(COOK_WA);
      check("ACCEPT tap -> 200 handled", r.statusCode === 200 && r.body?.handled === 1, JSON.stringify(r.body));
      check("ACCEPT tap flips booking", claimed && doc.status === "accepted", doc.status);
      check("customer notified accepted", notifs.some((n) => n.type === "booking_accepted"), notifs.map((n) => n.type).join(","));
      check("cook gets confirmation", /Accepted/.test(cookTexts), cookTexts.slice(0, 60));
    }

    {
      sent.length = 0; notifs.length = 0;
      const doc = mkBooking();
      mockParties();
      Booking.findById = async () => doc;
      Booking.find = mockFind();
      Booking.updateOne = async () => { doc.status = "rejected"; return { modifiedCount: 1 }; };
      const raw = inboundBody([buttonMsg(COOK_WA, `reject:${BID}`)]);
      const r = await postInbound(raw, sign(raw));
      check("REJECT tap -> 200 handled", r.statusCode === 200 && r.body?.handled === 1, JSON.stringify(r.body));
      check("REJECT tap flips booking", doc.status === "rejected", doc.status);
      check("customer notified rejected", notifs.some((n) => n.type === "booking_rejected"), notifs.map((n) => n.type).join(","));
    }

    {
      sent.length = 0; notifs.length = 0;
      const doc = mkBooking({ requestExpiresAt: new Date(Date.now() - 1000) });
      mockParties();
      Booking.findById = async () => doc;
      Booking.find = mockFind();
      const raw = inboundBody([buttonMsg(COOK_WA, `accept:${BID}`)]);
      const r = await postInbound(raw, sign(raw));
      check("expired tap -> 200, refused", r.statusCode === 200 && r.body?.handled === 0, JSON.stringify(r.body));
      check("expired tap marks expired", doc.status === "expired", doc.status);
      check("customer told expired", notifs.some((n) => n.type === "booking_expired"), notifs.map((n) => n.type).join(","));
    }

    {
      sent.length = 0;
      const doc = mkBooking();
      User.findOne = () => ({ select: async () => null });
      User.findById = () => ({ select: async () => ({}) });
      Booking.findById = async () => doc;
      let wrote = false;
      Booking.updateOne = async () => { wrote = true; return { modifiedCount: 0 }; };
      const raw = inboundBody([buttonMsg("911111111111", `accept:${BID}`)]);
      const r = await postInbound(raw, sign(raw));
      check("stranger tap -> silent 200", r.statusCode === 200 && r.body?.handled === 0 && sent.length === 0, JSON.stringify(r.body));
      check("stranger tap writes nothing", wrote === false, `wrote=${wrote}`);
    }

    {
      sent.length = 0;
      const doc = mkBooking();
      User.findOne = () => ({ select: async () => ({ ...cookUser, _id: "507f1f77bcf86cd799439099" }) });
      User.findById = () => ({ select: async () => ({}) });
      Booking.findById = async () => doc;
      Booking.find = mockFind();
      let wrote = false;
      Booking.updateOne = async () => { wrote = true; return { modifiedCount: 0 }; };
      const raw = inboundBody([buttonMsg(COOK_WA, `accept:${BID}`)]);
      const r = await postInbound(raw, sign(raw));
      const cookTexts = textsTo(COOK_WA);
      check("foreign tap refused + explained", r.statusCode === 200 && /isn't assigned/.test(cookTexts), cookTexts.slice(0, 80));
      check("foreign tap writes nothing", wrote === false && doc.status === "requested", `wrote=${wrote} status=${doc.status}`);
    }

    {
      sent.length = 0; notifs.length = 0;
      const full = mkBooking();
      mockParties();
      Booking.find = mockFind(
        [{ _id: BID, serviceType: "cook_for_me", date: full.date, startTime: "10:00", endTime: "12:00" }],
        []
      );
      Booking.findById = async () => full;
      Booking.updateOne = async () => { full.status = "accepted"; return { modifiedCount: 1 }; };
      // Approved-template quick-reply tap: Meta sends type/button, static payload.
      const qr = { from: COOK_WA, id: "wamid.qr1", type: "button", button: { payload: "Accept", text: "✅ बुकिंग स्वीकारा" } };
      const raw = inboundBody([qr]);
      const r = await postInbound(raw, sign(raw));
      check("template Accept tap (single pending) accepts directly", r.statusCode === 200 && r.body?.handled === 1 && full.status === "accepted", JSON.stringify(r.body));
    }

    {
      sent.length = 0; notifs.length = 0;
      const full = mkBooking();
      mockParties();
      Booking.find = mockFind(
        [{ _id: BID, serviceType: "cook_for_me", date: full.date, startTime: "10:00", endTime: "12:00" }],
        []
      );
      Booking.findById = async () => full;
      Booking.updateOne = async () => { full.status = "accepted"; return { modifiedCount: 1 }; };
      const raw = inboundBody([textMsg(COOK_WA, "स्वीकारा")]);
      const r = await postInbound(raw, sign(raw));
      check("Marathi text ACCEPT works", r.statusCode === 200 && r.body?.handled === 1 && full.status === "accepted", JSON.stringify(r.body));
    }

    {
      // Marathi-titled interactive button without an accept:<id> payload.
      const p = ctrl.__test.parseInboundAction({ interactive: { button_reply: { id: "tap", title: "✅ बुकिंग स्वीकारा" } } });
      check("Marathi button title parses to accept", p.action === "accept" && p.bookingId === null, JSON.stringify(p));
      const q = ctrl.__test.parseInboundAction({ type: "button", button: { payload: "Decline", text: "❌ नकार द्या" } });
      check("template Decline tap parses to reject", q.action === "reject" && q.bookingId === null, JSON.stringify(q));
      const u = ctrl.__test.parseInboundAction({ type: "text", text: { body: "hello, any work today?" } });
      check("unrelated text stays unrecognized (silent)", u.action === null, JSON.stringify(u));
    }

    {
      sent.length = 0;
      mockParties();
      Booking.find = mockFind(
        [
          { _id: BID, serviceType: "a", date: new Date(), startTime: "10:00", endTime: "12:00" },
          { _id: "507f1f77bcf86cd799439022", serviceType: "b", date: new Date(), startTime: "14:00", endTime: "16:00" },
        ],
        []
      );
      let wrote = false;
      Booking.updateOne = async () => { wrote = true; return { modifiedCount: 0 }; };
      const raw = inboundBody([textMsg(COOK_WA, "decline")]);
      const r = await postInbound(raw, sign(raw));
      check("ambiguous tap stays silent (no list broadcast), writes nothing",
        r.body?.handled === 0 && wrote === false && sent.length === 0,
        `handled=${r.body?.handled} wrote=${wrote} replies=${sent.length}`);
    }

    {
      sent.length = 0; notifs.length = 0;
      const doc = mkBooking();
      mockParties();
      Booking.findById = async () => doc;
      Booking.find = mockFind();
      let claims = 0;
      Booking.updateOne = async () => { claims += 1; doc.status = "accepted"; return { modifiedCount: 1 }; };
      const WebhookEvent = require("./models/WebhookEvent");
      const savedWE = WebhookEvent.create;
      const seen = new Set();
      WebhookEvent.create = async (e) => {
        if (seen.has(e.key)) { const err = new Error("dup"); err.code = 11000; throw err; }
        seen.add(e.key);
        return e;
      };
      const retryMsg = { from: COOK_WA, id: "wamid.retry1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: `accept:${BID}`, title: "Accept" } } };
      const raw = inboundBody([retryMsg]);
      const r1 = await postInbound(raw, sign(raw));
      const r2 = await postInbound(raw, sign(raw));
      WebhookEvent.create = savedWE;
      check("retry deduped: one claim only", r1.body?.handled === 1 && r2.body?.handled === 0 && claims === 1, `h1=${r1.body?.handled} h2=${r2.body?.handled} claims=${claims}`);
    }

    {
      sent.length = 0;
      const doc = mkBooking();
      mockParties();
      Booking.findById = async () => ({ ...doc, status: "accepted" });
      Booking.find = async () => [];
      Booking.updateOne = async () => ({ modifiedCount: 0 });
      const raw = inboundBody([buttonMsg(COOK_WA, `accept:${BID}`)]);
      const r = await postInbound(raw, sign(raw));
      const cookTexts = textsTo(COOK_WA);
      check("lost race replies current truth", r.statusCode === 200 && /already accepted/.test(cookTexts), cookTexts.slice(0, 80));
    }

    // ---- unknown sender + ID-suffix resolution ----
    {
      // Unknown number + explicit action: one guidance reply, zero mutation.
      sent.length = 0;
      User.findOne = () => ({ select: async () => null });
      User.find = () => ({ select: () => ({ lean: async () => [] }) });
      let touched = false;
      Booking.findById = async () => { touched = true; return null; };
      const r = await ctrl.__test.handleOneMessage({
        from: "910000000001", id: "wamid.unk1", type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: `accept:${BID}`, title: "Accept" } },
      });
      const bodies = textsTo("910000000001");
      check("unknown action-sender gets guidance, writes nothing",
        r?.ok === false && r?.reason === "unknown-sender" && touched === false &&
        /don't recognize/i.test(bodies) && /registered/i.test(bodies),
        `${r?.reason} touched=${touched}`);
    }
    {
      // Same stranger again: cooldown allows exactly one reply per hour.
      sent.length = 0;
      User.findOne = () => ({ select: async () => null });
      User.find = () => ({ select: () => ({ lean: async () => [] }) });
      const msg = (id) => ({ from: "910000000002", id, type: "text", text: { body: "accept" } });
      const r1 = await ctrl.__test.handleOneMessage(msg("wamid.cd1"));
      const r2 = await ctrl.__test.handleOneMessage(msg("wamid.cd2"));
      const n = sent.filter((s) => s.type === "text").length;
      check("unknown-sender reply rate-limited (1/hour)",
        r1?.reason === "unknown-sender" && r2?.reason === "unknown-sender" && n === 1, `replies=${n}`);
    }
    {
      // Stranger chatter (no action) stays fully silent.
      sent.length = 0;
      User.findOne = () => ({ select: async () => null });
      User.find = () => ({ select: () => ({ lean: async () => [] }) });
      const r = await ctrl.__test.handleOneMessage({ from: "910000000003", id: "wamid.ch1", type: "text", text: { body: "hello, any work today?" } });
      check("stranger chatter stays fully silent", r?.ok === false && sent.length === 0, `replies=${sent.length}`);
    }
    {
      // Slow database: never accuse the number, stay silent.
      sent.length = 0;
      User.findOne = () => ({ select: () => new Promise(() => {}) });
      User.find = () => ({ select: () => ({ lean: () => new Promise(() => {}) }) });
      const r = await ctrl.__test.handleOneMessage({ from: "910000000004", id: "wamid.to1", type: "text", text: { body: "accept" } });
      check("slow lookup stays silent (no false unknown-sender)", r?.reason === "unknown-sender" && sent.length === 0, `replies=${sent.length}`);
    }
    {
      // Template-tap disambiguation: "accept <6-hex suffix>" commits.
      sent.length = 0;
      const full = mkBooking();
      mockParties();
      Booking.find = mockFind(
        [{ _id: BID, serviceType: "cook_for_me", date: full.date, startTime: "10:00", endTime: "12:00" }],
        []
      );
      Booking.findById = async () => full;
      Booking.updateOne = async () => { full.status = "accepted"; return { modifiedCount: 1 }; };
      const r = await ctrl.__test.handleOneMessage(textMsg(COOK_WA, "accept 439011"));
      check("suffix accept commits (template-tap disambiguation)",
        r?.ok === true && full.status === "accepted", `${r?.reason} st=${full.status}`);
    }
    {
      // Suffix with no live match: clear reply, zero writes.
      sent.length = 0;
      mockParties();
      Booking.find = mockFind(
        [{ _id: "507f1f77bcf86cd799439022", serviceType: "a", date: new Date(), startTime: "10:00", endTime: "12:00" }],
        []
      );
      let touchedFind = false, wrote = false;
      Booking.findById = async () => { touchedFind = true; return null; };
      Booking.updateOne = async () => { wrote = true; return { modifiedCount: 0 }; };
      const r = await ctrl.__test.handleOneMessage(textMsg(COOK_WA, "accept 439011"));
      const bodies = textsTo(COOK_WA);
      check("suffix miss replies not-found, writes nothing",
        r?.ok === false && r?.reason === "not-found" && touchedFind === false && wrote === false &&
        /Couldn't find that live request/.test(bodies),
        r?.reason);
    }
    {
      // Suffix matching two live requests: ambiguous, zero writes.
      sent.length = 0;
      mockParties();
      Booking.find = mockFind(
        [
          { _id: BID, serviceType: "a", date: new Date(), startTime: "10:00", endTime: "12:00" },
          { _id: "607f1f77bcf86cd799439011", serviceType: "b", date: new Date(), startTime: "14:00", endTime: "16:00" },
        ],
        []
      );
      let wrote = false;
      Booking.updateOne = async () => { wrote = true; return { modifiedCount: 0 }; };
      const r = await ctrl.__test.handleOneMessage(textMsg(COOK_WA, "ACCEPT 439011"));
      const bodies = textsTo(COOK_WA);
      check("suffix collision stays ambiguous, writes nothing",
        r?.ok === false && r?.reason === "ambiguous" && wrote === false && /Dashboard/.test(bodies), r?.reason);
    }
    {
      // Replying inside one exact request message resolves through its
      // dispatch wamid even with several pending (no list broadcast).
      sent.length = 0;
      const full = mkBooking();
      mockParties();
      Booking.find = mockFind();
      const withEntry = {
        ...full,
        whatsappDispatch: [{ cook: COOK_ID, kind: "request", status: "sent", messageId: "wamid.req1", attempts: 1 }],
      };
      Booking.findOne = async (filter) =>
        filter && filter["whatsappDispatch.messageId"] === "wamid.req1" ? withEntry : null;
      Booking.findById = async () => full;
      Booking.updateOne = async () => { full.status = "accepted"; return { modifiedCount: 1 }; };
      const r = await ctrl.__test.handleOneMessage({
        from: COOK_WA, id: "wamid.ctx1", type: "text",
        text: { body: "accept" }, context: { id: "wamid.req1" },
      });
      check("reply-context accept commits the exact booking",
        r?.ok === true && full.status === "accepted", `${r?.reason} st=${full.status}`);
    }
    {
      // Context pointing at a dead request: clear reply, zero writes.
      sent.length = 0;
      mockParties();
      Booking.find = mockFind();
      const dead = {
        ...mkBooking(),
        status: "expired",
        whatsappDispatch: [{ cook: COOK_ID, kind: "request", status: "sent", messageId: "wamid.dead1", attempts: 1 }],
      };
      Booking.findOne = async (filter) =>
        filter && filter["whatsappDispatch.messageId"] === "wamid.dead1" ? dead : null;
      let wrote = false;
      Booking.updateOne = async () => { wrote = true; return { modifiedCount: 0 }; };
      const r = await ctrl.__test.handleOneMessage({
        from: COOK_WA, id: "wamid.ctx2", type: "text",
        text: { body: "accept" }, context: { id: "wamid.dead1" },
      });
      check("dead context replies no-longer-live, writes nothing",
        r?.ok === false && r?.reason === "not-found" && wrote === false && /no longer live/.test(textsTo(COOK_WA)),
        r?.reason);
    }
    {
      // Another cook's dispatch entry can never resolve for this sender.
      sent.length = 0;
      mockParties();
      const other = {
        ...mkBooking(),
        whatsappDispatch: [{ cook: "OTHERCOOK", kind: "request", status: "sent", messageId: "wamid.other1", attempts: 1 }],
      };
      Booking.findOne = async (filter) =>
        filter && filter["whatsappDispatch.messageId"] ? other : null;
      Booking.find = mockFind([], []);
      const r = await ctrl.__test.handleOneMessage({
        from: COOK_WA, id: "wamid.ctx3", type: "text",
        text: { body: "accept" }, context: { id: "wamid.other1" },
      });
      check("foreign context entry ignored (falls through to none-pending)",
        r?.ok === false && r?.reason === "none-pending", r?.reason);
    }
    {
      // Suffix parsing units (latin + Marathi + full-id compat).
      const p = ctrl.__test.parseInboundAction({ type: "text", text: { body: "accept 439011" } });
      check("suffix parses to short booking id", p.action === "accept" && p.bookingId === "439011", JSON.stringify(p));
      const q = ctrl.__test.parseInboundAction({ type: "text", text: { body: "स्वीकार 439011" } });
      check("Marathi suffix parses", q.action === "accept" && q.bookingId === "439011", JSON.stringify(q));
      const f = ctrl.__test.parseInboundAction({ type: "text", text: { body: `accept:${BID}` } });
      check("full id still parses", f.action === "accept" && f.bookingId === BID, JSON.stringify(f));
    }

    // ---- delivery receipts (Meta statuses callbacks) ----
    const WAMID = "wamid.delivery1";
    const mkDispatchDoc = (entry = {}) => mkBooking({
      whatsappDispatch: [{
        cook: COOK_ID, kind: "request", status: "sent", messageId: WAMID, attempts: 1, sentAt: new Date(), ...entry,
      }],
    });
    const mockDispatchStore = (doc) => {
      Booking.findOne = (filter) => {
        const id = filter?.["whatsappDispatch.messageId"];
        const hit = id && (doc.whatsappDispatch || []).some((e) => e.messageId === id);
        return { select: async () => (hit ? doc : null) };
      };
      Booking.updateOne = async (filter, update) => {
        const id = filter?.["whatsappDispatch.messageId"];
        const e = (doc.whatsappDispatch || []).find((x) => x.messageId === id);
        if (!e) return { modifiedCount: 0 };
        for (const [k, v] of Object.entries(update?.$set || {})) {
          const m = k.match(/^whatsappDispatch\.\$\.(.+)$/);
          if (m) e[m[1]] = v;
        }
        return { modifiedCount: 1 };
      };
    };
    const statusBody = (arr) =>
      Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { statuses: arr } }] }] }));
    const st = (id, status, errors) => ({ id, status, timestamp: String(Date.now()), recipient_id: "919876543210", ...(errors ? { errors } : {}) });

    {
      const doc = mkDispatchDoc();
      mockDispatchStore(doc);
      const raw = statusBody([st(WAMID, "delivered")]);
      const r2 = await postInbound(raw, sign(raw));
      const e = doc.whatsappDispatch[0];
      check("delivered advances sent entry", r2.statusCode === 200 && r2.body?.statusUpdates === 1 && e.deliveryStatus === "delivered" && e.deliveryUpdatedAt instanceof Date, `${r2.body?.statusUpdates}/${e.deliveryStatus}`);
    }

    {
      const doc = mkDispatchDoc({ deliveryStatus: "delivered" });
      mockDispatchStore(doc);
      const raw = statusBody([st(WAMID, "read")]);
      const r = await postInbound(raw, sign(raw));
      check("read advances delivered entry", r.body?.statusUpdates === 1 && doc.whatsappDispatch[0].deliveryStatus === "read", doc.whatsappDispatch[0].deliveryStatus);
    }

    {
      const doc = mkDispatchDoc({ deliveryStatus: "read" });
      mockDispatchStore(doc);
      let writes = 0;
      const realUpdate = Booking.updateOne;
      Booking.updateOne = async (...a) => { writes += 1; return realUpdate(...a); };
      const raw = statusBody([st(WAMID, "delivered")]);
      const r = await postInbound(raw, sign(raw));
      Booking.updateOne = realUpdate;
      check("stale delivered-after-read ignored", doc.whatsappDispatch[0].deliveryStatus === "read", `${doc.whatsappDispatch[0].deliveryStatus} writes=${writes}`);
      void r;
    }

    {
      const doc = mkDispatchDoc();
      mockDispatchStore(doc);
      const raw = statusBody([st(WAMID, "failed", [{ code: 131026, title: "Recipient not on WhatsApp" }])]);
      const r = await postInbound(raw, sign(raw));
      const e = doc.whatsappDispatch[0];
      check("failed records upstream code", r.body?.statusUpdates === 1 && e.deliveryStatus === "failed" && /131026/.test(e.error || ""), `${e.deliveryStatus}/${e.error}`);
    }

    {
      mockDispatchStore(mkDispatchDoc());
      const raw = statusBody([st("wamid.unknown", "delivered")]);
      const r = await postInbound(raw, sign(raw));
      check("unknown wamid ignored, still 200", r.statusCode === 200 && r.body?.statusUpdates === 0, JSON.stringify(r.body));
    }

    {
      const doc = mkDispatchDoc();
      mockDispatchStore(doc);
      let wrote = false;
      Booking.updateOne = async () => { wrote = true; return { modifiedCount: 0 }; };
      const raw = statusBody([st(WAMID, "delivered")]);
      const r = await postInbound(raw, "sha256=deadbeef");
      check("forged statuses -> 401, nothing written", r.statusCode === 401 && wrote === false && !doc.whatsappDispatch[0].deliveryStatus, `s=${r.statusCode} wrote=${wrote}`);
    }

    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    console.error("TEST ERROR:", err);
    process.exit(1);
  } finally {
    restoreAll();
    delete global.fetch;
  }
})();
