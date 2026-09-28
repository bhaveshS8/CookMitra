// COOKMITRA EVENTS seed — NON-DESTRUCTIVE. Upserts the event catalogue
// (§1) and the default admin pricing table (§6/§7/§8). Safe to run on a live
// database; never deletes or overwrites admin-customized prices.
// Run: npm run seed:events
const mongoose = require("mongoose");
const dotenv = require("dotenv");
const EventType = require("../models/EventType");
const EventPricing = require("../models/EventPricing");

dotenv.config();

const EVENT_CATALOGUE = [
  { name: "Birthday", description: "Birthday celebrations at home", icon: "cake" },
  { name: "Anniversary", description: "Anniversary dinners and parties", icon: "heart" },
  { name: "Family Function", description: "Family get-togethers and functions", icon: "users" },
  { name: "Home Celebration", description: "Festivals and home celebrations", icon: "sparkles" },
  { name: "Other", description: "Any other home event", icon: "calendar" },
];

const seedEvents = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("MongoDB connected for event seeding");

    let created = 0;
    for (const evt of EVENT_CATALOGUE) {
      const existing = await EventType.findOne({ name: evt.name });
      if (!existing) {
        await EventType.create({ ...evt, active: true });
        created += 1;
      }
    }
    console.log(`Event catalogue: ${created} created, ${EVENT_CATALOGUE.length - created} already present`);

    const pricing = await EventPricing.findOne({ key: "default" });
    if (!pricing) {
      const d = EventPricing.DEFAULT_PRICING;
      await EventPricing.create({
        key: "default",
        servicePrices: d.servicePrices,
        additionalCookPrice: d.additionalCookPrice,
        extraHourPrices: d.extraHourPrices,
        travelSlabs: d.travelSlabs.filter((s) => Number.isFinite(s.maxKm)),
      });
      console.log("Default event pricing created (§6/§7/§8 launch tables)");
    } else {
      console.log("Event pricing already configured — left untouched");
    }

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("Event seeding error:", error);
    process.exit(1);
  }
};

seedEvents();
