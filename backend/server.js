const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const dotenv = require("dotenv");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const connectDB = require("./config/db");
const errorHandler = require("./middleware/errorHandler");
const { rateLimitStore, describeRateLimitStores } = require("./utils/rateLimitStore");

dotenv.config();

const app = express();

// Behind reverse proxies (Render/Railway/Nginx/Heroku) so req.protocol/secure
// reflect the real client connection for HTTPS cookie/redirect logic.
app.set("trust proxy", 1);

// ---- Security + throughput headers/payload hardening (1000-user ready) ----
// helmet: safe defaults (HSTS, noSniff, frameguard, XSS filter).
// crossOriginResourcePolicy "cross-origin" keeps /uploads images + API
// usable when the frontend is hosted on a different origin (CLIENT_URL).
// contentSecurityPolicy is OFF: the app serves inline CRA scripts/styles and
// Razorpay/GA third-party scripts that a strict CSP would break.
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
// compression: gzip JSON/API + static frontend (threshold 1kb).
app.use(compression({ threshold: 1024 }));

// Rate limits. Counters live in memory per bucket by default; the
// security-critical, low-traffic buckets (auth, payments) use a MongoDB-backed
// store so the limits stay exact with 2+ replicas — no Redis, no new service.
// See utils/rateLimitStore.js. A store outage degrades to in-memory limits
// instead of 500-ing every request.
// Login/reset/visit stay generous enough for real bursts but blunt brute force
// and accidental poll storms. Standard + legacy headers off to save bytes.
const limitOpts = { standardHeaders: false, legacyHeaders: false };
const generalLimiter = rateLimit({
  ...limitOpts,
  store: rateLimitStore("general"),
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_GENERAL || 300),
  // Health checks must never be throttled: load balancers / uptime monitors
  // poll this path from a single IP and would otherwise exhaust the bucket
  // (and get a 429 instead of the DB status they need).
  skip: (req) => req.path === "/api/health",
  message: { message: "Too many requests — please slow down and retry." },
});
const authLimiter = rateLimit({
  ...limitOpts,
  store: rateLimitStore("auth"),
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AUTH || 100),
  message: { message: "Too many attempts — please try again later." },
});
const strictLimiter = rateLimit({
  ...limitOpts,
  store: rateLimitStore("strict"),
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_STRICT || 30),
  message: { message: "Too many attempts — please try again later." },
});
const visitLimiter = rateLimit({
  ...limitOpts,
  store: rateLimitStore("visit"),
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_VISIT || 120),
  message: { message: "Too many requests — please slow down and retry." },
});
app.use("/api/", generalLimiter);

// One line of operational truth at boot: with 2+ replicas, any bucket left
// in-memory has its effective limit multiplied by the replica count.
{
  const { shared, memory } = describeRateLimitStores();
  console.log(
    `Rate limiting: shared (MongoDB-backed) buckets [${shared.join(", ") || "none"}] · in-memory buckets [${memory.join(", ")}]`
  );
}

// ---- Production config validation (warn loudly, never crash) ----
if (process.env.NODE_ENV === "production") {
  const jwt = process.env.JWT_SECRET || "";
  if (
    !jwt ||
    /^your_/i.test(jwt) ||
    /change_?me|example/i.test(jwt) ||
    jwt.length < 32
  ) {
    console.error(
      "CONFIG WARNING: JWT_SECRET is missing, a placeholder, or too short (<32 chars). Set a long random secret (e.g. `openssl rand -hex 32`) or all logins will be insecure/unstable."
    );
  }
  if (process.env.ALLOW_TEST_PAYMENTS === "true") {
    console.error(
      "CONFIG WARNING: ALLOW_TEST_PAYMENTS=true is set while NODE_ENV=production. Test-mode checkout is now force-disabled in code, but unset this var to remove confusion."
    );
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.warn(
      "CONFIG NOTICE: GOOGLE_CLIENT_ID is not set — email/password auth works, but Google sign-in will return 500 until configured."
    );
  }
  try {
    // Reuse the same placeholder detection as the payments route.
    const { isConfigured } = require("./config/razorpay");
    if (!isConfigured) {
      console.warn(
        "CONFIG NOTICE: Razorpay keys missing/placeholder — POST /api/payments/order will return 503 until real RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are set."
      );
    }
  } catch {
    // non-fatal: payments route reports its own status
  }
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.warn(
      "CONFIG NOTICE: RAZORPAY_WEBHOOK_SECRET is not set — POST /api/payments/webhook cannot verify signatures (browser payments still work, webhook reconcile is skipped)."
    );
  }
}

