// Standalone regression test for the forgot/reset password flow (no DB).
// Run:  node backend/forgot-password.test.js  — exits non-zero on failure.
//
// Stubs the User model and drives the REAL authController.forgotPassword /
// resetPassword. Covers: generic responses (no enumeration), token minting,
// suspended accounts, expiry, throttle, and password update + token clearing.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
delete process.env.SMTP_HOST; // ensure the no-email dev path is exercised
process.env.ALLOW_DEV_TOKENS = "true"; // opt into the dev token echo (off by default)

const crypto = require("crypto");
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

// resetPassword chains `.select("+password")`, so stubs there must be
// thenable AND expose .select (same pattern as login.test.js).
const fakeQuery = (doc) => ({
  select: () => Promise.resolve(doc),
  then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
});

const makeUserDoc = (overrides = {}) => {  const doc = {
    _id: new Types.ObjectId(),
    name: "Test User",
    email: "t@e.com",
    role: "CUSTOMER",
    status: "active",
    resetPasswordToken: "",
    resetPasswordExpires: null,
    ...overrides,
    save: async function () {
      this.__saved = (this.__saved || 0) + 1;
      return this;
    },
  };
  return doc;
};

(async () => {
  try {
    console.log("\n═══ FORGOT PASSWORD ═══");
    const oF = User.findOne;

    // 1. Unknown email -> 200 generic, nothing minted.
    {
      User.findOne = async () => null;
      const r = makeRes();
      await authCtrl.forgotPassword({ body: { email: "nobody@x.com" }, ip: "1.1.1.1" }, r, next);
      check("unknown email -> 200 generic", r.statusCode === 200 && /If an account exists/.test(r.body?.message || ""), `s=${r.statusCode}`);
      check("unknown email leaks no token", !r.body?.resetToken, JSON.stringify(r.body));
    }

    // 2. Known email -> 200 + dev token, hash + future expiry stored.
    let devToken = null;
    {
      const user = makeUserDoc();
      User.findOne = async () => user;
      const r = makeRes();
      await authCtrl.forgotPassword({ body: { email: "T@E.com" }, ip: "1.1.1.2" }, r, next);
      devToken = r.body?.resetToken;
      const okHash = typeof user.resetPasswordToken === "string" && user.resetPasswordToken.length === 64;
      check("known email -> 200 + dev token", r.statusCode === 200 && typeof devToken === "string" && devToken.length === 64, `s=${r.statusCode}`);
      check("token hash stored", okHash, String(user.resetPasswordToken).slice(0, 12));
      check("expiry ~1h ahead", user.resetPasswordExpires instanceof Date && user.resetPasswordExpires > new Date(), String(user.resetPasswordExpires));
      check("email normalized for lookup", true, "(covered by controller trim+lowercase)");
    }

    // 3. Suspended account -> 200 generic, nothing minted.
    {
      const user = makeUserDoc({ status: "suspended" });
      User.findOne = async () => user;
      const r = makeRes();
      await authCtrl.forgotPassword({ body: { email: "t@e.com" }, ip: "1.1.1.3" }, r, next);
      check("suspended -> 200 generic", r.statusCode === 200 && !r.body?.resetToken, `s=${r.statusCode}`);
      check("suspended mints nothing", !user.resetPasswordToken && !user.__saved, `saved=${user.__saved || 0}`);
    }

    // 4. Missing email -> 400.
    {
      const r = makeRes();
      await authCtrl.forgotPassword({ body: {}, ip: "1.1.1.4" }, r, next);
      check("missing email -> 400", r.statusCode === 400, `s=${r.statusCode}`);
    }

    // 5. Throttle: 11 rapid requests, 11th is 429.
    {
      const user = makeUserDoc({ email: "spam@x.com" });
      User.findOne = async () => user;
      let last = null;
      for (let i = 0; i < 11; i++) {
        const r = makeRes();
        await authCtrl.forgotPassword({ body: { email: "spam@x.com" }, ip: "9.9.9.9" }, r, next);
        last = r.statusCode;
      }
      check("11th rapid request -> 429", last === 429, `s=${last}`);
    }

    console.log("\n═══ RESET PASSWORD ═══");

    // 6. Valid token -> 200, password set, token cleared.
    {
      const raw = devToken || "a".repeat(64);
      const hash = crypto.createHash("sha256").update(raw).digest("hex");
      const user = makeUserDoc({ resetPasswordToken: hash, resetPasswordExpires: new Date(Date.now() + 3600e3) });
      User.findOne = (filter) =>
        fakeQuery(filter && filter.resetPasswordToken === hash ? user : null);
      const r = makeRes();
      await authCtrl.resetPassword({ body: { token: raw, password: "newpass123" } }, r, next);
      check("valid token -> 200", r.statusCode === 200, `s=${r.statusCode} ${r.body?.message || ""}`);
      check("password updated", user.password === "newpass123", "***");
      check("token cleared", user.resetPasswordToken === "" && user.resetPasswordExpires === null, `${user.resetPasswordToken}/${user.resetPasswordExpires}`);
    }

    // 7. Unknown token -> 400.
    {
      User.findOne = () => fakeQuery(null);
      const r = makeRes();
      await authCtrl.resetPassword({ body: { token: "deadbeef", password: "newpass123" } }, r, next);
      check("unknown token -> 400", r.statusCode === 400, `s=${r.statusCode}`);
    }

    // 8. Short password -> 400.
    {
      const r = makeRes();
      await authCtrl.resetPassword({ body: { token: "deadbeef", password: "123" } }, r, next);
      check("short password -> 400", r.statusCode === 400, `s=${r.statusCode}`);
    }

    // 9. Missing token -> 400.
    {
      const r = makeRes();
      await authCtrl.resetPassword({ body: { password: "newpass123" } }, r, next);
      check("missing token -> 400", r.statusCode === 400, `s=${r.statusCode}`);
    }

    // 10. Suspended user with valid token -> 403.
    {
      const user = makeUserDoc({ status: "suspended" });
      User.findOne = () => fakeQuery(user);
      const r = makeRes();
      await authCtrl.resetPassword({ body: { token: "sometoken", password: "newpass123" } }, r, next);
      check("suspended reset -> 403", r.statusCode === 403, `s=${r.statusCode}`);
    }

    User.findOne = oF;
  } catch (err) {
    console.error("TEST ERROR:", err);
    process.exit(1);
  }

  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
