const jwt = require("jsonwebtoken");

const extractBearer = (req) => {
  const header = req.header("Authorization") || req.header("authorization") || "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token || null;
};

const SESSION_COOKIE = "__Host-cm_session";
const extractCookieToken = (req) => {
  try {
    const raw = req.header("cookie") || req.header("Cookie") || "";
    if (!raw) return null;
    for (const part of String(raw).split(";")) {
      const idx = part.indexOf("=");
      if (idx < 0) continue;
      const k = part.slice(0, idx).trim();
      if (k === SESSION_COOKIE) {
        const v = decodeURIComponent(part.slice(idx + 1).trim());
        if (v) return { token: v, viaCookie: true };
      }
    }
  } catch {
  }
  return null;
};

const assertSameOriginForCookieAuth = (req, res) => {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const origin = req.header("origin") || "";
  const referer = req.header("referer") || req.header("referrer") || "";
  const host = req.header("x-forwarded-host") || req.header("host") || "";
  const proto = req.header("x-forwarded-proto") || req.protocol || "http";
  const expectedOrigin = host ? `${proto}://${host}` : "";
  const sameOrigin = (v) => {
    if (!v) return false;
    try {
      const u = new URL(v);
      const e = new URL(expectedOrigin);
      return u.protocol === e.protocol && u.host === e.host;
    } catch {
      return false;
    }
  };
  if (origin ? sameOrigin(origin) : sameOrigin(referer)) return true;
  res.status(403).json({ message: "Cross-origin request refused" });
  return false;
};

const extractToken = (req) => {
  const bearer = extractBearer(req);
  if (bearer) return { token: bearer, viaCookie: false };
  return extractCookieToken(req);
};

const auth = async (req, res, next) => {
  const found = extractToken(req);
  const token = found?.token || null;

  if (!token) {
    return res.status(401).json({ message: "No token, authorization denied" });
  }

  if (found?.viaCookie && !assertSameOriginForCookieAuth(req, res)) return;

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ message: "Server auth is not configured" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const User = require("../models/User");
    const account = await User.findById(decoded.id).select("role status tokenVersion").lean();

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
    if (
      Number(account.tokenVersion) > 0 &&
      decoded.tv !== Number(account.tokenVersion)
    ) {
      return res
        .status(401)
        .json({ message: "Session expired. Please log in again." });
    }

    req.user = { id: account._id.toString(), role: account.role, status: account.status };
    next();
  } catch (error) {
    res.status(401).json({ message: "Token is not valid" });
  }
};

const optionalAuth = async (req, res, next) => {
  const found = extractToken(req);
  const token = found?.token || null;

  if (!token) {
    return next();
  }

  if (!process.env.JWT_SECRET) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const User = require("../models/User");
    const account = await User.findById(decoded.id).select("role status tokenVersion").lean();
    if (!account || account.status === "suspended") {
      return next();
    }
    if (
      Number(account.tokenVersion) > 0 &&
      decoded.tv !== Number(account.tokenVersion)
    ) {
      return next();
    }
    req.user = {
      id: account._id.toString(),
      role: account.role,
      status: account.status,
    };
  } catch (error) {
  }
  next();
};

const authorize = (...roles) => {
  const wanted = roles.map((r) => String(r).toUpperCase());
  return (req, res, next) => {
    if (!req.user || !wanted.includes(String(req.user.role).toUpperCase())) {
      return res.status(403).json({ message: "Not authorized for this action" });
    }
    next();
  };
};

module.exports = { auth, authorize, optionalAuth };
