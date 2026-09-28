const jwt = require("jsonwebtoken");

const extractBearer = (req) => {
  const header = req.header("Authorization") || req.header("authorization") || "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token || null;
};

const auth = async (req, res, next) => {
  const token = extractBearer(req);

  if (!token) {
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  if (!process.env.JWT_SECRET) {
    // Misconfigured server: never verify against an undefined secret.
    return res.status(500).json({ message: "Server auth is not configured" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Re-check the account on every authenticated request so admin
    // block/delete actions take effect immediately — even for tokens
    // issued before the account was blocked or removed.
    const User = require("../models/User");
    const account = await User.findById(decoded.id).select("role status");

    if (!account) {
      return res
        .status(401)
        .json({ message: "Account no longer exists. Please log in again." });
    }
    if (account.status === "suspended") {
      return res.status(403).json({
        message:
          "Your account has been blocked by an administrator. Please contact support.",
      });
    }

    // Keep the { id, role } shape controllers rely on, plus the live status.
    req.user = { id: account._id.toString(), role: account.role, status: account.status };
    next();
  } catch (error) {
    res.status(401).json({ message: "Token is not valid" });
  }
};

const optionalAuth = async (req, res, next) => {
  const token = extractBearer(req);

  if (!token) {
    return next();
  }

  if (!process.env.JWT_SECRET) {
    // Cannot verify offline — stay anonymous rather than trusting raw payload.
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Same live-account check as `auth`: a suspended/deleted account's stale
    // token must not keep its role (e.g. a blocked admin still seeing the
    // unfiltered cook list). On any failure (DB down, deleted, suspended),
    // continue as anonymous with NO role carried over.
    const User = require("../models/User");
    const account = await User.findById(decoded.id).select("role status");
    if (!account || account.status === "suspended") {
      return next();
    }
    req.user = {
      id: account._id.toString(),
      role: account.role,
      status: account.status,
    };
  } catch (error) {
    // Invalid token on public route: continue as anonymous
  }
  next();
};

const authorize = (...roles) => {
  // Case-insensitive so legacy authorize("admin") calls keep working with
  // the spec's UPPERCASE stored roles (ADMIN/CUSTOMER/COOK).
  const wanted = roles.map((r) => String(r).toUpperCase());
  return (req, res, next) => {
    // req.user is always set by auth() in route chains, but guard anyway so a
    // miswired route fails closed with 403 instead of crashing with a 500.
    if (!req.user || !wanted.includes(String(req.user.role).toUpperCase())) {
      return res.status(403).json({ message: "Not authorized for this action" });
    }
    next();
  };
};

module.exports = { auth, authorize, optionalAuth };
