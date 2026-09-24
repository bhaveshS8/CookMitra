// coupon.test.js — regression suite for coupon routes wiring, admin-only
// guards, discount math, normalization and usage protection (stubbed, no DB).
// Run:  node coupon.test.js  — exits non-zero on any failure.
const { Types } = require("mongoose");

const Coupon = require("./models/Coupon");
const couponCtrl = require("./controllers/couponController");
const couponRoutes = require("./routes/coupons");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) failures++;
};
const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
};
const next = (err) => { if (err) throw err; };

const makeCoupon = (overrides = {}) => ({
  _id: new Types.ObjectId(),
  code: "BAPPA20",
  description: "Ganesh Utsav special",
  percent: 20,
  maxDiscount: 500,
  minOrder: 0,
  usageLimit: null,
  usedCount: 0,
  usedBy: [],
  perUserLimit: 1,
  validFrom: null,
  validTo: null,
  active: true,
  createdBy: new Types.ObjectId(),
  ...overrides,
});

// Thenable + chainable query stub: controllers call .select().sort() before await.
const Q = (doc) => ({
  select: () => Q(doc),
  sort: () => Q(doc),
  then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
});
const stubFind = (doc) => () => Q(doc);
const stubFindOne = (doc) => () => Q(doc);

(async () => {
  try {
    console.log("\n═══ COUPON ROUTES (wiring + admin guards) ═══");

    const byPath = {};
    for (const layer of couponRoutes.stack) {
      const r = layer.route;
      if (!r) continue;
      byPath[r.path] = byPath[r.path] || {};
      for (const m of Object.keys(r.methods)) {
        // Keep handler references (identity) + first layer's name (auth check).
        byPath[r.path][m] = r.stack.map((h) => ({ fn: h.handle, isAuth: h.name === "auth" }));
      }
    }
    const handlerList = (path, m) => byPath[path]?.[m] || [];
    const lastIs = (path, m, fn) => {
      const L = handlerList(path, m);
      return L.length >= 1 && L[L.length - 1].fn === fn;
    };
    const firstIsAuth = (path, m) => handlerList(path, m)[0]?.isAuth === true;

    check("active route is public (single handler = listActiveCoupons)",
      handlerList("/active", "get").length === 1 && lastIs("/active", "get", couponCtrl.listActiveCoupons),
      JSON.stringify(handlerList("/active", "get").map((h) => h.is)));
    check("validate route is auth + customer authorize + validators + validateCoupon",
      firstIsAuth("/validate", "post") && handlerList("/validate", "post").length > 3 && lastIs("/validate", "post", couponCtrl.validateCoupon),
      JSON.stringify(handlerList("/validate", "post").length));
    for (const [m, fn] of [["get", couponCtrl.listCoupons], ["post", couponCtrl.createCoupon]]) {
      // GET / stays lean (auth + admin + list); POST / carries body validators.
      const wantLen = m === "get" ? 3 : ">3";
      const lenOk = m === "get"
        ? handlerList("/", m).length === 3
        : handlerList("/", m).length > 3;
      check(`admin ${m.toUpperCase()} / has auth + admin + ${fn === couponCtrl.listCoupons ? "list" : "create"} (len ${wantLen})`,
        firstIsAuth("/", m) && lenOk && lastIs("/", m, fn),
        JSON.stringify(handlerList("/", m).length));
    }
    check("admin PATCH /:id is auth + admin + validators + updateCoupon",
      firstIsAuth("/:id", "patch") && handlerList("/:id", "patch").length > 3 && lastIs("/:id", "patch", couponCtrl.updateCoupon),
      JSON.stringify(handlerList("/:id", "patch").length));
    check("admin DELETE /:id is auth + admin + id check + deleteCoupon",
      firstIsAuth("/:id", "delete") && handlerList("/:id", "delete").length > 3 && lastIs("/:id", "delete", couponCtrl.deleteCoupon),
      JSON.stringify(handlerList("/:id", "delete").length));

    console.log("\n═══ COUPON VALIDATE (no mutation) ═══");
    {
      // 20% of ₹1000 → ₹200 off, ₹800 payable.
      const oF = Coupon.findOne;
      Coupon.findOne = stubFindOne(makeCoupon());
      const r = makeRes();
      try {
        await couponCtrl.validateCoupon({ body: { code: "bappa20", amount: 1000 }, user: { id: "u1" } }, r, next);
        check("valid coupon → 200 with discount + payable",
          r.statusCode === 200 && r.body.discount === 200 && r.body.payable === 800, `s=${r.statusCode} ${JSON.stringify(r.body)}`);
        check("code normalized to uppercase", r.body.code === "BAPPA20", r.body.code);
      } catch (e) { check("validate ok", false, e.message); }
      finally { Coupon.findOne = oF; }
    }
    {
      // maxDiscount cap: 20% of ₹3000 = ₹600 → capped at ₹500.
      const oF = Coupon.findOne;
      Coupon.findOne = stubFindOne(makeCoupon());
      const r = makeRes();
      try {
        await couponCtrl.validateCoupon({ body: { code: "BAPPA20", amount: 3000 }, user: { id: "u1" } }, r, next);
        check("discount capped at maxDiscount", r.body.discount === 500, `discount=${r.body && r.body.discount}`);
      } catch (e) { check("cap ok", false, e.message); }
      finally { Coupon.findOne = oF; }
    }
    {
      // Unknown code → 400.
      const oF = Coupon.findOne;
      Coupon.findOne = stubFindOne(null);
      const r = makeRes();
      try {
        await couponCtrl.validateCoupon({ body: { code: "NOPE", amount: 1000 }, user: { id: "u1" } }, r, next);
        check("unknown code → 400", r.statusCode === 400 && /not valid for this booking/i.test(r.body.message || ""), `s=${r.statusCode}`);
      } catch (e) { check("unknown code", false, e.message); }
      finally { Coupon.findOne = oF; }
    }
    {
      // Per-user limit exhausted → rejected.
      const uid = "000000000000000000000009";
      const oF = Coupon.findOne;
      Coupon.findOne = stubFindOne(makeCoupon({ usedBy: [new Types.ObjectId(uid)], perUserLimit: 1 }));
      const r = makeRes();
      try {
        await couponCtrl.validateCoupon({ body: { code: "BAPPA20", amount: 1000 }, user: { id: uid } }, r, next);
        check("per-user limit exhausted → 400", r.statusCode === 400, `s=${r.statusCode} ${r.body && r.body.message}`);
      } catch (e) { check("per-user limit", false, e.message); }
      finally { Coupon.findOne = oF; }
    }

    console.log("\n═══ COUPON ADMIN CRUD ═══");
    {
      // Create normalizes code (uppercase + trim) and stamps createdBy.
      const oC = Coupon.create;
      Coupon.create = async (d) => ({ _id: new Types.ObjectId(), ...d });
      const r = makeRes();
      try {
        await couponCtrl.createCoupon({ body: { code: "  bappa20 ", percent: "20" }, user: { id: "admin1" } }, r, next);
        check("create → 201 + normalized code", r.statusCode === 201 && r.body.code === "BAPPA20", `s=${r.statusCode} code=${r.body && r.body.code}`);
        check("create stamps createdBy = admin", r.body.createdBy === "admin1", String(r.body && r.body.createdBy));
      } catch (e) { check("create ok", false, e.message); }
      finally { Coupon.create = oC; }
    }
    {
      // Duplicate code (Mongo 11000) → friendly 409.
      const oC = Coupon.create;
      Coupon.create = async () => { const err = new Error("dup"); err.code = 11000; throw err; };
      const r = makeRes();
      try {
        await couponCtrl.createCoupon({ body: { code: "BAPPA20", percent: 20 }, user: { id: "admin1" } }, r, next);
        check("duplicate code → 409", r.statusCode === 409 && /already exists/i.test(r.body.message || ""), `s=${r.statusCode}`);
      } catch (e) { check("duplicate code", false, e.message); }
      finally { Coupon.create = oC; }
    }

    console.log("\n═══ COUPON UPDATE / DELETE ═══");
    {
      // Update strips usage/history fields and normalizes a new code.
      const oP = Coupon.findByIdAndUpdate;
      let stripped = null;
      Coupon.findByIdAndUpdate = async (id, editable) => { stripped = editable; return makeCoupon({ code: "FESTIVEAL", percent: 15 }); };
      const r = makeRes();
      try {
        await couponCtrl.updateCoupon(
          { params: { id: "c1" }, body: { code: "festiveal ", percent: 15, usedCount: 999, usedBy: ["zzz"], createdBy: "hack", active: true } },
          r, next
        );
        check("update → 200 with normalized code", r.statusCode === 200 && r.body.code === "FESTIVEAL", `s=${r.statusCode} code=${r.body && r.body.code}`);
        check("update strips usedCount/usedBy/createdBy",
          stripped && stripped.usedCount === undefined && stripped.usedBy === undefined && stripped.createdBy === undefined, JSON.stringify(stripped));
      } catch (e) { check("update ok", false, e.message); }
      finally { Coupon.findByIdAndUpdate = oP; }
    }
    {
      const oP = Coupon.findByIdAndUpdate;
      Coupon.findByIdAndUpdate = async () => null;
      const r = makeRes();
      try {
        await couponCtrl.updateCoupon({ params: { id: "nope" }, body: { percent: 10 } }, r, next);
        check("update missing → 404", r.statusCode === 404, `s=${r.statusCode}`);
      } catch (e) { check("update missing", false, e.message); }
      finally { Coupon.findByIdAndUpdate = oP; }
    }
    {
      // Delete: used coupons must be refused, unused ones removed.
      const oF = Coupon.findById;
      Coupon.findById = async () => makeCoupon({ usedCount: 3 });
      let r = makeRes();
      try {
        await couponCtrl.deleteCoupon({ params: { id: "used" } }, r, next);
        check("delete used coupon → 400", r.statusCode === 400, `s=${r.statusCode} ${r.body && r.body.message}`);
      } catch (e) { check("delete used", false, e.message); }
      const fresh = makeCoupon();
      let deleted = false;
      fresh.deleteOne = async () => { deleted = true; };
      Coupon.findById = async () => fresh;
      r = makeRes();
      try {
        await couponCtrl.deleteCoupon({ params: { id: fresh._id } }, r, next);
        check("delete unused coupon → removed", r.statusCode === 200 && deleted, `s=${r.statusCode} deleted=${deleted}`);
      } catch (e) { check("delete unused", false, e.message); }
      finally { Coupon.findById = oF; }
    }

    console.log("\n═══ COUPON ACTIVE LIST ═══");
    {
      const oF = Coupon.find;
      let seenFilter = null;
      Coupon.find = (f) => { seenFilter = f; return stubFind([makeCoupon(), makeCoupon({ code: "FESTIVE15", percent: 15 })])(); };
      const r = makeRes();
      try {
        await couponCtrl.listActiveCoupons({}, r, next);
        check("active list → 200 array", r.statusCode === 200 && Array.isArray(r.body) && r.body.length === 2, `s=${r.statusCode}`);
        const dumped = JSON.stringify(seenFilter || {});
        check(
          "active list filters active + valid + under-limit",
          seenFilter?.active === true &&
            /validTo/.test(dumped) && /usageLimit|usedCount/.test(dumped),
          dumped.slice(0, 120)
        );
      } catch (e) { check("active list", false, e.message); }
      finally { Coupon.find = oF; }
    }
  } catch (error) {
    check("coupon suite did not throw", false, (error && error.message) || String(error));
  }

  console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();