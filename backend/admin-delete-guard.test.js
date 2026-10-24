// Admin-deletion financial-history guard — regression suite.
//
// Proves: (1) a user with ANY booking row (customer or cook) is rejected
// with 400 + ACCOUNT_HAS_FINANCIAL_HISTORY; (2) a rejected deletion
// performs ZERO destructive operations (no deleteMany, no deleteOne);
// (3) a user with no bookings still deletes exactly as before; (4) admin
// accounts and missing users keep their existing responses.
// (5) `{ anonymize: true }` with history scrubs identifiers, suspends,
// and revokes sessions while preserving ALL financial records
// (bookings, cook profile, notifications, reviews untouched); repeated
// anonymize stays safe; the flag is a no-op without history; admin
// targets stay 403.
//
// Hermetic: all models stubbed in-memory. No DB, no network.
// Run: node backend/admin-delete-guard.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const mongoose = require("mongoose");
const { Types } = mongoose;
const User = require("./models/User");
const CookProfile = require("./models/CookProfile");
const Availability = require("./models/Availability");
const Booking = require("./models/Booking");
const Review = require("./models/Review");
const Notification = require("./models/Notification");
const authCtrl = require("./controllers/authController");

let passes = 0; let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); ok ? passes++ : failures++; };
const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (p) => { r.body = p; return r; };
  return r;
};
const next = (err) => { if (err) throw err || new Error("next()"); };
const ADMIN = { id: new Types.ObjectId().toString(), role: "admin" };

// Wrap a model method with a call counter, restoring afterwards.
const spyCalls = () => {
  const counts = { cookProfile: 0, availability: 0, notification: 0, review: 0, booking: 0, deleteOne: 0 };
  const orig = {
    cp: CookProfile.deleteMany, av: Availability.deleteMany,
    nt: Notification.deleteMany, rv: Review.deleteMany, bk: Booking.deleteMany,
  };
  CookProfile.deleteMany = async () => { counts.cookProfile += 1; return { deletedCount: 0 }; };
  Availability.deleteMany = async () => { counts.availability += 1; return { deletedCount: 0 }; };
  Notification.deleteMany = async () => { counts.notification += 1; return { deletedCount: 0 }; };
  Review.deleteMany = async () => { counts.review += 1; return { deletedCount: 0 }; };
  Booking.deleteMany = async () => { counts.booking += 1; return { deletedCount: 0 }; };
  const restore = () => {
    CookProfile.deleteMany = orig.cp; Availability.deleteMany = orig.av;
    Notification.deleteMany = orig.nt; Review.deleteMany = orig.rv; Booking.deleteMany = orig.bk;
  };
  return { counts, restore };
};
const noDeletes = (c) =>
  c.cookProfile === 0 && c.availability === 0 && c.notification === 0 &&
  c.review === 0 && c.booking === 0 && c.deleteOne === 0;

