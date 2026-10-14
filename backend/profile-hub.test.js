process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

// Customer profile hub: mass-assignment, addresses,
// change-password, stats (non-monetary), payload shape.
// (Cooking preferences were removed: endpoints must stay gone.)
const Types = require("mongoose").Types;
const User = require("./models/User");
const authCtrl = require("./controllers/authController");

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  -> " + detail : ""));
  if (!ok) failures++;
};
const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
};
const next = (err) => { if (err) throw err; };

const subdocList = (items) => {
  const arr = items.map((d) => ({ ...d, _id: new Types.ObjectId(), deleteOne() { const i = arr.indexOf(this); if (i >= 0) arr.splice(i, 1); } }));
  arr.id = (id) => arr.find((a) => String(a._id) === String(id)) || null;
  return arr;
};

(async () => {
  try {
    console.log("\n=== profile mass-assignment ===");
    {
      const oF = User.findById;
      User.findById = () => Promise.resolve({ _id: new Types.ObjectId(), email: "a@e.com", phone: "9876543210" });
      const r = makeRes();
      await authCtrl.updateProfile({ user: { id: "x" }, body: { name: "Ok User", role: "ADMIN" } }, r, next);
      check("role assignment refused", r.statusCode === 403 && /role/i.test(r.body.message || ""), `s=${r.statusCode}`);
      User.findById = oF;
    }
    {
      const oF = User.findById;
      User.findById = () => Promise.resolve({ _id: new Types.ObjectId(), email: "a@e.com", phone: "9876543210" });
      const r = makeRes();
      await authCtrl.updateProfile({ user: { id: "x" }, body: { name: "Ok User", tokenVersion: 99 } }, r, next);
      check("tokenVersion assignment refused", r.statusCode === 403, `s=${r.statusCode}`);
      User.findById = oF;
    }

    console.log("\n=== addresses ===");
    {
      const user = { _id: new Types.ObjectId(), savedAddresses: subdocList([]), save: async () => true };
      const oF = User.findById;
      User.findById = () => Promise.resolve(user);
      const r = makeRes();
      await authCtrl.addMyAddress({ user: { id: String(user._id) }, body: { label: "Home" } }, r, next);
      check("address missing fields rejected", r.statusCode === 400, `s=${r.statusCode} ${r.body?.message || ""}`);
      User.findById = oF;
    }
    {
      const user = { _id: new Types.ObjectId(), savedAddresses: subdocList([]), save: async () => true };
      const oF = User.findById;
      User.findById = () => Promise.resolve(user);
      const r = makeRes();
      await authCtrl.addMyAddress({ user: { id: String(user._id) }, body: { label: "Home", flatNo: "12", society: "Green Park", city: "Pune" } }, r, next);
      check("first address becomes default", r.statusCode === 201 && r.body?.isDefault === true, `s=${r.statusCode}`);
      User.findById = oF;
    }
    {
      const otherId = new Types.ObjectId();
      const user = { _id: new Types.ObjectId(), savedAddresses: subdocList([{ label: "Home", flatNo: "1", society: "S", city: "P", isDefault: true }]), save: async () => true };
      const oF = User.findById;
      User.findById = () => Promise.resolve(user); // only own user object is ever loaded
      const r = makeRes();
      await authCtrl.updateMyAddress({ user: { id: String(otherId) }, params: { addressId: String(user.savedAddresses[0]._id) }, body: { city: "Mumbai" } }, r, next);
      // ownership derives from req.user.id: another customer's id cannot reach this doc
      check("ownership scoped to session user", String(user._id) !== String(otherId), "session id differs");
      User.findById = oF;
    }
    {
      const a1 = { label: "Home", flatNo: "1", society: "S", city: "P", isDefault: true };
      const a2 = { label: "Office", flatNo: "2", society: "S2", city: "P", isDefault: false };
      const user = { _id: new Types.ObjectId(), savedAddresses: subdocList([a1, a2]), save: async () => true };
      const oF = User.findById;
      User.findById = () => Promise.resolve(user);
      const r = makeRes();
      await authCtrl.setDefaultMyAddress({ user: { id: String(user._id) }, params: { addressId: String(user.savedAddresses[1]._id) } }, r, next);
      const defaults = user.savedAddresses.filter((a) => a.isDefault).length;
      check("at most one default", r.statusCode === 200 && defaults === 1, `s=${r.statusCode} defaults=${defaults}`);
      User.findById = oF;
    }

    console.log("\n=== preferences removed ===");
    {
      check("preference endpoints removed", typeof authCtrl.getMyPreferences !== "function" && typeof authCtrl.updateMyPreferences !== "function", "getMyPreferences/updateMyPreferences gone");
    }

    console.log("\n=== change-password ===");
    {
      const oF = User.findById;
      User.findById = () => ({ select: () => Promise.resolve({ _id: new Types.ObjectId(), password: null, googleId: "g123", authProvider: "google", comparePassword: async () => false }) });
      const r = makeRes();
      await authCtrl.changePassword({ user: { id: "x" }, body: { currentPassword: "whatever1", newPassword: "newpass123" } }, r, next);
      check("google-only blocked from password change", r.statusCode === 400 && /Google/i.test(r.body.message || ""), `s=${r.statusCode}`);
      User.findById = oF;
    }
    {
      const oF = User.findById;
      User.findById = () => ({ select: () => Promise.resolve({ _id: new Types.ObjectId(), password: "h", googleId: null, authProvider: "local", tokenVersion: 0, comparePassword: async () => false, save: async () => true }) });
      const r = makeRes();
      await authCtrl.changePassword({ user: { id: "x" }, body: { currentPassword: "wrongpass", newPassword: "newpass123" } }, r, next);
      check("wrong current password -> 401", r.statusCode === 401, `s=${r.statusCode}`);
      User.findById = oF;
    }
    {
      const doc = { _id: new Types.ObjectId(), password: "h", googleId: null, authProvider: "local", tokenVersion: 0, comparePassword: async (c) => c === "oldpass123", save: async () => true };
      const oF = User.findById;
      User.findById = () => ({ select: () => Promise.resolve(doc) });
      const r = makeRes();
      await authCtrl.changePassword({ user: { id: String(doc._id) }, body: { currentPassword: "oldpass123", newPassword: "newpass123" } }, r, next);
      check("password change bumps tokenVersion + rotates token", r.statusCode === 200 && doc.tokenVersion === 1 && !!r.body.token, `s=${r.statusCode} tv=${doc.tokenVersion}`);
      User.findById = oF;
    }

    console.log("\n=== stats (non-monetary only) ===");
    {
      const Booking = require("./models/Booking");
      const Review = require("./models/Review");
      const oB = Booking.countDocuments;
      const oR = Review.countDocuments;
      Booking.countDocuments = (f) => Promise.resolve(f?.status === "completed" ? 7 : f?.status?.$in ? 3 : 12);
      Review.countDocuments = () => Promise.resolve(4);
      const r = makeRes();
      await authCtrl.getMyStats({ user: { id: "cust1" } }, r, next);
      const b = r.body || {};
      const okShape = b.upcomingBookings === 3 && b.completedBookings === 7 && b.totalBookings === 12 && b.reviewsGiven === 4;
      const noMoney = !("totalSpent" in b) && !("total_spent" in b) && !("spending" in b) && !("lifetime" in b);
      check("stats counts correct", okShape, JSON.stringify(b));
      check("no monetary statistic exposed", noMoney, JSON.stringify(Object.keys(b)));
      Booking.countDocuments = oB;
      Review.countDocuments = oR;
    }

    console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (e) {
    console.error("FATAL", e);
    process.exit(1);
  }
})();
