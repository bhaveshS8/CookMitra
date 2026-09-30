// Standalone regression test for the user login flow (no deps, no DB).
// Run:  node backend/login.test.js  — exits non-zero on any failure.
//
// Stubs the User model and drives the REAL authController.login/getMe, then
// verifies the issued JWT actually carries `role` (which is what the middleware
// `authorize()` and the frontend ProtectedRoute depend on).
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const jwt = require("jsonwebtoken");
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

// Fake user records. comparePassword mirrors the schema method.
const makeUser = (role, status = "active") => ({
  _id: new Types.ObjectId(),
  name: "Test User",
  email: "t@e.com",
  phone: "9876543210",
  role,
  status,
  comparePassword: async (p) => p === "pass123",
});

// Mongoose `findOne({}).select("...")` returns a Query that is awaitable AND
// chainable. The controller does `await User.findOne({}).select("+password")`,
// so the stub must synchronously expose a chainable `select()` and be thenable.
// (Returning a Promise breaks `.select` — that was the bug found earlier.)
const fakeQuery = (doc) => ({
  select: () => Promise.resolve(doc),
  then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
});
const stubFindOne = (doc) => () => fakeQuery(doc);
const stubFindOneNull = () => () => fakeQuery(null);
// getMe does `await User.findById(id)` (no .select chain) — resolves to the doc.
const stubFindById = (doc) => () => Promise.resolve(doc);

(async () => {
  try {
    console.log("\n═══ LOGIN ═══");

        // 1.1 Customer logs in with valid credentials.
    {
      const user = makeUser("customer");
      const oF = User.findOne;
      User.findOne = stubFindOne(user);
      const r = makeRes();
      try {
        await authCtrl.login({ body: { email: "t@e.com", password: "pass123" } }, r, next);
        const decoded = jwt.verify(r.body.token, process.env.JWT_SECRET);
        check("1.1 login returns token + user", r.statusCode === 200 && !!r.body.token && r.body.user.role === "customer", `s=${r.statusCode}`);
        check("1.1 token embeds role=customer", decoded.role === "customer", JSON.stringify({ role: decoded.role }));
        check("1.1 token embeds user id", decoded.id === String(user._id), String(decoded.id));
      } catch (e) {
        check("1.1 login ok", false, e.message);
      } finally {
        User.findOne = oF;
      }
    }

    // 1.2 Admin logs in → token carries role=admin (powers /admin guard).
    {
      const user = makeUser("admin");
      const oF = User.findOne;
      User.findOne = stubFindOne(user);
      const r = makeRes();
      try {
        await authCtrl.login({ body: { email: "a@e.com", password: "pass123" } }, r, next);
        const decoded = jwt.verify(r.body.token, process.env.JWT_SECRET);
        check("1.2 admin login returns role=admin", r.statusCode === 200 && r.body.user.role === "admin", `s=${r.statusCode}`);
        check("1.2 token embeds role=admin", decoded.role === "admin", JSON.stringify({ role: decoded.role }));
      } catch (e) {
        check("1.2 admin login ok", false, e.message);
      } finally {
        User.findOne = oF;
      }
    }

    // 1.3 Unknown user → 401.
    {
      const oF = User.findOne;
      User.findOne = stubFindOneNull();
      const r = makeRes();
      try {
        await authCtrl.login({ body: { email: "n@e.com", password: "pass123" } }, r, next);
        check("1.3 unknown user -> 401", r.statusCode === 401 && /invalid credentials/i.test(r.body.message || ""), `s=${r.statusCode} msg=${r.body && r.body.message}`);
      } catch (e) {
        check("1.3 unknown user -> 401", false, e.message);
      } finally {
        User.findOne = oF;
      }
    }

    // 1.4 Wrong password → 401.
    {
      const user = makeUser("cook");
      const oF = User.findOne;
      User.findOne = stubFindOne(user);
      const r = makeRes();
      try {
        await authCtrl.login({ body: { email: "c@e.com", password: "nope" } }, r, next);
        check("1.4 wrong password -> 401", r.statusCode === 401, `s=${r.statusCode}`);
      } catch (e) {
        check("1.4 wrong password -> 401", false, e.message);
      } finally {
        User.findOne = oF;
      }
    }

    // 1.5 Suspended account → 403, no token issued.
    {
      const user = makeUser("customer", "suspended");
      const oF = User.findOne;
      User.findOne = stubFindOne(user);
      const r = makeRes();
      try {
        await authCtrl.login({ body: { email: "s@e.com", password: "pass123" } }, r, next);
        check("1.5 suspended -> 403", r.statusCode === 403, `s=${r.statusCode}`);
        check("1.5 suspended -> no token", !r.body.token, JSON.stringify(r.body));
      } catch (e) {
        check("1.5 suspended -> 403", false, e.message);
      } finally {
        User.findOne = oF;
      }
    }

    // 1.6 getMe returns profile without leaking the password hash.
    {
      const user = makeUser("cook");
      const doc = { ...user, password: "super-secret-hash" };
      const oF = User.findById;
      User.findById = stubFindById(doc);
      const r = makeRes();
      try {
        await authCtrl.getMe({ user: { id: String(user._id) } }, r, next);
        check("1.6 getMe -> 200", r.statusCode === 200, `s=${r.statusCode}`);
        check("1.6 getMe carries role", r.body.role === "cook", JSON.stringify(r.body));
        check("1.6 getMe omits password", r.body.password === undefined, JSON.stringify(r.body));
      } catch (e) {
        check("1.6 getMe ok", false, e.message);
      } finally {
        User.findById = oF;
      }
    }

    // 1.7 Admin sessions are capped at 12h (financial powers); customers keep 30d.
    {
      const admin = makeUser("ADMIN");
      const oF = User.findOne;
      User.findOne = stubFindOne(admin);
      const r = makeRes();
      try {
        await authCtrl.login({ body: { email: "a@e.com", password: "pass123" } }, r, next);
        const decoded = jwt.verify(r.body.token, process.env.JWT_SECRET);
        const lifetimeHrs = (decoded.exp - decoded.iat) / 3600;
        check("1.7 admin token capped at 12h", Math.abs(lifetimeHrs - 12) < 0.01 && r.body.expiresIn === "12h", `${lifetimeHrs.toFixed(2)}h/${r.body.expiresIn}`);
      } catch (e) {
        check("1.7 admin session cap", false, e.message);
      } finally {
        User.findOne = oF;
      }
    }

    // 1.8 Customer sessions keep the 30d contract.
    {
      const user = makeUser("CUSTOMER");
      const oF = User.findOne;
      User.findOne = stubFindOne(user);
      const r = makeRes();
      try {
        await authCtrl.login({ body: { email: "t@e.com", password: "pass123" } }, r, next);
        const decoded = jwt.verify(r.body.token, process.env.JWT_SECRET);
        const lifetimeDays = (decoded.exp - decoded.iat) / 86400;
        check("1.8 customer token keeps 30d", Math.abs(lifetimeDays - 30) < 0.01 && r.body.expiresIn === "30d", `${lifetimeDays.toFixed(2)}d/${r.body.expiresIn}`);
      } catch (e) {
        check("1.8 customer session lifetime", false, e.message);
      } finally {
        User.findOne = oF;
      }
    }
  } catch (error) {
    check("login suite did not throw", false, (error && error.message) || String(error));
  }

  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
