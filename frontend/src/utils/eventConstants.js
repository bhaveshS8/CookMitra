// COOKMITRA EVENTS — shared frontend constants (MVP doc §1–§9).
// Prices shown here are PREVIEW ONLY from the launch tables; the server
// recomputes every quote from the admin pricing table (POST
// /event-pricing/calculate) and the booking endpoint never trusts these.

import { formatCurrency } from "./constants";

export { formatCurrency };

export const EVENT_TYPE_FALLBACK = [
  { _id: "Birthday", name: "Birthday", description: "Birthday celebrations at home", icon: "cake" },
  { _id: "Anniversary", name: "Anniversary", description: "Anniversary dinners and parties", icon: "heart" },
  { _id: "Family Function", name: "Family Function", description: "Family get-togethers and functions", icon: "users" },
  { _id: "Home Celebration", name: "Home Celebration", description: "Festivals and home celebrations", icon: "sparkles" },
  { _id: "Other", name: "Other", description: "Any other home event", icon: "calendar" },
];

export const EVENT_SERVICES = [
  {
    id: "cooking_only",
    label: "Cooking Only",
    desc: "Cooking of food at your location",
  },
  {
    id: "preparation_cooking",
    label: "Preparation + Cooking",
    desc: "Basic preparation + cooking",
  },
  {
    id: "cooking_serving",
    label: "Cooking + Serving",
    desc: "Preparation + cooking + basic serving",
  },
];

export const EVENT_FOOD_TYPES = [
  "Breakfast",
  "Lunch",
  "Dinner",
  "Snacks",
  "Full Meal",
];

export const EVENT_SERVICE_LABEL = (id) =>
  (EVENT_SERVICES.find((s) => s.id === id) || {}).label || String(id || "").replace(/_/g, " ");

// Display label for an event booking's occasion. When the customer picked
// "Other" and typed a custom name, that name is shown instead of "Other".
export const eventTypeLabel = (booking) => {
  if (!booking) return "";
  const custom = typeof booking === "string" ? "" : String(booking.customEventType || "").trim();
  const base = typeof booking === "string" ? booking : booking.eventType;
  const name = (base || "").trim();
  if (name.toLowerCase() === "other" && custom) return custom;
  return name || "Event";
};

// Launch price tables (§6/§7/§8) — preview fallback when /event-pricing is
// unreachable. Keys mirror the backend duration buckets.
export const EVENT_LAUNCH_PRICES = {
  cooking_only: { upto2: 499, slot_2_3: 699, slot_3_4: 899, slot_4_5: 1099, slot_5_6: 1299, slot_6_7: 1499, slot_7_8: 1699 },
  preparation_cooking: { upto2: 799, slot_2_3: 999, slot_3_4: 1299, slot_4_5: 1599, slot_5_6: 1899, slot_6_7: 2199, slot_7_8: 2499 },
  cooking_serving: { upto2: 999, slot_2_3: 1299, slot_3_4: 1599, slot_4_5: 1999, slot_5_6: 2399, slot_6_7: 2799, slot_7_8: 3199 },
};

export const EVENT_ADDITIONAL_COOK_PRICE = 400;
export const EVENT_EXTRA_HOUR_PRICES = {
  cooking_only: 200,
  preparation_cooking: 250,
  cooking_serving: 300,
};
export const EVENT_TRAVEL_SLABS = [
  { maxKm: 3, charge: 0 },
  { maxKm: 5, charge: 50 },
  { maxKm: 8, charge: 100 },
  { maxKm: 10, charge: 150 },
  { maxKm: 15, charge: 250 },
  { maxKm: 20, charge: 350 },
  { maxKm: Infinity, charge: 450 },
];

