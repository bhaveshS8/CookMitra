const jwt = require("jsonwebtoken");

const extractBearer = (req) => {
  const header = req.header("Authorization") || req.header("authorization") || "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token || null;
};

// httpOnly session cookie fallback (P0-3 migration). Parsed without new
// dependencies. Cookie name uses the __Host- prefix (Secure in prod,
// Path=/, no Domain, SameSite=Lax).
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
    // ignore — fall through to no-cookie
  }
  return null;
};

// CSRF defense-in-depth for cookie-authenticated mutations: a cross-site
// form/fetch cannot set a custom Origin/Referer, so require a same-origin
// Origin (or Referer) on state-changing requests that authenticated via
// cookie. Bearer-header requests are immune to cookie-CSRF by construction
// (custom headers need CORS preflight) and skip this check.
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
  // Same-origin app shell sends no Origin on same-origin POSTs from older
  // browsers only when neither header is present — fail closed instead.
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
    // Misconfigured server: never verify against an undefined secret.
    return res.status(500).json({ message: "Server auth is not configured" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Re-check the account on every authenticated request so admin
    // block/delete actions take effect immediately — even for tokens
    // issued before the account was blocked or removed.
    const User = require("../models/User");
    const account = await User.findById(decoded.id).select("role status tokenVersion");

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
    // Phase 10: a password reset bumps tokenVersion, invalidating every
    // session minted before it (the user simply signs in again). Version 0
    // accounts accept legacy tokens without a tv claim.
    if (
      Number(account.tokenVersion) > 0 &&
      decoded.tv !== Number(account.tokenVersion)
    ) {
      return res
        .status(401)
        .json({ message: "Session expired. Please log in again." });
    }

    // Keep the { id, role } shape controllers rely on, plus the live status.
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
    const account = await User.findById(decoded.id).select("role status tokenVersion");
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
