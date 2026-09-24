const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

// COOKMITRA EVENTS (MVP §17) — canonical roles are UPPERCASE:
// CUSTOMER, COOK, ADMIN. Lowercase legacy values ("customer"/"cook"/"admin")
// from the earlier on-demand flow are auto-uppercased by the setter below so
// old documents, seeds and clients keep working without a data migration.
const USER_ROLES = ["CUSTOMER", "COOK", "ADMIN"];

const normalizeRole = (v) => {
  if (v == null) return v;
  const up = String(v).trim().toUpperCase();
  return USER_ROLES.includes(up) ? up : v;
};

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      // Optional for Google sign-in accounts (no phone from Google profile).
      // Still required for email/password registration via route validation.
      default: "",
      trim: true,
    },
    // COOKMITRA EVENTS spec (§17) names this field `mobile`. `phone` above is
    // the legacy name used across the app — both are kept in sync (see
    // pre-validate / pre-save hooks) so either one can be used.
    mobile: {
      type: String,
      default: "",
      trim: true,
    },
    address: {
      type: String,
      trim: true,
    },
    password: {
      type: String,
      // Not required for Google-only accounts (they authenticate via ID token).
      // Email/password registration still enforces this via route validation.
      required: function () {
        return !this.googleId;
      },
      minlength: 8,
      select: false,
    },
    // Session invalidation counter (Phase 10): embedded in every JWT as `tv`
    // and bumped on password reset. Pre-bump tokens stop verifying at once.
    // Defaults to 0 so legacy tokens (no tv claim) keep working until reset.
    tokenVersion: {
      type: Number,
      default: 0,
    },
    role: {
      type: String,
      enum: USER_ROLES,
      default: "CUSTOMER",
      uppercase: true,
      set: normalizeRole,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "suspended"],
      default: "active",
    },
    googleId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    avatar: {
      type: String,
      trim: true,
    },
    authProvider: {
      type: String,
      enum: ["local", "google", "local+google"],
      default: "local",
    },
    // Password-reset (forgot flow): sha256(token) + expiry. The raw token
    // only ever travels by email (or dev-only response); the hash here is
    // useless without it.
    resetPasswordToken: {
      type: String,
      default: "",
      trim: true,
    },
    resetPasswordExpires: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

userSchema.pre("validate", function (next) {
  // Normalize role before enum validation so legacy lowercase passes.
  if (this.role != null) this.role = normalizeRole(this.role);
  // Keep phone <-> mobile in sync (spec §17 uses `mobile`).
  if (!this.mobile && this.phone) this.mobile = this.phone;
  if (!this.phone && this.mobile) this.phone = this.mobile;
  next();
});

userSchema.pre("save", async function (next) {
  if (this.mobile && !this.phone) this.phone = this.mobile;
  if (this.phone && !this.mobile) this.mobile = this.phone;
  if (!this.isModified("password") || !this.password) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password || !candidatePassword) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

// Hot-pathed by role directory scans (complaint escalation, admin lists).
userSchema.index({ role: 1, status: 1 });

const User = mongoose.model("User", userSchema);

User.USER_ROLES = USER_ROLES;
User.normalizeRole = normalizeRole;

module.exports = User;
