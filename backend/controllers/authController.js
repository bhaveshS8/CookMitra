const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const findByEmailInsensitive = (email) =>
  User.findOne({ email }, null, { collation: { locale: "en", strength: 2 } });

const toUserPayload = (user) => {
  if (!user) return user;
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    mobile: user.mobile || user.phone,
    address: user.address,
    role: user.role,
    status: user.status,
    avatar: user.avatar,
    authProvider: user.authProvider,
    loginMethod: user.authProvider || "local",
    preferredLanguage: user.preferredLanguage || "",
    emailVerified: user.authProvider === "google" || user.authProvider === "local+google" ? true : Boolean(user.emailVerified),
    phoneVerified: Boolean(user.phoneVerified),
    memberSince: user.createdAt || null,
    createdAt: user.createdAt || null,
    savedAddresses: Array.isArray(user.savedAddresses) ? user.savedAddresses : [],
  };
};

const sanitizeAddressInput = (body) => {
  const out = {};
  if (body.label !== undefined) out.label = String(body.label || "").trim();
  if (body.customLabel !== undefined) out.customLabel = String(body.customLabel || "").trim().slice(0, 40);
  if (body.flatNo !== undefined) out.flatNo = String(body.flatNo || "").trim().slice(0, 120);
  if (body.society !== undefined) out.society = String(body.society || "").trim().slice(0, 160);
  if (body.landmark !== undefined) out.landmark = String(body.landmark || "").trim().slice(0, 160);
  if (body.city !== undefined) out.city = String(body.city || "").trim().slice(0, 80);
  if (body.lat !== undefined && body.lat !== "" && body.lat !== null) {
    const lat = Number(body.lat);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw Object.assign(new Error("Invalid latitude"), { statusCode: 400 });
    out.lat = lat;
  }
  if (body.lng !== undefined && body.lng !== "" && body.lng !== null) {
    const lng = Number(body.lng);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw Object.assign(new Error("Invalid longitude"), { statusCode: 400 });
    out.lng = lng;
  }
  if (body.isDefault !== undefined) out.isDefault = body.isDefault === true || body.isDefault === "true";
  return out;
};

const validateAddressComplete = (a, isNew = true) => {
  const labels = (require("../models/User").ADDRESS_LABELS || ["Home", "Office", "Parents' Home", "Other"]);
  if (isNew && !a.label) return "Address label is required";
  if (a.label !== undefined && !labels.includes(a.label)) return "Address label must be Home, Office, Parents' Home or Other";
  if (isNew && !a.flatNo) return "Flat/house number is required";
  if (a.flatNo !== undefined && !String(a.flatNo).trim()) return "Flat/house number is required";
  if (isNew && !a.society) return "Society/building is required";
  if (a.society !== undefined && !String(a.society).trim()) return "Society/building is required";
  if (isNew && !a.city) return "City is required";
  if (a.city !== undefined && !String(a.city).trim()) return "City is required";
  return null;
};

const normalizeRole = (v) => {
  const up = String(v || "").trim().toUpperCase();
  return ["CUSTOMER", "COOK", "ADMIN"].includes(up) ? up : "CUSTOMER";
};

const generateToken = (user, persistent = true) => {
  const isAdmin = String(user?.role || "").toUpperCase() === "ADMIN";
  return jwt.sign(
    { id: user._id, role: user.role, tv: Number(user.tokenVersion) || 0 },
    process.env.JWT_SECRET,
    { expiresIn: isAdmin ? "12h" : persistent === false ? "1d" : "30d" }
  );
};

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFailures = new Map(); // email -> { fails, windowStart, lockedUntil }
const loginLocked = (email) => {
  const rec = loginFailures.get(email);
  if (!rec) return 0;
  const now = Date.now();
  if (rec.lockedUntil && now < rec.lockedUntil) {
    return rec.lockedUntil - now;
  }
  if (now - rec.windowStart > LOGIN_WINDOW_MS) {
    loginFailures.delete(email);
    return 0;
  }
  return 0;
};
const recordLoginFail = (email) => {
  const now = Date.now();
  let rec = loginFailures.get(email);
  if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) {
    rec = { fails: 0, windowStart: now, lockedUntil: 0 };
  }
  rec.fails += 1;
  if (rec.fails >= LOGIN_MAX_FAILS) {
    rec.lockedUntil = now + LOGIN_LOCK_MS;
  }
  loginFailures.set(email, rec);
  if (loginFailures.size > 5000) {
    const oldest = loginFailures.keys().next().value;
    loginFailures.delete(oldest);
  }
  return rec.lockedUntil && now < rec.lockedUntil;
};
const clearLoginFails = (email) => {
  loginFailures.delete(email);
};