// Lower-bound-inclusive buckets (matches backend — see §9 worked example:
// 4h Prep+Cooking = ₹1,599).
export const eventDurationKey = (hours) => {
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

// Distance is decimal km - keep one dot and at most maxDecimals places.
export const sanitizeDecimalInput = (value, maxDecimals = 2) => {
  const cleaned = String(value ?? "").replace(/,/g, "").replace(/[^0-9.]/g, "");
  if (!cleaned) return "";
  const dot = cleaned.indexOf(".");
  const whole = (dot === -1 ? cleaned : cleaned.slice(0, dot)).replace(/^0+(?=\d)/, "");
  if (dot === -1) return whole;
  const fraction = cleaned.slice(dot + 1).replace(/\./g, "").slice(0, maxDecimals);
  return `${whole || "0"}.${fraction}`;
};

// Customer-facing travel copy derived from the admin-editable slab table.
export const eventTravelSlabHint = (slabs) => {
  const list = (Array.isArray(slabs) && slabs.length > 0 ? slabs : EVENT_TRAVEL_SLABS)
    .map((s) => ({ maxKm: Number(s.maxKm), charge: Number(s.charge) || 0 }))
    .filter((s) => (s.maxKm === Infinity || Number.isFinite(s.maxKm)) && s.maxKm > 0)
    .sort((a, b) => a.maxKm - b.maxKm);
  let lower = 0;
  return list
    .map((s, i) => {
      const from = lower;
      lower = s.maxKm;
      const range =
        i === list.length - 1 && s.maxKm > 1000000
          ? `${from}+ km`
          : from === 0
            ? `0-${s.maxKm} km`
            : `${from}-${s.maxKm} km`;
      return `${range} ${s.charge === 0 ? "FREE" : formatCurrency(s.charge)}`;
    })
    .join(" · ");
};

export const eventTravelCharge = (slabs, distanceKm) => {
  const dist = Math.max(0, Number(distanceKm) || 0);
  const list = (Array.isArray(slabs) && slabs.length > 0 ? slabs : EVENT_TRAVEL_SLABS)
    .map((s) => ({ maxKm: Number(s.maxKm), charge: Number(s.charge) || 0 }))
    .sort((a, b) => a.maxKm - b.maxKm);
  for (const s of list) {
    if (dist <= s.maxKm) return s.charge;
  }
  return list.length > 0 ? list[list.length - 1].charge : 0;
};

// Client-side preview: service + additional cooks + extra hours + travel.
// The server recomputes the authoritative total at quote/booking time.
export const previewEventPrice = (pricing, { serviceType, duration, distanceKm = 0, additionalCook = 0, extraHours = 0 }) => {
  const table = pricing || {};
  const servicePrices = table.servicePrices || EVENT_LAUNCH_PRICES;
  const extraHourPrices = table.extraHourPrices || EVENT_EXTRA_HOUR_PRICES;
  const travelSlabs = table.travelSlabs || EVENT_TRAVEL_SLABS;
  const addCookPrice = Number(table.additionalCookPrice ?? EVENT_ADDITIONAL_COOK_PRICE);
  const key = eventDurationKey(duration);
  if (!key) return null;
  const serviceAmount = Number(servicePrices?.[serviceType]?.[key]);
  if (!Number.isFinite(serviceAmount)) return null;
  const additionalCookAmount = Math.max(0, Math.floor(Number(additionalCook) || 0)) * addCookPrice;
  const extraHourAmount = Math.max(0, Number(extraHours) || 0) * Number(extraHourPrices?.[serviceType] || 0);
  const travelCharge = eventTravelCharge(travelSlabs, distanceKm);
  return {
    serviceAmount,
    additionalCookAmount,
    extraHourAmount,
    travelCharge,
    totalAmount: Math.round(serviceAmount + additionalCookAmount + extraHourAmount + travelCharge),
    durationKey: key,
  };
};

export const EVENT_STATUS_LABELS = {
  pending: "Pending",
  cook_assigned: "Cook Assigned",
  confirmed: "Confirmed",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const eventStatusLabel = (s) =>
  EVENT_STATUS_LABELS[s] || String(s || "").replace(/_/g, " ");

export const EVENT_STATUS_FLOW = ["pending", "cook_assigned", "confirmed", "in_progress", "completed"];

// Shared badge tones so customer, cook and admin surfaces stay consistent.
export const EVENT_STATUS_TONES = {
  pending: "amber",
  cook_assigned: "blue",
  confirmed: "emerald",
  in_progress: "purple",
  completed: "emerald",
  cancelled: "rose",
};

export const eventStatusTone = (s) => EVENT_STATUS_TONES[s] || "slate";

export const EVENT_REFUND_LABELS = {
  pending: "Refund requested",
  processing: "Refund processing",
  processed: "Refund processed",
  failed: "Refund needs attention",
  manual: "Refund settled manually",
  rejected: "Refund declined",
};

// Payment badge metadata derived ONLY from the saved booking/payment record.
// It never infers a successful payment from event status alone.
export const eventPaymentMeta = (booking) => {
  const payment = booking?.payment || {};
  const refund = String(payment.refundStatus || "");
  if (refund && refund !== "none") {
    return {
      label: EVENT_REFUND_LABELS[refund] || "Refund status updated",
      tone: ["failed", "rejected"].includes(refund) ? "rose" : ["processed", "manual"].includes(refund) ? "emerald" : "amber",
      isRefund: true,
    };
  }
  if (payment.status === "paid") return { label: "Paid", tone: "emerald" };
  if (payment.status === "failed") return { label: "Payment failed", tone: "rose" };
  if (booking?.bookingStatus === "cancelled") return { label: "No payment recorded", tone: "slate" };
  if (booking?.bookingStatus === "pending") return { label: "Payment not open", tone: "slate" };
  if (!booking?.cookId) return { label: "Payment not open", tone: "slate" };
  if (booking?.bookingStatus === "cook_assigned" && booking?.distanceVerified !== true) {
    return { label: "Awaiting distance verification", tone: "slate" };
  }
  if (["confirmed", "in_progress", "completed"].includes(booking?.bookingStatus)) {
    return { label: "No payment recorded", tone: "slate" };
  }
  if (payment.status === "pending") return { label: "Payment pending", tone: "amber" };
  return { label: "Payment not started", tone: "slate" };
};

// Admin action eligibility. The backend also rejects terminal/paid bookings;
// this keeps every admin surface from offering a verification that cannot land.
export const canVerifyEventDistance = (booking) =>
  Boolean(booking?.cookId) &&
  booking?.distanceVerified !== true &&
  !["completed", "cancelled"].includes(booking?.bookingStatus) &&
  booking?.payment?.status !== "paid";

export const PAYMENT_AMOUNT_LABEL = (booking) => {
  const payment = booking?.payment || {};
  if (payment.status === "paid") {
    return Number(payment.paidAmount) > 0
      ? `Paid ${formatCurrency(payment.paidAmount)}`
      : "Paid";
  }
  return "";
};
