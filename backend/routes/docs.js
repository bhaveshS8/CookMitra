const express = require("express");
const path = require("path");
const fs = require("fs");
const { auth } = require("../middleware/auth");
const { signDocUrl, verifyDocToken } = require("../utils/docTokens");
const { resolveDocPath, ownerIdOf } = require("../utils/storage");

const router = express.Router();

// POST /api/docs/signed-url — mint a short-lived view token for ONE private
// document. Authenticated via Authorization header (never via URL), so the
// session credential never lands in history/logs. The token itself is
// single-purpose and expires in minutes.
router.post("/signed-url", auth, async (req, res, next) => {
  try {
    const docPath = String(req.body?.doc || req.body?.url || "").trim();
    if (!docPath.startsWith("/uploads/")) {
      return res.status(400).json({ message: "A valid /uploads document path is required" });
    }
    // Authorize FIRST, mint LAST: the live account + owner-or-admin check
    // runs before any token exists, so failures reveal nothing about token
    // mechanics and no token is ever minted for an unauthorized caller.
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

// GET /api/docs/view?docToken=... — verify + authorize + stream the file.
// No session JWT is accepted here (P0-2): only short-lived doc tokens.
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
    // Filename embeds the OWNER cook: <field>_<userId>_<ts>_... — owner or admin.
    // (Admin uploads are re-owned to the cook at upload time, so the segment
    // here is always the cook's user id — never the uploader's.)
    const base = path.basename(verified.doc);
    const ownerId = ownerIdOf(base);
    const isOwner = ownerId && ownerId.toLowerCase() === String(account._id).toLowerCase();
    const isAdmin = String(account.role).toUpperCase() === "ADMIN";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Not authorized for this action" });
    }
    // F-01 fix: resolve through the shared storage dir (uploads/cook-docs),
    // not uploads/ — the old path could never match a multer-written file.
    const filePath = resolveDocPath(base);
    if (!filePath) {
      return res.status(400).json({ message: "Invalid document path" });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "Document not found" });
    }
    // Private docs: no caching of the bytes under the signed URL.
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.sendFile(filePath);
  } catch {
    return res.status(401).json({ message: "Authentication required to view this document" });
  }
});

module.exports = router;
