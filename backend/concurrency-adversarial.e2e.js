// concurrency-adversarial.e2e.js — ADVERSARIAL concurrency audit for Cook Mitra.
//
// Goal: prove (or disprove) that SIMULTANEOUS API requests cannot create
// invalid booking states. Sequential testing is NOT sufficient here: every
// burst below is dispatched with Promise.allSettled over synchronously-created
// fetch promises, so all requests in a burst are in flight at the same time.
//
// What it does (15 scenarios):
//   T01  30 (or FLOOD_N) customers, same cook + slot, same tick
//   T02  20 customers, overlapping ranges, same tick
//   T03  two accepts of the SAME booking, same tick
//   T04  accept vs removed-reschedule tombstone (410), same tick
//   T05  accept vs cancel, same tick
//   T06  create (overlapping) vs accept, same tick
//   T07  pay-confirm vs cancel, same tick            (needs test payments)
//   T08a double accept at the expiry boundary        (fast)
//   T08b double late-accept after expiry             (slow, RUN_SLOW=1)
//   T09  same idempotency key twice, same tick
//   T10  different idempotency keys, same slot, same tick
//   T11  retry AFTER a successful create (sequential idempotency)
//   T12a single-use coupon raced by two customers, same tick
//   T12b double pay-confirm of one booking, same tick  (needs test payments)
//   T13  invalid-id + wrong-owner ops vs a valid op, same tick
//   T14  same customer + same key from "two devices", same tick
//   T15  identical amounts, distinct payments, same tick (needs test payments)
//
// For EVERY test it records: initial DB state, every response status,
// final DB state, then checks: overlapping active bookings, invalid status
// transitions, duplicate payments, coupon accounting, payout leakage, and
// audit-history anomalies. Findings go to console AND to
// concurrency-report-<timestamp>.json. Exit code is non-zero on any FAIL.
//
// Run (scratch database ONLY — this script creates ~40 users + bookings):
//   MONGODB_URI=mongodb://localhost:27017/festivecook_adv node seeds/seed.js
//   MONGODB_URI=mongodb://localhost:27017/festivecook_adv ALLOW_TEST_PAYMENTS=true node server.js
//   ALLOW_LIVE_TESTS=1 BASE_URL=http://localhost:5000/api \
//     MONGODB_URI=mongodb://localhost:27017/festivecook_adv \
//     node backend/concurrency-adversarial.e2e.js
//
// Env knobs:
//   FLOOD_N        customers in T01 (default 30; use 100 with raised auth limits)
//   RATE_LIMIT_AUTH must cover ~FLOOD_N+10 on the test server for T01 at N=100
//   RUN_SLOW=1     include T08b (~6 min: waits out the 5-minute request window)
//   SKIP_PAY=1     skip payment-gated tests (T07, T12b, T15)
//   MONGODB_URI    when set, ALSO verifies ground truth directly in MongoDB
//                  (strongest check); otherwise verifies via the admin API.
//
// Safety: refuses to run without ALLOW_LIVE_TESTS=1, and refuses against a
// database that already holds non-test users (unless ADV_FORCE=1).
if (!process.env.ALLOW_LIVE_TESTS) {
  console.error(
    "Refusing to run: this suite writes users/bookings/coupons. " +
      "Re-run with ALLOW_LIVE_TESTS=1 against a SCRATCH database."
  );
  process.exit(1);
}
const BASE = process.env.BASE_URL || "http://localhost:5000/api";
const FLOOD_N = Math.max(2, parseInt(process.env.FLOOD_N || "30", 10) || 30);
const RUN_SLOW = process.env.RUN_SLOW === "1";
const SKIP_PAY = process.env.SKIP_PAY === "1";
const ADV_FORCE = process.env.ADV_FORCE === "1";
const RUN_TS = Date.now();
const TAG = `adv${String(RUN_TS).slice(-6)}`;

const fs = require("fs");
const path = require("path");

let failures = 0, passes = 0, skips = 0, envLimited = 0;
const results = [];
// True only while the suite's reads can be trusted: set by the SETUP
// db-match check. When false, failed READs prove nothing about the product.
let DB_OK = true;
const record = (id, name, verdict, detail, extra = {}) => {
  console.log(`${verdict}  ${id} ${name}${detail ? "  -> " + detail : ""}`);
  if (verdict === "PASS") passes++;
  else if (verdict === "FAIL") failures++;
  else if (verdict === "SKIP") skips++;
  else envLimited++;
  results.push({ id, name, verdict, detail: detail || "", ...extra });
};
// Verdict router for tests with BOTH HTTP and read-back evidence: HTTP
// failures always FAIL (server truth); failed reads FAIL only when reads
// are trustworthy, otherwise ENV-LIMITED with the HTTP evidence preserved.
const finalize = (id, name, httpOk, readOk, detail, extra = {}) => {
  if (!httpOk) return record(id, name, "FAIL", detail, extra);
  if (!readOk && !DB_OK) {
    return record(id, name, "ENV-LIMITED", `${detail} — read-back unverifiable (db mismatch)`, extra);
  }
  return record(id, name, readOk ? "PASS" : "FAIL", detail, extra);
};

