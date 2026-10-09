if (!process.env.TZ) process.env.TZ = "Asia/Kolkata";
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

app.set("trust proxy", 1);

// ---- Security + throughput headers/payload hardening (1000-user ready) ----
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    "'self'",
    "'unsafe-inline'",
    "https://checkout.razorpay.com",
    "https://accounts.google.com",
    "https://apis.google.com",
  ],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
  imgSrc: ["'self'", "data:", "blob:", "https://*.googleusercontent.com", "https://cdn.razorpay.com"],
  connectSrc: [
    "'self'",
    "https://api.razorpay.com",
    "https://checkout.razorpay.com",
    "https://cdn.razorpay.com",
    "https://accounts.google.com",
  ],
  frameSrc: ["'self'", "https://checkout.razorpay.com", "https://api.razorpay.com"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
};
app.use(
  helmet({
    contentSecurityPolicy: { directives: cspDirectives },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  })
);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  next();
});
// security-critical, low-traffic buckets (auth, payments) use a MongoDB-backed
const limitOpts = { standardHeaders: false, legacyHeaders: false };
const generalLimiter = rateLimit({
  ...limitOpts,
  store: rateLimitStore("general"),
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_GENERAL || 300),
  skip: (req) => {
    // Meta's webhook verification is a single GET that must return 200
    // with the raw challenge — never rate-limit it (429 = "callback rejected").
    const url = req.originalUrl || req.url || "";
    if (req.method === "GET" && url.split("?")[0] === "/api/whatsapp/webhook") return true;
    return req.path === "/api/health" || req.path === "/api/ready";
  },
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
app.use(compression({ threshold: 1024 }));

{
  const { shared, memory } = describeRateLimitStores();
  console.log(
    `Rate limiting: shared (MongoDB-backed) buckets [${shared.join(", ") || "none"}] · in-memory buckets [${memory.join(", ")}]`
  );
}

// ---- Production config validation (fail closed on security-critical gaps) ----
if (process.env.NODE_ENV === "production") {
  const jwt = process.env.JWT_SECRET || "";
  if (
    !jwt ||
    /^your_/i.test(jwt) ||
    /change_?me|example/i.test(jwt) ||
    jwt.length < 32
  ) {
    console.error(
      "CONFIG ERROR: JWT_SECRET is missing, a placeholder, or too short (<32 chars). Refusing to start: every session token depends on this secret. Set a long random secret (e.g. `openssl rand -hex 32`) and restart."
    );
    process.exit(1);
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.warn(
      "CONFIG NOTICE: GOOGLE_CLIENT_ID is not set — email/password auth works, but Google sign-in will return 500 until configured."
    );
  }
  try {
    const { isConfigured, keyId } = require("./config/razorpay");
    if (!isConfigured) {
      console.warn(
        "CONFIG NOTICE: Razorpay keys missing/placeholder — POST /api/payments/order will return 503 until real RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are set."
      );
    } else if (String(keyId || "").startsWith("rzp_test_")) {
      // traffic would fail at checkout. Loud prod warning (not a boot
      console.warn(
        "CONFIG WARNING: RAZORPAY_KEY_ID is a TEST key while NODE_ENV=production — live checkout requires rzp_live_ keys. Set live keys or expect payment failures."
      );
    }
  } catch {
  }
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    console.warn(
      "CONFIG NOTICE: RAZORPAY_WEBHOOK_SECRET is not set — POST /api/payments/webhook cannot verify signatures (browser payments still work, webhook reconcile is skipped)."
    );
  }
  if (process.env.REQUIRE_PAYMENTS === "true") {
    let paymentsReady = false;
    try {
      paymentsReady =
        require("./config/razorpay").isConfigured && Boolean(process.env.RAZORPAY_WEBHOOK_SECRET);
    } catch {
      paymentsReady = false;
    }
    if (!paymentsReady) {
      console.error(
        "CONFIG ERROR: REQUIRE_PAYMENTS=true but live Razorpay keys and/or RAZORPAY_WEBHOOK_SECRET are missing. Refusing to start."
      );
      process.exit(1);
    }
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.warn(
      "CONFIG NOTICE: SMTP_HOST/SMTP_USER are not set — password-reset emails cannot be delivered (users get a generic message and no link arrives). Set SMTP_HOST/PORT/USER/PASS/FROM to enable."
    );
    if (process.env.REQUIRE_SMTP === "true") {
      console.error(
        "CONFIG ERROR: REQUIRE_SMTP=true but SMTP_HOST/SMTP_USER are missing. Refusing to start."
      );
      process.exit(1);
    }
  }
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_NUMBER_ID) {
    console.warn(
      "CONFIG NOTICE: WHATSAPP_TOKEN/WHATSAPP_PHONE_NUMBER_ID are not set — automatic WhatsApp notifications are disabled (in-app notifications + wa.me share links still work). See docs/WHATSAPP_SETUP.md to enable."
    );
  }
}

connectDB();

const { ensurePayoutIndexes } = require("./utils/payoutIndexes");
ensurePayoutIndexes({ connection: mongoose.connection });

// Durable WhatsApp dispatch worker (in-process; atomic job claims make it
// safe with any number of instances/cluster workers). Recovers pending jobs
// left by previous processes. Disabled in tests and when
// WHATSAPP_DISPATCH_WORKER=false (API-only instances still persist jobs).
if (process.env.NODE_ENV !== "test" && String(process.env.WHATSAPP_DISPATCH_WORKER || "").toLowerCase() !== "false") {
  try {
    require("./services/bookingDispatchJobs").startWorker();
  } catch (err) {
    console.error("Dispatch worker failed to start (bookings unaffected):", err?.message || err);
  }
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception — exiting so the process manager restarts clean:", err);
  try {
    mongoose.connection.close(false);
  } catch {
  } finally {
    process.exit(1);
  }
});

