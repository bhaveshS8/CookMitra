const User = require("./models/User");
const CookProfile = require("./models/CookProfile");
const whatsappApi = require("./utils/whatsappApi");
const {
  buildEventCookConfirmedMessage,
  resolveEventCookContact,
  sendEventCookConfirmed,
  notifyEventCookConfirmed,
} = require("./utils/eventWhatsApp");

let passes = 0;
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes += 1;
  else failures += 1;
};

const EVENT_ID = "507f1f77bcf86cd799439011";
const COOK_ID = "507f1f77bcf86cd799439012";

const event = {
  _id: EVENT_ID,
  bookingId: "EVT-WA-TEST",
  eventType: "Birthday",
  customEventType: "",
  eventDate: new Date("2026-11-20T00:00:00+05:30"),
  startTime: "18:30",
  duration: 3,
  extraHours: 1,
  guestCount: 25,
  address: "Flat 7, Sunshine Society",
  area: "Kothrud",
  landmark: "Near City Mall",
  menu: "Paneer Butter Masala, Dal Makhani, Rice",
  serviceType: "cooking_serving",
  distanceKm: 8,
  totalAmount: 5500,
  payment: { status: "paid", paidAmount: 5500 },
  cookId: COOK_ID,
};

const realFindById = User.findById;
const realFindOne = CookProfile.findOne;
const realSend = whatsappApi.sendWhatsAppText;
const sent = [];
let cook = {
  _id: COOK_ID,
  name: "Sunita Kulkarni",
  phone: "9876543210",
  mobile: "",
  role: "COOK",
  status: "active",
};
let profile = { approvalStatus: "approved" };

const stubModels = () => {
  User.findById = () => ({ select: () => ({ lean: async () => cook }) });
  CookProfile.findOne = () => ({ select: () => ({ lean: async () => profile }) });
};

stubModels();
whatsappApi.sendWhatsAppText = async (to, body) => {
  sent.push({ to, body });
  return { ok: true, id: "wamid.event-test" };
};

(async () => {
  try {
    const body = buildEventCookConfirmedMessage({ event, cookName: cook.name });
    check("message names the cook", body.includes("Sunita Kulkarni"), "cook");
    check("message has event booking id", body.includes("EVT-WA-TEST"), "booking");
    check("message has event type", body.includes("Birthday"), "type");
    check("message has date and time", body.includes("तारीख:") && body.includes("6:30 PM"), "schedule");
    check("message has duration including extra hours", body.includes("4 तास"), "duration");
    check("message has guest count", body.includes("पाहुणे: 25"), "guests");
    check("message has menu", body.includes("Paneer Butter Masala"), "menu");
    check(
      "message has full venue address",
      body.includes("Flat 7") && body.includes("Kothrud") && body.includes("Near City Mall"),
      "address"
    );
    check("message has distance", body.includes("8 किमी"), "distance");
    check("message has paid amount", body.includes("₹5500"), "amount");
    check("message has event details link", body.includes(`/event-bookings/${EVENT_ID}`), "link");
    check("message is Marathi", /[\u0900-\u097F]/.test(body), "devanagari");
    const noVenue = buildEventCookConfirmedMessage({
      event: { ...event, address: "", area: "", landmark: "" },
      cookName: cook.name,
    });
    check("missing venue never gets a fake map link", !noVenue.includes("नकाशा:"), "no-map");

    const ok = await sendEventCookConfirmed(event);
    check("approved active cook is sent the message", ok.ok === true && sent.length === 1, JSON.stringify(ok));
    check("message targets stored cook phone", sent[0]?.to === "9876543210", sent[0]?.to);
    check("message includes full booking data", sent[0]?.body.includes("EVT-WA-TEST") && sent[0]?.body.includes("Paneer Butter Masala"), "body");

    const resolved = await resolveEventCookContact(event);
    check("contact resolves for approved cook", resolved?.phone === "9876543210" && resolved?.name === cook.name, JSON.stringify(resolved));

    sent.length = 0;
    const noCook = await sendEventCookConfirmed({ ...event, cookId: null });
    check("missing assigned cook is skipped", noCook.skipped === true && sent.length === 0, JSON.stringify(noCook));

    cook = { ...cook, status: "inactive" };
    stubModels();
    const inactive = await sendEventCookConfirmed(event);
    check("inactive cook is skipped", inactive.skipped === true && sent.length === 0, JSON.stringify(inactive));

    cook = { ...cook, status: "active", phone: "", mobile: "" };
    stubModels();
    const noPhone = await sendEventCookConfirmed(event);
    check("cook without phone is skipped", noPhone.skipped === true && sent.length === 0, JSON.stringify(noPhone));

    cook = { ...cook, phone: "9876543210" };
    profile = { approvalStatus: "rejected" };
    stubModels();
    const unapproved = await sendEventCookConfirmed(event);
    check("unapproved cook is skipped", unapproved.skipped === true && sent.length === 0, JSON.stringify(unapproved));

    profile = { approvalStatus: "approved" };
    stubModels();
    whatsappApi.sendWhatsAppText = async () => {
      throw new Error("meta-down");
    };
    const failed = await sendEventCookConfirmed(event);
    check("WhatsApp failure resolves without throwing", failed.ok === false && /meta-down/.test(failed.error || ""), JSON.stringify(failed));

    whatsappApi.sendWhatsAppText = async () => ({ ok: true, id: "wamid.wrapper" });
    let threw = false;
    try {
      notifyEventCookConfirmed(event);
      await new Promise((resolve) => setTimeout(resolve, 30));
    } catch {
      threw = true;
    }
    check("fire-and-forget wrapper never throws", threw === false, "no throw");

    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (error) {
    console.error("TEST ERROR:", error);
    process.exit(1);
  } finally {
    User.findById = realFindById;
    CookProfile.findOne = realFindOne;
    whatsappApi.sendWhatsAppText = realSend;
  }
})();
