const mongoose = require("mongoose");

// COOKMITRA EVENTS (MVP §16) — admin-managed event catalogue
// (Birthday, Anniversary, Family Function, Home Celebration, Other).
const eventTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, "Event name is required"], trim: true, unique: true },
    description: { type: String, default: "", trim: true },
    icon: { type: String, default: "", trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EventType", eventTypeSchema);
