const Lead = require("../models/Lead");

const normalizeWhatsapp = (input) => {
  const digits = String(input || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
};

exports.createLead = async (req, res, next) => {
  try {
    const { name, location } = req.body;
    const whatsapp = normalizeWhatsapp(req.body.whatsapp);

    if (!/^[6-9]\d{9}$/.test(whatsapp)) {
      return res.status(400).json({
        message: "Enter a valid 10-digit Indian WhatsApp number",
      });
    }

    const recentDuplicate = await Lead.findOne({
      whatsapp,
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    if (recentDuplicate) {
      return res.status(409).json({
        message: "This WhatsApp number was already registered recently. We will contact you soon!",
      });
    }

    // Missing fields must not coerce to the literal "undefined" string.
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ message: "Name is required" });
    }
    if (typeof location !== "string" || !location.trim()) {
      return res.status(400).json({ message: "Location is required" });
    }
    const leadData = {
      name: name.trim(),
      whatsapp,
      location: location.trim(),
    };
    const { lat, lng } = req.body.coords || {};
    const numLat = Number(lat);
    const numLng = Number(lng);
    if (
      lat != null && lng != null &&
      Number.isFinite(numLat) && Number.isFinite(numLng) &&
      numLat >= -90 && numLat <= 90 && numLng >= -180 && numLng <= 180
    ) {
      leadData.coords = { lat: numLat, lng: numLng };
    }

    const lead = await Lead.create(leadData);

    res.status(201).json({ message: "Registered successfully!", lead });
  } catch (error) {
    next(error);
  }
};

exports.getLeads = async (req, res, next) => {
  try {
    const { paginationParams, applyPagination, sendList } = require("../utils/pagination");
    const pg = paginationParams(req);
    const leads = await applyPagination(Lead.find().sort({ createdAt: -1 }), pg);
    return sendList(res, leads, pg, () => Lead.countDocuments());
  } catch (error) {
    next(error);
  }
};

exports.updateLeadStatus = async (req, res, next) => {
  try {
    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true, runValidators: true }
    );
    if (!lead) {
      return res.status(404).json({ message: "Enquiry not found" });
    }
    res.json(lead);
  } catch (error) {
    next(error);
  }
};

exports.deleteLead = async (req, res, next) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: "Enquiry not found" });
    }
    res.json({ message: "Enquiry deleted" });
  } catch (error) {
    next(error);
  }
};
