// whatsapp-inbound.test.js — cook Accept/Decline via WhatsApp.
// Run:  node backend/whatsapp-inbound.test.js — exits non-zero on failure.
// No DB, no network: models + fetch stubbed; HMACs computed like Meta would.
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
// Chainable query mock mirroring Mongoose (.select().sort().limit()).
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
// Booking.find mock routing: requested-filter -> pendings, otherwise rivals.
// Returns the chainable SYNCHRONOUSLY like Mongoose (never a bare Promise).
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
    // ── handshake ──
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

    // ── bad signature refused, nothing touched ──
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

    // ── button ACCEPT happy path ──
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

    // ── button REJECT happy path (unpaid -> no refund) ──
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

    // ── expired tap refused, customer told ──
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

    // ── tap from an unknown number -> silent, untouched ──
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

    // ── tap naming another cook's booking -> refused, untouched ──
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

    // ── text ACCEPT with single pending -> accepted ──
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
      const raw = inboundBody([textMsg(COOK_WA, "ACCEPT please")]);
      const r = await postInbound(raw, sign(raw));
      check("text ACCEPT (single pending) works", r.statusCode === 200 && r.body?.handled === 1 && full.status === "accepted", JSON.stringify(r.body));
    }

    // ── text with multiple pendings -> disambiguation, no write ──
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
      const cookTexts = textsTo(COOK_WA);
      check("ambiguous text lists pendings, writes nothing", r.body?.handled === 0 && wrote === false && /2 pending/.test(cookTexts), cookTexts.slice(0, 80));
    }

    // ── race lost (dashboard won) -> truthful reply ──
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
