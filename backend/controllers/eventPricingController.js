const EventPricing = require("../models/EventPricing");
const {
  getPricingTable,
  calculateEventPrice,
  durationKeyForHours,
} = require("../utils/eventPricing");

// Public: current price table (booking flow + price preview).
exports.getPricing = async (req, res, next) => {
  try {
    const table = await getPricingTable();
    res.json({ ...table, durationKeys: EventPricing.DURATION_KEYS, services: EventPricing.SERVICE_KEYS });
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
    const quote = await calculateEventPrice({
      serviceType,
      duration,
      distanceKm: distanceKm ?? distance ?? 0,
      additionalCook,
      extraHours,
    });
    res.json(quote);
  } catch (error) {
    return res.status(400).json({ message: error.message || "Could not calculate price" });
  }
};

// Admin: replace pricing pieces (§16 — hourly prices, additional-cook price,
// extra-hour prices, travel slabs). Partial updates allowed.
exports.updatePricing = async (req, res, next) => {
  try {
    const { servicePrices, additionalCookPrice, extraHourPrices, travelSlabs } = req.body || {};
    let doc = await EventPricing.findOne({ key: "default" });
    if (!doc) doc = new EventPricing({ key: "default" });

    if (servicePrices !== undefined) {
      if (typeof servicePrices !== "object" || Array.isArray(servicePrices)) {
        return res.status(400).json({ message: "servicePrices must be an object" });
      }
      const nextPrices = {};
      for (const svc of EventPricing.SERVICE_KEYS) {
        if (servicePrices[svc] === undefined) continue;
        nextPrices[svc] = {};
        for (const dk of EventPricing.DURATION_KEYS) {
          const v = Number(servicePrices[svc]?.[dk]);
          if (servicePrices[svc]?.[dk] !== undefined && (!Number.isFinite(v) || v < 0)) {
            return res.status(400).json({ message: `Invalid price for ${svc} / ${dk}` });
          }
          if (servicePrices[svc]?.[dk] !== undefined) nextPrices[svc][dk] = Math.round(v);
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
      const v = Number(additionalCookPrice);
      if (!Number.isFinite(v) || v < 0) {
        return res.status(400).json({ message: "Invalid additional cook price" });
      }
      doc.additionalCookPrice = Math.round(v);
    }

    if (extraHourPrices !== undefined) {
      if (typeof extraHourPrices !== "object" || Array.isArray(extraHourPrices)) {
        return res.status(400).json({ message: "extraHourPrices must be an object" });
      }
      const current = doc.extraHourPrices instanceof Map
        ? Object.fromEntries(doc.extraHourPrices.entries())
        : doc.extraHourPrices || {};
      const merged = { ...(current || {}) };
      for (const [svc, v] of Object.entries(extraHourPrices)) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({ message: `Invalid extra-hour price for ${svc}` });
        }
        merged[svc] = Math.round(n);
      }
      doc.extraHourPrices = merged;
      doc.markModified("extraHourPrices");
    }

    if (travelSlabs !== undefined) {
      if (!Array.isArray(travelSlabs) || travelSlabs.length === 0) {
        return res.status(400).json({ message: "travelSlabs must be a non-empty array" });
      }
      const slabs = travelSlabs.map((s) => ({
        maxKm: Number(s.maxKm),
        charge: Math.round(Number(s.charge)),
      }));
      if (slabs.some((s) => !Number.isFinite(s.maxKm) || !Number.isFinite(s.charge) || s.charge < 0)) {
        return res.status(400).json({ message: "Each travel slab needs a maxKm and a non-negative charge" });
      }
      slabs.sort((a, b) => a.maxKm - b.maxKm);
      doc.travelSlabs = slabs;
    }

    doc.updatedBy = req.user ? req.user.id : null;
    await doc.save();
    const table = await getPricingTable();
    res.json(table);
  } catch (error) {
    next(error);
  }
};

exports.durationKeyForHours = (req, res) => {
  const key = durationKeyForHours(req.query.hours);
  if (!key) return res.status(400).json({ message: "Hours must be between 1 and 8" });
  res.json({ hours: Number(req.query.hours), durationKey: key });
};
