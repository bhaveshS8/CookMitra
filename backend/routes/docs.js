const express = require("express");
const path = require("path");
const fs = require("fs");
const { auth } = require("../middleware/auth");
const { signDocUrl, verifyDocToken } = require("../utils/docTokens");
const { resolveDocPath, ownerIdOf } = require("../utils/storage");

const router = express.Router();

router.post("/signed-url", auth, async (req, res, next) => {
  try {
    const docPath = String(req.body?.doc || req.body?.url || "").trim();
    if (!docPath.startsWith("/uploads/")) {
      return res.status(400).json({ message: "A valid /uploads document path is required" });
    }
    const User = require("../models/User");
    const account = await User.findById(req.user.id).select("role status tokenVersion");
    if (!account) return res.status(401).json({ message: "Account no longer exists. Please log in again." });
    if (account.status === "suspended") {
      return res.status(403).json({ message: "Your account has been blocked by an administrator. Please contact support." });
    }
    const base = path.basename(docPath);
    const ownerId = ownerIdOf(base);
    const isOwner = ownerId && ownerId.toLowerCase() === String(account._id).toLowerCase();
    const isAdmin = String(account.role).toUpperCase() === "ADMIN";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Not authorized for this action" });
    }
    let minted;
    try {
      minted = signDocUrl(docPath, req.user.id);
    } catch (err) {
      return res.status(400).json({ message: err.message || "Cannot sign this document" });
    }
    const viewUrl = `/api/docs/view?docToken=${encodeURIComponent(minted.token)}`;
    return res.json({ url: viewUrl, expiresAt: new Date(minted.exp).toISOString() });
  } catch (err) {
    return next(err);
  }
});

router.get("/view", async (req, res) => {
  try {
    const verified = verifyDocToken(String(req.query?.docToken || ""));
    if (!verified) {
      return res.status(401).json({ message: "This document link is invalid or has expired" });
    }
    const User = require("../models/User");
    const account = await User.findById(verified.uid).select("role status");
    if (!account) {
      return res.status(401).json({ message: "Account no longer exists. Please log in again." });
    }
    if (account.status === "suspended") {
      return res.status(403).json({ message: "Your account has been blocked by an administrator. Please contact support." });
    }
    const base = path.basename(verified.doc);
    const ownerId = ownerIdOf(base);
    const isOwner = ownerId && ownerId.toLowerCase() === String(account._id).toLowerCase();
    const isAdmin = String(account.role).toUpperCase() === "ADMIN";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Not authorized for this action" });
    }
    const filePath = resolveDocPath(base);
    if (!filePath) {
      return res.status(400).json({ message: "Invalid document path" });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "Document not found" });
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.sendFile(filePath);
  } catch {
    return res.status(401).json({ message: "Authentication required to view this document" });
  }
});

module.exports = router;
