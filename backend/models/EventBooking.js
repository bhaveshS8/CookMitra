const mongoose = require("mongoose");

// COOKMITRA EVENTS (MVP §17) — event booking. The customer never selects a
// cook: Admin/CookMitra assigns a verified cook after the request is made.
//
// Status flow (§15):
//   pending → cook_assigned → confirmed → in_progress → completed
//   any live status → cancelled
const EVENT_BOOKING_STATUSES = [
  "pending",
  "cook_assigned",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
];

const EVENT_TYPES = [
  "Birthday",
  "Anniversary",
  "Family Function",
  "Home Celebration",
  "Other",
];

const EVENT_SERVICES = ["cooking_only", "preparation_cooking", "cooking_serving"];

const EVENT_FOOD_TYPES = [
  "Breakfast",
  "Lunch",
  "Dinner",
  "Snacks",
  "Full Meal",
  "Custom",
];

const eventBookingSchema = new mongoose.Schema(
  {
    bookingId: { type: String, unique: true, sparse: true, trim: true },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Assigned by Admin/CookMitra (§11). Null until assignment.
    cookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    eventType: {
      // Free-text label validated at creation against the admin-managed
      // EventType catalogue (active types only). The previous hardcoded enum
      // blocked newly created types and allowed deactivated ones; it is
      // intentionally removed. Historical bookings keep their original label
      // as a plain string, so renames/deletes never corrupt history.
      // No migration needed: existing values already match seeded names.
      type: String,
      required: [true, "Event type is required"],
      trim: true,
    },
    eventDate: {
      type: Date,
      required: [true, "Event date is required"],
    },
    startTime: {
      type: String,
      required: [true, "Start time is required"],
    },
    // Selected service duration in hours (maps to the hourly price table).
    duration: {
      type: Number,
      required: [true, "Duration is required"],
      min: [1, "Minimum 1 hour"],
      max: [12, "Maximum 12 hours"],
    },
    guestCount: {
      type: Number,
      required: [true, "Guest count is required"],
      min: [1, "At least 1 guest"],
      max: [1000, "Too many guests"],
    },
    address: { type: String, required: [true, "Address is required"], trim: true },
    area: { type: String, default: "", trim: true },
    landmark: { type: String, default: "", trim: true },
    // §4 — food type + free-text menu entered by the customer.
    foodType: {
      type: String,
      enum: EVENT_FOOD_TYPES,
      default: "Full Meal",
    },
    menu: { type: String, required: [true, "Menu requirement is required"], trim: true },
    serviceType: {
      type: String,
      enum: EVENT_SERVICES,
      required: [true, "Service type is required"],
    },
    additionalCook: { type: Number, default: 0, min: 0, max: 10 },
    extraHours: { type: Number, default: 0, min: 0, max: 12 },
    // One-way distance (km) used for the fixed travel-charge table (§8).
    // CUSTOMER-SUBMITTED ESTIMATE ONLY — never a verified measurement (no
    // trusted geocoding/routing integration exists). The travel charge derived
    // from it is PROVISIONAL until an admin verifies the distance (see
    // distanceVerified + PATCH /:id/verify-distance). Customers cannot bypass
    // verification by submitting 0: zero is still provisional.
    distanceKm: { type: Number, default: 0, min: 0 },
    distanceVerified: { type: Boolean, default: false },
    // Price snapshot (server-computed from the admin pricing table).
    serviceAmount: { type: Number, default: 0 },
    additionalCookAmount: { type: Number, default: 0 },
    extraHourAmount: { type: Number, default: 0 },
    travelCharge: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    bookingStatus: {
      type: String,
      enum: EVENT_BOOKING_STATUSES,
      default: "pending",
    },
    customerNotes: { type: String, default: "", trim: true },
    statusHistory: [
      {
        status: String,
        timestamp: { type: Date, default: Date.now },
        note: String,
      },
    ],
  },
  { timestamps: true, optimisticConcurrency: true }
);

eventBookingSchema.index({ customerId: 1, bookingStatus: 1 });
eventBookingSchema.index({ cookId: 1, bookingStatus: 1 });
eventBookingSchema.index({ eventDate: 1, bookingStatus: 1 });
eventBookingSchema.index({ bookingStatus: 1, createdAt: -1 });
eventBookingSchema.index({ cookId: 1, eventDate: 1, bookingStatus: 1 });

// Optimistic concurrency safety net: concurrent find-then-save paths throw
// VersionError instead of silently overwriting (set via schema option above).
// Controllers additionally use atomic conditional updates (status + __v
// filter) and map conflicts to 409.

const EventBooking = mongoose.model("EventBooking", eventBookingSchema);

EventBooking.EVENT_BOOKING_STATUSES = EVENT_BOOKING_STATUSES;
EventBooking.EVENT_TYPES = EVENT_TYPES;
EventBooking.EVENT_SERVICES = EVENT_SERVICES;
EventBooking.EVENT_FOOD_TYPES = EVENT_FOOD_TYPES;

module.exports = EventBooking;
