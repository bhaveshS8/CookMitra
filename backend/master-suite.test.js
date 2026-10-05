process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const mongoose = require("mongoose");
const { Types } = mongoose;
const jwt = require("jsonwebtoken");
const User = require("./models/User");
const Notification = require("./models/Notification");
const CookProfile = require("./models/CookProfile");
const Booking = require("./models/Booking");
const Review = require("./models/Review");
const Availability = require("./models/Availability");
const authCtrl = require("./controllers/authController");
const cookCtrl = require("./controllers/cookController");
const bookingCtrl = require("./controllers/bookingController");

let failures = 0, passes = 0;
const check = (n, ok, d) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`);
  ok ? passes++ : failures++;
};
const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
};
const next = (err) => { if (err) throw err || new Error("next()"); };

const Q = (doc) => ({
  select: () => Q(doc),
  populate: () => Q(doc),
  sort: () => Q(doc),
  limit: () => Q(doc),
  skip: () => Q(doc),
  lean: () => Q(doc),
  then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject),
});
const stubFindOne = (doc) => () => Q(doc);

const makeUser = (role, status = "active") => ({
  _id: new Types.ObjectId(),
  name: "Test User",
  email: "t@e.com",
  phone: "9876543210",
  role,
  status,
  comparePassword: async (p) => p === "pass123",
  save: async function () { return this; },
});

async function testAuth() {
  console.log("\n═══ AUTH ═══");
  const mu = makeUser("customer");

  { const oC = User.create, oF = User.findOne; User.findOne = async () => null; User.create = async (d) => ({ _id: new Types.ObjectId(), ...d }); const r = makeRes(); try { await authCtrl.register({ body: { name: "New", email: "new@e.com", password: "pass1234", phone: "9876543210", role: "customer" } }, r, next); check("1.1 Register ok", r.statusCode === 201 && r.body?.token, `s=${r.statusCode}`); } catch (e) { check("1.1 Register ok", false, e.message); } finally { User.create = oC; User.findOne = oF; } }

  { const oF = User.findOne; User.findOne = async () => mu; const r = makeRes(); try { await authCtrl.register({ body: { name: "T", email: "t@e.com", password: "p" } }, r, next); check("1.2 Dup email fails", r.statusCode === 400, `s=${r.statusCode}`); } catch (e) { check("1.2 Dup email fails", false, e.message); } finally { User.findOne = oF; } }

  { const oF = User.findOne; User.findOne = stubFindOne(mu); const r = makeRes(); try { await authCtrl.login({ body: { email: "t@e.com", password: "pass123" } }, r, next); const d = jwt.decode(r.body.token); check("1.3 Login ok", r.statusCode === 200 && r.body?.token, `s=${r.statusCode}`); check("1.3 token role embedded", d && d.role === "customer", JSON.stringify(d && { role: d.role })); } catch (e) { check("1.3 Login ok", false, e.message); } finally { User.findOne = oF; } }

  { const oF = User.findOne; User.findOne = stubFindOne(mu); const r = makeRes(); try { await authCtrl.login({ body: { email: "t@e.com", password: "wrong" } }, r, next); check("1.4 Wrong password -> 401", r.statusCode === 401, `s=${r.statusCode}`); } catch (e) { check("1.4 Wrong password -> 401", false, e.message); } finally { User.findOne = oF; } }

  { const oF = User.findOne; User.findOne = stubFindOne({ ...mu, status: "suspended" }); const r = makeRes(); try { await authCtrl.login({ body: { email: "t@e.com", password: "pass123" } }, r, next); check("1.5 Suspended -> 403", r.statusCode === 403 && !r.body.token, `s=${r.statusCode}`); } catch (e) { check("1.5 Suspended -> 403", false, e.message); } finally { User.findOne = oF; } }

  { const oF = User.findById; const doc = { ...mu, password: "secret-hash" }; User.findById = async () => doc; const r = makeRes(); try { await authCtrl.getMe({ user: { id: mu._id.toString() } }, r, next); check("1.6 getMe -> 200", r.statusCode === 200 && r.body?.email === "t@e.com", `s=${r.statusCode}`); check("1.6 getMe omits password", r.body.password === undefined, JSON.stringify(r.body)); } catch (e) { check("1.6 getMe", false, e.message); } finally { User.findById = oF; } }

  { const oF = User.findByIdAndUpdate; User.findByIdAndUpdate = async () => ({ ...mu, name: "Upd" }); const r = makeRes(); try { await authCtrl.updateProfile({ user: { id: mu._id.toString() }, body: { name: "Upd" } }, r, next); check("1.7 updateProfile -> 200", r.statusCode === 200 && r.body?.name === "Upd", `s=${r.statusCode}`); } catch (e) { check("1.7 updateProfile", false, e.message); } finally { User.findByIdAndUpdate = oF; } }
}

async function testAdmin() {
  console.log("\n═══ ADMIN ═══");

  { const oF = User.findById, oN = Notification.create; const tid = new Types.ObjectId(); let saved = null; User.findById = async () => ({ _id: tid, role: "customer", status: "active", save: async function () { saved = this; return this; } }); Notification.create = async () => ({}); const r = makeRes(); try { await authCtrl.adminSetUserStatus({ params: { id: tid.toString() }, user: { id: new Types.ObjectId().toString(), role: "admin" }, body: { status: "suspended" } }, r, next); check("2.1 admin block -> 200", r.statusCode === 200, `s=${r.statusCode}`); check("2.1 account suspended", saved && saved.status === "suspended", String(saved && saved.status)); } catch (e) { check("2.1 admin block", false, e.message); } finally { User.findById = oF; Notification.create = oN; } }

  { const oF = User.findById; const aid = new Types.ObjectId(); User.findById = async () => ({ _id: aid, role: "admin", status: "active" }); const r = makeRes(); try { await authCtrl.adminSetUserStatus({ params: { id: aid.toString() }, user: { id: aid.toString(), role: "admin" }, body: { status: "suspended" } }, r, next); check("2.2 no self-block -> 400", r.statusCode === 400, `s=${r.statusCode}`); } catch (e) { check("2.2 no self-block", false, e.message); } finally { User.findById = oF; } }

  { const oF = User.findById, oCP = CookProfile.deleteMany, oAV = Availability.deleteMany, oN = Notification.deleteMany, oR = Review.deleteMany, oB = Booking.deleteMany, oC = Booking.countDocuments; const uid = new Types.ObjectId(); let deleted = false; User.findById = async () => ({ _id: uid, role: "customer", deleteOne: async () => { deleted = true; return { deletedCount: 1 }; } }); CookProfile.deleteMany = async () => ({ deletedCount: 0 }); Availability.deleteMany = async () => ({ deletedCount: 0 }); Notification.deleteMany = async () => ({ deletedCount: 0 }); Review.deleteMany = async () => ({ deletedCount: 0 }); Booking.deleteMany = async () => ({ deletedCount: 0 }); Booking.countDocuments = async () => 0; const r = makeRes(); try { await authCtrl.adminDeleteUser({ params: { id: uid.toString() }, user: { id: new Types.ObjectId().toString(), role: "admin" }, body: {} }, r, next); check("2.3 admin delete -> 200", r.statusCode === 200 && deleted, `s=${r.statusCode}`); } catch (e) { check("2.3 admin delete", false, e.message); } finally { User.findById = oF; CookProfile.deleteMany = oCP; Availability.deleteMany = oAV; Notification.deleteMany = oN; Review.deleteMany = oR; Booking.deleteMany = oB; Booking.countDocuments = oC; } }

  { const oF = User.findById, oB = Booking.deleteMany, oC = Booking.countDocuments; const uid = new Types.ObjectId(); let deleted = false; User.findById = async () => ({ _id: uid, role: "customer", name: "X", email: "x@e.com", deleteOne: async () => { deleted = true; return { deletedCount: 1 }; } }); Booking.countDocuments = async () => 3; Booking.deleteMany = async () => { throw new Error("must not cascade-delete bookings"); }; const r = makeRes(); try { await authCtrl.adminDeleteUser({ params: { id: uid.toString() }, user: { id: new Types.ObjectId().toString(), role: "admin" }, body: {} }, r, next); check("2.3b delete with bookings -> 400, nothing deleted", r.statusCode === 400 && !deleted && r.body?.code === "ACCOUNT_HAS_FINANCIAL_HISTORY", `s=${r.statusCode}`); } catch (e) { check("2.3b delete with bookings", false, e.message); } finally { User.findById = oF; Booking.deleteMany = oB; Booking.countDocuments = oC; } }

  { const oF = User.findById, oAV = Availability.deleteMany, oC = Booking.countDocuments; const uid = new Types.ObjectId(); const doc = { _id: uid, role: "customer", name: "X", email: "x@e.com", phone: "9876543210", tokenVersion: 0, save: async function () { return this; } }; User.findById = async () => doc; Booking.countDocuments = async () => 2; Availability.deleteMany = async () => ({ deletedCount: 1 }); const r = makeRes(); try { await authCtrl.adminDeleteUser({ params: { id: uid.toString() }, user: { id: new Types.ObjectId().toString(), role: "admin" }, body: { anonymize: true } }, r, next); check("2.3c anonymize -> 200, scrubbed+suspended", r.statusCode === 200 && r.body?.anonymized === true && doc.status === "suspended" && doc.phone === "" && doc.tokenVersion === 1, `s=${r.statusCode}`); } catch (e) { check("2.3c anonymize", false, e.message); } finally { User.findById = oF; Availability.deleteMany = oAV; Booking.countDocuments = oC; } }

  { const oF = User.findById; User.findById = async () => null; const r = makeRes(); try { await authCtrl.adminDeleteUser({ params: { id: new Types.ObjectId().toString() }, user: { id: new Types.ObjectId().toString(), role: "admin" } }, r, next); check("2.4 admin delete 404", r.statusCode === 404, `s=${r.statusCode}`); } catch (e) { check("2.4 admin delete 404", false, e.message); } finally { User.findById = oF; } }

  { const oF = CookProfile.findByIdAndUpdate, oN = Notification.create; const pid = new Types.ObjectId(); CookProfile.findByIdAndUpdate = async () => ({ _id: pid, user: new Types.ObjectId(), approvalStatus: "approved" }); Notification.create = async () => ({}); const r = makeRes(); try { await cookCtrl.updateApprovalStatus({ params: { id: pid.toString() }, user: { id: new Types.ObjectId().toString(), role: "admin" }, body: { status: "approved" } }, r, next); check("2.5 admin approve cook -> 200", r.statusCode === 200 && r.body?.approvalStatus === "approved", `s=${r.statusCode}`); } catch (e) { check("2.5 admin approve cook", false, e.message); } finally { CookProfile.findByIdAndUpdate = oF; Notification.create = oN; } }
}

async function testCook() {
  console.log("\n═══ COOK ═══");
  const mp = {
    _id: new Types.ObjectId(),
    user: { _id: new Types.ObjectId(), name: "Priya", phone: "9876543210", status: "active" },
    serviceArea: "Pune",
    approvalStatus: "approved",
  };

  { const oF = CookProfile.find; CookProfile.find = () => Q([mp]); const r = makeRes(); try { await cookCtrl.getCooks({ query: {} }, r, next); check("3.1 getCooks -> 200 array", r.statusCode === 200 && Array.isArray(r.body), `s=${r.statusCode}`); } catch (e) { check("3.1 getCooks", false, e.message); } finally { CookProfile.find = oF; } }

  { const oF = CookProfile.findById, oO = CookProfile.findOne; CookProfile.findById = () => Q(mp); CookProfile.findOne = () => Q(null); const r = makeRes(); try { await cookCtrl.getCook({ params: { id: mp._id.toString() } }, r, next); check("3.2 getCook -> 200 populated", r.statusCode === 200 && r.body?.user?.name === "Priya", `s=${r.statusCode}`); } catch (e) { check("3.2 getCook", false, e.message); } finally { CookProfile.findById = oF; CookProfile.findOne = oO; } }

  { const oF = CookProfile.findById, oO = CookProfile.findOne; CookProfile.findById = () => Q(null); CookProfile.findOne = () => Q(null); const r = makeRes(); try { await cookCtrl.getCook({ params: { id: new Types.ObjectId().toString() } }, r, next); check("3.3 getCook 404", r.statusCode === 404, `s=${r.statusCode}`); } catch (e) { check("3.3 getCook 404", false, e.message); } finally { CookProfile.findById = oF; CookProfile.findOne = oO; } }

  { const oC = CookProfile.create, oF = CookProfile.findOne; CookProfile.findOne = async () => null; CookProfile.create = async (d) => ({ _id: new Types.ObjectId(), ...d }); const r = makeRes(); try { await cookCtrl.createCookProfile({ user: { id: new Types.ObjectId().toString() }, body: { serviceArea: "Mumbai" } }, r, next); check("3.4 createCookProfile -> 201", r.statusCode === 201 && r.body?._id, `s=${r.statusCode}`); } catch (e) { check("3.4 createCookProfile", false, e.message); } finally { CookProfile.create = oC; CookProfile.findOne = oF; } }

  { let created = null; const oC = CookProfile.create, oF = CookProfile.findOne; const uid = new Types.ObjectId().toString(); CookProfile.findOne = async () => null; CookProfile.create = async (d) => { created = d; return { _id: new Types.ObjectId(), ...d }; }; const r = makeRes(); try { await cookCtrl.createCookProfile({ user: { id: uid }, body: { serviceArea: "Mumbai", approvalStatus: "approved", rating: { average: 5, count: 99 }, user: new Types.ObjectId().toString() } }, r, next); check("3.4b create blocks self-approve/rating/user", r.statusCode === 201 && created?.approvalStatus === "pending" && created?.rating === undefined && created?.user === uid, `s=${r.statusCode} approval=${created?.approvalStatus} user=${created?.user === uid}`); } catch (e) { check("3.4b create blocks self-approve/rating/user", false, e.message); } finally { CookProfile.create = oC; CookProfile.findOne = oF; } }
  { const oF = CookProfile.findOneAndUpdate; CookProfile.findOneAndUpdate = async (f, b) => ({ _id: mp._id, user: mp.user._id, serviceArea: "Mumbai", ...b }); const r = makeRes(); try { await cookCtrl.updateCookProfile({ user: { id: mp.user._id.toString() }, params: { id: mp._id.toString() }, body: { serviceArea: "Mumbai" } }, r, next); check("3.5 updateCookProfile -> 200", r.statusCode === 200 && r.body?.serviceArea === "Mumbai", `s=${r.statusCode}`); } catch (e) { check("3.5 updateCookProfile", false, e.message); } finally { CookProfile.findOneAndUpdate = oF; } }
  { let filter = null, update = null; const oF = CookProfile.findOneAndUpdate; CookProfile.findOneAndUpdate = async (f, b) => { filter = f; update = b; return { _id: mp._id, user: mp.user._id, serviceArea: "Pune", approvalStatus: "approved", ...b }; }; const r = makeRes(); try { await cookCtrl.updateCookProfile({ user: { id: mp.user._id.toString() }, params: { id: mp._id.toString() }, body: { serviceArea: "Mumbai", approvalStatus: "rejected", rating: { average: 5, count: 42 }, user: new Types.ObjectId().toString(), liveLocation: { lat: 1, lng: 1 } } }, r, next); check("3.5b update strips approvalStatus/rating/user/liveLocation", r.statusCode === 200 && update?.serviceArea === "Mumbai" && update?.approvalStatus === undefined && update?.rating === undefined && update?.user === undefined && update?.liveLocation === undefined, `s=${r.statusCode} keys=${Object.keys(update || {}).join(",")}`); } catch (e) { check("3.5b update strips admin-only fields", false, e.message); } finally { CookProfile.findOneAndUpdate = oF; } }
}

async function testCustomer() {
  console.log("\n═══ CUSTOMER ═══");
  const win = { _id: new Types.ObjectId(), startTime: "09:00", endTime: "11:00" };

  {
    const oCP = CookProfile.findOne, oCPF = CookProfile.find, oAF = Availability.find, oBF = Booking.find, oBC = Booking.create, oN = Notification.create, oUF = User.findById;
    const slots = require("./utils/slots");
    const oW = slots.getDayWindows, oA = slots.resolveCookAvailability;
    slots.getDayWindows = async () => [{ startTime: "08:00", endTime: "20:00" }];
    slots.resolveCookAvailability = async () => true;
    let createdDoc = null;
    const userId = new Types.ObjectId().toString();
    const cookId = new Types.ObjectId().toString();
    CookProfile.findOne = async () => ({ rate: 500, liveLocation: null });
    CookProfile.find = () => ({ populate: () => ({ lean: async () => [{ user: { _id: cookId, name: "Chef", status: "active" }, approvalStatus: "approved", serviceTypes: [] }] }) });
    Availability.find = () => ({ sort: () => Promise.resolve([win]) });
    Booking.find = () => ({ select: () => ({ lean: async () => [] }) });
    Booking.create = async (d) => { createdDoc = d; return { _id: new Types.ObjectId(), ...d, toObject: () => createdDoc }; };
    Notification.create = async (d) => d;
    User.findById = () => ({ select: () => Promise.resolve({ name: "Neha", phone: "9876543210" }) });
    const r = makeRes();
    try {
      const d30 = new Date();
      d30.setDate(d30.getDate() + 30);
      const pp = (n) => String(n).padStart(2, "0");
      const FUTURE_DATE = `${d30.getFullYear()}-${pp(d30.getMonth() + 1)}-${pp(d30.getDate())}`;
      await bookingCtrl.createBooking(
        {
          user: { id: userId, name: "Neha" },
          body: {
            cook: cookId, serviceType: "cook_for_me", date: FUTURE_DATE,
            startTime: "09:00", endTime: "11:00", durationHours: 2, address: "Pune",
            customer: new Types.ObjectId().toString(),
            cookArrived: true, hoursCompleted: true,
            cookLocation: { lat: 12.34, lng: 56.78 },
            status: "completed",
          },
        },
        r, next
      );
      check("4.1 booking create ignores customer tamper", r.statusCode === 201 && String(createdDoc.customer) === userId && createdDoc.cook === null, `s=${r.statusCode} customer=${String(createdDoc?.customer) === userId} cook=${createdDoc?.cook}`);
      check("4.1 booking create ignores injected lifecycle flags", createdDoc?.status === "requested" && createdDoc?.cookArrived === undefined && createdDoc?.hoursCompleted === undefined && createdDoc?.cookLocation === undefined && createdDoc?.payment?.status === "pending", `status=${createdDoc?.status} arrived=${createdDoc?.cookArrived}`);
    } catch (e) { check("4.1 booking create escalation", false, e.message); }
    finally { CookProfile.findOne = oCP; CookProfile.find = oCPF; Availability.find = oAF; Booking.find = oBF; Booking.create = oBC; Notification.create = oN; User.findById = oUF; slots.getDayWindows = oW; slots.resolveCookAvailability = oA; }
  }

  {
    const oF = Booking.findById, oN = Notification.create;
    Booking.findById = async () => ({ _id: "b1", customer: "cust1", cook: "cook1", status: "rejected", save: async () => {}, toObject: () => ({ status: "rejected" }) });
    Notification.create = async () => ({});
    const r = makeRes();
    try { await bookingCtrl.cancelBooking({ params: { id: "b1" }, user: { id: "cust1" } }, r, next); check("4.2 cancel of rejected booking refused 400", r.statusCode === 400, `s=${r.statusCode}`); } catch (e) { check("4.2 cancel of rejected booking refused 400", false, e.message); }
    finally { Booking.findById = oF; Notification.create = oN; }
  }

  {
    const oF = Booking.findById, oN = Notification.create;
    Booking.findById = async () => ({ _id: "b1", customer: "cust2", cook: "cook1", status: "requested", save: async () => {}, toObject: () => ({ status: "requested" }) });
    Notification.create = async () => ({});
    const r = makeRes();
    try { await bookingCtrl.cancelBooking({ params: { id: "b1" }, user: { id: "cust1" } }, r, next); check("4.3 cross-account cancel -> 403", r.statusCode === 403, `s=${r.statusCode}`); } catch (e) { check("4.3 cross-account cancel", false, e.message); }
    finally { Booking.findById = oF; Notification.create = oN; }
  }
}

(async () => {
  try {
    await testAuth();
    await testAdmin();
    await testCook();
    await testCustomer();
  } catch (e) {
    check("master suite did not throw", false, (e && e.message) || String(e));
  }
  console.log(`\nmaster-suite: ${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