const parseOrigins = (v) =>
  (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const corsOrigins = parseOrigins(process.env.CLIENT_URL);
const isProduction = process.env.NODE_ENV === "production";
app.use(
  cors({
    origin:
      !isProduction && corsOrigins.length === 0
        ? true
        : corsOrigins.length > 0
          ? corsOrigins
          : false,
    credentials: true,
  })
);
app.use("/api/payments/webhook", express.raw({ type: "application/json", limit: "100kb" }));
app.use("/api/whatsapp/webhook", express.raw({ type: "application/json", limit: "100kb" }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
const crypto = require("crypto");
let requestCounter = 0;
app.use((req, res, next) => {
  try {
    const incoming = String(req.header("x-request-id") || "").trim().slice(0, 64);
    const id =
      /^[A-Za-z0-9_-]{8,64}$/.test(incoming)
        ? incoming
        : `${Date.now().toString(36)}-${(requestCounter = (requestCounter + 1) % 1e6).toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    req.id = id;
    res.setHeader("X-Request-Id", id);
  } catch {
  }
  next();
});
morgan.token("scrubbed-url", (req) => {
  const url = req.originalUrl || req.url || "";
  return url.replace(/([?&]docToken=)[^&\s]*/g, "$1[REDACTED]");
});
morgan.token("req-id", (req) => req.id || "-");
app.use(
  morgan(isProduction ? ':remote-addr - :remote-user [:date[clf]] ":method :scrubbed-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" req=:req-id' : "dev", {
    skip: (req) => (req.path === "/api/health" || req.path === "/api/ready") && isProduction,
  })
);

const uploadAccess = async (req, res, next) => {
  try {
    const base = path.basename(req.path || "");
    if (/^photo_/i.test(base)) return next();
    if (req.query && String(req.query.token || "").trim()) {
      return res.status(401).json({
        message: "Document links using session tokens are no longer supported. Please refresh to get a secure view link.",
        code: "DOC_TOKEN_DEPRECATED",
      });
    }
    const header = req.header("Authorization") || req.header("authorization") || "";
    const headerToken = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const token = headerToken;
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
    const account = await User.findById(decoded.id).select("role status tokenVersion").lean();
    if (!account) {
      return res.status(401).json({ message: "Account no longer exists. Please log in again." });
    }
    if (account.status === "suspended") {
      return res.status(403).json({
        message: "Your account has been blocked by an administrator. Please contact support.",
      });
    }
    if (Number(account.tokenVersion) > 0 && decoded.tv !== Number(account.tokenVersion)) {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }
    const { ownerIdOf } = require("./utils/storage");
    const ownerId = ownerIdOf(base);
    const isOwner = ownerId && ownerId.toLowerCase() === String(account._id).toLowerCase();
    if (String(account.role).toUpperCase() !== "ADMIN" && !isOwner) {
      return res.status(403).json({ message: "Not authorized for this action" });
    }
    return next();
  } catch {
    return res.status(401).json({ message: "Authentication required to view this document" });
  }
};
const { uploadDir } = require("./utils/storage");
app.use("/uploads", uploadAccess, express.static(path.dirname(uploadDir)));

app.use("/api/auth", authLimiter, require("./routes/auth"));
app.use("/api/docs", require("./routes/docs"));
app.use("/api/cooks", require("./routes/cooks"));
app.use("/api/bookings", require("./routes/bookings"));
app.use("/api/payments", strictLimiter, require("./routes/payments"));
app.use("/api/availability", require("./routes/availability"));
app.use("/api/reviews", require("./routes/reviews"));
app.use("/api/complaints", require("./routes/complaints"));
app.use("/api/notifications", require("./routes/notifications"));
app.get("/api/realtime/stream", require("./utils/realtime").sseHandler);
app.use("/api/whatsapp", require("./routes/whatsapp"));
app.use("/api/leads", require("./routes/leads"));
app.use("/api/coupons", require("./routes/coupons"));
app.use("/api/analytics", require("./routes/analytics"));
app.use("/api/payouts", strictLimiter, require("./routes/payouts"));
app.use("/api/cook", require("./routes/cookEarnings"));
app.use("/api/admin/cook-incentives", require("./routes/adminCookEarnings"));
app.use("/api/admin/cook-payouts", require("./routes/adminCookEarnings"));
app.use("/api/stats/public/visit", visitLimiter);
app.use("/api/stats/public", require("./routes/stats"));

app.set("rateLimiters", { generalLimiter, authLimiter, strictLimiter, visitLimiter });

app.get("/api/health", (req, res) => {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  res.json({
    status: "ok",
    db: states[mongoose.connection.readyState] ?? "unknown",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/ready", (req, res) => {
  if (mongoose.connection.readyState === 1) {
    return res.json({ ready: true, timestamp: new Date().toISOString() });
  }
  return res.status(503).json({ ready: false, db: "disconnected" });
});

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

app.use("/api", (req, res) => {
  res.status(404).json({ message: "API route not found" });
});

app.use(errorHandler);

const PORT = process.env.PORT || 5000;
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

const shutdown = (signal) => {
  console.log(`Received ${signal} — closing server gracefully...`);
  try {
    require("./services/bookingDispatchJobs").stopWorker();
  } catch {
  }
  server.close(() => {
    mongoose.connection.close(false).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGUSR2", () => shutdown("SIGUSR2"));
