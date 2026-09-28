const mongoose = require("mongoose");
const dotenv = require("dotenv");
const User = require("../models/User");
const CookProfile = require("../models/CookProfile");
const Availability = require("../models/Availability");
const Booking = require("../models/Booking");
const Review = require("../models/Review");
const Notification = require("../models/Notification");
const Coupon = require("../models/Coupon");
const Complaint = require("../models/Complaint");
const Lead = require("../models/Lead");
const { INITIAL_COUPONS, RETIRED_COUPON_CODES } = require("../utils/couponCatalog");

dotenv.config();

// Promo coupons now live in ../utils/couponCatalog (pure data, so the pricing
// tests can assert every live code is redeemable against the launch slabs).
// See that file for the ladder design and the rationale per code.

const seedData = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected for seeding");

    // DANGER: seeding wipes every collection. Refuse when the database
    // already holds real data unless --force is passed explicitly.
    const existingUsers = await User.countDocuments();
    if (existingUsers > 0 && !process.argv.includes("--force")) {
      console.error(
        `Refusing to seed: database "${mongoose.connection.name}" already has ${existingUsers} user(s). ` +
          `Seeding DELETES all users, cooks, bookings, reviews and notifications. ` +
          `Re-run with --force if you really want to wipe it: node seeds/seed.js --force`
      );
      await mongoose.disconnect();
      process.exit(1);
    }

    await User.deleteMany({});
    await CookProfile.deleteMany({});
    await Availability.deleteMany({});
    await Booking.deleteMany({});
    await Review.deleteMany({});
    await Notification.deleteMany({});
    await Coupon.deleteMany({});
    // Complaints/leads hold cook/customer refs — wiping without them leaves
    // dangling references after every reseed.
    await Complaint.deleteMany({});
    await Lead.deleteMany({});

    const admin = await User.create({
      name: "Admin",
      email: "admin@festivecook.com",
      phone: "9999999999",
      password: "admin123",
      role: "ADMIN",
    });

    const customer = await User.create({
      name: "Neha Sharma",
      email: "neha@example.com",
      phone: "9876543210",
      password: "password123",
      role: "CUSTOMER",
    });

    const cook1 = await User.create({
      name: "Priya Patil",
      email: "priya@example.com",
      phone: "9123456789",
      password: "password123",
      role: "COOK",
    });

    const cook2 = await User.create({
      name: "Sunita Deshmukh",
      email: "sunita@example.com",
      phone: "9123456780",
      password: "password123",
      role: "COOK",
    });

    console.log("Seed data created successfully!");
    console.log("Admin: admin@festivecook.com / admin123");
    console.log("Customer: neha@example.com / password123");
    console.log("Cook 1: priya@example.com / password123");
    console.log("Cook 2: sunita@example.com / password123");

    // Cook profiles: one approved (bookable), one pending (admin approval demo)
    await CookProfile.create({
      user: cook1._id,
      bio: "Experienced in Diwali Faral and traditional Maharashtrian sweets with 8 years of home cooking experience.",
      experienceYears: 8,
      specialties: ["Chakli", "Karanji", "Ladoo", "Modak"],
      serviceTypes: ["cook_for_me", "cook_with_me", "teach_me"],
      rate: 500,
      serviceArea: "Pune",
      approvalStatus: "approved",
    });

    await CookProfile.create({
      user: cook2._id,
      bio: "Specialist in fasting recipes and festive prasad.",
      experienceYears: 5,
      specialties: ["Sabudana Khichdi", "Modak"],
      serviceTypes: ["cook_with_me", "preparation_help"],
      rate: 400,
      serviceArea: "Mumbai",
      approvalStatus: "pending",
    });

    // Availability windows for the approved cook (next 7 days, 3 broad
    // windows/day covering the whole 08:00–20:00 service day). Windows must
    // comfortably exceed the app's default 3-hour session — narrow windows
    // can never fit it and the date shows "no slots".
    const slots = [];
    for (let d = 1; d <= 7; d++) {
      const date = new Date();
      date.setDate(date.getDate() + d);
      date.setHours(0, 0, 0, 0);
      slots.push(
        { cook: cook1._id, date: new Date(date), startTime: "08:00", endTime: "12:00", status: "available" },
        { cook: cook1._id, date: new Date(date), startTime: "12:00", endTime: "16:00", status: "available" },
        { cook: cook1._id, date: new Date(date), startTime: "16:00", endTime: "20:00", status: "available" }
      );
    }
    await Availability.insertMany(slots);
    console.log(`Seeded 1 approved + 1 pending cook profile and ${slots.length} availability slots`);

    // Initial promo coupons — up to 20% off festive bookings. Admin-managed
    // from the admin dashboard (Coupons tab) at any time afterwards.
    await Coupon.create(INITIAL_COUPONS.map((c) => ({ ...c, createdBy: admin._id })));
    console.log(
      `Seeded ${INITIAL_COUPONS.length} promo coupons (${INITIAL_COUPONS.map((c) => c.code).join(", ")})`
    );
    // Disconnect first so buffered writes flush — exiting mid-flush can
    // truncate the seed on slow connections.
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("Seeding error:", error);
    process.exit(1);
  }
};

// Safe, non-destructive coupon sync for an existing database. Three things,
// none of which ever delete a record or touch usedCount/usedBy history:
//   1. create catalogue codes that are missing
//   2. sync the terms of existing catalogue codes (e.g. WELCOME50's min order)
//   3. deactivate retired codes so dead/false-promise offers stop being served
// Run: npm run seed:coupons
const seedCouponsOnly = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected for coupon sync (--coupons-only)");
    const admin = await User.findOne({ role: { $in: ["ADMIN", "admin"] } }).select("_id");

    let created = 0;
    let updated = 0;
    for (const coupon of INITIAL_COUPONS) {
      const existing = await Coupon.findOne({ code: coupon.code });
      if (!existing) {
        await Coupon.create({ ...coupon, createdBy: admin?._id });
        created += 1;
        continue;
      }
      // Only the offer terms are synced — usage counters stay append-only.
      const terms = { ...coupon };
      delete terms.code;
      await Coupon.updateOne({ _id: existing._id }, { $set: terms });
      updated += 1;
    }

    // Retired codes are deactivated, never deleted: bookings reference them.
    const retired = await Coupon.updateMany(
      { code: { $in: RETIRED_COUPON_CODES }, active: true },
      { $set: { active: false } }
    );
    const alreadyOff = await Coupon.countDocuments({
      code: { $in: RETIRED_COUPON_CODES },
      active: false,
    });

    console.log(
      `Coupon sync done: ${created} created, ${updated} synced, ` +
        `${retired.modifiedCount} retired (${alreadyOff} already inactive).`
    );
    const live = await Coupon.find({ active: true }).select("code").sort({ code: 1 });
    console.log(`Live now: ${live.map((c) => c.code).join(", ") || "(none)"}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("Coupon sync error:", error);
    process.exit(1);
  }
};

if (process.argv.includes("--coupons-only")) {
  seedCouponsOnly();
} else {
  seedData();
}
