const EventPricing = require("../models/EventPricing");
const {
  normalizePricing,
  getPricingSnapshot,
  calculateEventPrice,
  durationKeyForHours,
  validatePricingTable,
} = require("../utils/eventPricing");

// Public: current price table (booking flow + price preview).
exports.getPricing = async (req, res, next) => {
  try {
    const snapshot = await getPricingSnapshot();
    res.json({
      ...snapshot.table,
      durationKeys: EventPricing.DURATION_KEYS,
      services: EventPricing.SERVICE_KEYS,
      // Booking submissions echo this version back; a mismatch means the
      // table changed after the customer reviewed the quote.
      version: snapshot.version,
      updatedAt: snapshot.updatedAt,
    });
  } catch (error) {
    next(error);
  }
};


// Pricing quote (§19). Reads the admin-configured table — never trusts
// client-side totals.
exports.calculateQuote = async (req, res, next) => {
  try {
    const {
      serviceType,
      duration,
      distanceKm = 0,
      distance,
      additionalCook = 0,
      extraHours = 0,
    } = req.body || {};
    // One read supplies both the amounts and the version the client must
    // echo when creating the booking.
    const snapshot = await getPricingSnapshot();
    const quote = await calculateEventPrice({
      serviceType,
      duration,
      distanceKm: distanceKm ?? distance ?? 0,
      additionalCook,
      extraHours,
      pricingTable: snapshot.table,
    });
    res.json({
      ...quote,
      pricingVersion: snapshot.version,
      pricingUpdatedAt: snapshot.updatedAt,
    });
  } catch (error) {
    if (error && (error.statusCode === 503 || error.code === "PRICING_UNAVAILABLE")) {
      error.message = error.message || "Pricing is temporarily unavailable. Please try again.";
      return next(error);
    }
    return res.status(400).json({ message: error.message || "Could not calculate price" });
  }
};

// Strict admin number guard: require real JSON numbers (reject numeric
// strings, booleans, NaN, Infinity) within [0, MAX]. Frontend coerces via
// Number() before PUT, so legitimate saves always send numbers.
const MAX_PRICE = 10000000;
const requireAdminPrice = (v, label) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_PRICE) {
    const err = new Error(`Invalid price for ${label}`);
    err.statusCode = 400;
    throw err;
  }
  return Math.round(v);
};