(async () => {
  // 1. Customer with booking history -> 400 + code, zero deletes.
  {
    const oF = User.findById, oC = Booking.countDocuments;
    const uid = new Types.ObjectId();
    User.findById = async () => ({ _id: uid, role: "customer", name: "X", email: "x@e.com", deleteOne: async () => { throw new Error("must not delete"); } });
    Booking.countDocuments = async () => 3;
    const s = spyCalls();
    const r = makeRes();
    try {
      await authCtrl.adminDeleteUser({ params: { id: uid.toString() }, user: ADMIN, body: {} }, r, next);
      check("customer with history rejected 400", r.statusCode === 400, `s=${r.statusCode}`);
      check("rejection carries code", r.body?.code === "ACCOUNT_HAS_FINANCIAL_HISTORY", String(r.body?.code));
      check("rejection performed zero deletes", noDeletes(s.counts), JSON.stringify(s.counts));
    } catch (e) { check("customer with history rejected 400", false, e.message); }
    finally { User.findById = oF; Booking.countDocuments = oC; s.restore(); }
  }

  // 2. Cook with a single booking row -> 400, zero deletes.
  {
    const oF = User.findById, oC = Booking.countDocuments;
    const uid = new Types.ObjectId();
    let filter = null;
    User.findById = async () => ({ _id: uid, role: "cook", name: "C", email: "c@e.com", deleteOne: async () => { throw new Error("must not delete"); } });
    Booking.countDocuments = async (f) => { filter = f; return 1; };
    const s = spyCalls();
    const r = makeRes();
    try {
      await authCtrl.adminDeleteUser({ params: { id: uid.toString() }, user: ADMIN, body: {} }, r, next);
      const coversCook = filter && filter.$or && filter.$or.some((c) => c.cook !== undefined);
      check("cook with history rejected 400", r.statusCode === 400 && r.body?.code === "ACCOUNT_HAS_FINANCIAL_HISTORY", `s=${r.statusCode}`);
      check("guard covers cook bookings", coversCook === true, JSON.stringify(filter));
      check("cook rejection performed zero deletes", noDeletes(s.counts), JSON.stringify(s.counts));
    } catch (e) { check("cook with history rejected 400", false, e.message); }
    finally { User.findById = oF; Booking.countDocuments = oC; s.restore(); }
  }

  // 3. No bookings -> deletes exactly as before (200).
  {
    const oF = User.findById, oC = Booking.countDocuments;
    const uid = new Types.ObjectId();
    let deleted = false;
    User.findById = async () => ({ _id: uid, role: "customer", name: "Y", email: "y@e.com", deleteOne: async () => { deleted = true; return { deletedCount: 1 }; } });
    Booking.countDocuments = async () => 0;
    const oCP = CookProfile.deleteMany, oAV = Availability.deleteMany, oN = Notification.deleteMany,
      oR = Review.deleteMany, oB = Booking.deleteMany;
    CookProfile.deleteMany = async () => ({ deletedCount: 0 });
    Availability.deleteMany = async () => ({ deletedCount: 0 });
    Notification.deleteMany = async () => ({ deletedCount: 0 });
    Review.deleteMany = async () => ({ deletedCount: 0 });
    Booking.deleteMany = async () => ({ deletedCount: 0 });
    const r = makeRes();
    try {
      await authCtrl.adminDeleteUser({ params: { id: uid.toString() }, user: ADMIN, body: {} }, r, next);
      check("no-history delete still 200", r.statusCode === 200 && deleted, `s=${r.statusCode}`);
    } catch (e) { check("no-history delete still 200", false, e.message); }
    finally {
      User.findById = oF; Booking.countDocuments = oC;
      CookProfile.deleteMany = oCP; Availability.deleteMany = oAV; Notification.deleteMany = oN;
      Review.deleteMany = oR; Booking.deleteMany = oB;
    }
  }

  // 4. Admin target keeps its existing 403 (guard never reached).
  {
    const oF = User.findById, oC = Booking.countDocuments;
    const aid = new Types.ObjectId();
    let counted = 0;
    User.findById = async () => ({ _id: aid, role: "admin", status: "active" });
    Booking.countDocuments = async () => { counted += 1; return 99; };
    const r = makeRes();
    try {
      await authCtrl.adminDeleteUser({ params: { id: aid.toString() }, user: { id: new Types.ObjectId().toString(), role: "admin" }, body: { status: "suspended" } }, r, next);
      check("admin target still 403", r.statusCode === 403, `s=${r.statusCode}`);
      check("admin check precedes guard", counted === 0, `countDocuments calls=${counted}`);
    } catch (e) { check("admin target still 403", false, e.message); }
    finally { User.findById = oF; Booking.countDocuments = oC; }
  }

  // 5. Missing user keeps its existing 404.
  {
    const oF = User.findById;
    User.findById = async () => null;
    const r = makeRes();
    try {
      await authCtrl.adminDeleteUser({ params: { id: new Types.ObjectId().toString() }, user: ADMIN, body: {} }, r, next);
      check("missing user still 404", r.statusCode === 404, `s=${r.statusCode}`);
    } catch (e) { check("missing user still 404", false, e.message); }
    finally { User.findById = oF; }
  }

  // 6. History + anonymize -> 200 scrubbed+suspended, financial records kept.
  {
    const oF = User.findById, oC = Booking.countDocuments;
    const oAV = Availability.deleteMany, oCP = CookProfile.deleteMany,
      oN = Notification.deleteMany, oR = Review.deleteMany, oB = Booking.deleteMany;
    const uid = new Types.ObjectId();
    const doc = {
      _id: uid, role: "customer", name: "X Real Name", email: "x@e.com",
      phone: "9876543210", mobile: "9876543210", address: "12 MG Road",
      avatar: "https://img/u.png", googleId: "g-123", authProvider: "local+google",
      emailVerified: true, phoneVerified: true, savedAddresses: [{ label: "Home" }],
      resetPasswordToken: "tok", resetPasswordExpires: new Date(),
      status: "active", tokenVersion: 0,
      save: async function () { return this; },
    };
    let deleted = false;
    doc.deleteOne = async () => { deleted = true; throw new Error("must not hard-delete"); };
    User.findById = async () => doc;
    Booking.countDocuments = async () => 2;
    const calls = { availability: 0, cookProfile: 0, notification: 0, review: 0, booking: 0 };
    Availability.deleteMany = async () => { calls.availability += 1; return { deletedCount: 1 }; };
    CookProfile.deleteMany = async () => { calls.cookProfile += 1; return { deletedCount: 0 }; };
    Notification.deleteMany = async () => { calls.notification += 1; return { deletedCount: 0 }; };
    Review.deleteMany = async () => { calls.review += 1; return { deletedCount: 0 }; };
    Booking.deleteMany = async () => { calls.booking += 1; return { deletedCount: 0 }; };
    const r = makeRes();
    try {
      await authCtrl.adminDeleteUser({ params: { id: uid.toString() }, user: ADMIN, body: { anonymize: true } }, r, next);
      check("anonymize with history -> 200 + flag", r.statusCode === 200 && r.body?.anonymized === true, `s=${r.statusCode}`);
      check("account suspended + sessions revoked", doc.status === "suspended" && doc.tokenVersion === 1, `${doc.status}/${doc.tokenVersion}`);
      check("direct identifiers scrubbed", doc.phone === "" && doc.mobile === "" && doc.name === "Deleted User" && doc.address === "" && doc.avatar === "" && doc.googleId === undefined, `${doc.phone}/${doc.mobile}/${doc.name}`);
      check("email replaced by unique placeholder", doc.email === `deleted-${String(uid).toLowerCase()}@deleted.local`, doc.email);
      check("addresses + reset tokens cleared", Array.isArray(doc.savedAddresses) && doc.savedAddresses.length === 0 && !doc.resetPasswordToken && doc.emailVerified === false, JSON.stringify(doc.savedAddresses));
      check("availability removed (no future matching)", calls.availability === 1, `${calls.availability}`);
      check("financial records untouched", calls.booking === 0 && calls.cookProfile === 0 && calls.notification === 0 && calls.review === 0 && deleted === false, JSON.stringify(calls));
    } catch (e) { check("anonymize with history -> 200 + flag", false, e.message); }
    finally {
      User.findById = oF; Booking.countDocuments = oC;
      Availability.deleteMany = oAV; CookProfile.deleteMany = oCP;
      Notification.deleteMany = oN; Review.deleteMany = oR; Booking.deleteMany = oB;
    }
  }

  // 7. Repeated anonymize -> 200 again, records still intact.
  {
    const oF = User.findById, oC = Booking.countDocuments;
    const oAV = Availability.deleteMany, oB = Booking.deleteMany;
    const uid = new Types.ObjectId();
    const doc = {
      _id: uid, role: "customer", name: "Deleted User",
      email: `deleted-${String(uid).toLowerCase()}@deleted.local`,
      phone: "", mobile: "", status: "suspended", tokenVersion: 1,
      save: async function () { return this; },
    };
    User.findById = async () => doc;
    Booking.countDocuments = async () => 2; // bookings preserved -> still counted
    Availability.deleteMany = async () => ({ deletedCount: 0 });
    let bookingDeletes = 0;
    Booking.deleteMany = async () => { bookingDeletes += 1; return { deletedCount: 0 }; };
    const r = makeRes();
    try {
      await authCtrl.adminDeleteUser({ params: { id: uid.toString() }, user: ADMIN, body: { anonymize: true } }, r, next);
      check("repeat anonymize -> 200, stays suspended", r.statusCode === 200 && r.body?.anonymized === true && doc.status === "suspended", `s=${r.statusCode}`);
      check("repeat anonymize never touches bookings", bookingDeletes === 0, `${bookingDeletes}`);
    } catch (e) { check("repeat anonymize -> 200, stays suspended", false, e.message); }
    finally { User.findById = oF; Booking.countDocuments = oC; Availability.deleteMany = oAV; Booking.deleteMany = oB; }
  }

  // 8. No history + anonymize flag -> plain hard delete as before (flag is a no-op).
  {
    const oF = User.findById, oC = Booking.countDocuments;
    const oCP = CookProfile.deleteMany, oAV = Availability.deleteMany, oN = Notification.deleteMany,
      oR = Review.deleteMany, oB = Booking.deleteMany;
    const uid = new Types.ObjectId();
    let deleted = false;
    User.findById = async () => ({ _id: uid, role: "customer", name: "Y", email: "y@e.com", deleteOne: async () => { deleted = true; return { deletedCount: 1 }; } });
    Booking.countDocuments = async () => 0;
    CookProfile.deleteMany = async () => ({ deletedCount: 0 });
    Availability.deleteMany = async () => ({ deletedCount: 0 });
    Notification.deleteMany = async () => ({ deletedCount: 0 });
    Review.deleteMany = async () => ({ deletedCount: 0 });
    Booking.deleteMany = async () => ({ deletedCount: 0 });
    const r = makeRes();
    try {
      await authCtrl.adminDeleteUser({ params: { id: uid.toString() }, user: ADMIN, body: { anonymize: true } }, r, next);
      check("no-history anonymize still hard-deletes 200", r.statusCode === 200 && deleted && r.body?.anonymized !== true, `s=${r.statusCode}`);
    } catch (e) { check("no-history anonymize still hard-deletes 200", false, e.message); }
    finally {
      User.findById = oF; Booking.countDocuments = oC;
      CookProfile.deleteMany = oCP; Availability.deleteMany = oAV; Notification.deleteMany = oN;
      Review.deleteMany = oR; Booking.deleteMany = oB;
    }
  }

  // 9. Cook with history + anonymize -> 200, cook profile (payout details) kept.
  {
    const oF = User.findById, oC = Booking.countDocuments;
    const oAV = Availability.deleteMany, oCP = CookProfile.deleteMany, oB = Booking.deleteMany;
    const uid = new Types.ObjectId();
    const doc = {
      _id: uid, role: "cook", name: "Chef C", email: "c@e.com",
      phone: "9123456780", mobile: "9123456780", status: "active", tokenVersion: 0,
      save: async function () { return this; },
    };
    User.findById = async () => doc;
    Booking.countDocuments = async () => 1;
    Availability.deleteMany = async () => ({ deletedCount: 2 });
    let profileDeletes = 0;
    CookProfile.deleteMany = async () => { profileDeletes += 1; return { deletedCount: 0 }; };
    let bookingDeletes = 0;
    Booking.deleteMany = async () => { bookingDeletes += 1; return { deletedCount: 0 }; };
    const r = makeRes();
    try {
      await authCtrl.adminDeleteUser({ params: { id: uid.toString() }, user: ADMIN, body: { anonymize: true } }, r, next);
      check("cook anonymize -> 200 suspended", r.statusCode === 200 && doc.status === "suspended" && doc.phone === "", `s=${r.statusCode}`);
      check("cook profile + bookings preserved for payouts", profileDeletes === 0 && bookingDeletes === 0, `${profileDeletes}/${bookingDeletes}`);
    } catch (e) { check("cook anonymize -> 200 suspended", false, e.message); }
    finally { User.findById = oF; Booking.countDocuments = oC; Availability.deleteMany = oAV; CookProfile.deleteMany = oCP; Booking.deleteMany = oB; }
  }

  // 10. Admin target + anonymize -> still 403, guard never reached.
  {
    const oF = User.findById, oC = Booking.countDocuments;
    const aid = new Types.ObjectId();
    let counted = 0;
    User.findById = async () => ({ _id: aid, role: "admin", status: "active" });
    Booking.countDocuments = async () => { counted += 1; return 99; };
    const r = makeRes();
    try {
      await authCtrl.adminDeleteUser({ params: { id: aid.toString() }, user: { id: new Types.ObjectId().toString(), role: "admin" }, body: { anonymize: true } }, r, next);
      check("admin anonymize still 403", r.statusCode === 403, `s=${r.statusCode}`);
      check("admin check still precedes guard", counted === 0, `countDocuments calls=${counted}`);
    } catch (e) { check("admin anonymize still 403", false, e.message); }
    finally { User.findById = oF; Booking.countDocuments = oC; }
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
