const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const USER_ROLES = ["CUSTOMER", "COOK", "ADMIN"];

const ADDRESS_LABELS = ["Home", "Office", "Parents' Home", "Other"];

const savedAddressSchema = new mongoose.Schema(
  {
    label: { type: String, enum: ADDRESS_LABELS, required: [true, "Address label is required"], trim: true },
    customLabel: { type: String, default: "", trim: true, maxlength: [40, "Label is too long"] },
    flatNo: { type: String, required: [true, "Flat/house number is required"], trim: true, maxlength: [120, "Flat/house number is too long"] },
    society: { type: String, required: [true, "Society/building is required"], trim: true, maxlength: [160, "Society/building is too long"] },
    landmark: { type: String, default: "", trim: true, maxlength: [160, "Landmark is too long"] },
    city: { type: String, required: [true, "City is required"], trim: true, maxlength: [80, "City is too long"] },
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

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
    preferredLanguage: {
      type: String,
      default: "",
      trim: true,
      maxlength: [40, "Language is too long"],
    },
    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },
    savedAddresses: { type: [savedAddressSchema], default: [] },
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
  // Backward compat: legacy users get safe defaults.
  if (!Array.isArray(this.savedAddresses)) this.savedAddresses = [];
  // Maintain at most one default address.
  if (Array.isArray(this.savedAddresses) && this.savedAddresses.length > 1) {
    let seen = false;
    for (let i = this.savedAddresses.length - 1; i >= 0; i -= 1) {
      if (this.savedAddresses[i]?.isDefault) {
        if (!seen) seen = true;
        else this.savedAddresses[i].isDefault = false;
      }
    }
  }
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
User.ADDRESS_LABELS = ADDRESS_LABELS;

module.exports = User;
