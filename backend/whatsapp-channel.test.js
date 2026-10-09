// WhatsApp booking channel tests (spec section 21).
//
// Covers: broadcast fan-out to eligible cooks only, Marathi templates,
// shared accept service for website+whatsapp, atomic race protection,
// ignore semantics, expiry/cancel/slot guards, Meta-failure resilience,
// duplicate-webhook idempotency, wrong-cook authorization, and the
// scheduled/confirmed Marathi messages. Website flow is untouched.

process.env.WHATSAPP_ENABLED = "true";
process.env.WHATSAPP_TOKEN = "test_token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.WHATSAPP_APP_SECRET = "test_app_secret_abc";

const slots = require("./utils/slots");
slots.getDayWindows = async () => [{ startTime: "08:00", endTime: "20:00" }];
slots.resolveCookAvailability = async () => true;

const mongoose = require("mongoose");
const savedReadyState = mongoose.connection.readyState;

const Booking = require("./models/Booking");
const User = require("./models/User");
const CookProfile = require("./models/CookProfile");
const Notification = require("./models/Notification");
const realtime = require("./utils/realtime");
const { acceptBookingForCook, rejectBookingForCook } = require("./services/bookingAcceptService");
const dispatch = require("./services/whatsappDispatch");
const marathi = require("./utils/whatsappMessages");
const waCtrl = require("./controllers/whatsappController");

let passes = 0, failures = 0;
const check = (n, ok, d) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`);
  ok ? passes++ : failures++;
};

// ---------- in-memory fake store ----------
const store = { bookings: new Map(), users: new Map(), profiles: new Map() };
const notifs = [];
const realtimeEvents = [];
const sentPayloads = [];
let metaFail = false;
let wamidSeq = 0;

global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  sentPayloads.push(body);
  if (metaFail) {
    return { ok: false, status: 500, json: async () => ({ error: { message: "meta-boom" } }) };
  }
  wamidSeq += 1;
  return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.${wamidSeq}` }] }) };
};

const getPath = (obj, path) =>
  String(path).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const setPath = (obj, path, value) => {
  const keys = String(path).split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (k === "$") continue;
    if (o[k] == null || typeof o[k] !== "object") o[k] = {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
};
const sameId = (a, b) => String(a) === String(b);
const matchVal = (actual, cond) => {
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    if ("$gt" in cond) return actual > cond.$gt;
    if ("$lt" in cond) return actual < cond.$lt;
    if ("$gte" in cond) return actual >= cond.$gte;
    if ("$lte" in cond) return actual <= cond.$lte;
    if ("$ne" in cond) return !sameId(actual, cond.$ne) && actual !== cond.$ne;
    if ("$in" in cond) return (cond.$in || []).some((v) => sameId(v, actual) || v === actual);
    if ("$elemMatch" in cond) {
      const arr = Array.isArray(actual) ? actual : [];
      const em = cond.$elemMatch;
      return arr.some((e) => Object.keys(em).every((k) => sameId(getPath(e, k), em[k]) || getPath(e, k) === em[k]));
    }
    return false;
  }
  if (cond === null) return actual === null || actual === undefined;
  return sameId(actual, cond) || actual === cond;
};
const matchFilter = (doc, filter = {}) =>
  Object.keys(filter || {}).every((k) => matchVal(getPath(doc, k), filter[k]));

const applyUpdate = (doc, update = {}) => {
  if (update.$set) {
    for (const k of Object.keys(update.$set)) {
      if (k.includes(".$.")) {
        const m = k.match(/^whatsappDispatch\.\$\.(.+)$/);
        if (m) {
          const pending = doc.__pendingElem;
          if (pending) pending[m[1]] = update.$set[k];
          continue;
        }
      }
      setPath(doc, k, update.$set[k]);
    }
  }
  if (update.$push) {
    for (const k of Object.keys(update.$push)) {
      doc[k] = doc[k] || [];
      doc[k].push(update.$push[k]);
    }
  }
  if (update.$addToSet) {
    for (const k of Object.keys(update.$addToSet)) {
      doc[k] = doc[k] || [];
      if (!doc[k].map(String).includes(String(update.$addToSet[k]))) doc[k].push(update.$addToSet[k]);
    }
  }
};

Booking.findOne = async (filter) => {
  for (const doc of store.bookings.values()) {
    if (matchFilter(doc, filter)) return doc;
  }
  return null;
};
Booking.findById = async (id) => store.bookings.get(String(id)) || null;
Booking.find = (filter) => {
  const rows = [...store.bookings.values()].filter((d) => matchFilter(d, filter));
  return { select: async () => rows };
};
Booking.updateOne = async (filter, update) => {
  for (const doc of store.bookings.values()) {
    if (matchFilter(doc, filter)) {
      const em = filter?.whatsappDispatch?.$elemMatch;
      if (em) {
        doc.__pendingElem =
          (doc.whatsappDispatch || []).find((e) =>
            Object.keys(em).every((k) => sameId(getPath(e, k), em[k]))
          ) || null;
        if (!doc.__pendingElem && update.$push) {
          applyUpdate(doc, update);
          return { modifiedCount: 1 };
        }
        if (!doc.__pendingElem) return { modifiedCount: 0 };
        applyUpdate(doc, update);
        delete doc.__pendingElem;
        return { modifiedCount: 1 };
      }
      applyUpdate(doc, update);
      return { modifiedCount: 1 };
    }
  }
  return { modifiedCount: 0 };
};

