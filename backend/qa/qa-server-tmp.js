// TEMP UI-QA launcher: isolated database + seeded events data + minted JWTs.
// Never touches the dev database (name is hard-checked below).
process.env.PORT = "5055";
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const BASE = "C:/Users/jiya/Desktop/Events/CookMitra/backend";
process.chdir(BASE);
require("dotenv").config();

const TEST_DB = "cookmitra_uiqa";
const uri = (process.env.MONGODB_URI || "").trim();
if (!uri) { console.error("ABORT: no MONGODB_URI"); process.exit(1); }
const testUri = uri.replace(/\/([^/?]+)(\?|$)/, `/${TEST_DB}$2`);
if (testUri === uri) { console.error("ABORT: cannot derive isolated URI"); process.exit(1); }

(async () => {
  await mongoose.connect(testUri, { serverSelectionTimeoutMS: 12000 });
  if (mongoose.connection.name !== TEST_DB) {
    console.error('ABORT: connected to "' + mongoose.connection.name + '"');
    await mongoose.disconnect(); process.exit(1);
  }
  await mongoose.connection.db.dropDatabase();

  const User = require("./models/User");
  const CookProfile = require("./models/CookProfile");
  const EventType = require("./models/EventType");
  const EventPricing = require("./models/EventPricing");
  const EventBooking = require("./models/EventBooking");

  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d;
  };

  const admin = await User.create({ name: "QA Admin", email: "admin@qa.test", password: "Test1234!", phone: "9876543210", role: "ADMIN" });
  const cust = await User.create({ name: "Aarav Sharma", email: "cust@qa.test", password: "Test1234!", phone: "9812345670", role: "CUSTOMER" });
  const cust2 = await User.create({ name: "Priya Deshmukh", email: "cust2@qa.test", password: "Test1234!", phone: "9812345671", role: "CUSTOMER" });
  const cook1 = await User.create({ name: "Sunita Kulkarni", email: "cook1@qa.test", password: "Test1234!", phone: "9812345672", role: "COOK" });
  const cook2 = await User.create({ name: "Meena Patil", email: "cook2@qa.test", password: "Test1234!", phone: "9812345673", role: "COOK" });
  const cook3 = await User.create({ name: "Rahul Jadhav", email: "cook3@qa.test", password: "Test1234!", phone: "9812345674", role: "COOK" });

  await CookProfile.create({ user: cook1._id, approvalStatus: "approved", availabilityStatus: "available", serviceArea: "Hadapsar, Pune", experienceYears: 8, cuisines: ["Maharashtrian", "North Indian"] });
  await CookProfile.create({ user: cook2._id, approvalStatus: "approved", availabilityStatus: "available", serviceArea: "Kothrud, Pune", experienceYears: 5, cuisines: ["Gujarati", "Continental"] });
  await CookProfile.create({ user: cook3._id, approvalStatus: "pending", availabilityStatus: "available", serviceArea: "Baner, Pune", experienceYears: 2, cuisines: ["Indian"] });

  for (const [name, description, icon] of [
    ["Birthday", "Birthday celebrations at home", "cake"],
    ["Anniversary", "Anniversary dinners and parties", "heart"],
    ["Family Function", "Family get-togethers and functions", "users"],
    ["Home Celebration", "Festivals and home celebrations", "sparkles"],
    ["Other", "Any other home event", "calendar"],
  ]) await EventType.create({ name, description, icon, active: true });

  const d = EventPricing.DEFAULT_PRICING;
  await EventPricing.create({ key: "default", servicePrices: d.servicePrices, additionalCookPrice: d.additionalCookPrice, extraHourPrices: d.extraHourPrices, travelSlabs: d.travelSlabs.filter((s) => Number.isFinite(s.maxKm)) });

  const mk = (o) => ({
    customerId: o.customer, cookId: o.cook || null, bookingId: o.bid,
    eventType: o.type, eventDate: day(o.dayOffset), startTime: o.start || "18:00",
    duration: o.duration ?? 4, guestCount: o.guests ?? 20,
    address: o.address || "Flat 4B, Sunrise Residency, Market Road", area: o.area || "Hadapsar, Pune",
    landmark: o.landmark || "", foodType: "Full Meal", menu: o.menu || "Puri, Bhaji, Rice, Dal, Salad and Gulab Jamun",
    serviceType: o.service || "preparation_cooking", additionalCook: o.addCook ?? 0, extraHours: o.extra ?? 0,
    distanceKm: o.km ?? 7, distanceVerified: o.verified ?? false,
    serviceAmount: o.svc ?? 1599, additionalCookAmount: (o.addCook ?? 0) * 400,
    extraHourAmount: 0, travelCharge: o.travel ?? 100, totalAmount: o.total ?? 2099,
    bookingStatus: o.status, customerNotes: o.notes || "",
    statusHistory: [{ status: o.status, note: "Seeded for UI QA" }],
  });

  await EventBooking.create([
    mk({ customer: cust._id, bid: "EVT-QAPEND01", type: "Birthday", dayOffset: 6, status: "pending", verified: false }),
    mk({ customer: cust._id, bid: "EVT-QAASSN01", type: "Anniversary", dayOffset: 3, status: "cook_assigned", cook: cook1._id, km: 12, travel: 250, total: 2249 }),
    mk({ customer: cust2._id, bid: "EVT-QACONF01", type: "Family Function", dayOffset: 2, status: "confirmed", cook: cook2._id, duration: 6, guests: 45, svc: 2199, km: 4, travel: 50, total: 2249, verified: true }),
    mk({ customer: cust2._id, bid: "EVT-QAPROG01", type: "Home Celebration", dayOffset: 0, start: "10:00", status: "in_progress", cook: cook1._id, duration: 5, guests: 30, svc: 1899, km: 2, travel: 0, total: 1899, verified: true }),
    mk({ customer: cust._id, bid: "EVT-QACOMP01", type: "Birthday", dayOffset: -4, status: "completed", cook: cook2._id, duration: 4, guests: 15, svc: 1599, km: 7, travel: 100, total: 1699, verified: true }),
    mk({ customer: cust2._id, bid: "EVT-QACANC01", type: "Other", dayOffset: -1, status: "cancelled", cook: cook1._id, duration: 3, guests: 10, svc: 1299, km: 9, travel: 150, total: 1449, verified: false }),
  ]);

  const sign = (u) => jwt.sign({ id: u._id, role: String(u.role).toLowerCase() }, process.env.JWT_SECRET, { expiresIn: "1d" });
  const tokens = { admin: sign(admin), customer: sign(cust), customer2: sign(cust2), cook: sign(cook1), cookPending: sign(cook3) };
  const users = {
    admin: { id: admin._id.toString(), _id: admin._id.toString(), name: admin.name, email: admin.email, role: "admin" },
    customer: { id: cust._id.toString(), _id: cust._id.toString(), name: cust.name, email: cust.email, role: "customer" },
    customer2: { id: cust2._id.toString(), _id: cust2._id.toString(), name: cust2.name, email: cust2.email, role: "customer" },
    cook: { id: cook1._id.toString(), _id: cook1._id.toString(), name: cook1.name, email: cook1.email, role: "cook" },
    cookPending: { id: cook3._id.toString(), _id: cook3._id.toString(), name: cook3.name, email: cook3.email, role: "cook" },
  };
  fs.writeFileSync(path.join(require("os").tmpdir(), "uiqa-auth.json"), JSON.stringify({ tokens, users }, null, 2));
  console.log("QA seed complete. Auth file written.");

  // Keep this process as the API+static server.
  require(path.join(BASE, "server.js"));
})().catch((e) => { console.error("QA boot failed:", e.message); process.exit(1); });
