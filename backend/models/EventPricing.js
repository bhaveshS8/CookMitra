const mongoose = require("mongoose");

// COOKMITRA EVENTS (MVP §6–8, §16) — admin-editable pricing. A single
// singleton document (key "default") holds every price so the frontend never
// hard-codes a rupee value. The pricing engine in utils/eventPricing.js reads
// this table; seed defaults mirror the §6/§7/§8 launch tables.
const DURATION_KEYS = [
  "upto2",
  "slot_2_3",
  "slot_3_4",
  "slot_4_5",
  "slot_5_6",
  "slot_6_7",
  "slot_7_8",
];

const SERVICE_KEYS = ["cooking_only", "preparation_cooking", "cooking_serving"];

const eventPricingSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: "default", trim: true },
    // servicePrices[service][durationKey] = price in ₹ (§6).
    servicePrices: {
      type: Map,
      of: Map,
      of: Number,
      default: undefined,
    },
    // ₹ per additional cook (§7).
    additionalCookPrice: { type: Number, default: 400, min: 0 },
    // ₹ per extra hour, per service (§7).
    extraHourPrices: {
      type: Map,
      of: Number,
      default: undefined,
    },
    // Fixed travel-charge table (§8): ordered { maxKm, charge } slabs.
    travelSlabs: [
      {
        maxKm: { type: Number, required: true },
        charge: { type: Number, required: true, min: 0 },
      },
    ],
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

const EventPricing = mongoose.model("EventPricing", eventPricingSchema);

EventPricing.DURATION_KEYS = DURATION_KEYS;
EventPricing.SERVICE_KEYS = SERVICE_KEYS;

// Launch defaults straight from the MVP doc (§6/§7/§8).
EventPricing.DEFAULT_PRICING = {
  servicePrices: {
    cooking_only: {
      upto2: 499,
      slot_2_3: 699,
      slot_3_4: 899,
      slot_4_5: 1099,
      slot_5_6: 1299,
      slot_6_7: 1499,
      slot_7_8: 1699,
    },
    preparation_cooking: {
      upto2: 799,
      slot_2_3: 999,
      slot_3_4: 1299,
      slot_4_5: 1599,
      slot_5_6: 1899,
      slot_6_7: 2199,
      slot_7_8: 2499,
    },
    cooking_serving: {
      upto2: 999,
      slot_2_3: 1299,
      slot_3_4: 1599,
      slot_4_5: 1999,
      slot_5_6: 2399,
      slot_6_7: 2799,
      slot_7_8: 3199,
    },
  },
  additionalCookPrice: 400,
  extraHourPrices: {
    cooking_only: 200,
    preparation_cooking: 250,
    cooking_serving: 300,
  },
  travelSlabs: [
    { maxKm: 3, charge: 0 },
    { maxKm: 5, charge: 50 },
    { maxKm: 8, charge: 100 },
    { maxKm: 10, charge: 150 },
    { maxKm: 15, charge: 250 },
    { maxKm: 20, charge: 350 },
    { maxKm: Number.MAX_SAFE_INTEGER, charge: 450 },
  ],
};

module.exports = EventPricing;