const userQuery = (data) => ({
  select: () => userQuery(data),
  lean: async () => data,
  then: (res) => Promise.resolve(data).then(res),
});
User.findById = (id) => userQuery(store.users.get(String(id)) || null);
User.findOne = (filter) => {
  const or = filter?.$or || [];
  let found = null;
  for (const u of store.users.values()) {
    const hit = or.some((c) => {
      if (c.phone) return (c.phone.$in || []).includes(u.phone) || (c.phone.$in || []).includes(u.mobile);
      if (c.mobile) return (c.mobile.$in || []).includes(u.phone) || (c.mobile.$in || []).includes(u.mobile);
      return false;
    });
    if (hit) {
      found = u;
      break;
    }
  }
  return userQuery(found);
};
User.find = (filter) => {
  const ids = ((filter?._id?.$in || []).map(String));
  const rows = [...store.users.values()].filter((u) => ids.includes(String(u._id)));
  return { select: () => ({ lean: async () => rows }) };
};
CookProfile.findOne = async (q) => store.profiles.get(String(q?.user)) || null;
Notification.create = async (d) => {
  notifs.push(d);
  return d;
};
realtime.emit = (event, payload) => {
  realtimeEvents.push({ event, payload });
};

const COOK_A = "507f1f77bcf86cd7994390a1";
const COOK_B = "507f1f77bcf86cd7994390b2";
const COOK_C = "507f1f77bcf86cd7994390c3";
const COOK_SUSPENDED = "507f1f77bcf86cd7994390d4";
const COOK_NOPHONE = "507f1f77bcf86cd7994390e5";
const CUST = "507f1f77bcf86cd7994390f6";

const seedUsers = () => {
  store.users.clear();
  store.profiles.clear();
  const mk = (id, phone, status = "active") => ({
    _id: id, name: `Cook ${id.slice(-2)}`, phone, mobile: phone, role: "COOK", status,
  });
  store.users.set(COOK_A, mk(COOK_A, "9811111111"));
  store.users.set(COOK_B, mk(COOK_B, "9822222222"));
  store.users.set(COOK_C, mk(COOK_C, "9833333333"));
  store.users.set(COOK_SUSPENDED, mk(COOK_SUSPENDED, "9844444444", "suspended"));
  store.users.set(COOK_NOPHONE, mk(COOK_NOPHONE, ""));
  store.users.set(CUST, { _id: CUST, name: "Aditi Rao", phone: "9199999999", mobile: "9199999999", role: "CUSTOMER", status: "active" });
  for (const id of [COOK_A, COOK_B, COOK_C]) {
    store.profiles.set(id, { user: id, approvalStatus: "approved", serviceTypes: ["cook_for_me"] });
  }
  store.profiles.set(COOK_SUSPENDED, { user: COOK_SUSPENDED, approvalStatus: "approved", serviceTypes: ["cook_for_me"] });
  store.profiles.set(COOK_NOPHONE, { user: COOK_NOPHONE, approvalStatus: "approved", serviceTypes: ["cook_for_me"] });
};

const mkBooking = (over = {}) => {
  const id = over._id || `b${store.bookings.size + 1}${Date.now() % 100000}`;
  const doc = {
    _id: id,
    customer: CUST,
    cook: null,
    ignoredBy: [],
    serviceType: "cook_for_me",
    date: new Date(Date.now() + 3 * 864e5),
    startTime: "10:00",
    endTime: "12:00",
    durationHours: 2,
    address: "Flat 7, Sunshine Society, Pune",
    addressDetails: { flatNo: "7", society: "Sunshine", city: "Pune" },
    guests: 4,
    notes: "less spicy",
    amount: 699,
    cookPayout: 594,
    status: "requested",
    statusHistory: [{ status: "requested" }],
    requestExpiresAt: new Date(Date.now() + 300e3),
    paymentExpiresAt: null,
    payment: { status: "pending", paidAmount: 0 },
    whatsappDispatch: [],
    serviceOtp: "4321",
    save: async function () {
      store.bookings.set(String(this._id), this);
      return this;
    },
    ...over,
  };
  store.bookings.set(String(id), doc);
  return doc;
};

const reset = () => {
  store.bookings.clear();
  notifs.length = 0;
  realtimeEvents.length = 0;
  sentPayloads.length = 0;
  metaFail = false;
};

const errOf = async (fn) => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
};