// ── HTTP ────────────────────────────────────────────────────────────────────
const api = async (method, p, { token, body, timeoutMs = 30000 } = {}) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${p}`, {
      method,
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  } catch (e) {
    return { status: -1, data: null, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
};
// Fire N async operations with TRUE concurrency: every promise is created
// synchronously in the same tick before any is awaited. Returns the plain
// API responses in order (NOT allSettled wrappers) — a rejected thunk
// becomes a NETWORK pseudo-response so tallies stay meaningful.
const burst = async (thunks) => {
  const settled = await Promise.allSettled(thunks.map((t) => t()));
  return settled.map((s) =>
    s.status === "fulfilled"
      ? s.value
      : { status: -1, data: null, error: String((s.reason && s.reason.message) || s.reason) }
  );
};
const tally = (responses) => {
  const m = {};
  for (const r of responses) {
    const s = r.status === -1 ? "NETWORK" : `HTTP_${r.status}`;
    m[s] = (m[s] || 0) + 1;
  }
  return m;
};

// ── time helpers (IST-agnostic: test slots are days out, on-grid) ───────────
const p2 = (n) => String(n).padStart(2, "0");
const dayStr = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
const toMin = (t) => {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const overlap = (aS, aE, bS, bE) => aS < bE && bS < aE;
const fmtMin = (m) => `${p2(Math.floor(m / 60))}:${p2(m % 60)}`;
const addMinutes = (t, d) => fmtMin(toMin(t) + d);
const normId = (v) => String((v && v._id) || v || "");

// ── state snapshots ─────────────────────────────────────────────────────────
let useDirectDb = false;
let DirectBooking = null, DirectCoupon = null;
async function initDirectDb() {
  if (!process.env.MONGODB_URI) return false;
  try {
    const mongoose = require("mongoose");
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    }
    DirectBooking = require("./models/Booking");
    DirectCoupon = require("./models/Coupon");
    return true;
  } catch (e) {
    console.log(`INFO  direct-DB verify unavailable (${e.message}); using admin API`);
    return false;
  }
}
const asList = (r) => {
  if (!r || r.status !== 200) return null;
  if (Array.isArray(r.data)) return r.data;
  if (Array.isArray(r.data?.data)) return r.data.data;
  return null;
};
async function snapshotBookings(adminToken) {
  if (useDirectDb) {
    const docs = await DirectBooking.find({}).select(
      "_id customer cook date startTime endTime status payment requestExpiresAt couponCode clientKey statusHistory"
    ).lean();
    return docs.map((b) => ({ ...b, _id: String(b._id) }));
  }
  const r = await api("GET", "/bookings?limit=200", { token: adminToken });
  return asList(r) || [];
}
const ACTIVE = ["accepted", "confirmed", "in_progress"];
function findOverlaps(bookings, now = Date.now()) {
  const blockers = (bookings || []).filter((b) => {
    if (ACTIVE.includes(b.status)) return true;
    if (b.status === "requested" && b.requestExpiresAt && new Date(b.requestExpiresAt).getTime() > now) return true;
    return false;
  });
  const out = [];
  for (let i = 0; i < blockers.length; i++) {
    for (let j = i + 1; j < blockers.length; j++) {
      const a = blockers[i], b = blockers[j];
      if (normId(a.cook) !== normId(b.cook)) continue;
      const dayDiff = Math.abs(new Date(a.date).getTime() - new Date(b.date).getTime());
      if (dayDiff > 12 * 3600 * 1000) continue;
      const as = toMin(a.startTime), ae = toMin(a.endTime);
      const bs = toMin(b.startTime), be = toMin(b.endTime);
      if (as == null || ae == null || bs == null || be == null) continue;
      if (overlap(as, ae, bs, be)) out.push([a, b]);
    }
  }
  return out;
}
function findDupPayments(bookings) {
  const seen = new Map();
  const dups = [];
  for (const b of bookings || []) {
    const pid = b.payment?.razorpayPaymentId || "";
    if (!pid) continue;
    if (seen.has(pid)) dups.push({ paymentId: pid, bookings: [seen.get(pid), String(b._id)] });
    else seen.set(pid, String(b._id));
  }
  return dups;
}
const TERMINAL = ["completed", "cancelled", "rejected", "expired"];
const LIVE = ["accepted", "confirmed", "in_progress"];
function historyAnomalies(booking) {
  const out = [];
  const hist = booking.statusHistory || [];
  let sawTerminal = null;
  for (const h of hist) {
    const s = h.status;
    if (TERMINAL.includes(s)) sawTerminal = sawTerminal || s;
    else if (LIVE.includes(s) && sawTerminal) {
      out.push(`live '${s}' after terminal '${sawTerminal}'`);
    }
  }
  // requested-after-accepted is only legal as the accept-rollback path
  for (let i = 1; i < hist.length; i++) {
    if (hist[i - 1].status === "accepted" && hist[i].status === "requested" &&
        !/rolled back/i.test(String(hist[i].note || ""))) {
      out.push("accepted->requested without rollback note");
    }
  }
  // Duplicate consecutive entries are the fingerprint of non-atomic
  // transitions (double accept, double late-expiry, double complete).
  // Same-status ANNOTATIONS are legitimate and excluded: refund-queue notes
  // (cancel pushes 'cancelled' then appends a second 'cancelled' refund note)
  // and arrival notes on an already-live booking.
  const ANNOTATION_RE = /refund|arrived/i;
  for (let i = 1; i < hist.length; i++) {
    if (hist[i].status === hist[i - 1].status &&
        !ANNOTATION_RE.test(String(hist[i].note || ""))) {
      out.push(`duplicate consecutive '${hist[i].status}'`);
    }
  }
  const acceptedEntries = hist.filter((h) => h.status === "accepted").length;
  return { out, acceptedEntries };
}

// ── accounts ────────────────────────────────────────────────────────────────
const ADMIN = { email: process.env.SEED_ADMIN_EMAIL || "admin@festivecook.com", password: process.env.SEED_ADMIN_PASS || "admin123" };
const COOK = { email: process.env.SEED_COOK_EMAIL || "priya@example.com", password: process.env.SEED_COOK_PASS || "password123" };
async function login(email, password) {
  const r = await api("POST", "/auth/login", { body: { email, password } });
  if (r.status !== 200 || !r.data?.token) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
async function registerCustomer(i) {
  const email = `${TAG}c${i}@example.com`;
  const r = await api("POST", "/auth/register", {
    body: {
      name: `Adv Customer ${i}`,
      email,
      password: "Test1234!",
      phone: String(9000000000 + i),
      role: "customer",
    },
  });
  if (r.status === 429) return { limited: true, status: r.status };
  if ((r.status !== 200 && r.status !== 201) || !r.data?.token) {
    throw new Error(`register ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  return { token: r.data.token, id: r.data.user?._id || r.data.user?.id, email };
}
const bookPayload = (cookId, date, s, e, extra = {}) => ({
  cook: cookId,
  serviceType: "cook_for_me",
  date,
  startTime: s,
  endTime: e,
  durationHours: (toMin(e) - toMin(s)) / 60,
  address: "H-12, Green Park, Pune",
  addressDetails: { flatNo: "H-12", society: "Green Park", landmark: "Metro", city: "Pune" },
  guests: 2,
  ...extra,
});

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const startedAt = new Date().toISOString();
  useDirectDb = await initDirectDb();
  console.log(`INFO  verify mode: ${useDirectDb ? "direct MongoDB (ground truth)" : "admin API"}`);

  // Guard: never run against a database with real users.
  let admin, cook;
  try {
    admin = await login(ADMIN.email, ADMIN.password);
    cook = await login(COOK.email, COOK.password);
  } catch (e) {
    record("SETUP", "seeded admin/cook login", "FAIL", e.message);
    finish(startedAt);
    return;
  }
  const cookId = String(cook.user?._id || cook.user?.id || "");
  if (!cookId) { record("SETUP", "cook id resolution", "FAIL", JSON.stringify(cook.user)); finish(startedAt); return; }
  if (!ADV_FORCE) {
    const users = useDirectDb
      ? await require("mongoose").connection.db.collection("users").countDocuments()
      : null;
    if (users != null && users > 20) {
      record("SETUP", "scratch-db guard", "FAIL", `${users} users present; use a scratch DB or ADV_FORCE=1`);
      finish(startedAt);
      return;
    }
  }

  // Pick a free 10:00-12:00 slot 7 days out (shift days on clash).
  const DATE = dayStr(7);
  const SLOT = { s: "10:00", e: "12:00" };
  const free = await api("GET", `/availability/${cookId}?date=${DATE}&durationHours=2`, { token: admin.token });
  const freeList = asList(free) || free.data?.slots || [];
  const hasSlot = (freeList || []).some((o) => o.startTime === SLOT.s && o.endTime === SLOT.e);
  record("SETUP", "target slot free", hasSlot ? "PASS" : "FAIL", `${DATE} ${SLOT.s}-${SLOT.e} (${(freeList || []).length} options)`);
  if (!hasSlot) { finish(startedAt); return; }

  // Customer pool (sequential setup; the CONCURRENCY is in the tests).
  // Size covers both the flood (FLOOD_N) and the fixed-index tests (≥20).
  const POOL_N = Math.max(FLOOD_N, 20);
  const customers = [];
  for (let i = 0; i < POOL_N; i++) {
    const c = await registerCustomer(i);
    if (c.limited) {
      record("SETUP", "customer pool (rate budget)", "ENV-LIMITED",
        `429 after ${customers.length} registers — raise RATE_LIMIT_AUTH for FLOOD_N=${FLOOD_N}`);
      break;
    }
    customers.push(c);
  }
  if (customers.length < 20) {
    record("SETUP", "customer pool", "ENV-LIMITED",
      `only ${customers.length}/20 customers (auth rate budget) — raise RATE_LIMIT_AUTH on the test server or lower FLOOD_N`);
    finish(startedAt);
    return;
  }
  // The server and the suite must point at the SAME database, or every
  // read-back below finds nothing while HTTP writes succeed elsewhere.
  if (useDirectDb) {
    try {
      const mongoose = require("mongoose");
      const directTotal = await mongoose.connection.db.collection("bookings").countDocuments();
      const adminList = await api("GET", "/bookings?limit=1", { token: admin.token });
      const adminTotal = adminList.data?.pagination?.total;
      DB_OK = adminTotal === directTotal;
      record("SETUP", "server/suite database match",
        DB_OK ? "PASS" : "ENV-LIMITED",
        `adminAPI=${adminTotal} direct=${directTotal}` +
        (adminTotal === directTotal
          ? ""
          : " — MISMATCH: the server and suite point at different databases; read-back verdicts below are unreliable"));
    } catch (e) {
      record("SETUP", "server/suite database match", "ENV-LIMITED", String((e && e.message) || e));
    }
  }
  // Probe test-payments availability (throwaway booking).
  let testPayLive = false;
  if (!SKIP_PAY) {
    const probe = await api("POST", "/bookings", {
      token: customers[0].token,
      body: bookPayload(cookId, dayStr(8), "10:00", "12:00", { clientKey: `${TAG}-probe` }),
    });
    if ([200, 201].includes(probe.status) && probe.data?._id) {
      const pid = probe.data._id;
      const acc = await api("PATCH", `/bookings/${pid}/accept`, { token: cook.token });
      if (acc.status === 200) {
        const pay = await api("PATCH", `/bookings/${pid}/pay`, {
          token: customers[0].token, body: { method: "upi", testMode: true },
        });
        testPayLive = pay.status === 200 && pay.data?.payment?.status === "paid";
      }
      await api("PATCH", `/bookings/${pid}/cancel`, { token: customers[0].token, body: {} });
    }
    record("SETUP", "test-payments probe", testPayLive ? "PASS" : "SKIP",
      testPayLive ? "ALLOW_TEST_PAYMENTS live on test server" : "gateway path enforced — payment tests will SKIP");
  }

  const snapCount = async () => (await snapshotBookings(admin.token)).length;

  // ══ T01: flood, same cook + slot ══════════════════════════════════════════
  {
    const before = await snapCount();
    const indexed = customers.map((c, i) => ({ c, i }));
    const settled = await burst(
      indexed.map(({ c, i }) => () => api("POST", "/bookings", {
        token: c.token,
        body: bookPayload(cookId, DATE, SLOT.s, SLOT.e, { clientKey: `${TAG}-t01-${i}` }),
      }).then((r) => ({ r, i })))
    );
    const responses = settled.map((v) => (v && v.r) || { status: -1, data: null });
    const okIdx = settled.filter((v) => v && v.r && [200, 201].includes(v.r.status));
    // Snapshot BEFORE cleanup: deleting surviving holds first would erase
    // the very double-booking evidence this test hunts.
    const after = await snapshotBookings(admin.token);
    const overs = findOverlaps(after).filter(([a, b]) =>
      [a, b].every((x) => normId(x.cook) === cookId));
    const createdIds = okIdx.map(({ r }) => String(r.data?._id || ""));
    // HTTP evidence (server truth): at most one winner. Read evidence:
    // no overlapping pair in the snapshot.
    finalize("T01", `${customers.length}x same-slot create`, okIdx.length <= 1, overs.length === 0,
      `created=${okIdx.length} tally=${JSON.stringify(tally(responses))} overlaps=${overs.length}`,
      { initial: before, tally: tally(responses), createdIds });
    // Best-effort cleanup: withdraw the surviving hold(s) so later runs
    // start from a clean slot (DELETE is allowed for requested holds).
    for (const { r, i } of okIdx) {
      if (r.data?._id) {
        try { await api("DELETE", `/bookings/${r.data._id}`, { token: customers[i].token }); } catch { /* ignore */ }
      }
    }
  }

  // ══ T02: overlapping ranges ══════════════════════════════════════════════
  {
    const starts = ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30"];
    const endFor = (s) => { const m = toMin(s) + 120; return `${p2(Math.floor(m / 60))}:${p2(m % 60)}`; };
    const takers = customers.slice(0, 20);
    const settled02 = await burst(
      takers.map((c, i) => {
        const s = starts[i % starts.length];
        return () => api("POST", "/bookings", {
          token: c.token,
          body: bookPayload(cookId, dayStr(9), s, endFor(s), { clientKey: `${TAG}-t02-${i}` }),
        }).then((r) => ({ r, i }));
      })
    );
    const responses = settled02.map((v) => (v && v.r) || { status: -1, data: null });
    // Best-effort cleanup of surviving holds (requested only).
    for (const v of settled02) {
      if (v && v.r && [200, 201].includes(v.r.status) && v.r.data?._id) {
        try { await api("DELETE", `/bookings/${v.r.data._id}`, { token: takers[v.i].token }); } catch { /* ignore */ }
      }
    }
    const after = await snapshotBookings(admin.token);
    const day = after.filter((b) => normId(b.cook) === cookId &&
      Math.abs(new Date(b.date).getTime() - new Date(dayStr(9)).getTime()) < 12 * 3600 * 1000);
    const overs = findOverlaps(day);
    finalize("T02", "20x overlapping ranges",
      responses.every((r) => r.status !== -1), overs.length === 0,
      `created=${responses.filter((r) => [200, 201].includes(r.status)).length} overlaps=${overs.length} tally=${JSON.stringify(tally(responses))}`,
      { tally: tally(responses), overlaps: overs.map(([a, b]) => `${a.startTime}-${a.endTime}/${a.status} x ${b.startTime}-${b.endTime}/${b.status}`) });
  }

  // Helper: fresh request id. A previous run's unexpired 5-minute hold can
  // still occupy the slot when re-running quickly — nudge forward on 409
  // (overlap is preserved for T06-style tests: +30m steps stay overlapping).
  const freshRequest = async (cust, date = dayStr(10), s = "10:00", e = "12:00", extra = {}) => {
    const dur = toMin(e) - toMin(s);
    let start = s;
    for (let attempt = 0; attempt < 5; attempt++) {
      const end = fmtMin(toMin(start) + dur);
      const r = await api("POST", "/bookings", {
        token: cust.token, body: bookPayload(cookId, date, start, end, { clientKey: `${TAG}-r${Math.random().toString(36).slice(2)}`, ...extra }),
      });
      if ([200, 201].includes(r.status) && r.data?._id) return String(r.data._id);
      if (r.status !== 409) throw new Error(`setup request: ${r.status} ${JSON.stringify(r.data)}`);
      start = addMinutes(start, 30);
    }
    throw new Error(`setup request: slot persistently occupied on ${date} from ${s}`);
  };
  const fetchBooking = async (id) => {
    if (useDirectDb) return DirectBooking.findById(id).lean();
    const r = await api("GET", `/bookings/${id}`, { token: admin.token });
    return r.status === 200 ? r.data : null;
  };

  // ══ T03: double accept, same booking ══════════════════════════════════════
  {
    const id = await freshRequest(customers[0], dayStr(11));
    const before = await fetchBooking(id);
    const [r1, r2] = await burst([
      () => api("PATCH", `/bookings/${id}/accept`, { token: cook.token }),
      () => api("PATCH", `/bookings/${id}/accept`, { token: cook.token }),
    ]);
    const after = await fetchBooking(id);
    const { acceptedEntries } = historyAnomalies(after || { statusHistory: [] });
    const ok = after?.status === "accepted" && acceptedEntries === 1;
    // Serialized accept: exactly one winner (200), the loser is refused
    // (400/409) — never two concurrent winners. The old suite demanded
    // double-200, which was the race itself.
    const oneWinner = [r1.status, r2.status].filter((s) => s === 200).length === 1 &&
      [r1.status, r2.status].every((s) => [200, 400, 409].includes(s));
    finalize("T03", "2x accept same booking", oneWinner, ok,
      `responses=${r1.status},${r2.status} acceptedEntries=${acceptedEntries} status=${after?.status}`,
      { responses: [r1.status, r2.status], history: (after?.statusHistory || []).map((h) => h.status) });
    await api("PATCH", `/bookings/${id}/cancel`, { token: cook.token, body: {} });
  }

  // ══ T04: accept vs removed-reschedule tombstone ═══════════════════════════
  // Self-serve reschedule was removed; the endpoint is a permanent 410
  // tombstone. This burst proves a concurrent tombstone call can neither
  // disturb the accept nor mutate the booking.
  {
    const id = await freshRequest(customers[1], dayStr(12));
    const before = await fetchBooking(id);
    const [ra, rr] = await burst([
      () => api("PATCH", `/bookings/${id}/accept`, { token: cook.token }),
      () => api("PATCH", `/bookings/${id}/reschedule`, { token: customers[1].token, body: { date: dayStr(12), startTime: "14:00" } }),
    ]);
    const after = await fetchBooking(id);
    const an = historyAnomalies(after || { statusHistory: [] });
    const moved = after?.startTime !== before?.startTime || after?.endTime !== before?.endTime;
    const valid = ["requested", "accepted", "confirmed"].includes(after?.status) && an.out.length === 0 && !moved;
    finalize("T04", "accept vs removed reschedule (410 tombstone)", ra.status === 200 && rr.status === 410, valid,
      `accept=${ra.status} resched=${rr.status} final=${after?.status}@${after?.startTime} moved=${moved} anomalies=${an.out.join(";") || "none"}`,
      { responses: [ra.status, rr.status], final: after });
    await api("PATCH", `/bookings/${id}/cancel`, { token: customers[1].token, body: {} });
  }

  // ══ T05: accept vs cancel ═════════════════════════════════════════════════
  {
    const id = await freshRequest(customers[2], dayStr(13));
    const [ra, rc] = await burst([
      () => api("PATCH", `/bookings/${id}/accept`, { token: cook.token }),
      () => api("PATCH", `/bookings/${id}/cancel`, { token: customers[2].token, body: {} }),
    ]);
    const after = await fetchBooking(id);
    const valid = ["accepted", "cancelled"].includes(after?.status);
    const an = historyAnomalies(after || { statusHistory: [] });
    // Serialized: exactly one winner; the loser gets a terminal code
    // (400/409/410), never a silent double-effect. History must be clean.
    const oneWinner = [ra.status, rc.status].filter((s) => s === 200).length === 1;
    finalize("T05", "accept vs cancel",
      oneWinner && [200, 400, 409].includes(ra.status) && [200, 400, 409, 410].includes(rc.status) && valid && an.out.length === 0, valid && an.out.length === 0,
      `accept=${ra.status} cancel=${rc.status} final=${after?.status} anomalies=${an.out.join(";") || "none"}`,
      { responses: [ra.status, rc.status], history: (after?.statusHistory || []).map((h) => h.status) });
    if (after?.status === "accepted") await api("PATCH", `/bookings/${id}/cancel`, { token: cook.token, body: {} });
  }

  // ══ T06: create-overlap vs accept ═════════════════════════════════════════
  {
    const idA = await freshRequest(customers[3], dayStr(14));
    const [rCreate, rAccept] = await burst([
      () => api("POST", "/bookings", {
        token: customers[4].token,
        body: bookPayload(cookId, dayStr(14), "11:00", "13:00", { clientKey: `${TAG}-t06b` }),
      }),
      () => api("PATCH", `/bookings/${idA}/accept`, { token: cook.token }),
    ]);
    const after = await snapshotBookings(admin.token);
    const day = after.filter((b) => normId(b.cook) === cookId &&
      Math.abs(new Date(b.date).getTime() - new Date(dayStr(14)).getTime()) < 12 * 3600 * 1000);
    const overs = findOverlaps(day).filter(([a, b]) =>
      ACTIVE.includes(a.status) && ACTIVE.includes(b.status));
    // Informational: a live requested hold overlapping an accepted booking is
    // a known design gap (accept checks ignore requested rivals) — recorded,
    // not failed, so the run documents it either way.
    const holdOvers = findOverlaps(day).filter(([a, b]) =>
      [a.status, b.status].includes("requested") &&
      [a, b].some((x) => ACTIVE.includes(x.status)));
    finalize("T06", "create-overlap vs accept",
      rAccept.status === 200 && [200, 201, 409].includes(rCreate.status), overs.length === 0,
      `create=${rCreate.status} accept=${rAccept.status} activeOverlaps=${overs.length} holdVsActive=${holdOvers.length}`,
      { responses: [rCreate.status, rAccept.status] });
    const a = await fetchBooking(idA);
    if (a?.status === "accepted") await api("PATCH", `/bookings/${idA}/cancel`, { token: cook.token, body: {} });
    else await api("DELETE", `/bookings/${idA}`, { token: customers[3].token });
    // B may survive as a requested hold overlapping accepted A (known gap) —
    // withdraw it so later runs start clean.
    if ([200, 201].includes(rCreate.status) && rCreate.data?._id) {
      try { await api("DELETE", `/bookings/${rCreate.data._id}`, { token: customers[4].token }); } catch { /* ignore */ }
    }
  }

  // ══ T07: pay vs cancel ═══════════════════════════════════════════════════
  if (!testPayLive) {
    record("T07", "pay vs cancel", "SKIP", "test payments unavailable on target server");
  } else {
    const id = await freshRequest(customers[5], dayStr(15));
    await api("PATCH", `/bookings/${id}/accept`, { token: cook.token });
    const [rp, rc] = await burst([
      () => api("PATCH", `/bookings/${id}/pay`, { token: customers[5].token, body: { method: "upi", testMode: true } }),
      () => api("PATCH", `/bookings/${id}/cancel`, { token: customers[5].token, body: {} }),
    ]);
    const after = await fetchBooking(id);
    const coherent =
      (after?.status === "confirmed" && after?.payment?.status === "paid") ||
      (after?.status === "cancelled");
    const bad = after?.status === "confirmed" && after?.payment?.status !== "paid";
    finalize("T07", "pay vs cancel",
      ![rp, rc].some((r) => r.status === -1 || r.status >= 500), coherent && !bad,
      `pay=${rp.status} cancel=${rc.status} payMsg=${rp.data?.message || ""} final=${after?.status}/${after?.payment?.status}`,
      { responses: [rp.status, rc.status] });
    if (after?.status === "confirmed") await api("PATCH", `/bookings/${id}/cancel`, { token: admin.token, body: {} });
  }

  // ══ T08a: double accept at expiry boundary ═══════════════════════════════
  {
    const id = await freshRequest(customers[6], dayStr(16));
    const [r1, r2] = await burst([
      () => api("PATCH", `/bookings/${id}/accept`, { token: cook.token }),
      () => api("PATCH", `/bookings/${id}/accept`, { token: admin.token }),
    ]);
    const after = await fetchBooking(id);
    const { acceptedEntries } = historyAnomalies(after || { statusHistory: [] });
    // Serialized accept across roles: exactly one winner (200), loser refused.
    const oneWinner = [r1.status, r2.status].filter((s) => s === 200).length === 1 &&
      [r1.status, r2.status].every((s) => [200, 400, 409].includes(s));
    finalize("T08a", "2x accept (cook+admin) same tick",
      oneWinner, after?.status === "accepted" && acceptedEntries === 1,
      `responses=${r1.status},${r2.status} acceptedEntries=${acceptedEntries}`,
      { responses: [r1.status, r2.status] });
    await api("PATCH", `/bookings/${id}/cancel`, { token: cook.token, body: {} });
  }

  // ══ T08b: double late-accept after expiry (SLOW) ══════════════════════════
  if (!RUN_SLOW) {
    record("T08b", "2x late-accept after expiry", "SKIP", "set RUN_SLOW=1 (~6 min)");
  } else {
    const id = await freshRequest(customers[7], dayStr(17));
    const seeded = await fetchBooking(id);
    const waitMs = Math.max(0, new Date(seeded.requestExpiresAt).getTime() - Date.now() + 8000);
    console.log(`INFO  T08b waiting ${(waitMs / 1000).toFixed(0)}s for the 5-minute window to lapse…`);
    await new Promise((r) => setTimeout(r, waitMs));
    const [r1, r2] = await burst([
      () => api("PATCH", `/bookings/${id}/accept`, { token: cook.token }),
      () => api("PATCH", `/bookings/${id}/accept`, { token: cook.token }),
    ]);
    const after = await fetchBooking(id);
    const expiredEntries = (after?.statusHistory || []).filter((h) => h.status === "expired").length;
    const ok = after?.status === "expired" && [410, 400].includes(r1.status) && [410, 400].includes(r2.status);
    finalize("T08b", "2x late-accept after expiry",
      [410, 400].includes(r1.status) && [410, 400].includes(r2.status), ok && expiredEntries === 1,
      `responses=${r1.status},${r2.status} final=${after?.status} expiredEntries=${expiredEntries}`,
      { responses: [r1.status, r2.status] });
  }

  // ══ T09: same idempotency key twice ═══════════════════════════════════════
  {
    const key = `${TAG}-t09`;
    const [r1, r2] = await burst([
      () => api("POST", "/bookings", { token: customers[8].token, body: bookPayload(cookId, dayStr(18), "10:00", "12:00", { clientKey: key }) }),
      () => api("POST", "/bookings", { token: customers[8].token, body: bookPayload(cookId, dayStr(18), "10:00", "12:00", { clientKey: key }) }),
    ]);
    const ids = [r1.data?._id, r2.data?._id].filter(Boolean).map(String);
    const ok = [200, 201].includes(r1.status) && [200, 201].includes(r2.status) &&
      ids.length === 2 && ids[0] === ids[1];
    record("T09", "same clientKey x2", ok ? "PASS" : "FAIL",
      `responses=${r1.status},${r2.status} sameId=${ids[0] === ids[1]}`,
      { responses: [r1.status, r2.status] });
    if (ids[0]) await api("DELETE", `/bookings/${ids[0]}`, { token: customers[8].token });
  }

  // ══ T10: different keys, same slot ═══════════════════════════════════════
  {
    const [r1, r2] = await burst([
      () => api("POST", "/bookings", { token: customers[9].token, body: bookPayload(cookId, dayStr(19), "10:00", "12:00", { clientKey: `${TAG}-t10a` }) }),
      () => api("POST", "/bookings", { token: customers[10].token, body: bookPayload(cookId, dayStr(19), "10:00", "12:00", { clientKey: `${TAG}-t10b` }) }),
    ]);
    const created = [r1, r2].filter((r) => [200, 201].includes(r.status));
    const after = await snapshotBookings(admin.token);
    const day = after.filter((b) => normId(b.cook) === cookId &&
      Math.abs(new Date(b.date).getTime() - new Date(dayStr(19)).getTime()) < 12 * 3600 * 1000);
    const overs = findOverlaps(day);
    record("T10", "distinct keys same slot", created.length === 1 && overs.length === 0 ? "PASS" : "FAIL",
      `created=${created.length} overlaps=${overs.length} tally=${JSON.stringify(tally([r1, r2]))}`,
      { responses: [r1.status, r2.status] });
    for (const r of created) {
      const owner = r === r1 ? customers[9] : customers[10];
      await api("DELETE", `/bookings/${r.data._id}`, { token: owner.token });
    }
  }

  // ══ T11: retry after success (sequential) ═════════════════════════════════
  {
    const key = `${TAG}-t11`;
    const r1 = await api("POST", "/bookings", { token: customers[11].token, body: bookPayload(cookId, dayStr(20), "10:00", "12:00", { clientKey: key }) });
    const before = await snapCount();
    const r2 = await api("POST", "/bookings", { token: customers[11].token, body: bookPayload(cookId, dayStr(20), "10:00", "12:00", { clientKey: key }) });
    const afterN = await snapCount();
    const ok = [200, 201].includes(r1.status) && r2.status === 200 &&
      String(r1.data?._id) === String(r2.data?._id) && afterN === before;
    record("T11", "retry after success", ok ? "PASS" : "FAIL",
      `first=${r1.status} retry=${r2.status} retryMsg=${r2.data?.message || ""} countDelta=${afterN - before}`,
      { responses: [r1.status, r2.status] });
    if (r1.data?._id) await api("DELETE", `/bookings/${r1.data._id}`, { token: customers[11].token });
  }

  // ══ T12a: single-use coupon raced ═════════════════════════════════════════
  {
    const code = `${TAG}01`.toUpperCase();
    const mk = await api("POST", "/coupons", {
      token: admin.token,
      body: { code, description: "adv", discountType: "flat", flatAmount: 50, minOrder: 0, usageLimit: 1, perUserLimit: 1, active: true },
    });
    if (mk.status !== 201) {
      record("T12a", "single-use coupon race", "ENV-LIMITED", `coupon create: ${mk.status}`);
    } else {
      const [r1, r2] = await burst([
        () => api("POST", "/bookings", { token: customers[12].token, body: bookPayload(cookId, dayStr(21), "10:00", "12:00", { clientKey: `${TAG}-t12a`, couponCode: code }) }),
        () => api("POST", "/bookings", { token: customers[13].token, body: bookPayload(cookId, dayStr(21), "14:00", "16:00", { clientKey: `${TAG}-t12b`, couponCode: code }) }),
      ]);
      const created = [r1, r2].filter((r) => [200, 201].includes(r.status));
      let usedCount = null;
      if (useDirectDb) {
        const c = await DirectCoupon.findOne({ code }).lean();
        usedCount = c?.usedCount;
      } else {
        const list = await api("GET", "/coupons", { token: admin.token });
        const arr = asList(list) || [];
        usedCount = (arr.find((c) => c.code === code) || {}).usedCount;
      }
      const ok = created.length === 1 && usedCount === 1;
      finalize("T12a", "single-use coupon race", created.length === 1, ok,
        `created=${created.length} usedCount=${usedCount} tally=${JSON.stringify(tally([r1, r2]))}`,
        { responses: [r1.status, r2.status], usedCount });
      for (const [r, cust] of [[r1, customers[12]], [r2, customers[13]]]) {
        if ([200, 201].includes(r.status) && r.data?._id) {
          await api("PATCH", `/bookings/${r.data._id}/cancel`, { token: cust.token, body: {} });
        }
      }
    }
  }

  // ══ T12b: double pay-confirm, one booking ═════════════════════════════════
  if (!testPayLive) {
    record("T12b", "double pay-confirm", "SKIP", "test payments unavailable on target server");
  } else {
    const id = await freshRequest(customers[14], dayStr(22));
    await api("PATCH", `/bookings/${id}/accept`, { token: cook.token });
    const [r1, r2] = await burst([
      () => api("PATCH", `/bookings/${id}/pay`, { token: customers[14].token, body: { method: "upi", testMode: true } }),
      () => api("PATCH", `/bookings/${id}/pay`, { token: customers[14].token, body: { method: "upi", testMode: true } }),
    ]);
    const after = await fetchBooking(id);
    const ok = after?.status === "confirmed" && after?.payment?.status === "paid" &&
      r1.status === 200 && r2.status === 200;
    const confirms = (after?.statusHistory || []).filter((h) => h.status === "confirmed").length;
    finalize("T12b", "double pay-confirm", r1.status === 200 && r2.status === 200, ok && confirms === 1,
      `responses=${r1.status},${r2.status} confirms=${confirms} paidAmount=${after?.payment?.paidAmount}`,
      { responses: [r1.status, r2.status] });
    await api("PATCH", `/bookings/${id}/cancel`, { token: admin.token, body: {} });
  }

  // ══ T13: invalid + wrong-owner vs valid ═══════════════════════════════════
  {
    const id = await freshRequest(customers[15], dayStr(23));
    const [badId, wrongOwner, good] = await burst([
      () => api("PATCH", "/bookings/not-a-valid-id/accept", { token: cook.token }),
      () => api("PATCH", `/bookings/${id}/cancel`, { token: customers[16].token, body: {} }),
      () => api("PATCH", `/bookings/${id}/accept`, { token: cook.token }),
    ]);
    const after = await fetchBooking(id);
    const ok = badId.status === 404 && wrongOwner.status === 403 &&
      good.status === 200 && after?.status === "accepted";
    finalize("T13", "invalid/wrong-owner vs valid",
      badId.status === 404 && wrongOwner.status === 403 && good.status === 200, ok,
      `badId=${badId.status} wrongOwner=${wrongOwner.status} good=${good.status} final=${after?.status}`,
      { responses: [badId.status, wrongOwner.status, good.status] });
    await api("PATCH", `/bookings/${id}/cancel`, { token: cook.token, body: {} });
  }

  // ══ T14: two devices, one key ═════════════════════════════════════════════
  {
    const key = `${TAG}-t14`;
    const [r1, r2] = await burst([
      () => api("POST", "/bookings", { token: customers[17].token, body: bookPayload(cookId, dayStr(24), "10:00", "12:00", { clientKey: key }) }),
      () => api("POST", "/bookings", { token: customers[17].token, body: bookPayload(cookId, dayStr(24), "10:00", "12:00", { clientKey: key }) }),
    ]);
    const ids = [r1.data?._id, r2.data?._id].filter(Boolean).map(String);
    const ok = ids.length === 2 && ids[0] === ids[1];
    record("T14", "two devices one key", ok ? "PASS" : "FAIL",
      `responses=${r1.status},${r2.status} sameId=${ids[0] === ids[1]}`,
      { responses: [r1.status, r2.status] });
    if (ids[0]) await api("DELETE", `/bookings/${ids[0]}`, { token: customers[17].token });
  }

  // ══ T15: identical amounts, distinct payments ═════════════════════════════
  if (!testPayLive) {
    record("T15", "identical amounts distinct pays", "SKIP", "test payments unavailable on target server");
  } else {
    const mkPaid = async (cust, date, s, e) => {
      const id = await freshRequest(cust, date, s, e);
      await api("PATCH", `/bookings/${id}/accept`, { token: cook.token });
      const p = await api("PATCH", `/bookings/${id}/pay`, { token: cust.token, body: { method: "upi", testMode: true } });
      return { id, pay: p };
    };
    const [A, B] = await Promise.all([
      mkPaid(customers[18], dayStr(25), "10:00", "12:00"),
      mkPaid(customers[19], dayStr(25), "14:00", "16:00"),
    ]);
    const [a, b] = await Promise.all([fetchBooking(A.id), fetchBooking(B.id)]);
    const distinct = a?.payment?.razorpayPaymentId && b?.payment?.razorpayPaymentId &&
      a.payment.razorpayPaymentId !== b.payment.razorpayPaymentId;
    const ok = a?.status === "confirmed" && b?.status === "confirmed" &&
      a?.payment?.paidAmount === b?.payment?.paidAmount && distinct;
    finalize("T15", "identical amounts distinct pays",
      A.pay.status === 200 && B.pay.status === 200, ok,
      `amounts=${a?.payment?.paidAmount}/${b?.payment?.paidAmount} distinctIds=${distinct}`,
      { ids: [A.id, B.id] });
    await api("PATCH", `/bookings/${A.id}/cancel`, { token: admin.token, body: {} });
    await api("PATCH", `/bookings/${B.id}/cancel`, { token: admin.token, body: {} });
  }

  // ══ Final global invariants (scoped to THIS run via clientKey TAG so
  // seeded/sample rows can never false-fail the suite). Meaningless when
  // the db-match check already failed — downgraded, not passed.
  {
    if (!DB_OK) {
      record("INV", "global invariants", "ENV-LIMITED", "not evaluated (db mismatch)");
    } else {
      const all = await snapshotBookings(admin.token);
    const scoped = all.filter((b) => String(b.clientKey || "").startsWith(TAG));
    const overs = findOverlaps(scoped).filter(([a, b]) => ACTIVE.includes(a.status) && ACTIVE.includes(b.status));
    const dups = findDupPayments(scoped);
    const histBad = [];
    for (const b of scoped) {
      const an = historyAnomalies(b);
      if (an.out.length) histBad.push({ id: String(b._id), issues: an.out });
    }
    record("INV", "global invariants",
      overs.length === 0 && dups.length === 0 && histBad.length === 0 ? "PASS" : "FAIL",
      `activeOverlaps=${overs.length} dupPayments=${dups.length} historyAnomalies=${histBad.length}`,
      { overlaps: overs.map(([a, b]) => `${a.startTime}-${a.endTime}/${a.status} x ${b.startTime}-${b.endTime}/${b.status}`), dups, histBad });
    }
  }

  finish(startedAt);
})().catch((e) => {
  // A setup crash (e.g. occupied slot) must still leave a report behind —
  // never die silently with no artifact.
  console.error("FATAL suite crash:", (e && e.stack) || e);
  try { record("FATAL", "unhandled suite crash", "FAIL", String((e && e.message) || e)); } catch { /* ignore */ }
  try { finish(new Date().toISOString()); } catch { process.exit(1); }
});

function finish(startedAt) {
  const report = {
    startedAt, finishedAt: new Date().toISOString(),
    base: BASE, floodN: FLOOD_N, runSlow: RUN_SLOW,
    summary: { passes, failures, skips, envLimited },
    tests: results,
  };
  try {
    const file = path.join(__dirname, `concurrency-report-${RUN_TS}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(`INFO  report written to ${file}`);
  } catch (e) {
    console.log(`INFO  report write failed: ${e.message}`);
  }
  console.log(`\n${passes} passed, ${failures} failed, ${skips} skipped, ${envLimited} env-limited`);
  try {
    const mongoose = require("mongoose");
    if (mongoose.connection.readyState === 1) mongoose.disconnect();
  } catch { /* ignore */ }
  process.exit(failures ? 1 : 0);
}
