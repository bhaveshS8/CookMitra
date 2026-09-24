// p0-hardening.test.js — P0-1 (admin registration) + P0-2 (signed doc URLs)
// + P0-3 (session cookie) regression tests. Stubbed, no DB.
// Run: node backend/p0-hardening.test.js — exits non-zero on any failure.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-p0-hardening-32chars!!";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const { signDocUrl, verifyDocToken, isPrivateDocPath } = require("./utils/docTokens");

let failures = 0;
let passes = 0;
const check = (n, ok, d) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  -> ${d}` : ""}`);
  if (ok) passes += 1;
  else failures += 1;
};
const makeRes = () => {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.getHeader = (k) => r.headers[k];
  return r;
};
const next = (err) => { if (err) throw err || new Error("next()"); };

async function main() {
  console.log("═══ P0-1: public registration role whitelist ═══");
  const authCtrl = require("./controllers/authController");
  const User = require("./models/User");
  const realCreate = User.create;
  const realFindOne = User.findOne;

  const tryRegister = async (body) => {
    let created = null;
    User.findOne = () => null;
    User.create = async (doc) => { created = doc; return { _id: "u1", ...doc }; };
    const Notification = require("./models/Notification");
    const realNotif = Notification.create;
    Notification.create = async () => ({});
    const r = makeRes();
    await authCtrl.register({ body }, r, next);
    User.create = realCreate;
    User.findOne = realFindOne;
    Notification.create = realNotif;
    return { res: r, created };
  };

  const base = { name: "Attacker", email: "a@x.com", password: "secret12", phone: "9876543210" };
  for (const role of ["ADMIN", "admin", "Admin", "administrator", "ADMINISTRATOR", "root", "superuser", ""]) {
    const { res, created } = await tryRegister({ ...base, email: `${Date.now()}${Math.random()}@x.com`, role });
    check(
      `register role=${JSON.stringify(role)} never creates ADMIN`,
      res.statusCode === 201 && created && created.role !== "ADMIN",
      `s=${res.statusCode} role=${created?.role}`
    );
  }
  {
    const { res, created } = await tryRegister({ ...base, email: "norole@x.com" });
    check("missing role defaults to CUSTOMER", res.statusCode === 201 && created?.role === "CUSTOMER", `role=${created?.role}`);
  }
  {
    const { res, created } = await tryRegister({ ...base, email: "cookok@x.com", role: "cook" });
    check("role=cook (lowercase) maps to COOK", res.statusCode === 201 && created?.role === "COOK", `role=${created?.role}`);
  }
  {
    // Prototype-pollution-style payload: __proto__/constructor keys must not
    // escalate the role or pollute Object.prototype.
    const before = ({}).polluted;
    const payload = JSON.parse('{"name":"Proto Attacker","email":"proto@x.com","password":"secret12","phone":"9876543210","role":"ADMIN","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
    const { res, created } = await tryRegister(payload);
    check(
      "prototype-style payload cannot create ADMIN",
      res.statusCode === 201 && created?.role !== "ADMIN",
      `role=${created?.role}`
    );
    check("no Object.prototype pollution", ({}).polluted === undefined && before === undefined);
    delete Object.prototype.polluted;
  }
  {
    // Mass assignment: extra privileged fields in body must not land on the user.
    const { created } = await tryRegister({ ...base, email: "mass@x.com", role: "CUSTOMER", status: "suspended", isAdmin: true });
    check("mass assignment cannot set status/isAdmin", created && created.status === undefined && created.isAdmin === undefined);
  }
  {
    // 20 simultaneous ADMIN registration attempts — all must fail to escalate.
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tryRegister({ ...base, email: `race${i}@x.com`, role: "ADMIN" })
      )
    );
    check(
      "20x concurrent role=ADMIN all contained",
      attempts.every((a) => a.res.statusCode === 201 && a.created?.role !== "ADMIN"),
      `${attempts.filter((a) => a.created?.role === "ADMIN").length} escalated`
    );
  }
  {
    // Session cookie is issued on register (P0-3).
    const { res } = await tryRegister({ ...base, email: "cookie1@x.com", role: "CUSTOMER" });
    const setCookie = String(res.headers["Set-Cookie"] || "");
    check("register sets __Host- session cookie", setCookie.includes("__Host-cm_session="), setCookie.slice(0, 80));
    check("session cookie is HttpOnly", /httponly/i.test(setCookie));
    check("session cookie is SameSite=Lax", /samesite=lax/i.test(setCookie));
    check("session cookie has Path=/", /path=\//i.test(setCookie));
  }

  console.log("\n═══ P0-2: signed document URLs ═══");
  const cookId = "507f1f77bcf86cd799439011";
  const aadhar = `/uploads/aadhar_${cookId}_123_file.jpg`;
  check("aadhar path is private-eligible", isPrivateDocPath(aadhar) === true);
  check("photo_ is NOT private-eligible", isPrivateDocPath(`/uploads/photo_${cookId}_1.jpg`) === false);
  check("non-uploads rejected", isPrivateDocPath("/etc/passwd") === false);
  check("traversal rejected", isPrivateDocPath("/uploads/../server.js") === false);
  {
    const { token, exp } = signDocUrl(aadhar, cookId);
    check("mint returns token+expiry", !!token && exp > Date.now());
    const v = verifyDocToken(token);
    check("valid token verifies (doc+uid)", v && v.doc === aadhar && v.uid === cookId, JSON.stringify(v));
    check("no session JWT accepted as doc token", verifyDocToken("eyJhbGciOiJIUzI1NiJ9.e30.abc") === null);
  }
  {
    // Tampering with the doc path invalidates the signature.
    const { token } = signDocUrl(aadhar, cookId);
    const [p, s] = token.split(".");
    const other = Buffer.from(JSON.stringify({ doc: `/uploads/aadhar_OTHERID_123_file.jpg`, uid: cookId, exp: Date.now() + 60000 }))
      .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    check("swapped-doc replay rejected", verifyDocToken(`${other}.${s}`) === null);
    void p;
  }
  {
    // Expired token rejected.
    const { token } = signDocUrl(aadhar, cookId, 30 * 1000);
    const [p] = token.split(".");
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    payload.exp = Date.now() - 1000;
    const re = Buffer.from(JSON.stringify(payload)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    check("expired token rejected", verifyDocToken(`${re}.${token.split(".")[1]}`) === null);
  }
  {
    // photo_ cannot be minted (stays public/cacheable by design).
    let threw = false;
    try { signDocUrl(`/uploads/photo_${cookId}_1.jpg`, cookId); } catch { threw = true; }
    check("photo_ mint refused", threw === true);
  }
  {
    // Malformed tokens rejected.
    check("empty rejected", verifyDocToken("") === null);
    check("garbage rejected", verifyDocToken("not.a.valid.token.here") === null);
    check("null rejected", verifyDocToken(null) === null);
  }

  {
    // Adversarial: with JWT_SECRET unset, an attacker can compute
    // sha256("doc-view:") offline — verify must fail closed anyway.
    const saved = process.env.JWT_SECRET;
    const { token } = signDocUrl(aadhar, cookId);
    delete process.env.JWT_SECRET;
    check("doc token invalid without server secret", verifyDocToken(token) === null);
    process.env.JWT_SECRET = saved;
    check("doc token valid again with secret restored", verifyDocToken(token)?.uid === cookId);
  }

  console.log("\n═══ P0-3: cookie auth + CSRF guard ═══");
  {
    const jwt = require("jsonwebtoken");
    const { auth } = require("./middleware/auth");
    const U = require("./models/User");
    const realFindById = U.findById;
    U.findById = () => ({ select: async () => ({ _id: cookId, role: "CUSTOMER", status: "active" }) });
    const token = jwt.sign({ id: cookId, role: "CUSTOMER" }, process.env.JWT_SECRET);
    // Cookie-authenticated GET works.
    {
      const r = makeRes();
      let passed = false;
      await auth({ method: "GET", path: "/", headers: {}, header: (k) => (String(k).toLowerCase() === "cookie" ? `__Host-cm_session=${encodeURIComponent(token)}` : "") }, r, () => { passed = true; });
      check("cookie session authenticates GET", passed === true && r.statusCode === 200);
    }
    // Cookie-authenticated cross-origin POST is refused (CSRF).
    {
      const r = makeRes();
      let passed = false;
      await auth({
        method: "POST", path: "/api/bookings",
        header: (k) => {
          const kl = String(k).toLowerCase();
          if (kl === "cookie") return `__Host-cm_session=${encodeURIComponent(token)}`;
          if (kl === "origin") return "https://evil.example";
          if (kl === "host") return "cookmitra.in";
          return "";
        },
        protocol: "https",
      }, r, () => { passed = true; });
      check("cross-origin cookie POST refused", passed === false && r.statusCode === 403, `s=${r.statusCode}`);
    }
    U.findById = realFindById;
  }

  console.log("\n═══ Adversarial: cook profile + admin overview ═══");
  {
    const cookCtrl = require("./controllers/cookController");
    const CookProfile = require("./models/CookProfile");
    // Non-object schedule must 400, never throw (TypeError -> 500).
    {
      const realFUA = CookProfile.findOneAndUpdate;
      let called = false;
      CookProfile.findOneAndUpdate = async () => { called = true; return null; };
      for (const bad of ["x", 42, ["a"]]) {
        const r = makeRes();
        await cookCtrl.updateCookProfile(
          { body: { schedule: bad }, user: { id: "cook1", role: "COOK" } },
          r,
          next
        );
        check(
          `schedule=${JSON.stringify(bad)} rejected 400 without write`,
          r.statusCode === 400 && called === false,
          `s=${r.statusCode}`
        );
      }
      CookProfile.findOneAndUpdate = realFUA;
    }
    // Admin overview must strip OTP secrets and exclude test money.
    {
      const BookingM = require("./models/Booking");
      const ReviewM = require("./models/Review");
      const UserM = require("./models/User");
      const realCPFindOne = CookProfile.findOne;
      const realCPFindById = CookProfile.findById;
      const realBFind = BookingM.find;
      const realRFind = ReviewM.find;
      const realUFind = UserM.findById;
      const otpBooking = {
        _id: "b1",
        status: "completed",
        serviceType: "cook_for_me",
        durationHours: 2,
        serviceOtp: "1234",
        serviceOtpGeneratedAt: new Date(),
        serviceOtpAttempts: 3,
        serviceOtpLockedUntil: null,
        serviceStartedAt: new Date(),
        payment: { status: "paid", razorpayPaymentId: "pay_test_x", paidAmount: 199, testMode: true },
        toObject() {
          const { toObject, ...rest } = this;
          return { ...rest };
        },
      };
      const realBooking = {
        _id: "b2",
        status: "completed",
        serviceType: "cook_for_me",
        durationHours: 1,
        payment: { status: "paid", razorpayPaymentId: "pay_real_1", paidAmount: 349, testMode: false },
        toObject() {
          const { toObject, ...rest } = this;
          return { ...rest };
        },
      };
      CookProfile.findById = async () => null;
      CookProfile.findOne = () => ({
        populate: async () => ({ _id: "prof1", user: { _id: "cook1" } }),
      });
      BookingM.find = () => ({ populate: () => ({ sort: async () => [otpBooking, realBooking] }) });
      ReviewM.find = () => ({ populate: () => ({ populate: () => ({ sort: async () => [] }) }) });
      UserM.findById = () => ({ select: async () => ({ name: "Cook", phone: "9876543210" }) });
      const r = makeRes();
      await cookCtrl.getCookAdminOverview({ params: { id: "prof1" } }, r, next);
      const out = r.body?.bookings || [];
      const leaked = out.some((b) => b.serviceOtp !== undefined || b.serviceOtpAttempts !== undefined);
      check("admin overview strips OTP secrets", r.statusCode === 200 && leaked === false);
      check(
        "admin overview excludes test money from earnings",
        r.body?.summary?.totalEarnings === 349,
        `earnings=${r.body?.summary?.totalEarnings}`
      );
      CookProfile.findOne = realCPFindOne;
      CookProfile.findById = realCPFindById;
      BookingM.find = realBFind;
      ReviewM.find = realRFind;
      UserM.findById = realUFind;
    }
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