// Admin: replace pricing pieces (§16 — hourly prices, additional-cook price,
// extra-hour prices, travel slabs). Partial updates allowed: unspecified
// fields are preserved via merge, then the ENTIRE resulting table is
// validated so a partial edit can never corrupt the config.
exports.updatePricing = async (req, res, next) => {
  try {
    const { servicePrices, additionalCookPrice, extraHourPrices, travelSlabs } = req.body || {};
    const hasUpdate =
      servicePrices !== undefined ||
      additionalCookPrice !== undefined ||
      extraHourPrices !== undefined ||
      travelSlabs !== undefined;
    let doc = await EventPricing.findOne({ key: "default" });
    // Empty payload is a no-op: return the current complete table without
    // writing (and without bumping __v, which would invalidate live quotes).
    if (!hasUpdate) {
      return res.json(normalizePricing(doc));
    }
    if (!doc) doc = new EventPricing({ key: "default" });

    if (servicePrices !== undefined) {
      if (typeof servicePrices !== "object" || servicePrices === null || Array.isArray(servicePrices)) {
        return res.status(400).json({ message: "servicePrices must be an object" });
      }
      // Reject unknown service keys (typos / injection) outright.
      for (const svc of Object.keys(servicePrices)) {
        if (!EventPricing.SERVICE_KEYS.includes(svc)) {
          return res.status(400).json({ message: `Unknown service: ${svc}` });
        }
        const inner = servicePrices[svc];
        if (typeof inner !== "object" || inner === null || Array.isArray(inner)) {
          return res.status(400).json({ message: `Invalid prices for ${svc}` });
        }
        for (const dk of Object.keys(inner)) {
          if (!EventPricing.DURATION_KEYS.includes(dk)) {
            return res.status(400).json({ message: `Unknown duration key: ${dk}` });
          }
        }
      }
      const nextPrices = {};
      for (const svc of EventPricing.SERVICE_KEYS) {
        if (servicePrices[svc] === undefined) continue;
        nextPrices[svc] = {};
        for (const dk of EventPricing.DURATION_KEYS) {
          if (servicePrices[svc]?.[dk] === undefined) continue;
          try {
            nextPrices[svc][dk] = requireAdminPrice(servicePrices[svc][dk], `${svc} / ${dk}`);
          } catch (e) {
            return res.status(400).json({ message: e.message });
          }
        }
      }
      // Merge into existing so partial updates keep other prices.
      const current = doc.servicePrices instanceof Map
        ? Object.fromEntries([...doc.servicePrices.entries()].map(([k, v]) => [k, v instanceof Map ? Object.fromEntries(v.entries()) : v]))
        : doc.servicePrices || {};
      const merged = { ...(current || {}) };
      for (const [svc, vals] of Object.entries(nextPrices)) {
        merged[svc] = { ...(merged[svc] || {}), ...vals };
      }
      doc.servicePrices = merged;
      doc.markModified("servicePrices");
    }

    if (additionalCookPrice !== undefined) {
      try {
        doc.additionalCookPrice = requireAdminPrice(additionalCookPrice, "additional cook");
      } catch (e) {
        return res.status(400).json({ message: "Invalid additional cook price" });
      }
    }

    if (extraHourPrices !== undefined) {
      if (typeof extraHourPrices !== "object" || extraHourPrices === null || Array.isArray(extraHourPrices)) {
        return res.status(400).json({ message: "extraHourPrices must be an object" });
      }
      for (const svc of Object.keys(extraHourPrices)) {
        if (!EventPricing.SERVICE_KEYS.includes(svc)) {
          return res.status(400).json({ message: `Unknown service: ${svc}` });
        }
      }
      const current = doc.extraHourPrices instanceof Map
        ? Object.fromEntries(doc.extraHourPrices.entries())
        : doc.extraHourPrices || {};
      const merged = { ...(current || {}) };
      for (const [svc, v] of Object.entries(extraHourPrices)) {
        try {
          merged[svc] = requireAdminPrice(v, `extra-hour ${svc}`);
        } catch (e) {
          return res.status(400).json({ message: `Invalid extra-hour price for ${svc}` });
        }
      }
      doc.extraHourPrices = merged;
      doc.markModified("extraHourPrices");
    }

    if (travelSlabs !== undefined) {
      if (!Array.isArray(travelSlabs) || travelSlabs.length === 0) {
        return res.status(400).json({ message: "travelSlabs must be a non-empty array" });
      }
      if (travelSlabs.length > 20) {
        return res.status(400).json({ message: "Too many travel slabs (max 20)" });
      }
      const slabs = [];
      for (let i = 0; i < travelSlabs.length; i++) {
        const s = travelSlabs[i] || {};
        // Strict: must be real numbers, not numeric strings.
        if (typeof s.maxKm !== "number" || typeof s.charge !== "number") {
          return res.status(400).json({ message: `Travel slab ${i} must use numeric maxKm and charge` });
        }
        if (!Number.isFinite(s.maxKm) || !Number.isFinite(s.charge) || s.charge < 0 || s.charge > MAX_PRICE) {
          return res.status(400).json({ message: "Each travel slab needs a finite maxKm and a non-negative charge" });
        }
        if (s.maxKm <= 0 || s.maxKm > Number.MAX_SAFE_INTEGER) {
          return res.status(400).json({ message: `Invalid maxKm in travel slab ${i}` });
        }
        slabs.push({ maxKm: s.maxKm, charge: Math.round(s.charge) });
      }
      slabs.sort((a, b) => a.maxKm - b.maxKm);
      // Strictly increasing (no duplicates / overlaps in effective lookup).
      for (let i = 1; i < slabs.length; i++) {
        if (slabs[i].maxKm <= slabs[i - 1].maxKm) {
          return res.status(400).json({ message: "Travel slabs must be strictly increasing by maxKm" });
        }
      }
      // Final slab must cover unlimited distance (frontend sends a large
      // sentinel for the "20+ km" row; seed uses MAX_SAFE_INTEGER).
      const last = slabs[slabs.length - 1];
      if (last.maxKm < 1000000) {
        return res.status(400).json({ message: "Final travel slab must cover unlimited distance (maxKm >= 1000000)" });
      }
      doc.travelSlabs = slabs;
    }

    // Validate and persist the ENTIRE resulting configuration (not just the
    // supplied fields) so a partial edit can never leave the app unconfigured.
    const full = normalizePricing(doc);
    try {
      validatePricingTable(full);
    } catch (e) {
      return res.status(400).json({ message: e.message || "Invalid pricing configuration" });
    }
    doc.servicePrices = full.servicePrices;
    doc.additionalCookPrice = full.additionalCookPrice;
    doc.extraHourPrices = full.extraHourPrices;
    doc.travelSlabs = full.travelSlabs;
    doc.markModified("servicePrices");
    doc.markModified("extraHourPrices");
    doc.updatedBy = req.user ? req.user.id : null;
    try {
      await doc.save();
    } catch (e) {
      // Concurrent admin edit: optimisticConcurrency threw VersionError.
      if (e && (e.name === "VersionError" || e.code === 11000)) {
        console.warn(`[event-pricing-409] pricing update conflicted — another admin saved first (retryable, reload and retry)`);
        return res.status(409).json({
          message: "Pricing was updated by another admin — please reload and retry.",
        });
      }
      throw e;
    }
    res.json(full);
  } catch (error) {
    if (error && error.name === "VersionError") {
      return res.status(409).json({ message: "Pricing was updated by another admin — please reload and retry." });
    }
    next(error);
  }
};

exports.durationKeyForHours = (req, res) => {
  const key = durationKeyForHours(req.query.hours);
  if (!key) return res.status(400).json({ message: "Hours must be between 1 and 8" });
  res.json({ hours: Number(req.query.hours), durationKey: key });
};