(async () => {
  try {
    try {
      Object.defineProperty(mongoose.connection, "readyState", { value: 1, configurable: true });
    } catch {
      mongoose.connection.readyState = 1;
    }
    seedUsers();

    // ---- T1: Marathi request template — exact allowlist, named mapping ----
    {
      reset();
      const b = mkBooking();
      const msg = marathi.buildBookingRequestMessage({ booking: b, customerName: "Aditi Rao" });
      check("T1 template has required header", msg.startsWith("🍳 नवीन Cook Mitra बुकिंग विनंती"), msg.slice(0, 40));
      check("T1 customer name mapped", msg.includes("👤 ग्राहक: Aditi Rao"), "name");
      check("T1 time and duration separate (12-hour clock)", msg.includes("🕐 वेळ: 10:00 AM ते 12:00 PM") && msg.includes("⏱️ कालावधी: 2 तास"), "slot");
      check("T1 address/guests/notes mapped", msg.includes("Flat 7, Sunshine Society, Pune") && msg.includes("👥 व्यक्ती: 4") && msg.includes("less spicy"), "fields");
      check("T1 no extra booking info", !msg.includes("594") && !msg.includes("cook_for_me") && !msg.includes("माझ्यासाठी") && !msg.includes("मानधन") && !msg.includes("कालबाह्य") && !/Booking ID|requestExpires|Expiry/i.test(msg), "allowlist");
      check("T1 serviceType Marathi mapping intact", marathi.serviceTypeMarathi("cook_for_me") === "माझ्यासाठी स्वयंपाक", marathi.serviceTypeMarathi("cook_for_me"));
      check("T1 all serviceType labels Marathi", ["cook_with_me", "teach_me", "preparation_help"].every((s) => /[\u0900-\u097F]/.test(marathi.serviceTypeMarathi(s))), "labels");
      check("T1 button titles Marathi", marathi.ACCEPT_BUTTON_TITLE.includes("स्वीकारा") && marathi.REJECT_BUTTON_TITLE.includes("नकार"), "titles");
    }
    // ---- T1b: IST date/weekday + missing-value rules, no field shifting ----
    {
      const dated = mkBooking({ date: new Date("2026-10-07T00:00:00+05:30") });
      const msg = marathi.buildBookingRequestMessage({ booking: dated, customerName: "Aditi Rao" });
      check("T1b Marathi date", msg.includes("📅 तारीख: 7 ऑक्टोबर 2026"), "date");
      check("T1b Marathi weekday from IST date", msg.includes("📆 वार: बुधवार"), "weekday");
      const bare = mkBooking({ address: "", notes: "   ", guests: null, durationHours: null });
      const msg2 = marathi.buildBookingRequestMessage({ booking: bare, customerName: "" });
      check("T1b empty notes shows नाही", msg2.includes("📝 सूचना: नाही"), "notes");
      check("T1b missing fields never borrow values", msg2.includes("📍 ठिकाण:\nमाहिती उपलब्ध नाही") && msg2.includes("👥 व्यक्ती: माहिती उपलब्ध नाही") && msg2.includes("⏱️ कालावधी: माहिती उपलब्ध नाही") && msg2.includes("👤 ग्राहक: माहिती उपलब्ध नाही"), "missing");
      check("T1b invalid date shows unavailable", marathi.calculateMarathiWeekday("not-a-date") === "माहिती उपलब्ध नाही" && marathi.formatMarathiDate(null) === "माहिती उपलब्ध नाही", "invalid");
    }

    // ---- T2: fan-out reaches eligible cooks only, failures retryable ----
    {
      reset();
      const b = mkBooking();
      const eligible = [{ userId: COOK_A }, { userId: COOK_B }, { userId: COOK_C }, { userId: COOK_SUSPENDED }, { userId: COOK_NOPHONE }];
      const r = await dispatch.fanOutBookingRequest(b, eligible, { customerName: "Aditi Rao" });
      const interactive = sentPayloads.filter((p) => p.type === "interactive");
      const recipients = interactive.map((p) => p.to).sort();
      check("T2 all eligible cooks get interactive request", r.ok && recipients.length === 3, recipients.join(","));
      check("T2 suspended cook excluded", !recipients.some((t) => t.includes("9844444444")), recipients.join(","));
      check("T2 cook without number excluded+marked failed", !recipients.some((t) => !t || t === "91"), "no-number");
      const failedEntry = (store.bookings.get(b._id).whatsappDispatch || []).find((e) => String(e.cook) === COOK_NOPHONE);
      check("T2 failed dispatch recorded retryable", failedEntry?.status === "failed", failedEntry?.status || "none");
      const sentEntry = (store.bookings.get(b._id).whatsappDispatch || []).find((e) => String(e.cook) === COOK_A);
      check("T2 sent dispatch has Meta message id", sentEntry?.status === "sent" && (sentEntry?.messageId || "").startsWith("wamid."), sentEntry?.messageId || "none");
      const first = interactive[0];
      check("T2 buttons carry booking payload", first.interactive.action.buttons.some((x) => x.reply.id === `accept:${b._id}`) && first.interactive.action.buttons.some((x) => x.reply.id === `reject:${b._id}`), "payloads");
      check("T2 buttons Marathi titles", first.interactive.action.buttons.some((x) => x.reply.title.includes("स्वीकारा")), "titles");
      check("T2 booking untouched by fan-out", store.bookings.get(b._id).status === "requested", "requested");
      // idempotent resend: already-sent cooks skipped
      sentPayloads.length = 0;
      const r2 = await dispatch.fanOutBookingRequest(b, [{ userId: COOK_A }], { customerName: "Aditi Rao" });
      check("T2 sent entry prevents duplicate send", sentPayloads.length === 0, `${sentPayloads.length} sends`);
    }

    // ---- T2b: Meta failure does not fail booking, stays retryable ----
    {
      reset();
      const b = mkBooking();
      metaFail = true;
      const r = await dispatch.fanOutBookingRequest(b, [{ userId: COOK_A }], { customerName: "Aditi Rao" });
      metaFail = false;
      const entry = (store.bookings.get(b._id).whatsappDispatch || []).find((e) => String(e.cook) === COOK_A);
      check("T2b Meta failure recorded failed", entry?.status === "failed", entry?.status || "none");
      check("T2b booking still requested after Meta failure", store.bookings.get(b._id).status === "requested", "requested");
      // retry after recovery succeeds
      sentPayloads.length = 0;
      const rr = await dispatch.fanOutBookingRequest(b, [{ userId: COOK_A }], { customerName: "Aditi Rao" });
      check("T2b retry after recovery sends", rr.ok && sentPayloads.length === 1, `${sentPayloads.length}`);
    }

    // ---- T3: WhatsApp accept assigns + opens payment window + realtime ----
    {
      reset();
      const b = mkBooking();
      const out = await acceptBookingForCook({ bookingId: b._id, cookId: COOK_A, source: "whatsapp" });
      const doc = store.bookings.get(b._id);
      check("T3 assigned to accepting cook", String(doc.cook) === COOK_A && doc.status === "accepted", `${doc.status}/${doc.cook}`);
      check("T3 5-minute payment window opened", doc.paymentExpiresAt instanceof Date && doc.paymentExpiresAt > new Date(), String(doc.paymentExpiresAt));
      check("T3 customer notified accepted", notifs.some((n) => String(n.user) === CUST && n.type === "booking_accepted"), notifs.map((n) => n.type).join(","));
      check("T3 realtime booking_assigned emitted", realtimeEvents.some((e) => e.event === "booking_assigned" && e.payload.assignedCookId === COOK_A && e.payload.customerId === CUST), JSON.stringify(realtimeEvents.map((e) => e.event)));
      check("T3 no second booking created", store.bookings.size === 1, String(store.bookings.size));
      void out;
    }

    // ---- T4: website + WhatsApp race — exactly one winner ----
    {
      reset();
      const b = mkBooking();
      const [r1, r2] = await Promise.allSettled([
        acceptBookingForCook({ bookingId: b._id, cookId: COOK_A, source: "whatsapp" }),
        acceptBookingForCook({ bookingId: b._id, cookId: COOK_B, source: "website" }),
      ]);
      const wins = [r1, r2].filter((r) => r.status === "fulfilled");
      const doc = store.bookings.get(b._id);
      check("T4 exactly one cook wins", wins.length === 1 && !!doc.cook, `wins=${wins.length} cook=${doc.cook}`);
      check("T4 loser got authorization/state failure", [r1, r2].some((r) => r.status === "rejected"), "rejected");
      check("T4 single acceptance history entry", doc.statusHistory.filter((h) => h.status === "accepted").length === 1, String(doc.statusHistory.length));
    }

    // ---- T5: three cooks, A accepts; ignore semantics ----
    {
      reset();
      const b = mkBooking();
      await acceptBookingForCook({ bookingId: b._id, cookId: COOK_A, source: "whatsapp" });
      const eB = await errOf(() => acceptBookingForCook({ bookingId: b._id, cookId: COOK_B, source: "website" }));
      const eC = await errOf(() => acceptBookingForCook({ bookingId: b._id, cookId: COOK_C, source: "whatsapp" }));
      check("T5 B/C cannot accept after A", eB?.statusCode === 409 && eC?.statusCode === 409, `${eB?.statusCode}/${eC?.statusCode}`);
      check("T5 A stays assigned", String(store.bookings.get(b._id).cook) === COOK_A, String(store.bookings.get(b._id).cook));

      reset();
      const b2 = mkBooking();
      const ign = await rejectBookingForCook({ bookingId: b2._id, cookId: COOK_A, source: "whatsapp" });
      check("T5 ignore keeps requested", ign.ignored === true && store.bookings.get(b2._id).status === "requested", store.bookings.get(b2._id).status);
      check("T5 ignore recorded", (store.bookings.get(b2._id).ignoredBy || []).map(String).includes(COOK_A), "ignoredBy");
      const eA = await errOf(() => acceptBookingForCook({ bookingId: b2._id, cookId: COOK_A, source: "whatsapp" }));
      check("T5 ignored cook cannot accept later", eA?.code === "BOOKING_IGNORED_BY_YOU", eA?.code || "no-error");
      const okB = await acceptBookingForCook({ bookingId: b2._id, cookId: COOK_B, source: "website" });
      check("T5 other cooks can still accept", okB?.booking && String(store.bookings.get(b2._id).cook) === COOK_B, String(store.bookings.get(b2._id).cook));
    }

    // ---- T6/T7: expired + cancelled guards ----
    {
      reset();
      const b = mkBooking({ requestExpiresAt: new Date(Date.now() - 1000) });
      const e = await errOf(() => acceptBookingForCook({ bookingId: b._id, cookId: COOK_A, source: "whatsapp" }));
      check("T6 expired accept refused", e?.statusCode === 410, String(e?.statusCode));
      check("T6 no assignment on expiry", store.bookings.get(b._id).cook == null, String(store.bookings.get(b._id).cook));

      reset();
      const b2 = mkBooking({ status: "cancelled" });
      const before = JSON.stringify({ ...store.bookings.get(b2._id), save: undefined });
      const e2 = await errOf(() => acceptBookingForCook({ bookingId: b2._id, cookId: COOK_A, source: "whatsapp" }));
      const after = JSON.stringify({ ...store.bookings.get(b2._id), save: undefined });
      check("T7 cancelled accept fails safely", e2 && e2.statusCode !== 200 && before === after, `${e2?.statusCode}`);
    }

    // ---- T8: slot race ----
    {
      reset();
      const clash = mkBooking({ _id: "conflict1", cook: COOK_A, status: "accepted", requestExpiresAt: new Date(Date.now() + 300e3) });
      void clash;
      const b = mkBooking();
      const e = await errOf(() => acceptBookingForCook({ bookingId: b._id, cookId: COOK_A, source: "whatsapp" }));
      check("T8 conflicting slot rejected", e?.code === "SLOT_UNAVAILABLE", e?.code || "no-error");
      check("T8 no double booking", store.bookings.get(b._id).cook == null && store.bookings.get(b._id).status === "requested", "clean");
    }

    // ---- T9: duplicate webhook idempotent ----
    {
      reset();
      const b = mkBooking();
      const first = await acceptBookingForCook({ bookingId: b._id, cookId: COOK_A, source: "whatsapp" });
      const windowAt = store.bookings.get(b._id).paymentExpiresAt;
      const notifCount = notifs.length;
      const second = await acceptBookingForCook({ bookingId: b._id, cookId: COOK_A, source: "whatsapp" });
      const doc = store.bookings.get(b._id);
      check("T9 redelivery recognized accepted", second?.alreadyAccepted === true, JSON.stringify(second?.alreadyAccepted));
      check("T9 payment window untouched", doc.paymentExpiresAt === windowAt, "window");
      check("T9 no duplicate history", doc.statusHistory.filter((h) => h.status === "accepted").length === 1, "history");
      check("T9 no duplicate notifications", notifs.length === notifCount, `${notifs.length} vs ${notifCount}`);
      void first;
    }

    // ---- T10: wrong cook ----
    {
      reset();
      const b = mkBooking({ cook: COOK_A });
      const e = await errOf(() => acceptBookingForCook({ bookingId: b._id, cookId: COOK_B, source: "whatsapp" }));
      check("T10 foreign cook refused", e?.statusCode === 404, String(e?.statusCode));
      check("T10 no mutation by stranger", String(store.bookings.get(b._id).cook) === COOK_A, String(store.bookings.get(b._id).cook));

      reset();
      const b2 = mkBooking();
      const e2 = await errOf(() => acceptBookingForCook({ bookingId: b2._id, cookId: COOK_SUSPENDED, source: "whatsapp" }));
      check("T10 suspended cook ineligible", e2?.code === "COOK_NOT_ELIGIBLE", e2?.code || String(e2?.statusCode));
    }

    // ---- T11: webhook sender identity decides, payload ids don't ----
    {
      reset();
      const HEX_ID = "507f1f77bcf86cd799439011";
      const b = mkBooking({ _id: HEX_ID, cook: COOK_A });
      const strangerMsg = { from: "911111111111", id: "wamid.t11a", type: "interactive", interactive: { type: "button_reply", button_reply: { id: `accept:${b._id}`, title: "Accept" } } };
      const r1 = await waCtrl.__test.handleOneMessage(strangerMsg);
      check("T11 unknown sender silent", r1?.ok === false && r1?.reason === "unknown-sender", r1?.reason);
      check("T11 unknown sender no mutation", String(store.bookings.get(b._id).cook) === COOK_A, "cook");
      const before = sentPayloads.length;
      const otherCookMsg = { from: "9822222222", id: "wamid.t11b", type: "text", text: { body: `accept:${b._id}` } };
      // text path without booking id would be ambiguous; use button payload instead
      const otherBtn = { from: "9822222222", id: "wamid.t11c", type: "interactive", interactive: { type: "button_reply", button_reply: { id: `accept:${b._id}`, title: "Accept" } } };
      void otherCookMsg;
      const r2 = await waCtrl.__test.handleOneMessage(otherBtn);
      check("T11 payload cannot impersonate owner", r2?.ok === false, r2?.reason || "ok?");
      check("T11 impersonation writes nothing", String(store.bookings.get(b._id).cook) === COOK_A && store.bookings.get(b._id).status === "requested", "clean");
      void before;
    }

    // ---- T12: customer confirmed Marathi message (no OTP) ----
    {
      reset();
      const b = mkBooking({ status: "confirmed", cook: COOK_A, payment: { status: "paid", paidAmount: 699 } });
      sentPayloads.length = 0;
      const r = await dispatch.sendCustomerConfirmedMessage(b, {});
      const body = (sentPayloads.find((p) => p.type === "text")?.text?.body) || "";
      check("T12 confirmed message sent to customer", r?.ok === true, JSON.stringify(r?.ok));
      check("T12 Marathi confirmed content", body.includes("निश्चित झाली") && body.includes("Aditi Rao") && body.includes("699"), body.slice(0, 60));
      check("T12 OTP promise without leaking OTP", body.includes("OTP") && !body.includes("4321"), "otp-safe");
      check("T12 has booking link", body.includes("/bookings/"), "link");
    }

    // ---- T13: cook scheduled message idempotent (paid only) ----
    {
      reset();
      const b = mkBooking({ status: "accepted", cook: COOK_A, payment: { status: "paid", paidAmount: 699 } });
      sentPayloads.length = 0;
      const r1 = await dispatch.sendCookScheduledMessage(b, { customerName: "Aditi Rao" });
      const body = (sentPayloads.find((p) => p.type === "text")?.text?.body) || "";
      check("T13 scheduled sent to cook", r1?.ok === true && body.includes("नमस्कार") && body.includes("google.com/maps/dir"), body.slice(0, 80));
      check("T13 scheduled drops service/payout/url blocks", !body.includes("🍽️ सेवा:") && !body.includes("मानधन") && !body.includes("बुकिंग तपशील"), "trimmed");
      sentPayloads.length = 0;
      const r2 = await dispatch.sendCookScheduledMessage(b, { customerName: "Aditi Rao" });
      check("T13 scheduled resend skipped", sentPayloads.length === 0 && r2?.reason === "already-sent", r2?.reason || "sent");
    }

    // ---- T13b: unpaid booking -> scheduled message held until payment ----
    {
      reset();
      const b = mkBooking({ status: "accepted", cook: COOK_A, payment: { status: "pending", paidAmount: 0 } });
      sentPayloads.length = 0;
      const r = await dispatch.sendCookScheduledMessage(b, { customerName: "Aditi Rao" });
      check("T13b unpaid holds scheduled message", r?.reason === "payment-pending" && sentPayloads.length === 0, `${r?.reason} sends=${sentPayloads.length}`);
      b.payment = { status: "paid", paidAmount: 699 };
      const r2 = await dispatch.sendCookScheduledMessage(b, { customerName: "Aditi Rao" });
      check("T13b paid releases scheduled message", r2?.ok === true && sentPayloads.length === 1, `ok=${r2?.ok} sends=${sentPayloads.length}`);
    }

    // ---- T14: expiry + payment-expiry Marathi notices exist ----
    {
      const exp = marathi.buildBookingExpiredMessage({});
      const already = marathi.buildBookingAlreadyAcceptedMessage({});
      const cancelled = marathi.buildBookingCancelledMessage({});
      const payExp = marathi.buildPaymentExpiredMessage({});
      check("T14 expired Marathi", exp.includes("कालबाह्य"), exp.slice(0, 40));
      check("T14 already-accepted Marathi", already.includes("आधीच दुसऱ्या कुकने स्वीकारले"), already.slice(0, 60));
      check("T14 cancelled Marathi", cancelled.includes("रद्द केली"), cancelled.slice(0, 40));
      check("T14 payment-expiry Marathi", payExp.includes("पेमेंट न झाल्यामुळे"), payExp.slice(0, 40));
    }

    // ---- T15: website + WhatsApp share one service ----
    {
      reset();
      const b1 = mkBooking();
      const b2 = mkBooking();
      const w = await acceptBookingForCook({ bookingId: b1._id, cookId: COOK_A, source: "website" });
      const m = await acceptBookingForCook({ bookingId: b2._id, cookId: COOK_B, source: "whatsapp" });
      const d1 = store.bookings.get(b1._id);
      const d2 = store.bookings.get(b2._id);
      const sameShape =
        d1.status === "accepted" && d2.status === "accepted" &&
        !!d1.paymentExpiresAt && !!d2.paymentExpiresAt &&
        d1.statusHistory.filter((h) => h.status === "accepted").length === 1 &&
        d2.statusHistory.filter((h) => h.status === "accepted").length === 1;
      check("T15 both channels same outcome", !!w?.booking && !!m?.booking && sameShape, "parity");
      check("T15 shared service exported", typeof acceptBookingForCook === "function" && typeof rejectBookingForCook === "function", "exports");
    }

    // ---- T16: cold-start uses approved template first (deliverable outside 24h window) ----
    {
      reset();
      process.env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK = "new_booking_request";
      const b = mkBooking();
      sentPayloads.length = 0;
      const r = await dispatch.fanOutBookingRequest(b, [{ userId: COOK_A }], { customerName: "Aditi Rao" });
      const types = sentPayloads.map((p) => p.type);
      const tpl = sentPayloads.find((p) => p.type === "template");
      const params = tpl?.template?.components?.[0]?.parameters || [];
      check("T16 template sent (no interactive fallback needed)", types.includes("template") && !types.includes("interactive"), JSON.stringify(types));
      check("T16 template name+lang", tpl?.template?.name === "new_booking_request" && tpl?.template?.language?.code === "mr", JSON.stringify(tpl?.template));
      check("T16 template has 6 params", params.length === 6 && params.every((p) => p.type === "text"), `params=${params.length}`);
      check("T16 delivery marked sent", r.ok === true, String(r.ok));
      delete process.env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK;
    }
    // ---- T16a: no template configured -> interactive only (unchanged warm path) ----
    {
      reset();
      delete process.env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK;
      delete process.env.WHATSAPP_REQUEST_TEMPLATE;
      const b = mkBooking();
      sentPayloads.length = 0;
      const r = await dispatch.fanOutBookingRequest(b, [{ userId: COOK_A }], { customerName: "Aditi Rao" });
      const types = sentPayloads.map((p) => p.type);
      const inter = sentPayloads.find((p) => p.type === "interactive");
      const body = inter?.interactive?.body?.text || "";
      check("T16a interactive only without template", !types.includes("template") && types.includes("interactive"), JSON.stringify(types));
      check("T16a new-format body only", body.startsWith("🍳 नवीन Cook Mitra बुकिंग विनंती") && body.includes("📆 वार:") && !body.includes("cook for me") && !body.includes("मानधन"), body.slice(0, 60));
      check("T16a delivery marked sent", r.ok === true, String(r.ok));
    }
    {
      reset();
      process.env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK = "cook_booking_request";
      metaFail = true;
      const b = mkBooking();
      const r = await dispatch.fanOutBookingRequest(b, [{ userId: COOK_A }], { customerName: "Aditi Rao" });
      metaFail = false;
      delete process.env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK;
      const entry = (store.bookings.get(b._id).whatsappDispatch || []).find((e) => String(e.cook) === COOK_A);
      check("T16b template+buttons failure stays retryable", r.ok !== true && entry?.status === "failed", entry?.status || "none");
      check("T16b booking untouched by Meta outage", store.bookings.get(b._id).status === "requested", "requested");
    }

    // ---- T17: admin retry endpoint ----
    {
      reset();
      const CookProfile = require("./models/CookProfile");
      const savedFind = CookProfile.find;
      CookProfile.find = () => ({
        populate: () => ({
          lean: async () => [
            { user: { _id: COOK_A, name: "Cook A", status: "active" }, approvalStatus: "approved", serviceTypes: ["cook_for_me"] },
          ],
        }),
      });
      const bookingCtrl = require("./controllers/bookingController");
      const b = mkBooking();
      const mkRes = () => {
        const r = { statusCode: 200, body: null };
        r.status = (c) => { r.statusCode = c; return r; };
        r.json = (x) => { r.body = x; return r; };
        return r;
      };
      const r1 = mkRes();
      await bookingCtrl.retryCookWhatsApp({ params: { id: b._id }, user: { id: "admin1" } }, r1, (e) => { throw e; });
      check("T17 retry notifies eligible cooks", r1.statusCode === 200 && r1.body?.ok === true, `s=${r1.statusCode} ok=${r1.body?.ok}`);
      check("T17 retry exposes dispatch state", Array.isArray(r1.body?.dispatch) && r1.body.dispatch.some((e) => e.status === "sent"), JSON.stringify((r1.body?.dispatch || []).map((e) => e.status)));
      const r2 = mkRes();
      const b2 = mkBooking({ status: "accepted", cook: COOK_A });
      await bookingCtrl.retryCookWhatsApp({ params: { id: b2._id }, user: { id: "admin1" } }, r2, (e) => { throw e; });
      check("T17 retry refused when not requested", r2.statusCode === 409, `s=${r2.statusCode}`);
      const r3 = mkRes();
      await bookingCtrl.retryCookWhatsApp({ params: { id: "507f1f77bcf86cd799439099" }, user: { id: "admin1" } }, r3, (e) => { throw e; });
      check("T17 retry missing booking 404", r3.statusCode === 404, `s=${r3.statusCode}`);
      CookProfile.find = savedFind;
    }

    // ---- T18: self-clash 409 carries the existing booking id ----
    {
      reset();
      const CookProfile = require("./models/CookProfile");
      const savedFind = CookProfile.find;
      CookProfile.find = () => ({
        populate: () => ({
          lean: async () => [
            { user: { _id: COOK_A, name: "Cook A", status: "active" }, approvalStatus: "approved", serviceTypes: ["cook_for_me"] },
          ],
        }),
      });
      const bookingCtrl = require("./controllers/bookingController");
      const clash = mkBooking({ serviceType: "cook_for_me", date: new Date(Date.now() + 3 * 864e5), startTime: "10:00", endTime: "12:00" });
      const savedBookingFind = Booking.find;
      Booking.find = (filter) => {
        if (filter && filter.customer) {
          return { select: async () => [store.bookings.get(String(clash._id))] };
        }
        return { select: async () => [] };
      };
      const mkRes = () => {
        const r = { statusCode: 200, body: null };
        r.status = (c) => { r.statusCode = c; return r; };
        r.json = (x) => { r.body = x; return r; };
        return r;
      };
      const future = new Date(Date.now() + 3 * 864e5);
      const pad = (n) => String(n).padStart(2, "0");
      const dateStr = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}`;
      const r = mkRes();
      await bookingCtrl.createBooking(
        {
          body: { serviceType: "cook_for_me", date: dateStr, startTime: "10:30", endTime: "11:30", durationHours: 1, address: "Flat 1, Pune" },
          user: { id: CUST, role: "customer", name: "Aditi" },
          params: {},
        },
        r,
        (e) => { throw e; }
      );
      check("T18 self-clash 409 carries bookingId", r.statusCode === 409 && r.body?.bookingId === String(clash._id), `s=${r.statusCode} id=${r.body?.bookingId}`);
      Booking.find = savedBookingFind;
      CookProfile.find = savedFind;
    }

    // ---- T19: controller accept flow (§13) — webhook tap to DB truth ----
    {
      reset();
      const HEX = "507f1f77bcf86cd7994390aa";
      const b = mkBooking({ _id: HEX });
      const btn = (from, id) => ({ from, id, type: "interactive", interactive: { type: "button_reply", button_reply: { id: `accept:${HEX}`, title: "x" } } });
      const cookTexts = () => sentPayloads.filter((p) => p.to === "919811111111" && p.type === "text").map((p) => p.text.body).join("\n");
      const r = await waCtrl.__test.handleOneMessage(btn("919811111111", "wamid.t19a"));
      const doc = store.bookings.get(HEX);
      check("T19 tap assigns original booking", r?.ok === true && String(doc.cook) === COOK_A && doc.status === "accepted", `${doc.status}/${doc.cook}`);
      check("T19 payment window opened", doc.paymentExpiresAt instanceof Date && doc.paymentExpiresAt > new Date(), "window");
      check("T19 history records accept", doc.statusHistory.filter((h) => h.status === "accepted").length === 1, "history");
      check("T19 realtime assigned emitted", realtimeEvents.some((e) => e.event === "booking_assigned" && e.payload.assignedCookId === COOK_A), "event");
      check("T19 reply confirms without claiming payment", cookTexts().includes("बुकिंग स्वीकारली") && !/Payment Received|payment-confirmed|💰/.test(cookTexts()), cookTexts().slice(0, 60));
      check("T19 reply carries live slot", cookTexts().includes("10:00") && cookTexts().includes("Aditi Rao"), "live");
      // duplicate tap: idempotent, window untouched
      const win = doc.paymentExpiresAt;
      const nCount = notifs.length;
      const r2 = await waCtrl.__test.handleOneMessage(btn("919811111111", "wamid.t19b"));
      check("T19 redelivery idempotent", r2?.ok === true && doc.paymentExpiresAt === win && doc.statusHistory.filter((h) => h.status === "accepted").length === 1 && notifs.length === nCount, "idem");
    }
    // ---- T20: controller race — WhatsApp vs website, one winner ----
    {
      reset();
      const HEX = "507f1f77bcf86cd7994390bb";
      mkBooking({ _id: HEX });
      const btn = (from, id) => ({ from, id, type: "interactive", interactive: { type: "button_reply", button_reply: { id: `accept:${HEX}`, title: "x" } } });
      const [w, s] = await Promise.allSettled([
        waCtrl.__test.handleOneMessage(btn("919811111111", "wamid.t20a")),
        acceptBookingForCook({ bookingId: HEX, cookId: COOK_B, source: "website" }),
      ]);
      const wins = [w, s].filter((x) => x.status === "fulfilled" && (x.value?.ok === true || x.value?.booking));
      const doc = store.bookings.get(HEX);
      check("T20 exactly one winner", wins.length === 1 && !!doc.cook, `wins=${wins.length} cook=${doc.cook}`);
      check("T20 loser did not replace winner", String(doc.cook) === (wins[0].value?.booking ? COOK_B : COOK_A), String(doc.cook));
      // loser cook B via WhatsApp now hears already-accepted
      sentPayloads.length = 0;
      await waCtrl.__test.handleOneMessage(btn("919822222222", "wamid.t20b"));
      const loserTexts = sentPayloads.filter((p) => p.to === "919822222222").map((p) => p.text?.body || "").join("\n");
      check("T20 loser told already-accepted", loserTexts.includes("आधीच दुसऱ्या कुकने स्वीकारले"), loserTexts.slice(0, 60));
    }
    // ---- T21: controller guards — foreign, expired, cancelled ----
    {
      reset();
      const HEX = "507f1f77bcf86cd7994390cc";
      mkBooking({ _id: HEX, cook: COOK_A });
      const btn = (from, id) => ({ from, id, type: "interactive", interactive: { type: "button_reply", button_reply: { id: `accept:${HEX}`, title: "x" } } });
      const r = await waCtrl.__test.handleOneMessage(btn("919822222222", "wamid.t21a"));
      check("T21 foreign cook refused, no mutation", r?.ok === false && String(store.bookings.get(HEX).cook) === COOK_A, r?.reason || "ok?");

      reset();
      const HEX2 = "507f1f77bcf86cd7994390dd";
      mkBooking({ _id: HEX2, requestExpiresAt: new Date(Date.now() - 1000) });
      const btn2 = (from, id) => ({ from, id, type: "interactive", interactive: { type: "button_reply", button_reply: { id: `accept:${HEX2}`, title: "x" } } });
      const r2 = await waCtrl.__test.handleOneMessage(btn2("919811111111", "wamid.t21b"));
      check("T21 expired tap refused+expired", r2?.ok === false && store.bookings.get(HEX2).status === "expired", store.bookings.get(HEX2).status);

      reset();
      const HEX3 = "507f1f77bcf86cd7994390ee";
      mkBooking({ _id: HEX3, status: "cancelled" });
      const btn3 = (from, id) => ({ from, id, type: "interactive", interactive: { type: "button_reply", button_reply: { id: `accept:${HEX3}`, title: "x" } } });
      const before = JSON.stringify({ ...store.bookings.get(HEX3), save: undefined });
      const r3 = await waCtrl.__test.handleOneMessage(btn3("919811111111", "wamid.t21c"));
      const after = JSON.stringify({ ...store.bookings.get(HEX3), save: undefined });
      check("T21 cancelled tap fails safely", r3?.ok === false && before === after, r3?.reason || "ok?");
    }

    // ---- T22: payment-window auto-cancel sends no WhatsApp ----
    {
      reset();
      const { expireBookingIfNeeded } = require("./services/bookingTransitions");
      const b = mkBooking({ status: "accepted", cook: COOK_A, paymentExpiresAt: new Date(Date.now() - 1000) });
      await expireBookingIfNeeded(b);
      const doc = store.bookings.get(b._id);
      check("T22 auto-cancel still transitions", doc.status === "cancelled", doc.status);
      check("T22 no WhatsApp to cook or customer", sentPayloads.length === 0, `${sentPayloads.length} sends`);
      check("T22 in-app notifications kept", notifs.filter((n) => n.type === "booking_cancelled").length === 2, notifs.map((n) => n.type).join(","));
    }

    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    console.error("TEST ERROR:", err);
    process.exit(1);
  } finally {
    delete global.fetch;
    try {
      Object.defineProperty(mongoose.connection, "readyState", { value: savedReadyState, configurable: true });
    } catch {
      mongoose.connection.readyState = savedReadyState;
    }
  }
})();
