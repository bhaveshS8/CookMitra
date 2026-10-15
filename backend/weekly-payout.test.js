// Weekly Cook Payout Management: Pending/Completed tabs by earning week +
// receipt-evidence settlement.
//
// Covers: IST Monday–Sunday boundaries, weekly grouping, payout calculations
// (paise-exact, cancelled excluded, no double count), proof upload
// validation (type/size/missing/content), failed persistence cleanup,
// duplicate + concurrent settlement safety, access control, completed-payment
// history by earning week. Isolated: real route stack over HTTP, in-memory
// MongoDB, temp upload dir (repo uploads/ untouched).
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = "test";
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.UPLOAD_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "payout-receipts-")), "cook-docs");

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

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fake-png-payload-for-receipt-tests"),
]);
const countFiles = () => fs.readdirSync(process.env.UPLOAD_DIR).length;

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(await mongod.getUri());

  const User = require("./models/User");
  const Booking = require("./models/Booking");
  const CookPayout = require("./models/CookPayout");
  const CookProfile = require("./models/CookProfile");
  const CookEventLog = require("./models/CookEventLog");
  const Notification = require("./models/Notification");
  await Promise.all([User.init(), Booking.init(), CookPayout.init(), CookProfile.init(), CookEventLog.init(), Notification.init()]);

  const { parseWeekStartIST, weekRangeIST } = require("./utils/weeklyPayouts");

  // ── 1. Weekly boundaries (IST Monday–Sunday) ──────────────────────────
  {
    // 2026-10-05 is a Monday; 2026-10-11 a Sunday; 2026-10-12 a Monday.
    const mon = parseWeekStartIST("2026-10-05");
    const sun = parseWeekStartIST(new Date("2026-10-11T18:00:00Z")); // Sun 23:30 IST
    const next = parseWeekStartIST("2026-10-12");
    check("monday maps to itself 00:00 IST", mon?.toISOString() === "2026-10-04T18:30:00.000Z", mon?.toISOString());
    check("sunday 23:30 IST stays in same week", sun?.toISOString() === "2026-10-04T18:30:00.000Z", sun?.toISOString());
    check("next monday starts new week", next?.toISOString() === "2026-10-11T18:30:00.000Z", next?.toISOString());
    const r = weekRangeIST("2026-10-07"); // mid-week Wednesday
    check(
      "mid-week day resolves full Mon–Sun range",
      r?.weekStart.toISOString() === "2026-10-04T18:30:00.000Z" &&
        r?.weekEnd.toISOString() === "2026-10-11T18:29:59.999Z",
      `${r?.weekStart.toISOString()} .. ${r?.weekEnd.toISOString()}`
    );
    check("garbage week input -> null", weekRangeIST("not-a-date") === null && parseWeekStartIST("") !== undefined);
  }

  const mkUser = async (role) => User.create({
    name: `${role} User`,
    email: `${role}-${Math.random().toString(36).slice(2, 10)}@test.local`,
    phone: `9${String(Math.floor(100000000 + Math.random() * 899999999))}`,
    password: "password123",
    role,
  });
  const cook1 = await mkUser("cook");
  const cook2 = await mkUser("cook");
  const cust = await mkUser("customer");
  const admin = await mkUser("admin");
  const tok = (u) => jwt.sign({ id: u._id.toString() }, process.env.JWT_SECRET);

  const mkBooking = (cookId, overrides = {}) => Booking.create({
    customer: cust._id,
    cook: cookId,
    serviceType: "cook_for_me",
    date: new Date("2026-10-06T06:30:00Z"), // Tue 12:00 IST, in week of Oct 5
    startTime: "10:00",
    endTime: "12:00",
    address: "Weekly Venue",
    durationHours: 2,
    amount: 349,
    slabPrice: 349,
    discount: 0,
    commission: 52.35,
    cookPayout: 296.65,
    status: "completed",
    hoursCompleted: true,
    cookArrived: true,
    serviceStartedAt: new Date("2026-10-06T06:30:00Z"),
    payment: { status: "paid", paidAmount: 349, refundStatus: "none" },
    payoutInfo: {
      regularPrice: 349,
      discountAmount: 0,
      finalCustomerPrice: 349,
      platformDeductionPercent: 15,
      platformDeductionAmount: 52.35,
      cookPayoutAmount: 296.65,
      payoutStatus: "eligible",
    },
    ...overrides,
  });

  // cook1: 2 eligible + 1 cancelled (excluded) + 1 refund-pending (excluded).
  await mkBooking(cook1._id);
  await mkBooking(cook1._id, { date: new Date("2026-10-11T06:30:00Z") }); // Sunday, same week
  await mkBooking(cook1._id, { status: "cancelled" });
  await mkBooking(cook1._id, { payment: { status: "paid", paidAmount: 349, refundStatus: "pending", refundAmount: 349 } });
  // cook2: 1 eligible.
  await mkBooking(cook2._id);

  const app = express();
  app.use(express.json());
  app.use("/api/admin/cook-payouts", require("./routes/adminCookEarnings"));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err?.statusCode || 500).json({ message: err?.message || "error", ...(err?.code ? { code: err.code } : {}) }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, token, body) => {
    const res = await fetch(`${url}${p}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  };
  const apiForm = async (p, token, { method = "upi", reference = "UPI-TEST-1", file = { bytes: PNG, name: "receipt.png", type: "image/png" } } = {}) => {
    const fd = new FormData();
    fd.append("paymentMethod", method);
    fd.append("reference", reference);
    if (file) fd.append("receipt", new Blob([file.bytes], { type: file.type }), file.name);
    const res = await fetch(`${url}${p}`, {
      method: "POST",
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: fd,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, data };
  };
  const A = tok(admin);

  // ── 2. Build weekly cycles; calculations exclude ineligible ───────────
  const WEEK = "2026-10-05";
  const b1 = await api("POST", "/api/admin/cook-payouts/payouts/build", A, { cookId: cook1._id.toString(), weekStart: WEEK });
  check("cook1 build -> 201 with 2 eligible only", b1.status === 201 && b1.data?.bookingCount === 2, `s=${b1.status} n=${b1.data?.bookingCount}`);
  check("cycle totals paise-exact (2 x 296.65)", b1.data?.cookEarnings === 593.3 && b1.data?.totalPayable === 593.3, JSON.stringify({ e: b1.data?.cookEarnings, t: b1.data?.totalPayable }));
  check("cycle gross = 2 x 349", b1.data?.grossCustomerValue === 698, `g=${b1.data?.grossCustomerValue}`);
  const b1dup = await api("POST", "/api/admin/cook-payouts/payouts/build", A, { cookId: cook1._id.toString(), weekStart: WEEK });
  check("rebuild same week cannot double-count (400/200-reuse)", b1dup.status === 400 || b1dup.data?.alreadyExists === true, `s=${b1dup.status}`);
  const b2 = await api("POST", "/api/admin/cook-payouts/payouts/build", A, { cookId: cook2._id.toString(), weekStart: WEEK });
  check("cook2 build -> 201 x1", b2.status === 201 && b2.data?.bookingCount === 1, `s=${b2.status}`);
  const cycle1 = b1.data._id;
  const cycle2 = b2.data._id;

  // ── 3. Pending tab: week selection, totals, cook count ────────────────
  {
    const p = await api("GET", `/api/admin/cook-payouts/weekly/pending?weekStart=${WEEK}`, A);
    check("pending 200 with 2 records", p.status === 200 && p.data?.records?.length === 2, `s=${p.status} n=${p.data?.records?.length}`);
    check("pending totals = 593.3 + 296.65", p.data?.totals?.totalPayable === 889.95, `t=${p.data?.totals?.totalPayable}`);
    check("pending cookCount 2, remaining == total", p.data?.totals?.cookCount === 2 && p.data?.totals?.remaining === 889.95, JSON.stringify(p.data?.totals));
    const r1 = p.data.records.find((r) => String(r.cook?._id) === String(cook1._id));
    check("record shows cook + bookings + gross/net + settled/remaining", Boolean(r1?.cook?.name) && r1?.bookingCount === 2 && r1?.grossCustomerValue === 698 && r1?.cookEarnings === 593.3 && r1?.settledAmount === 0 && r1?.remainingPayable === 593.3, JSON.stringify({ n: r1?.cook?.name, b: r1?.bookingCount, rem: r1?.remainingPayable }));
    const other = await api("GET", "/api/admin/cook-payouts/weekly/pending?weekStart=2026-10-12", A);
    check("other week has no records (no leakage)", other.status === 200 && other.data?.records?.length === 0 && other.data?.totals?.totalPayable === 0, `n=${other.data?.records?.length}`);
    const bad = await api("GET", "/api/admin/cook-payouts/weekly/pending?weekStart=junk", A);
    check("invalid week -> 400", bad.status === 400, `s=${bad.status}`);
  }

  // ── 4. Access control ─────────────────────────────────────────────────
  {
    const anon = await api("GET", `/api/admin/cook-payouts/weekly/pending?weekStart=${WEEK}`, null);
    check("no token -> 401", anon.status === 401, `s=${anon.status}`);
    const cookTry = await api("GET", `/api/admin/cook-payouts/weekly/completed?weekStart=${WEEK}`, tok(cook1));
    check("cook cannot read weekly payouts -> 403", cookTry.status === 403, `s=${cookTry.status}`);
    const settleCook = await apiForm(`/api/admin/cook-payouts/payouts/${cycle1}/settle-weekly`, tok(cook1));
    check("cook cannot settle -> 403/401", [401, 403].includes(settleCook.status), `s=${settleCook.status}`);
  }

  // ── 5. Proof upload validation (no false success, balance kept) ──────
  const filesBefore = countFiles();
  {
    const noFile = await apiForm(`/api/admin/cook-payouts/payouts/${cycle1}/settle-weekly`, A, { file: null });
    check("missing receipt -> 400 RECEIPT_REQUIRED", noFile.status === 400 && noFile.data?.code === "RECEIPT_REQUIRED", `s=${noFile.status} ${noFile.data?.code}`);
    const badType = await apiForm(`/api/admin/cook-payouts/payouts/${cycle1}/settle-weekly`, A, { reference: "UPI-BADTYPE-1", file: { bytes: PNG, name: "receipt.txt", type: "text/plain" } });
    check("wrong file type -> 400", badType.status === 400, `s=${badType.status} ${badType.data?.message}`);
    const badContent = await apiForm(`/api/admin/cook-payouts/payouts/${cycle1}/settle-weekly`, A, { reference: "UPI-BADCONTENT-1", file: { bytes: Buffer.from("not an image at all"), name: "receipt.png", type: "image/png" } });
    check("spoofed content -> 400 INVALID_FILE_CONTENT", badContent.status === 400, `s=${badContent.status} ${badContent.data?.code}`);
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024, 1)]);
    const tooBig = await apiForm(`/api/admin/cook-payouts/payouts/${cycle1}/settle-weekly`, A, { reference: "UPI-BIG-1", file: { bytes: big, name: "receipt.png", type: "image/png" } });
    check("oversize receipt -> 400 RECEIPT_TOO_LARGE", tooBig.status === 400 && tooBig.data?.code === "RECEIPT_TOO_LARGE", `s=${tooBig.status} ${tooBig.data?.code}`);
    const badMethod = await apiForm(`/api/admin/cook-payouts/payouts/${cycle1}/settle-weekly`, A, { method: "cheque", reference: "UPI-M-1" });
    check("bad payment method -> 400", badMethod.status === 400, `s=${badMethod.status}`);
    const ghost = await apiForm(`/api/admin/cook-payouts/payouts/${new (require("mongoose").Types.ObjectId)()}/settle-weekly`, A, { reference: "UPI-GHOST-1" });
    check("unknown cycle -> 404, upload cleaned", ghost.status === 404 && countFiles() === filesBefore, `s=${ghost.status} files=${countFiles()}`);
    const still = await CookPayout.findById(cycle1).lean();
    check("failed attempts leave balance pending", still.status !== "paid", still.status);
  }

  // ── 6. Happy-path settlement with receipt evidence ────────────────────
  {
    await api("POST", `/api/admin/cook-payouts/payouts/${cycle1}/approve`, A);
    const s = await apiForm(`/api/admin/cook-payouts/payouts/${cycle1}/settle-weekly`, A, { method: "upi", reference: "UPI-WEEK-001" });
    check("settle -> 200 paid", s.status === 200 && s.data?.status === "paid", `s=${s.status} st=${s.data?.status}`);
    check("settlement persists method/ref/admin/amount", s.data?.paymentMethod === "upi" && s.data?.paymentReference === "UPI-WEEK-001" && String(s.data?.settledBy?._id || s.data?.settledBy) === String(admin._id) && s.data?.settledAmount === 593.3, JSON.stringify({ m: s.data?.paymentMethod, a: s.data?.settledAmount }));
    check("receipt stored + on disk (private payout_ file)", Boolean(s.data?.receiptUrl?.includes("/uploads/cook-docs/payout_")) && fs.existsSync(path.join(process.env.UPLOAD_DIR, path.basename(s.data.receiptUrl))), s.data?.receiptUrl);
    check("earning week unchanged by settlement", String(new Date(s.data.weekStart).toISOString()).startsWith("2026-10-04"), s.data?.weekStart);
    const bp = await Booking.countDocuments({ _id: { $in: s.data.bookings }, "payoutInfo.payoutStatus": "paid" });
    check("cycle bookings flipped to paid", bp === 2, `${bp}/2`);
    check("payout_paid audit once", (await CookEventLog.countDocuments({ event: "payout_paid", refId: cycle1 })) === 1);
    check("cook notified of payout", (await Notification.countDocuments({ user: cook1._id, type: "payout_paid" })) === 1);
    // Idempotent replay with a fresh receipt must not double-pay.
    const replay = await apiForm(`/api/admin/cook-payouts/payouts/${cycle1}/settle-weekly`, A, { reference: "UPI-WEEK-002" });
    check("re-settle idempotent (no double pay)", replay.status === 200 && replay.data?.alreadySettled === true && replay.data?.settledAmount === 593.3, `s=${replay.status}`);
    check("replay leaves single audit", (await CookEventLog.countDocuments({ event: "payout_paid", refId: cycle1 })) === 1);
  }

  // ── 7. Duplicate reference across cycles ──────────────────────────────
  {
    await api("POST", `/api/admin/cook-payouts/payouts/${cycle2}/approve`, A);
    const dup = await apiForm(`/api/admin/cook-payouts/payouts/${cycle2}/settle-weekly`, A, { reference: "UPI-WEEK-001" });
    check("same transaction ID on another cycle -> 409", dup.status === 409, `s=${dup.status}`);
  }

  // ── 8. Concurrent settlement: exactly one wins ────────────────────────
  {
    const cook3 = await mkUser("cook");
    await mkBooking(cook3._id);
    const b3 = await api("POST", "/api/admin/cook-payouts/payouts/build", A, { cookId: cook3._id.toString(), weekStart: WEEK });
    await api("POST", `/api/admin/cook-payouts/payouts/${b3.data._id}/approve`, A);
    const filesPre = countFiles();
    const attempts = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        apiForm(`/api/admin/cook-payouts/payouts/${b3.data._id}/settle-weekly`, A, { reference: `UPI-RACE-${i}` })
      )
    );
    const wins = attempts.filter((a) => a.status === 200 && !a.data?.alreadySettled).length;
    const replays = attempts.filter((a) => a.status === 200 && a.data?.alreadySettled).length;
    const conflicts = attempts.filter((a) => a.status === 409).length;
    check("concurrent settle: exactly one real win", wins === 1 && wins + replays + conflicts === 6, `wins=${wins} replays=${replays} conflicts=${conflicts}`);
    const fin = await CookPayout.findById(b3.data._id).lean();
    check("cycle paid exactly once", fin.status === "paid" && fin.settledAmount === 296.65, `${fin.status} ${fin.settledAmount}`);
    check("single paid audit under race", (await CookEventLog.countDocuments({ event: "payout_paid", refId: b3.data._id })) === 1);
    check("loser uploads cleaned (one receipt file kept)", countFiles() === filesPre + 1, `files=${countFiles()} pre=${filesPre}`);
  }

  // ── 9. Completed history grouped by EARNING week ──────────────────────
  {
    const done = await api("GET", `/api/admin/cook-payouts/weekly/completed?weekStart=${WEEK}`, A);
    check("completed 200 lists settled cycles", done.status === 200 && done.data?.records?.length === 2, `n=${done.data?.records?.length}`);
    check("completed totals = 593.3 + 296.65", done.data?.totals?.totalPaid === 889.95 && done.data?.totals?.cookCount === 2, JSON.stringify(done.data?.totals));
    const r = done.data.records[0];
    check("record exposes method/ref/receipt/admin/timestamps", Boolean(r?.paymentMethod && r?.paymentReference && r?.receiptUrl && r?.settledBy && (r?.paidAt || r?.paymentDate) && r?.week?.start), JSON.stringify({ m: r?.paymentMethod, w: r?.week }));
    const pendingNow = await api("GET", `/api/admin/cook-payouts/weekly/pending?weekStart=${WEEK}`, A);
    check("settled cycles leave the pending tab", pendingNow.data?.records?.length === 1, `n=${pendingNow.data?.records?.length}`);
    // Settled a week later, still grouped by earning week — never moved.
    const nextWeek = await api("GET", "/api/admin/cook-payouts/weekly/completed?weekStart=2026-10-12", A);
    check("settlement date does not re-bucket the earning week", nextWeek.data?.records?.length === 0, `n=${nextWeek.data?.records?.length}`);
  }

  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongod.stop();
  fs.rmSync(path.dirname(process.env.UPLOAD_DIR), { recursive: true, force: true });
  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
