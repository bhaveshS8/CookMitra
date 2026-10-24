// Marathi cook-facing WhatsApp messages — content, language selection,
// Unicode preservation, and booking-data substitution.
//
// Covers the Marathi requirement: replacement broadcasts, acceptance
// confirmations, post-assignment details, and cook cancellation notices
// are Devanagari Marathi; customer messages keep existing language.
// Hermetic: builders are pure; dispatcher paths use stubbed models and a
// mocked fetch. No DB, no network, no real sends.
// Run: node backend/whatsapp-marathi-cook.test.js
process.env.WHATSAPP_ENABLED = "true";
process.env.WHATSAPP_TOKEN = "test_token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";

const marathi = require("./utils/whatsappMessages");
const api = require("./utils/whatsappApi");
const dispatch = require("./services/whatsappDispatch");
const User = require("./models/User");
const Booking = require("./models/Booking");

let passes = 0; let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); ok ? passes++ : failures++; };
const DEVA = /[\u0900-\u097F]/;

const booking = {
  _id: "bk-mr-001",
  serviceType: "cook_for_me",
  date: new Date("2026-10-07T00:00:00+05:30"),
  startTime: "10:00",
  endTime: "12:00",
  durationHours: 2,
  address: "Flat 7, Sunshine Society, Pune",
  guests: 4,
  notes: "less spicy",
  status: "requested",
  payment: { status: "paid", paidAmount: 699 },
  cook: "cook1",
  customer: "cust1",
};
const unpaid = { ...booking, payment: { status: "pending", paidAmount: 0 } };

// ---- 1. Replacement request body: required fields, paid-conditional ----
{
  const paid = marathi.buildBookingRequestMessage({ booking, customerName: "Aditi Rao" });
  check("M1 request has booking ref", paid.includes("📋 बुकिंग क्रमांक: bk-mr-001"), "ref");
  check("M1 request has Marathi service type", paid.includes("🍽️ सेवा:") && paid.includes("माझ्यासाठी स्वयंपाक"), "service");
  check("M1 paid request states paid + no-repay", paid.includes("आधीच पेमेंट केले आहे") && paid.includes("पुन्हा पेमेंटची आवश्यकता नाही"), "paid");
  check("M1 request is Devanagari", DEVA.test(paid), "mr");
  const free = marathi.buildBookingRequestMessage({ booking: unpaid, customerName: "Aditi Rao" });
  check("M1 unpaid request omits paid claim", !free.includes("आधीच पेमेंट केले आहे"), "unpaid-honest");
  check("M1 unpaid still has ref + service", free.includes("bk-mr-001") && free.includes("माझ्यासाठी स्वयंपाक"), "ref");
  const bare = marathi.buildBookingRequestMessage({ booking: {}, customerName: "" });
  check("M1 missing values never borrowed", bare.includes("माहिती उपलब्ध नाही") && !bare.includes("bk-mr-001"), "nodata");
}

// ---- 2. Scheduled confirmation: ref + paid line ----
{
  const body = marathi.buildCookBookingScheduledMessage({ booking, cookName: "Suresh", customerName: "Aditi Rao" });
  check("M2 scheduled has booking ref", body.includes("📋 बुकिंग क्रमांक: bk-mr-001"), "ref");
  check("M2 scheduled states paid, no double-charge", body.includes("आधीच पेमेंट केले आहे") && body.includes("पुन्हा पेमेंट घेऊ नका"), "paid");
  check("M2 scheduled names customer", body.includes("Aditi Rao") && body.includes("Suresh"), "parties");
  check("M2 scheduled is Devanagari", DEVA.test(body), "mr");
}

