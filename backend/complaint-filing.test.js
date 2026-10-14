// Regression: the BookingDetails "Report an issue" form must really file.
// The form POSTs { booking, category, message } to POST /api/complaints.
// Two defects broke BOTH roles here (verified by reproduction 2026-10-13):
//  1. cook filings always 400'd ("A cook is required") — the controller
//     never assigned `cook` for cook filers;
//  2. customer filings always 400'd ("Invalid category") — the route
//     validator rejected every customer reason code the form sends.
// Isolated: real route stack (auth + authorize + validate + controller)
// over HTTP, in-memory MongoDB. Never production records.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = "test";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const express = require("express");
const jwt = require("jsonwebtoken");

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes++;
  else failures++;
};

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(await mongod.getUri());

  const User = require("./models/User");
  const Booking = require("./models/Booking");
  const Complaint = require("./models/Complaint");
  await Promise.all([User.init(), Booking.init(), Complaint.init()]);

  const mkUser = async (role) => User.create({
    name: `${role} User`,
    email: `${role}-${Math.random().toString(36).slice(2, 10)}@test.local`,
    phone: `9${String(Math.floor(100000000 + Math.random() * 899999999))}`,
    password: "password123",
    role,
  });
  const mkBooking = (cookId, custId) => Booking.create({
    customer: custId,
    cook: cookId,
    serviceType: "cook_for_me",
    date: new Date(),
    startTime: "10:00",
    endTime: "12:00",
    address: "Test Venue",
    durationHours: 2,
    amount: 349,
    status: "completed",
    payment: { status: "paid", paidAmount: 349, refundStatus: "none" },
  });
  const cook = await mkUser("cook");
  const cust = await mkUser("customer");
  const otherCook = await mkUser("cook");
  const admin = await mkUser("admin");
  const tok = (u) => jwt.sign({ id: u._id.toString() }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  app.use("/api/complaints", require("./routes/complaints"));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err?.statusCode || 500).json({ message: err?.message || "error" }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, token, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  };

  // ── 1. Cook report form files for real ──────────────────────────
  {
    const b = await mkBooking(cook._id, cust._id);
    const r = await api("POST", "/api/complaints", tok(cook), {
      booking: b._id.toString(), category: "no_show",
      message: "The customer was not available at the address given.",
    });
    check("cook filing -> 201", r.status === 201, `s=${r.status} ${JSON.stringify(r.data)}`);
    check("cook filing links cook+customer+booking", r.data?.filedBy === "cook"
      && String(r.data?.cook) === String(cook._id)
      && String(r.data?.customer) === String(cust._id)
      && String(r.data?.booking) === String(b._id));
    const stored = await Complaint.findById(r.data?._id).lean();
    check("cook complaint persisted with status open", stored?.status === "open" && stored?.category === "no_show");
    const mine = await api("GET", "/api/complaints/my", tok(cook));
    check("cook sees it under /my", mine.status === 200 && (mine.data?.length ?? mine.data?.data?.length ?? 0) >= 1, `s=${mine.status}`);
    const all = await api("GET", "/api/complaints", tok(admin));
    const rows = Array.isArray(all.data) ? all.data : all.data?.data || [];
    check("admin sees it in the queue", all.status === 200 && rows.some((c) => String(c._id) === String(r.data?._id)), `s=${all.status} n=${rows.length}`);
  }

  // ── 2. Customer report form files for every reason code ─────────
  for (const [sent, want] of [
    ["COOK_DID_NOT_ARRIVE", "cook_did_not_arrive"],
    ["MAJOR_SERVICE_DEVIATION", "major_service_deviation"],
    ["SERVICE_QUALITY_ISSUE", "service_quality_issue"],
    ["UNPROFESSIONAL_BEHAVIOR", "unprofessional_behavior"],
    ["OTHER", "other"],
  ]) {
    const b = await mkBooking(cook._id, cust._id);
    const r = await api("POST", "/api/complaints", tok(cust), {
      booking: b._id.toString(), category: sent,
      message: "Detailed description of the service problem here.",
    });
    check(`customer ${sent} -> 201 as ${want}`, r.status === 201 && r.data?.category === want, `s=${r.status} cat=${r.data?.category}`);
  }

  // ── 3. Guards still hold ────────────────────────────────────────
  {
    const b = await mkBooking(cook._id, cust._id);
    const bad = await api("POST", "/api/complaints", tok(cust), {
      booking: b._id.toString(), category: "NOT_A_REASON", message: "Long enough description here.",
    });
    check("bogus category still 400", bad.status === 400, `s=${bad.status}`);
    const short = await api("POST", "/api/complaints", tok(cook), {
      booking: b._id.toString(), category: "other", message: "too short",
    });
    check("short message still 400", short.status === 400, `s=${short.status}`);
    const anon = await api("POST", "/api/complaints", null, {
      booking: b._id.toString(), category: "other", message: "Long enough description here.",
    });
    check("no token -> 401", anon.status === 401, `s=${anon.status}`);
    const cross = await api("POST", "/api/complaints", tok(otherCook), {
      booking: b._id.toString(), category: "other", message: "Trying to report someone else's booking here.",
    });
    check("other cook cannot file on it -> 403", cross.status === 403, `s=${cross.status}`);
    const noBooking = await api("POST", "/api/complaints", tok(cust), {
      category: "OTHER", message: "Customer complaint with no booking attached here.",
    });
    check("customer complaint without booking -> 400", noBooking.status === 400, `s=${noBooking.status}`);
    // Duplicate open complaint on the same booking+role -> 409, one row.
    const bd = await mkBooking(cook._id, cust._id);
    const first = await api("POST", "/api/complaints", tok(cook), {
      booking: bd._id.toString(), category: "safety", message: "First report about this booking, detailed.",
    });
    const dup = await api("POST", "/api/complaints", tok(cook), {
      booking: bd._id.toString(), category: "safety", message: "Second report about this booking, detailed.",
    });
    check("duplicate open complaint -> 409", first.status === 201 && dup.status === 409, `${first.status},${dup.status}`);
    check("no duplicate row created", (await Complaint.countDocuments({ booking: bd._id, filedBy: "cook" })) === 1);
  }

  // ── 4. Admin can resolve what was filed ─────────────────────────
  {
    const c = await Complaint.findOne({ filedBy: "customer" }).lean();
    const r = await api("PATCH", `/api/complaints/${c._id}/status`, tok(admin), { status: "resolved", adminNote: "Reviewed, cook counselled." });
    check("admin resolves filed complaint", r.status === 200 && r.data?.status === "resolved", `s=${r.status}`);
  }

  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongod.stop();
  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
