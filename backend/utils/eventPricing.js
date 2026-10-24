// COOKMITRA EVENTS pricing engine (MVP §6–9).
// Single source of truth for event quotes. Reads the admin-configured
// EventPricing table; falls back to the §6/§7/§8 launch defaults when no
// admin pricing exists yet (fresh install). The server always recomputes —
// client totals are preview-only and never trusted.
//
// Currency policy: all amounts are whole INR (₹), rounded with Math.round at
// the quote boundary. Stored snapshots are whole rupees so later pricing
// edits never alter previously booked totals.

const EventPricing = require("../models/EventPricing");

// Hard limits guard safe arithmetic (reject absurd values before multiply).
const MAX_PRICE = 10000000; // ₹1cr per cell — far above any real price
const MAX_DISTANCE_KM = 100000; // beyond this is malformed input, not travel
const UNLIMITED_SLAB_MIN_KM = 1000000; // final slab must cover "20+ km" and beyond

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
// Pure function — callers must validate distanceKm beforehand; this clamps
// defensively (negative → 0) so a missed check can never produce a negative.
const travelChargeForDistance = (travelSlabs, distanceKm) => {
  const raw = Number(distanceKm);
  const dist = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  const slabs = [...travelSlabs].sort((a, b) => a.maxKm - b.maxKm);
  for (const slab of slabs) {
    if (dist <= slab.maxKm) return Number(slab.charge) || 0;
  }
  return slabs.length > 0 ? Number(slabs[slabs.length - 1].charge) || 0 : 0;
};

// Strict numeric guards — REJECT invalid instead of silently coercing to 0
// (the old `Number(x) || 0` turned NaN into free travel / free cooks).
const assertFiniteNumber = (value, name) => {
  const n = typeof value === "number" ? value : Number(value);
  if (typeof value === "boolean" || value === "" || value == null || !Number.isFinite(n)) {
    throw new Error(`${name} must be a finite number`);
  }
  return n;
};

// Validate a full pricing table (used after merging partial admin updates so
// an incomplete/corrupt edit can never leave the app without usable pricing).
// Throws with a human message on the first problem found.
const validatePricingTable = (table) => {
  if (!table || typeof table !== "object") throw new Error("Invalid pricing table");
  for (const svc of EventPricing.SERVICE_KEYS) {
    for (const dk of EventPricing.DURATION_KEYS) {
      const v = Number(table.servicePrices?.[svc]?.[dk]);
      if (!Number.isFinite(v) || v < 0 || v > MAX_PRICE) {
        throw new Error(`Invalid price for ${svc} / ${dk}`);
      }
    }
  }
  const addCook = Number(table.additionalCookPrice);
  if (!Number.isFinite(addCook) || addCook < 0 || addCook > MAX_PRICE) {
    throw new Error("Invalid additional cook price");
  }
  for (const svc of EventPricing.SERVICE_KEYS) {
    const v = Number(table.extraHourPrices?.[svc]);
    if (!Number.isFinite(v) || v < 0 || v > MAX_PRICE) {
      throw new Error(`Invalid extra-hour price for ${svc}`);
    }
  }
  validateTravelSlabs(table.travelSlabs);
  return true;
};

