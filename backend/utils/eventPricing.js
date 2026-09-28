// COOKMITRA EVENTS pricing engine (MVP §6–9).
// Single source of truth for event quotes. Reads the admin-configured
// EventPricing table; falls back to the §6/§7/§8 launch defaults when no
// admin pricing exists yet (fresh install). The server always recomputes —
// client totals are preview-only and never trusted.

const EventPricing = require("../models/EventPricing");

// Map a duration in hours to its price-table slot (§6).
// Buckets are lower-bound inclusive (the §9 worked example pins this:
// 4h Preparation + Cooking = ₹1,599 = the "4–5 Hours" row, and 7 km travel
// = ₹100 + 1 additional cook ₹400 gives the stated Total = ₹2,099).
//   d < 2 → upto2, 2 ≤ d < 3 → slot_2_3, …, 7 ≤ d ≤ 8 → slot_7_8.
// Beyond 8h returns null — extra time is billed via extraHours instead.
const durationKeyForHours = (hours) => {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  if (h < 2) return "upto2";
  if (h < 3) return "slot_2_3";
  if (h < 4) return "slot_3_4";
  if (h < 5) return "slot_4_5";
  if (h < 6) return "slot_5_6";
  if (h < 7) return "slot_6_7";
  if (h <= 8) return "slot_7_8";
  return null;
};

// Plain-object view of the pricing doc (or launch defaults when absent).
// Map fields come back as Maps from Mongoose — normalize to objects.
const normalizePricing = (doc) => {
  const d = EventPricing.DEFAULT_PRICING;
  if (!doc) return JSON.parse(JSON.stringify({ ...d }));
  const mapToObj = (m, fallback) => {
    if (!m) return { ...fallback };
    if (typeof m === "object" && !(m instanceof Map)) return { ...fallback, ...m };
    const out = { ...fallback };
    for (const [k, v] of m.entries()) {
      if (v instanceof Map) {
        out[k] = {};
        for (const [kk, vv] of v.entries()) out[k][kk] = Number(vv);
      } else {
        out[k] = Number(v);
      }
    }
    return out;
  };
  return {
    servicePrices: mapToObj(doc.servicePrices, d.servicePrices),
    additionalCookPrice: Number(doc.additionalCookPrice ?? d.additionalCookPrice),
    extraHourPrices: mapToObj(doc.extraHourPrices, d.extraHourPrices),
    travelSlabs: Array.isArray(doc.travelSlabs) && doc.travelSlabs.length > 0
      ? [...doc.travelSlabs]
          .map((s) => ({ maxKm: Number(s.maxKm), charge: Number(s.charge) }))
          .sort((a, b) => a.maxKm - b.maxKm)
      : d.travelSlabs.map((s) => ({ ...s })),
  };
};

const getPricingTable = async () => {
  let doc = null;
  try {
    // Unit tests / offline boot run disconnected — a findOne() would buffer
    // and hang instead of throwing, so skip the DB read entirely and serve
    // the launch defaults.
    const mongoose = require("mongoose");
    if (mongoose.connection && mongoose.connection.readyState === 1) {
      doc = await EventPricing.findOne({ key: "default" }).lean();
    }
  } catch {
    doc = null; // DB error: fall back to launch defaults
  }
  return normalizePricing(doc);
};

// Fixed travel-charge lookup (§8): first slab whose maxKm covers the distance.
const travelChargeForDistance = (travelSlabs, distanceKm) => {
  const dist = Math.max(0, Number(distanceKm) || 0);
  const slabs = [...travelSlabs].sort((a, b) => a.maxKm - b.maxKm);
  for (const slab of slabs) {
    if (dist <= slab.maxKm) return Number(slab.charge) || 0;
  }
  return slabs.length > 0 ? Number(slabs[slabs.length - 1].charge) || 0 : 0;
};

// Full quote (§9):
//   Service Price + Additional Cook Charges + Extra Hour Charges + Travel = Total
const calculateEventPrice = async ({
  serviceType,
  duration,
  distanceKm = 0,
  additionalCook = 0,
  extraHours = 0,
}) => {
  const table = await getPricingTable();
  if (!EventPricing.SERVICE_KEYS.includes(serviceType)) {
    throw new Error("Valid service type is required");
  }
  const key = durationKeyForHours(duration);
  if (!key) {
    throw new Error("Duration must be between 1 and 8 hours (use extra hours beyond that)");
  }
  const serviceAmount = Number(table.servicePrices?.[serviceType]?.[key]);
  if (!Number.isFinite(serviceAmount)) {
    throw new Error("No price configured for this service and duration");
  }
  const cooks = Math.max(0, Math.floor(Number(additionalCook) || 0));
  const extra = Math.max(0, Number(extraHours) || 0);
  const additionalCookAmount = cooks * Number(table.additionalCookPrice || 0);
  const extraHourAmount = extra * Number(table.extraHourPrices?.[serviceType] || 0);
  const travelCharge = travelChargeForDistance(table.travelSlabs, distanceKm);
  const totalAmount = Math.round(
    serviceAmount + additionalCookAmount + extraHourAmount + travelCharge
  );
  return {
    serviceAmount,
    additionalCookAmount,
    extraHourAmount,
    travelCharge,
    totalAmount,
    durationKey: key,
  };
};

module.exports = {
  durationKeyForHours,
  getPricingTable,
  travelChargeForDistance,
  calculateEventPrice,
};