// Background retry loop — never throws, never exits. The API stays up
// (health reports db status) even while MongoDB is unreachable.
connectDB();

// A single stray async error must not kill the whole server. Log loudly,
// keep serving.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server kept alive):", err);
});

// CORS: allow the deployed frontend origin (CLIENT_URL, comma-separated for
// multiple environments). In production the app is same-origin, so CORS only
// matters for separately hosted frontends.
const parseOrigins = (v) =>
  (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const corsOrigins = parseOrigins(process.env.CLIENT_URL);
const isProduction = process.env.NODE_ENV === "production";
app.use(
  cors({
    // In production with no CLIENT_URL set, default to same-origin only
    // (no cross-origin headers at all). In dev, allow everything.
    origin:
      !isProduction && corsOrigins.length === 0
        ? true
        : corsOrigins.length > 0
          ? corsOrigins
          : false,
    credentials: true,
  })
);
// Razorpay webhooks need the RAW request body for HMAC verification — mount
// before express.json() (body-parser skips bodies that are already parsed,
// so the JSON parser below leaves webhook requests untouched).
app.use("/api/payments/webhook", express.raw({ type: "application/json", limit: "100kb" }));
// Bounded JSON bodies: a 10MB default lets one client burn memory per request.
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(
  morgan(isProduction ? "combined" : "dev", {
    // Keep health-check noise out of production logs.
    skip: (req) => req.path === "/api/health" && isProduction,
  })
);

// Uploaded cook verification documents (Aadhaar / PAN / photo).
// Identity docs are private: public profile photos (photo_*) stay open, but
// aadhar_*/pan_* need the owning cook or an admin. Browsers fetch these via
// plain <img>/<a>/<iframe> (no auth headers), so a ?token= query is accepted
// alongside the Authorization header — the frontend appends it automatically.
const uploadAccess = async (req, res, next) => {
  try {
    const base = path.basename(req.path || "");
    if (/^photo_/i.test(base)) return next();
    const header = req.header("Authorization") || req.header("authorization") || "";
    const headerToken = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const token = (req.query && String(req.query.token || "").trim()) || headerToken;
    if (!token || !process.env.JWT_SECRET) {
      return res.status(401).json({ message: "Authentication required to view this document" });
    }
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Token is not valid" });
    }
    const User = require("./models/User");
    const account = await User.findById(decoded.id).select("role status");
    if (!account) {
      return res.status(401).json({ message: "Account no longer exists. Please log in again." });
    }
    if (account.status === "suspended") {
      return res.status(403).json({
        message: "Your account has been blocked by an administrator. Please contact support.",
      });
    }
    // Filenames embed the uploader: <field>_<userId>_<ts>_... — the owner or
    // an admin may view; everyone else is refused.
    const ownerId = String(base).split("_")[1] || "";
    const isOwner = ownerId && ownerId.toLowerCase() === String(account._id).toLowerCase();
    if (String(account.role).toUpperCase() !== "ADMIN" && !isOwner) {
      return res.status(403).json({ message: "Not authorized for this action" });
    }
    return next();
  } catch {
    return res.status(401).json({ message: "Authentication required to view this document" });
  }
};
app.use("/uploads", uploadAccess, express.static(path.join(__dirname, "uploads")));

