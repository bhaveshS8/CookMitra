const mongoose = require("mongoose");
const EventType = require("../models/EventType");

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Case-insensitive exact-match lookup (handles "birthday" vs "Birthday" and
// surrounding whitespace). The unique index is case-sensitive, so this
// pre-check is the duplicate guard; the 11000 catch below is the race backstop.
const findByNameCI = (name, excludeId = null) => {
  const q = { name: { $regex: `^${escapeRegExp(String(name).trim())}$`, $options: "i" } };
  if (excludeId) q._id = { $ne: excludeId };
  return EventType.findOne(q);
};

// Public catalogue — active types for the booking flow, all types for admin.
exports.listEventTypes = async (req, res, next) => {
  try {
    const admin =
      req.user && String(req.user.role).toUpperCase() === "ADMIN";
    const filter = admin && req.query.all === "1" ? {} : { active: true };
    const types = await EventType.find(filter).sort({ name: 1 });
    res.json(types);
  } catch (error) {
    next(error);
  }
};

exports.createEventType = async (req, res, next) => {
  try {
    const { name, description = "", icon = "", active = true } = req.body || {};
    const trimmed = String(name || "").trim();
    if (!trimmed) {
      return res.status(400).json({ message: "Event name is required" });
    }
    if (trimmed.length > 100) {
      return res.status(400).json({ message: "Event name is too long (max 100 characters)" });
    }
    if (String(description || "").length > 500) {
      return res.status(400).json({ message: "Description is too long (max 500 characters)" });
    }
    const dup = await findByNameCI(trimmed);
    if (dup) {
      return res.status(409).json({ message: "An event with this name already exists" });
    }
    const type = await EventType.create({
      name: trimmed,
      description: String(description || "").trim().slice(0, 500),
      icon: String(icon || "").trim().slice(0, 50),
      active: active !== false,
    });
    res.status(201).json(type);
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ message: "An event with this name already exists" });
    }
    if (error && error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    next(error);
  }
};

exports.updateEventType = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Event not found" });
    }
    const type = await EventType.findById(req.params.id);
    if (!type) return res.status(404).json({ message: "Event not found" });
    const { name, description, icon, active } = req.body || {};
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return res.status(400).json({ message: "Event name cannot be empty" });
      if (trimmed.length > 100) {
        return res.status(400).json({ message: "Event name is too long (max 100 characters)" });
      }
      const dup = await findByNameCI(trimmed, type._id);
      if (dup) {
        return res.status(409).json({ message: "An event with this name already exists" });
      }
      type.name = trimmed;
    }
    if (description !== undefined) {
      if (String(description).length > 500) {
        return res.status(400).json({ message: "Description is too long (max 500 characters)" });
      }
      type.description = String(description || "").trim();
    }
    if (icon !== undefined) type.icon = String(icon || "").trim().slice(0, 50);
    if (active !== undefined) type.active = active !== false && active !== "false";
    await type.save();
    res.json(type);
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ message: "An event with this name already exists" });
    }
    if (error && error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    next(error);
  }
};

exports.deleteEventType = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Event not found" });
    }
    const type = await EventType.findById(req.params.id);
    if (!type) return res.status(404).json({ message: "Event not found" });
    // Historical bookings store the event label as a plain string, so delete
    // never corrupts history — existing bookings keep their original label.
    await EventType.findByIdAndDelete(type._id);
    res.json({ message: "Event deleted", id: String(type._id) });
  } catch (error) {
    next(error);
  }
};
