const EventType = require("../models/EventType");

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
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "Event name is required" });
    }
    const type = await EventType.create({
      name: String(name).trim(),
      description: String(description || "").trim(),
      icon: String(icon || "").trim(),
      active: active !== false,
    });
    res.status(201).json(type);
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ message: "An event with this name already exists" });
    }
    next(error);
  }
};

exports.updateEventType = async (req, res, next) => {
  try {
    const type = await EventType.findById(req.params.id);
    if (!type) return res.status(404).json({ message: "Event not found" });
    const { name, description, icon, active } = req.body || {};
    if (name !== undefined) type.name = String(name).trim();
    if (description !== undefined) type.description = String(description || "");
    if (icon !== undefined) type.icon = String(icon || "");
    if (active !== undefined) type.active = active !== false && active !== "false";
    await type.save();
    res.json(type);
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ message: "An event with this name already exists" });
    }
    next(error);
  }
};

exports.deleteEventType = async (req, res, next) => {
  try {
    const type = await EventType.findById(req.params.id);
    if (!type) return res.status(404).json({ message: "Event not found" });
    await EventType.findByIdAndDelete(type._id);
    res.json({ message: "Event deleted", id: String(type._id) });
  } catch (error) {
    next(error);
  }
};