const SESSION_COOKIE = "__Host-cm_session";
const setSessionCookie = (res, token, persistent = true, maxAgeSec = null) => {
  try {
    const isProd = process.env.NODE_ENV === "production";
    const maxAge = maxAgeSec ?? (persistent === false ? 1 : 30) * 24 * 60 * 60;
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      "Path=/",
      `Max-Age=${maxAge}`,
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (isProd) parts.push("Secure");
    const existing = res.getHeader("Set-Cookie");
    if (existing) {
      res.setHeader("Set-Cookie", [...(Array.isArray(existing) ? existing : [existing]), parts.join("; ")]);
    } else {
      res.setHeader("Set-Cookie", parts.join("; "));
    }
  } catch {
  }
};
const clearSessionCookie = (res) => {
  try {
    const isProd = process.env.NODE_ENV === "production";
    const parts = [`${SESSION_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
    if (isProd) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  } catch {
  }
};

const sendWelcomeNotification = async (user) => {
  try {
    const Notification = require("../models/Notification");
    const name = String(user?.name || "").trim().split(" ")[0] || "there";
    const isCook = String(user?.role).toUpperCase() === "COOK";
    await Notification.create({
      user: user._id,
      type: "general",
      message: isCook
        ? `Welcome to Cook Mitra, ${name}! Your cook account is ready — complete your cook profile to start receiving bookings.`
        : `Welcome to Cook Mitra, ${name}! Your account is ready — explore verified cooks and book your first service.`,
    });
  } catch {
  }
};

const normalizeMobileCore = (v) => {
  let digits = String(v || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
};

exports.register = async (req, res, next) => {
  try {
    const { password } = req.body;
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!name || name.length < 2 || name.length > 80) {
      return res.status(400).json({ message: "Name must be 2–80 characters" });
    }
    if (!email) {
      return res.status(400).json({ message: "Enter a valid email address" });
    }
    if (!password || String(password).length < 8 || String(password).length > 128) {
      return res.status(400).json({ message: "Password must be 8–128 characters" });
    }
    let role = normalizeRole(req.body.role || "CUSTOMER");
    if (!["CUSTOMER", "COOK"].includes(role)) role = "CUSTOMER";

    const existingUser = await findByEmailInsensitive(email);
    if (existingUser) {
      return res.status(400).json({
        message: "Email already exists, please enter another email",
        code: "EMAIL_EXISTS",
        field: "email",
        errors: [{ path: "email", param: "email", msg: "Email already exists, please enter another email" }],
      });
    }

    let user;
    try {
      const rawPhone = req.body.phone || req.body.mobile;
      const core = normalizeMobileCore(rawPhone);
      const tenDigit = /^[6-9]\d{9}$/.test(core) ? core : String(rawPhone || "").trim();
      user = await User.create({
        name,
        email,
        phone: tenDigit,
        mobile: tenDigit,
        password,
        role,
      });
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(400).json({
          message: "Email already exists, please enter another email",
          code: "EMAIL_EXISTS",
          field: "email",
          errors: [{ path: "email", param: "email", msg: "Email already exists, please enter another email" }],
        });
      }
      throw error;
    }
    const token = generateToken(user, true);

    await sendWelcomeNotification(user);

    setSessionCookie(res, token, true);
    res.status(201).json({
      token,
      user: toUserPayload(user),
      expiresIn: "30d",
    });
  } catch (error) {
    next(error);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { password } = req.body;
    const persistent = req.body.rememberMe !== false && req.body.rememberMe !== "false";
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: "Enter a valid email address" });
    }
    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }
    const lockedMs = loginLocked(email);
    if (lockedMs > 0) {
      return res.status(429).json({
        message: "Too many failed sign-in attempts — please try again in a few minutes.",
      });
    }

    const user = await User.findOne({ email }).select("+password");
    if (!user) {
      recordLoginFail(email);
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (!user.password && user.googleId) {
      return res.status(401).json({
        message: "This account uses Google sign-in. Please continue with Google.",
      });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      if (recordLoginFail(email)) {
        return res.status(429).json({
          message: "Too many failed sign-in attempts — please try again in a few minutes.",
        });
      }
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (user.status === "suspended") {
      return res.status(403).json({
        message:
          "Your account has been blocked by an administrator. Please contact support.",
      });
    }
    clearLoginFails(email);

    const token = generateToken(user, persistent);
    const me = toUserPayload(user);
    const isAdminSession = String(user.role || "").toUpperCase() === "ADMIN";
    setSessionCookie(res, token, persistent, isAdminSession ? 12 * 60 * 60 : null);
    res.json({ token, user: me, expiresIn: isAdminSession ? "12h" : persistent ? "30d" : "1d" });
  } catch (error) {
    next(error);
  }
};

exports.googleAuth = async (req, res, next) => {
  try {
    const { idToken, role } = req.body;
    if (!idToken) {
      return res.status(400).json({ message: "Google ID token is required" });
    }
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({
        message: "Google sign-in is not configured on the server (GOOGLE_CLIENT_ID missing)",
      });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (err) {
      return res.status(401).json({ message: "Invalid Google token. Please try again." });
    }

    const googleId = payload?.sub;
    const email = payload?.email?.toLowerCase?.();
    const emailVerified = payload?.email_verified;
    const name = payload?.name || email?.split("@")[0] || "Google User";
    const avatar = payload?.picture;

    if (!googleId || !email) {
      return res.status(401).json({ message: "Google account did not return an email" });
    }
    if (emailVerified !== true) {
      return res.status(401).json({ message: "Google email is not verified" });
    }

    let user = await User.findOne({ googleId });
    let isNewGoogleUser = false;
    if (!user) {
      user = await findByEmailInsensitive(email);
      if (user) {
        if (user.status === "suspended") {
          return res.status(403).json({
            message:
              "Your account has been blocked by an administrator. Please contact support.",
          });
        }
        user.googleId = user.googleId || googleId;
        if (avatar && !user.avatar) user.avatar = avatar;
        user.authProvider = user.password ? "local+google" : "google";
        await user.save();
      } else {
        const safeRole = normalizeRole(role) === "COOK" ? "COOK" : "CUSTOMER";
        user = await User.create({
          name: String(name).slice(0, 80),
          email,
          googleId,
          avatar,
          authProvider: "google",
          role: safeRole,
        });
        isNewGoogleUser = true;
      }
    } else if (user.status === "suspended") {
      return res.status(403).json({
        message:
          "Your account has been blocked by an administrator. Please contact support.",
      });
    } else {
      let changed = false;
      if (avatar && user.avatar !== avatar) {
        user.avatar = avatar;
        changed = true;
      }
      if (name && user.name !== name && !user.name) {
        user.name = name;
        changed = true;
      }
      if (changed) await user.save();
    }

    if (isNewGoogleUser) {
      await sendWelcomeNotification(user);
    }

    const token = generateToken(user);
    const isAdminSession = String(user.role || "").toUpperCase() === "ADMIN";
    setSessionCookie(res, token, true, isAdminSession ? 12 * 60 * 60 : null);
    res.json({ token, user: toUserPayload(user), expiresIn: isAdminSession ? "12h" : "30d" });
  } catch (error) {
    next(error);
  }
};

const forgotAttempts = new Map();
const forgotAllowed = (key) => {
  const now = Date.now();
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX = 10;
  const hits = (forgotAttempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX) return false;
  hits.push(now);
  forgotAttempts.set(key, hits);
  if (forgotAttempts.size > 5000) {
    for (const [k, v] of forgotAttempts) {
      if (!v.length || now - v[v.length - 1] >= WINDOW_MS) forgotAttempts.delete(k);
      if (forgotAttempts.size <= 4000) break;
    }
  }
  return true;
};

exports.forgotPassword = async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: "Valid email is required" });
    }
    const key = `${email}|${req.ip || ""}`;
    if (!forgotAllowed(key)) {
      return res.status(429).json({
        message: "Too many reset requests — please try again in 15 minutes.",
      });
    }
    const generic = {
      message:
        "If an account exists for this email, a password-reset link is on its way (valid 1 hour).",
    };
    const user = await User.findOne({ email });
    if (!user || user.status === "suspended") {
      return res.json(generic);
    }
    const token = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = crypto.createHash("sha256").update(token).digest("hex");
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
    try {
      await user.save();
    } catch {
      return res.json(generic);
    }
    const { sendResetEmail } = require("../utils/mailer");
    try {
      const result = await sendResetEmail({ to: user.email, name: user.name, token });
      if (result?.delivered) return res.json(generic);
    } catch {
    }
    if (process.env.NODE_ENV === "production" || process.env.ALLOW_DEV_TOKENS !== "true") {
      if (process.env.NODE_ENV === "production") {
        console.error(
          "Password-reset token minted but no email delivery is configured — set SMTP_* (and install nodemailer) to email reset links."
        );
      }
      return res.json(generic);
    }
    return res.json({ ...generic, resetToken: token, devOnly: true });
  } catch (error) {
    next(error);
  }
};

exports.resetPassword = async (req, res, next) => {
  try {
    const token = String(req.body.token || "").trim();
    const password = String(req.body.password || "");
    if (!token) {
      return res.status(400).json({ message: "Reset token is required" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      resetPasswordToken: hash,
      resetPasswordExpires: { $gt: new Date() },
    }).select("+password");
    if (!user) {
      return res.status(400).json({ message: "This reset link is invalid or has expired." });
    }
    if (user.status === "suspended") {
      return res.status(403).json({
        message: "Your account has been blocked by an administrator. Please contact support.",
      });
    }
    user.password = password; // pre-save hook hashes it
    user.resetPasswordToken = "";
    user.resetPasswordExpires = null;
    user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
    if (user.googleId) user.authProvider = "local+google";
    else user.authProvider = "local";
    await user.save();
    res.json({ message: "Password has been reset — please sign in with your new password." });
  } catch (error) {
    next(error);
  }
};

exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(toUserPayload(user));
  } catch (error) {
    next(error);
  }
};

const UPCOMING_STATUSES = ["requested", "accepted", "confirmed", "in_progress"];

exports.getMyStats = async (req, res, next) => {
  try {
    const Booking = require("../models/Booking");
    const Review = require("../models/Review");
    const customerId = req.user.id;
    const [upcoming, completed, total, reviewsGiven] = await Promise.all([
      Booking.countDocuments({ customer: customerId, status: { $in: UPCOMING_STATUSES } }),
      Booking.countDocuments({ customer: customerId, status: "completed" }),
      Booking.countDocuments({ customer: customerId }),
      Review.countDocuments({ customer: customerId }),
    ]);
    res.json({ upcomingBookings: upcoming, completedBookings: completed, totalBookings: total, reviewsGiven });
  } catch (error) {
    next(error);
  }
};

exports.changePassword = async (req, res, next) => {
  try {
    const currentPassword = String(req.body.currentPassword || req.body.current_password || req.body.oldPassword || "");
    const newPassword = String(req.body.newPassword || req.body.new_password || req.body.password || "");
    if (!currentPassword) return res.status(400).json({ message: "Current password is required" });
    if (!newPassword || newPassword.length < 8 || newPassword.length > 128) {
      return res.status(400).json({ message: "New password must be 8–128 characters" });
    }
    const user = await User.findById(req.user.id).select("+password googleId authProvider tokenVersion");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.password && user.googleId) {
      return res.status(400).json({ message: "This account uses Google sign-in. Please set a password via password reset." });
    }
    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(401).json({ message: "Current password is incorrect" });
    if (currentPassword === newPassword) {
      return res.status(400).json({ message: "New password must be different from the current password" });
    }
    user.password = newPassword;
    user.tokenVersion = (Number(user.tokenVersion) || 0) + 1;
    if (user.googleId) user.authProvider = "local+google";
    else user.authProvider = "local";
    await user.save();
    const token = generateToken(user, true);
    setSessionCookie(res, token, true);
    res.json({ message: "Password changed successfully. Please use your new password next time.", token });
  } catch (error) {
    next(error);
  }
};

exports.getMyAddresses = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select("savedAddresses");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user.savedAddresses || []);
  } catch (error) {
    next(error);
  }
};

exports.addMyAddress = async (req, res, next) => {
  try {
    let patch;
    try {
      patch = sanitizeAddressInput(req.body);
    } catch (e) {
      return res.status(e.statusCode || 400).json({ message: e.message });
    }
    const errMsg = validateAddressComplete(patch, true);
    if (errMsg) return res.status(400).json({ message: errMsg });
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    if ((user.savedAddresses || []).length >= 10) {
      return res.status(400).json({ message: "You can save up to 10 addresses" });
    }
    if (patch.isDefault || (user.savedAddresses || []).length === 0) {
      (user.savedAddresses || []).forEach((a) => { a.isDefault = false; });
      patch.isDefault = true;
    }
    user.savedAddresses.push(patch);
    await user.save();
    res.status(201).json(user.savedAddresses[user.savedAddresses.length - 1]);
  } catch (error) {
    if (error?.name === "ValidationError") {
      return res.status(400).json({ message: Object.values(error.errors || {})[0]?.message || "Invalid address" });
    }
    next(error);
  }
};

exports.updateMyAddress = async (req, res, next) => {
  try {
    let patch;
    try {
      patch = sanitizeAddressInput(req.body);
    } catch (e) {
      return res.status(e.statusCode || 400).json({ message: e.message });
    }
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const addr = (user.savedAddresses || []).id(req.params.addressId);
    if (!addr) return res.status(404).json({ message: "Address not found" });
    const merged = { label: addr.label, flatNo: addr.flatNo, society: addr.society, city: addr.city, ...patch };
    const errMsg = validateAddressComplete(merged, true);
    if (errMsg) return res.status(400).json({ message: errMsg });
    Object.entries(patch).forEach(([k, v]) => { addr[k] = v; });
    if (patch.isDefault === true) {
      user.savedAddresses.forEach((a) => {
        if (String(a._id) !== String(addr._id)) a.isDefault = false;
      });
      addr.isDefault = true;
    }
    await user.save();
    res.json(addr);
  } catch (error) {
    if (error?.name === "ValidationError") {
      return res.status(400).json({ message: Object.values(error.errors || {})[0]?.message || "Invalid address" });
    }
    next(error);
  }
};

exports.deleteMyAddress = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const addr = (user.savedAddresses || []).id(req.params.addressId);
    if (!addr) return res.status(404).json({ message: "Address not found" });
    const wasDefault = Boolean(addr.isDefault);
    addr.deleteOne();
    if (wasDefault && user.savedAddresses.length > 0) {
      user.savedAddresses[0].isDefault = true;
    }
    await user.save();
    res.json({ message: "Address deleted" });
  } catch (error) {
    next(error);
  }
};

exports.setDefaultMyAddress = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const addr = (user.savedAddresses || []).id(req.params.addressId);
    if (!addr) return res.status(404).json({ message: "Address not found" });
    user.savedAddresses.forEach((a) => { a.isDefault = String(a._id) === String(addr._id); });
    await user.save();
    res.json(addr);
  } catch (error) {
    next(error);
  }
};

exports.logout = async (req, res) => {
  clearSessionCookie(res);
  res.json({ message: "Signed out" });
};

exports.updateProfile = async (req, res, next) => {
  try {
    const FORBIDDEN = ["role", "status", "tokenVersion", "password", "googleId", "resetPasswordToken", "resetPasswordExpires", "emailVerified", "phoneVerified", "authProvider", "savedAddresses"];
    for (const k of FORBIDDEN) {
      if (req.body[k] !== undefined) {
        return res.status(403).json({ message: `Field '${k}' cannot be updated here` });
      }
    }
    const { name, phone, mobile, address } = req.body;
    const phoneRaw = phone || mobile;
    let phoneVal;
    if (phoneRaw !== undefined) {
      const core = normalizeMobileCore(phoneRaw);
      if (!/^[6-9]\d{9}$/.test(core)) {
        return res.status(400).json({ message: "Enter a valid 10-digit mobile number" });
      }
      phoneVal = core;
    }
    let emailVal;
    if (req.body.email !== undefined) {
      const email = String(req.body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ message: "Enter a valid email address" });
      }
      const clash = await findByEmailInsensitive(email);
      if (clash && String(clash._id) !== String(req.user.id)) {
        return res.status(400).json({ message: "A user with this email already exists" });
      }
      emailVal = email;
    }
    let nameVal;
    if (name !== undefined) {
      const n = String(name || "").trim().replace(/\s+/g, " ");
      if (!n || n.length < 2 || n.length > 80) {
        return res.status(400).json({ message: "Name must be 2–80 characters" });
      }
      nameVal = n;
    }
    let addressVal;
    if (address !== undefined) {
      addressVal = String(address || "").trim().slice(0, 500);
    }
    let avatarVal;
    if (req.body.avatar !== undefined) {
      const a = String(req.body.avatar || "").trim().slice(0, 500);
      if (a && !/^https?:\/\/.+/i.test(a) && !/^\/uploads\/.+/.test(a)) {
        return res.status(400).json({ message: "Avatar must be a valid URL" });
      }
      avatarVal = a;
    }
    let langVal;
    if (req.body.preferredLanguage !== undefined) {
      langVal = String(req.body.preferredLanguage || "").trim().slice(0, 40);
    }
    // Fetch current to detect email/phone change (never auto-verify on edit).
    const current = await User.findById(req.user.id).select("email phone mobile");
    if (!current) return res.status(404).json({ message: "User not found" });
    const emailChanged = emailVal !== undefined && emailVal !== String(current.email || "").toLowerCase();
    const phoneChanged = phoneVal !== undefined && phoneVal !== String(current.phone || current.mobile || "");
    let user;
    try {
      user = await User.findByIdAndUpdate(
        req.user.id,
        {
          ...(nameVal !== undefined ? { name: nameVal } : {}),
          ...(phoneVal !== undefined ? { phone: phoneVal, mobile: phoneVal, phoneVerified: false } : {}),
          ...(addressVal !== undefined ? { address: addressVal } : {}),
          ...(emailVal !== undefined ? { email: emailVal, emailVerified: false } : {}),
          ...(avatarVal !== undefined ? { avatar: avatarVal } : {}),
          ...(langVal !== undefined ? { preferredLanguage: langVal } : {}),
        },
        { new: true, runValidators: true }
      );
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(400).json({ message: "A user with this email already exists" });
      }
      throw error;
    }
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    const payload = toUserPayload(user);
    if (emailChanged) payload.emailChangeNotice = "Email updated — you may need to re-verify or sign in again.";
    if (phoneChanged) payload.phoneChangeNotice = "Contact number updated.";
    res.json(payload);
  } catch (error) {
    next(error);
  }
};

exports.getAllUsers = async (req, res, next) => {
  try {
    const { paginationParams, applyPagination, sendList } = require("../utils/pagination");
    const pg = paginationParams(req);
    const users = await applyPagination(
      User.find()
        .select("-password -resetPasswordToken -resetPasswordExpires -googleId")
        .sort({ createdAt: -1 }),
      pg
    );
    return sendList(res, users, pg, () => User.countDocuments());
  } catch (error) {
    next(error);
  }
};

exports.adminAddCook = async (req, res, next) => {
  try {
    const {
      name,
      password,
      rate,
      serviceArea,
      specialties,
      serviceTypes,
    } = req.body;
    const email = String(req.body.email || "").trim().toLowerCase();
    const phone = req.body.phone;
    const mobile = req.body.mobile;

    const existing = await findByEmailInsensitive(email);
    if (existing) {
      return res.status(400).json({ message: "A user with this email already exists" });
    }

    const phoneVal = phone || mobile;
    let user;
    try {
      user = await User.create({ name, email, phone: phoneVal, mobile: phoneVal, password, role: "COOK" });
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(400).json({ message: "A user with this email already exists" });
      }
      throw error;
    }

    const profileData = {
      user: user._id,
      approvalStatus: "approved",
      rate: Number(rate) || 500,
      serviceArea: serviceArea || "",
      specialties: Array.isArray(specialties)
        ? specialties.map((s) => String(s).trim()).filter(Boolean)
        : [],
      serviceTypes: Array.isArray(serviceTypes) && serviceTypes.length
        ? serviceTypes.filter((t) =>
            ["cook_for_me", "cook_with_me", "teach_me", "preparation_help"].includes(t)
          )
        : ["cook_with_me"],
    };

    const CookProfile = require("../models/CookProfile");
    let profile;
    try {
      profile = await CookProfile.create(profileData);
    } catch (error) {
      try {
        await User.deleteOne({ _id: user._id });
      } catch {
      }
      throw error;
    }

    try {
      const Notification = require("../models/Notification");
      await Notification.create({
        user: user._id,
        type: "general",
        message: "Welcome to Cook Mitra! Your chef account is approved and ready for bookings.",
      });
    } catch {
    }

    res.status(201).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
      profile,
    });
  } catch (error) {
    next(error);
  }
};

exports.adminAddAdmin = async (req, res, next) => {
  try {
    const { name, phone, mobile, password } = req.body;
    const email = String(req.body.email || "").trim().toLowerCase();

    const existing = await findByEmailInsensitive(email);
    if (existing) {
      return res.status(400).json({ message: "A user with this email already exists" });
    }

    const phoneVal = phone || mobile;
    let user;
    try {
      user = await User.create({ name, email, phone: phoneVal, mobile: phoneVal, password, role: "ADMIN" });
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(400).json({ message: "A user with this email already exists" });
      }
      throw error;
    }

    try {
      const Notification = require("../models/Notification");
      await Notification.create({
        user: user._id,
        type: "general",
        message: "Welcome to Cook Mitra! Your admin account is ready — sign in to open the Admin Control Panel.",
      });
    } catch {
    }

    res.status(201).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (error) {
    next(error);
  }
};

const assertManageableAccount = (req, res, target) => {
  if (String(target._id) === String(req.user.id)) {
    res.status(400).json({ message: "You cannot manage your own account" });
    return false;
  }
  if (String(target.role).toUpperCase() === "ADMIN") {
    res.status(403).json({ message: "Admin accounts cannot be blocked or deleted" });
    return false;
  }
  return true;
};

exports.adminSetUserStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!["active", "suspended"].includes(status)) {
      return res
        .status(400)
        .json({ message: "Status must be either active or suspended" });
    }

    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }
    if (!assertManageableAccount(req, res, target)) return;

    target.status = status;
    await target.save();

    const Notification = require("../models/Notification");
    await Notification.create({
      user: target._id,
      type: "general",
      message:
        status === "suspended"
          ? "Your account has been blocked by an administrator. Please contact support."
          : "Your account has been unblocked. Welcome back!",
    });

    res.json({
      id: target._id,
      name: target.name,
      email: target.email,
      role: target.role,
      status: target.status,
    });
  } catch (error) {
    next(error);
  }
};

exports.adminDeleteUser = async (req, res, next) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ message: "User not found" });
    }
    if (String(target.role).toUpperCase() === "ADMIN") {
      return res.status(403).json({ message: "Admin accounts cannot be deleted" });
    }

    const Booking = require("../models/Booking");
    // Financial-history guard: any booking row (as customer or cook) is an
    // audit record linked to payment/refund/payout trails (Booking.payment,
    // Booking.payout, LedgerEntry.booking, CancellationAudit.bookingId).
    // This read runs BEFORE any destructive write, so a rejected deletion
    // performs zero deletes. LedgerEntry/CancellationAudit/Complaint rows
    // are never deleted by this controller in any path.
    //
    // Product policy (Option A, approved): hard deletion stays blocked
    // whenever history exists, but an explicit `{ anonymize: true }`
    // request scrubs direct identifiers, suspends the account, and
    // invalidates sessions while preserving EVERY financial/audit record
    // (bookings, payouts, refunds, ledger, audits) and the cook profile
    // (needed to settle pending earnings). See the anonymize branch below.
    const historyCount = await Booking.countDocuments({
      $or: [{ customer: target._id }, { cook: target._id }],
    });
    const wantsAnonymize = req.body?.anonymize === true;
    if (historyCount > 0 && !wantsAnonymize) {
      return res.status(400).json({
        message: "This account has booking or financial history and cannot be permanently deleted.",
        code: "ACCOUNT_HAS_FINANCIAL_HISTORY",
      });
    }

    if (historyCount > 0) {
      // Anonymize-with-history: irreversible scrub of direct identifiers.
      // Referential integrity is kept (same _id), so bookings, payouts,
      // refunds, ledger entries, and audits stay intact and attributable
      // to an anonymous record. Only availability is removed (no future
      // matching); the cook profile — including payout details required
      // to settle pending earnings — is retained as a financial record.
      const Availability = require("../models/Availability");
      target.name = "Deleted User";
      // Email is unique + required: per-account placeholder, never "".
      target.email = `deleted-${String(target._id).toLowerCase()}@deleted.local`;
      // Clear BOTH: the pre-save hook mirrors phone<->mobile when one side
      // is set, so clearing only one would resurrect the other.
      target.phone = "";
      target.mobile = "";
      target.address = "";
      target.avatar = "";
      // Sparse-unique: must be undefined ("" would be indexed and collide
      // across anonymized accounts).
      target.googleId = undefined;
      target.emailVerified = false;
      target.phoneVerified = false;
      target.savedAddresses = [];
      target.resetPasswordToken = "";
      target.resetPasswordExpires = null;
      if (target.authProvider && target.authProvider !== "local") target.authProvider = "local";
      target.status = "suspended";
      target.tokenVersion = Number(target.tokenVersion || 0) + 1;
      await target.save();
      await Availability.deleteMany({ cook: target._id });
      return res.json({
        message: `Account anonymized and suspended — ${historyCount} booking record(s) preserved for audit`,
        id: target._id,
        anonymized: true,
      });
    }

    const CookProfile = require("../models/CookProfile");
    const Availability = require("../models/Availability");
    const Review = require("../models/Review");
    const Notification = require("../models/Notification");

    await CookProfile.deleteMany({ user: target._id });
    await Availability.deleteMany({ cook: target._id });
    await Notification.deleteMany({ user: target._id });
    await Review.deleteMany({ $or: [{ customer: target._id }, { cook: target._id }] });
    await Booking.deleteMany({ $or: [{ customer: target._id }, { cook: target._id }] });

    await target.deleteOne();

    res.json({
      message: `Account for ${target.name} (${target.email}) has been permanently deleted`,
      id: target._id,
    });
  } catch (error) {
    next(error);
  }
};
