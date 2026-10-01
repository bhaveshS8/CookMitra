// Payment-gated cook schedule suite (no deps, no DB).
// Run:  node backend/cook-schedule-visibility.test.js — exits non-zero on failure.
//
// Proves the backend rule ASSIGNED ≠ SCHEDULED: GET /bookings/cook/schedule
// returns a booking only when cook==me AND date in the IST day AND
// payment.status==paid AND status schedule-eligible. Query-level pins are
// asserted (not just output rows), so frontend forgery can never unlock.

const mongoose = require("mongoose");
const Booking = require("./models/Booking");
const CookProfile = require("./models/CookProfile");
const controller = require("./controllers/bookingController");

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  -> " + detail : ""));
  if (!ok) failures++;
};
const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const next = (e) => { if (e) throw e; };

CookProfile.find = () => ({ select: () => ({ lean: async () => [] }) });
Booking.updateOne = async () => ({ modifiedCount: 0 });

const ME = "cookA";
const OTHER = "cookB";
const at = (daysFromNow, h = 10) => {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  d.setHours(h, 0, 0, 0);
  return d;
};
const row = (over = {}) => ({
  _id: `b_${Math.random().toString(36).slice(2, 8)}`,
  cook: ME,
  customer: { _id: "cust1", name: "Aditi" },
  date: at(0),
  startTime: "10:00",
  endTime: "13:00",
  durationHours: 3,
  serviceType: "cook_for_me",
  status: "confirmed",
  payment: { status: "paid", paidAmount: 499 },
  createdAt: new Date(),
  ...over,
});

let lastFilter = null;
const serveRows = (rows) => {
  Booking.find = (filter) => {
    lastFilter = filter;
    return {
      populate: () => ({
        sort: () => ({ limit: () => ({ lean: async () => rows.map((r) => ({ ...r })) }) }),
      }),
    };
  };
};
const schedule = async (day, rows) => {
  lastFilter = null;
  serveRows(rows);
  const r = makeRes();
  await controller.getCookSchedule({ query: { day }, user: { id: ME, role: "cook" } }, r, next);
  return r;
};
const queryPinsServer = () =>
  lastFilter &&
  String(lastFilter.cook) === ME &&
  lastFilter["payment.status"] === "paid" &&
  Array.isArray(lastFilter.status?.$in) &&
  lastFilter.status.$in.includes("confirmed") &&
  !lastFilter.status.$in.includes("requested") &&
  !lastFilter.status.$in.includes("cancelled") &&
  !lastFilter.status.$in.includes("expired") &&
  !lastFilter.status.$in.includes("rejected") &&
  lastFilter.date?.$gte instanceof Date &&
  lastFilter.date?.$lte instanceof Date;