// ---- 3. Cook cancellation variants ----
{
  const cook = marathi.buildCookCancelledMessage({ booking, cancelledBy: "cook" });
  check("M3 cook-cancel promises replacement search", cook.includes("बदली कुक शोधत आहोत"), "replacement");
  check("M3 cook-cancel has ref + Marathi date", cook.includes("bk-mr-001") && cook.includes("7 ऑक्टोबर 2026"), "substitution");
  check("M3 paid cook-cancel keeps paid note", cook.includes("पुन्हा पेमेंटची आवश्यकता नाही"), "paid");
  const cookUnpaid = marathi.buildCookCancelledMessage({ booking: unpaid, cancelledBy: "cook" });
  check("M3 unpaid cook-cancel omits paid note", !cookUnpaid.includes("पुन्हा पेमेंटची आवश्यकता नाही"), "honest");
  const cust = marathi.buildCookCancelledMessage({ booking, cancelledBy: "customer" });
  check("M3 customer-cancel variant", cust.includes("ग्राहकाने ही बुकिंग रद्द केली आहे"), "customer");
  const adm = marathi.buildCookCancelledMessage({ booking, cancelledBy: "admin" });
  check("M3 admin-cancel variant", adm.includes("सपोर्ट टीमने"), "admin");
  check("M3 all variants Devanagari", [cook, cust, adm].every((m) => DEVA.test(m)), "mr");
}

// ---- 4. Cook acceptance acknowledgement ----
{
  const body = marathi.buildCookAcceptedMessage({ booking, customerName: "Aditi Rao" });
  check("M4 accepted is Marathi", DEVA.test(body) && body.includes("स्वीकारले"), "mr");
  check("M4 accepted has ref + customer + 5-min note", body.includes("bk-mr-001") && body.includes("Aditi Rao") && body.includes("५ मिनिट"), "fields");
}

// ---- 5. Unicode preservation through transport encoding ----
{
  const bodies = [
    marathi.buildBookingRequestMessage({ booking, customerName: "Aditi Rao" }),
    marathi.buildCookBookingScheduledMessage({ booking, cookName: "Suresh", customerName: "Aditi Rao" }),
    marathi.buildCookCancelledMessage({ booking, cancelledBy: "cook" }),
    marathi.buildCookAcceptedMessage({ booking, customerName: "Aditi Rao" }),
  ];
  const roundTripped = bodies.map((b) => JSON.parse(JSON.stringify({ text: b })).text);
  check("M5 JSON round-trip preserves Devanagari exactly", roundTripped.every((t, i) => t === bodies[i]), "unicode");
  check("M5 no mojibake markers", roundTripped.every((t) => !/ï¿½|Ã|Â/.test(t)), "clean");
}

// ---- 5b. Customer location in the cook confirmation ----
{
  const withPin = {
    ...booking,
    location: { lat: 18.5204, lng: 73.8567 },
    address: "Flat 7, Sunshine Society, Pune",
  };
  const body = marathi.buildCookBookingScheduledMessage({ booking: withPin, cookName: "Suresh", customerName: "Aditi Rao" });
  check("M8 confirmation has saved address", body.includes("Flat 7, Sunshine Society, Pune"), "address");
  check(
    "M8 valid coords produce search link",
    body.includes("https://www.google.com/maps/search/?api=1&query=18.5204,73.8567"),
    "pin-link"
  );
  const addrOnly = {
    ...booking,
    address: "Flat 7, Sunshine Society, Pune",
  };
  delete addrOnly.location;
  const body2 = marathi.buildCookBookingScheduledMessage({ booking: addrOnly, cookName: "Suresh", customerName: "Aditi Rao" });
  check(
    "M8 missing coords fall back to encoded address link",
    body2.includes("https://www.google.com/maps/search/?api=1&query=") && body2.includes(encodeURIComponent("Flat 7, Sunshine Society, Pune")),
    "addr-link"
  );
  const bare = { ...booking, address: "" };
  delete bare.location;
  const body3 = marathi.buildCookBookingScheduledMessage({ booking: bare, cookName: "Suresh", customerName: "Aditi Rao" });
  check("M8 missing location handled safely", !body3.includes("maps/search") && !body3.includes("undefined"), "nodata");
  check("M8 never invents coordinates", !/query=-?\d+\.\d+,-?\d+\.\d+/.test(body3), "no-guess");
}

