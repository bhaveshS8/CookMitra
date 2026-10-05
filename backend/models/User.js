const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

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
      default: "",
      trim: true,
    },
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
      required: function () {
        return !this.googleId;
      },
      minlength: 8,
      select: false,
    },
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
  if (this.role != null) this.role = normalizeRole(this.role);
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

userSchema.index({ role: 1, status: 1 });
userSchema.index({ name: 1 });

const User = mongoose.model("User", userSchema);

User.USER_ROLES = USER_ROLES;
User.normalizeRole = normalizeRole;

module.exports = User;