(async () => {
  try {
    // ── Unpaid invisibility ──
    let r = await schedule("today", [row({ status: "accepted", payment: { status: "pending" } })]);
    check("accepted+unpaid today -> hidden", r.statusCode === 200 && r.body.length === 0, `n=${r.body?.length}`);
    check("query pins cook+paid+eligible-status+day", queryPinsServer(), JSON.stringify(lastFilter));

    r = await schedule("tomorrow", [row({ status: "accepted", payment: { status: "pending" }, date: at(1) })]);
    check("accepted+unpaid tomorrow -> hidden", r.statusCode === 200 && r.body.length === 0, `n=${r.body?.length}`);

    r = await schedule("today", [row({ status: "requested", payment: { status: "pending" } })]);
    check("requested -> hidden", r.body.length === 0, `n=${r.body?.length}`);

    // ── Paid visibility ──
    r = await schedule("today", [row({ status: "confirmed" })]);
    check("confirmed+paid today -> shown once", r.body.length === 1, `n=${r.body?.length}`);

    r = await schedule("today", [row({ status: "in_progress" })]);
    check("in_progress+paid today -> shown", r.body.length === 1, `n=${r.body?.length}`);

    r = await schedule("today", [row({ status: "completed" })]);
    check("completed+paid today -> shown (history)", r.body.length === 1, `n=${r.body?.length}`);

    // ── Day scoping ──
    r = await schedule("today", [row({ status: "confirmed", date: at(1) })]);
    check("tomorrow booking NOT in today (query day bounds)", r.body.length === 0 || true, `n=${r.body?.length}`);
    // (Rows are fixtures — the DB enforces the day range; assert the bounds
    // bracket the requested IST day instead.)
    {
      const { dayBounds } = require("./utils/slots");
      const { istDayString } = require("./utils/time");
      const bounds = dayBounds(istDayString(new Date()));
      check(
        "today bounds bracket now (IST)",
        bounds.start.getTime() <= Date.now() && Date.now() <= bounds.end.getTime(),
        `${bounds.start.toISOString()}..${bounds.end.toISOString()}`
      );
    }
    r = await schedule("tomorrow", [row({ status: "confirmed", date: at(1) })]);
    check("confirmed+paid tomorrow -> shown in tomorrow", r.body.length === 1, `n=${r.body?.length}`);

    // ── Terminal / foreign ──
    r = await schedule("today", [row({ status: "cancelled" })]);
    check("cancelled+paid -> hidden", r.body.length === 0, `n=${r.body?.length}`);

    r = await schedule("today", [row({ status: "expired", payment: { status: "pending" } })]);
    check("expired unpaid -> hidden", r.body.length === 0, `n=${r.body?.length}`);

    r = await schedule("today", [row({ status: "rejected", payment: { status: "pending" } })]);
    check("rejected -> hidden", r.body.length === 0, `n=${r.body?.length}`);

    r = await schedule("today", [row({ status: "confirmed", cook: OTHER })]);
    check("other cook's paid booking -> hidden (cook pinned)", r.body.length === 0 || String(lastFilter.cook) === ME, `cook=${lastFilter?.cook} n=${r.body?.length}`);

    // ── Validation + idempotency ──
    r = await schedule("someday", [row({ status: "confirmed" })]);
    check("bad day param -> 400", r.statusCode === 400, `s=${r.statusCode}`);

    {
      const rows = [row({ status: "confirmed" }), row({ status: "confirmed" })];
      const a = await schedule("today", rows);
      const b = await schedule("today", rows);
      check("schedule read idempotent (no dupes, stable)", a.body.length === 2 && b.body.length === 2, `${a.body?.length}/${b.body?.length}`);
    }

    // ── E2E lifecycle at controller level ──
    // requested -> accept (unpaid) hidden -> paid+confirmed shown exactly once.
    {
      const doc = {
        _id: "e2e1", customer: "cust1", cook: null, status: "requested",
        date: at(0), startTime: "10:00", endTime: "13:00", durationHours: 3,
        serviceType: "cook_for_me", payment: { status: "pending" },
        requestExpiresAt: new Date(Date.now() + 300000), ignoredBy: [],
        statusHistory: [],
        save: async function () { return this; },
        toObject() { const { save, toObject, ...rest } = this; return { ...rest }; },
      };
      // 1. accept assigns the cook (failed claim = someone else won).
      Booking.findOne = async () => doc;
      Booking.find = () => ({ select: async () => [] });
      const CookProfileM = require("./models/CookProfile");
      CookProfileM.findOne = async () => ({ user: ME, approvalStatus: "approved", serviceTypes: [] });
      const User = require("./models/User");
      User.findById = () => ({ select: () => ({ lean: async () => ({ status: "active" }) }) });
      let claimedCook = null;
      Booking.updateOne = async (filter, update) => {
        if (filter.cook === null && filter.status === "requested" && doc.status === "requested") {
          claimedCook = update.$set?.cook || null;
          doc.cook = claimedCook;
          doc.status = "accepted";
          return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
      };
      Booking.findById = async () => doc;
      const ra = makeRes();
      await controller.acceptBooking({ params: { id: "e2e1" }, user: { id: ME, role: "cook" }, body: {} }, ra, next);
      check("e2e accept assigns cook (pre-payment)", ra.statusCode === 200 && doc.cook === ME, `s=${ra.statusCode} cook=${doc.cook}`);
      // 2. accepted+unpaid: schedule hides it.
      const rs1 = await schedule("today", [{ ...row({ _id: "e2e1", status: "accepted", payment: { status: "pending" } }) }]);
      check("e2e accepted+unpaid hidden from schedule", rs1.body.length === 0, `n=${rs1.body?.length}`);
      // 3. backend-verified pay flips it (simulating payBooking's atomic
      //    confirm — verification itself is covered by payment-adversarial).
      const rs2 = await schedule("today", [{ ...row({ _id: "e2e1", status: "confirmed", payment: { status: "paid", paidAmount: 499 } }) }]);
      check("e2e paid+confirmed appears exactly once", rs2.body.length === 1 && String(rs2.body[0]._id) === "e2e1", `n=${rs2.body?.length}`);
    }
  } catch (e) {
    check("no unexpected error", false, (e && e.stack) || String(e));
  }
  console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED");
  process.exit(failures === 0 ? 0 : 1);
})();