// ---- 6. Dispatcher split: cook Marathi, customer keeps English ----
(async () => {
  const oFindById = User.findById;
  User.findById = (id) => ({
    select: () => ({
      lean: async () => String(id) === "cook1"
        ? { _id: "cook1", name: "Suresh", phone: "9876543210" }
        : { _id: "cust1", name: "Aditi Rao", phone: "9123456780" },
    }),
  });
  const sent = [];
  const oFetch = global.fetch;
  global.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.1" }] }) };
  };
  try {
    const r = await api.sendBookingWhatsApp("cancelled", booking, { cancelledBy: "cook" });
    const texts = sent.filter((p) => p.type === "text").map((p) => p.text.body);
    const cookText = texts.find((t) => /बदली कुक शोधत/.test(t)) || "";
    const custText = texts.find((t) => /cook cancelled/i.test(t)) || "";
    check("M6 dispatch ok to both sides", r?.ok === true && texts.length === 2, `${texts.length} texts`);
    check("M6 cook side Marathi replacement", DEVA.test(cookText) && cookText.includes("bk-mr-001"), "cook-mr");
    check("M6 customer side keeps English", /cook cancelled/i.test(custText) && !DEVA.test(custText), "cust-en");
  } catch (e) { check("M6 dispatch split", false, e.message); }
  finally { User.findById = oFindById; global.fetch = oFetch; }

  // ---- 7. Template language defaults to mr ----
  const CookProfile = require("./models/CookProfile");
  const oFind2 = User.find;
  const oFindOne = CookProfile.findOne;
  const oFindById2 = User.findById;
  const oFindBooking = Booking.findById;
  const oUpdate = Booking.updateOne;
  User.find = () => ({ select: () => ({ lean: async () => [{ _id: "cook1", phone: "9876543210", name: "Suresh" }] }) });
  User.findById = () => ({ select: () => ({ lean: async () => ({ _id: "cook1", role: "cook", status: "active" }) }) });
  CookProfile.findOne = async () => ({ user: "cook1", approvalStatus: "approved", serviceTypes: ["cook_for_me"] });
  const rbBase = { ...booking, _id: "bk-mr-002", cook: null, status: "requested", ignoredBy: [], whatsappDispatch: [] };
  Booking.findById = async () => rbBase;
  Booking.updateOne = async () => ({ modifiedCount: 0 });
  const tplSent = [];
  global.fetch = async (url, opts) => {
    tplSent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.2" }] }) };
  };
  const oTpl = process.env.WHATSAPP_REQUEST_TEMPLATE;
  const oLang = process.env.WHATSAPP_REQUEST_TEMPLATE_LANG;
  const oTplCook = process.env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK;
  const oLangCook = process.env.WHATSAPP_TEMPLATE_LANG_COOK_REQUEST;
  process.env.WHATSAPP_REQUEST_TEMPLATE = "new_booking_request";
  delete process.env.WHATSAPP_REQUEST_TEMPLATE_LANG;
  delete process.env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK;
  delete process.env.WHATSAPP_TEMPLATE_LANG_COOK_REQUEST;
  try {
    const rb = { ...booking, _id: "bk-mr-002", cook: null, status: "requested", whatsappDispatch: [] };
    await dispatch.fanOutBookingRequest(rb, [{ userId: "cook1" }], { customerName: "Aditi Rao" });
    const tpl = tplSent.find((p) => p.type === "template");
    check("M7 template language defaults to mr", tpl?.template?.language?.code === "mr", tpl?.template?.language?.code || "no-template");
    check("M7 template name from env", tpl?.template?.name === "new_booking_request", tpl?.template?.name || "none");
  } catch (e) { check("M7 template lang", false, e.message); }
  finally {
    if (oTpl === undefined) delete process.env.WHATSAPP_REQUEST_TEMPLATE; else process.env.WHATSAPP_REQUEST_TEMPLATE = oTpl;
    if (oLang === undefined) delete process.env.WHATSAPP_REQUEST_TEMPLATE_LANG; else process.env.WHATSAPP_REQUEST_TEMPLATE_LANG = oLang;
    if (oTplCook === undefined) delete process.env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK; else process.env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK = oTplCook;
    if (oLangCook === undefined) delete process.env.WHATSAPP_TEMPLATE_LANG_COOK_REQUEST; else process.env.WHATSAPP_TEMPLATE_LANG_COOK_REQUEST = oLangCook;
    User.find = oFind2; User.findById = oFindById2; CookProfile.findOne = oFindOne;
    Booking.findById = oFindBooking; Booking.updateOne = oUpdate; global.fetch = oFetch;
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