// Travel slabs must be ordered, strictly increasing, non-overlapping in their
// effective interpretation (first-cover wins), start above 0, and cover every
// supported distance including the final unlimited range.
const validateTravelSlabs = (slabs) => {
  if (!Array.isArray(slabs) || slabs.length === 0) {
    throw new Error("travelSlabs must be a non-empty array");
  }
  let prevMax = -Infinity;
  slabs.forEach((s, i) => {
    // Reject numeric strings, booleans, NaN, Infinity (except the unlimited
    // sentinel which must still be a finite large number — Infinity does not
    // survive JSON/Mongo round-trips, so require >= UNLIMITED_SLAB_MIN_KM).
    if (!s || typeof s !== "object") throw new Error(`Invalid travel slab at index ${i}`);
    if (typeof s.maxKm !== "number" || typeof s.charge !== "number") {
      throw new Error(`Travel slab ${i} must use numeric maxKm and charge`);
    }
    const { maxKm, charge } = s;
    if (!Number.isFinite(maxKm) || !Number.isFinite(charge)) {
      throw new Error(`Travel slab ${i} must have finite maxKm and charge`);
    }
    if (maxKm <= 0 || maxKm <= prevMax) {
      throw new Error("Travel slabs must be strictly increasing by maxKm");
    }
    if (charge < 0 || charge > MAX_PRICE) {
      throw new Error(`Invalid charge in travel slab ${i}`);
    }
    prevMax = maxKm;
  });
  const last = slabs[slabs.length - 1];
  if (last.maxKm < UNLIMITED_SLAB_MIN_KM && last.maxKm !== Number.MAX_SAFE_INTEGER) {
    throw new Error("Final travel slab must cover unlimited distance (maxKm >= 1000000)");
  }
  return true;
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
  // Strict guards reject booleans / "" / null that Number() would coerce
  // (Number(true) === 1 would silently bill an extra cook).
  const dur = assertFiniteNumber(duration, "Duration");
  if (dur < 1 || dur > 8) {
    throw new Error("Duration must be between 1 and 8 hours (use extra hours beyond that)");
  }
  const key = durationKeyForHours(dur);
  if (!key) {
    throw new Error("Duration must be between 1 and 8 hours (use extra hours beyond that)");
  }
  const serviceAmount = Number(table.servicePrices?.[serviceType]?.[key]);
  if (!Number.isFinite(serviceAmount) || serviceAmount < 0 || serviceAmount > MAX_PRICE) {
    throw new Error("No price configured for this service and duration");
  }
  // Strict quantity validation — never coerce garbage to 0.
  const cooksRaw = assertFiniteNumber(additionalCook, "Additional cooks");
  if (!Number.isInteger(cooksRaw) || cooksRaw < 0 || cooksRaw > 10) {
    throw new Error("Additional cooks must be an integer between 0 and 10");
  }
  const extraRaw = assertFiniteNumber(extraHours, "Extra hours");
  if (extraRaw < 0 || extraRaw > 12) {
    throw new Error("Extra hours must be between 0 and 12");
  }
  const distRaw = assertFiniteNumber(distanceKm, "Distance");
  if (distRaw < 0 || distRaw > MAX_DISTANCE_KM) {
    throw new Error("Distance must be between 0 and 100000 km");
  }
  // Round extra-hour billing to 2 decimals to avoid float dust (e.g. 0.1h),
  // then build the total from the EXACT components that get stored, so the
  // persisted breakdown always re-sums to the persisted total
  // (totalAmount === round(stored service + stored cook + stored extra +
  // stored travel)) under any valid price table, even fractional ones.
  const extra = Math.round(extraRaw * 100) / 100;
  const additionalCookAmount = Math.round(cooksRaw * Number(table.additionalCookPrice || 0) * 100) / 100;
  const extraHourAmount = Math.round(extra * Number(table.extraHourPrices?.[serviceType] || 0) * 100) / 100;
  const travelCharge = Math.round(travelChargeForDistance(table.travelSlabs, distRaw));
  const serviceRounded = Math.round(serviceAmount);
  const totalAmount = Math.round(serviceRounded + additionalCookAmount + extraHourAmount + travelCharge);
  if (!Number.isFinite(totalAmount) || totalAmount < 0 || totalAmount > MAX_PRICE * 10) {
    throw new Error("Could not calculate price");
  }
  return {
    serviceAmount: serviceRounded,
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
  validatePricingTable,
  validateTravelSlabs,
  MAX_PRICE,
  MAX_DISTANCE_KM,
  UNLIMITED_SLAB_MIN_KM,
};