app.use("/api/auth", authLimiter, require("./routes/auth"));
app.use("/api/cooks", require("./routes/cooks"));
app.use("/api/bookings", require("./routes/bookings"));
// COOKMITRA EVENTS (MVP): event catalogue, event bookings (admin-assigned
// cooks), and the admin-editable event pricing engine.
app.use("/api/events", require("./routes/events"));
app.use("/api/event-bookings", require("./routes/eventBookings"));
app.use("/api/event-pricing", require("./routes/eventPricing"));
app.use("/api/payments", strictLimiter, require("./routes/payments"));
app.use("/api/availability", require("./routes/availability"));
app.use("/api/reviews", require("./routes/reviews"));
app.use("/api/complaints", require("./routes/complaints"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/leads", require("./routes/leads"));
app.use("/api/coupons", require("./routes/coupons"));
app.use("/api/analytics", require("./routes/analytics"));
// Visit pings fire once per browser session — own lighter bucket so a traffic
// spike can't eat the general budget (or vice versa).
app.use("/api/stats/public/visit", visitLimiter);
app.use("/api/stats/public", require("./routes/stats"));

// Export limiters for route-level use (e.g. stricter OTP verify).
app.set("rateLimiters", { generalLimiter, authLimiter, strictLimiter, visitLimiter });

app.get("/api/health", (req, res) => {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  res.json({
    status: "ok",
    db: states[mongoose.connection.readyState] ?? "unknown",
    timestamp: new Date().toISOString(),
  });
});

// ---- Static frontend (single-service deployment) ----
// When a production build exists (frontend/build copied in, or built in a
// monorepo image), serve it from this process and fall back to index.html for
// client-side routes. API + /uploads routes above always win.
const frontendBuild = path.join(__dirname, "..", "frontend", "build");
if (fs.existsSync(path.join(frontendBuild, "index.html"))) {
  app.use(express.static(frontendBuild, { maxAge: "1y", index: false }));
  app.get("*", (req, res, next) => {
    if (/^\/(api|uploads)(\/|$)/.test(req.path)) {
      return next();
    }
    res.sendFile(path.join(frontendBuild, "index.html"));
  });
  console.log("Serving frontend build from", frontendBuild);
}

// Unknown API routes answer JSON (not Express's default HTML 404), matching
// the API error shape. Placed after the frontend fallback above, which passes
// /api + /uploads through via next().
app.use("/api", (req, res) => {
  res.status(404).json({ message: "API route not found" });
});

app.use(errorHandler);

const PORT = process.env.PORT || 5000;
// A previous instance (or a nodemon restart race) can still hold the port
// for a moment. Retry instead of dying instantly — instant exit(1) here is
// what made the backend look like it "closes automatically".
const MAX_LISTEN_RETRIES = Number(process.env.PORT_RETRY_ATTEMPTS || 10);
const LISTEN_RETRY_MS = Number(process.env.PORT_RETRY_MS || 1000);
let listenRetries = 0;

const server = app.listen(PORT, () => {
  listenRetries = 0;
  console.log(`Server running on port ${PORT}`);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && listenRetries < MAX_LISTEN_RETRIES) {
    listenRetries += 1;
    console.warn(
      `Port ${PORT} busy (old instance still shutting down?) — retrying in ${LISTEN_RETRY_MS / 1000}s ` +
        `(attempt ${listenRetries}/${MAX_LISTEN_RETRIES})...`
    );
    setTimeout(() => server.listen(PORT), LISTEN_RETRY_MS);
    return;
  }
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is still in use after ${MAX_LISTEN_RETRIES} retries — another "node server.js" is probably still running. ` +
        `Run only ONE backend (npm run dev OR npm start, not both), or stop the other first (taskkill /F /IM node.exe).`
    );
    process.exit(1);
    return;
  }
  console.error("Server error:", err);
});

// Graceful shutdown — close the listener (frees the port immediately for the
// next instance) and the DB connection instead of dying mid-request.
const shutdown = (signal) => {
  console.log(`Received ${signal} — closing server gracefully...`);
  server.close(() => {
    mongoose.connection.close(false).finally(() => process.exit(0));
  });
  // Force-exit if keep-alive sockets hang the graceful close.
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGUSR2", () => shutdown("SIGUSR2"));
