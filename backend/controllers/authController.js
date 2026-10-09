const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const findByEmailInsensitive = (email) =>
  User.findOne({ email }, null, { collation: { locale: "en", strength: 2 } });

const toUserPayload = (user) => ({
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
});

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

    if (String(role).toUpperCase() === "COOK") {
      const refCode = String(req.body.referralCode || req.body.ref || "").trim().toUpperCase();
      if (refCode) {
        try {
          const CookProfile = require("../models/CookProfile");
          const CookReferral = require("../models/CookReferral");
          const ownerProfile = await CookProfile.findOne({ referralCode: refCode }).populate("user", "email");
          const ownerId = ownerProfile?.user?._id || ownerProfile?.user;
          if (
            ownerProfile &&
            ownerId &&
            String(ownerId) !== String(user._id) &&
            String(ownerProfile?.user?.email || "").toLowerCase() !== String(email).toLowerCase()
          ) {
            const already = await CookReferral.findOne({ referredCook: user._id }).select("_id");
            if (!already) {
              await CookReferral.create({
                referrer: ownerId,
                referredCook: user._id,
                referralCode: refCode,
              });
              try {
                const Notification = require("../models/Notification");
                await Notification.create({
                  user: ownerId,
                  type: "referral_registered",
                  message: `${user.name} joined Cook Mitra with your referral — ₹250 unlocks after their 10th verified booking.`,
                  link: "/cook/earnings",
                });
              } catch {
              }
            }
          }
        } catch {
        }
      }
    }

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
      if (String(user.role).toUpperCase() === "COOK") {
        const refCode = String(req.body.referralCode || req.body.ref || "").trim().toUpperCase();
        if (refCode) {
          try {
            const CookProfile = require("../models/CookProfile");
            const CookReferral = require("../models/CookReferral");
            const ownerProfile = await CookProfile.findOne({ referralCode: refCode }).populate("user", "email");
            const ownerId = ownerProfile?.user?._id || ownerProfile?.user;
            if (
              ownerProfile && ownerId && String(ownerId) !== String(user._id) &&
              String(ownerProfile?.user?.email || "").toLowerCase() !== String(user.email || "").toLowerCase()
            ) {
              const already = await CookReferral.findOne({ referredCook: user._id }).select("_id");
              if (!already) {
                await CookReferral.create({ referrer: ownerId, referredCook: user._id, referralCode: refCode });
              }
            }
          } catch {
          }
        }
      }
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

exports.logout = async (req, res) => {
  clearSessionCookie(res);
  res.json({ message: "Signed out" });
};

exports.updateProfile = async (req, res, next) => {
  try {
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
    let user;
    try {
      user = await User.findByIdAndUpdate(
        req.user.id,
        {
          ...(name !== undefined ? { name } : {}),
          ...(phoneVal !== undefined ? { phone: phoneVal, mobile: phoneVal } : {}),
          ...(address !== undefined ? { address } : {}),
          ...(emailVal !== undefined ? { email: emailVal } : {}),
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
    res.json(toUserPayload(user));
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

    const CookProfile = require("../models/CookProfile");
    const Availability = require("../models/Availability");
    const Booking = require("../models/Booking");
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
