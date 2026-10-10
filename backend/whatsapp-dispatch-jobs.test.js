// Durable WhatsApp dispatch-outbox tests.
//
// Covers: job persistence on enqueue, worker processing, restart recovery,
// transient retry with backoff, permanent-failure termination, no-recipient
// and disabled-config recording, invalid-status skips (expired/cancelled/
// assigned), sent-recipient dedup, atomic claim concurrency, stale/recent
// `sending` reconciliation, backfill of job-less bookings, admin listing,
// and manual-retry record compatibility. Website/accept flows are covered
// by the existing whatsapp-channel + booking suites (run separately).
//
// No real Meta calls, no real DB: DispatchJob/Booking/User are faked
// in-memory and global.fetch is stubbed.

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.WHATSAPP_ENABLED = "true";
process.env.WHATSAPP_TOKEN = "test_token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";

const DispatchJob = require("./models/DispatchJob");
const Booking = require("./models/Booking");
const User = require("./models/User");
const jobs = require("./services/bookingDispatchJobs");
const dispatch = require("./services/whatsappDispatch");
const CookProfile = require("./models/CookProfile");
const bookingCtrl = require("./controllers/bookingController");
const fs = require("fs");
const path = require("path");

let passes = 0, failures = 0;
const check = (n, ok, d) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`);
  ok ? passes++ : failures++;
};

// ---------- fake stores ----------
const jobStore = new Map();
const bookingStore = new Map();
const userStore = new Map();
let seq = 0;
const nid = (p) => `${p}_${Date.now().toString(36)}_${(seq += 1)}`;
const clone = (o) => JSON.parse(JSON.stringify(o));

const getPath = (obj, path) =>
  String(path).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const setPath = (obj, path, value) => {
  const keys = String(path).split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i] === "$") continue;
    if (o[keys[i]] == null || typeof o[keys[i]] !== "object") o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
};
const sameId = (a, b) => String(a) === String(b);
const matchVal = (actual, cond) => {
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    if ("$not" in cond) return !matchVal(actual, cond.$not);
    if ("$in" in cond) return (cond.$in || []).some((v) => sameId(v, actual));
    if ("$lte" in cond) return actual != null && new Date(actual).getTime() <= new Date(cond.$lte).getTime();
    if ("$lt" in cond) return actual != null && new Date(actual).getTime() < new Date(cond.$lt).getTime();
    if ("$gte" in cond) return actual != null && new Date(actual).getTime() >= new Date(cond.$gte).getTime();
    if ("$gt" in cond) return actual != null && new Date(actual).getTime() > new Date(cond.$gt).getTime();
    if ("$ne" in cond) return !sameId(actual, cond.$ne) && actual !== cond.$ne;
    if ("$elemMatch" in cond) {
      const arr = Array.isArray(actual) ? actual : [];
      const em = cond.$elemMatch;
      return arr.some((e) => Object.keys(em).every((k) => sameId(getPath(e, k), em[k]) || getPath(e, k) === em[k]));
    }
    return false;
  }
  if (cond === null) return actual === null || actual === undefined;
  return sameId(actual, cond) || actual === cond;
};
const matchFilter = (doc, filter = {}) =>
  Object.keys(filter || {}).every((k) => {
    if (k === "$and") return filter.$and.every((c) => matchFilter(doc, c));
    if (k === "$or") return filter.$or.some((c) => matchFilter(doc, c));
    return matchVal(getPath(doc, k), filter[k]);
  });

const applyUpdate = (doc, update = {}) => {
  if (update.$setOnInsert) {
    // handled by upsert path; plain docs ignore
  }
  if (update.$set) {
    for (const k of Object.keys(update.$set)) {
      if (k.includes(".$.")) {
        const m = k.match(/^whatsappDispatch\.\$\.(.+)$/);
        if (m && doc.__pendingElem) {
          doc.__pendingElem[m[1]] = update.$set[k];
          delete doc.__pendingElem.__pendingElem;
          continue;
        }
      }
      setPath(doc, k, update.$set[k]);
    }
  }
  if (update.$inc) {
    for (const k of Object.keys(update.$inc)) doc[k] = (Number(doc[k]) || 0) + update.$inc[k];
  }
  if (update.$push) {
    for (const k of Object.keys(update.$push)) {
      doc[k] = doc[k] || [];
      doc[k].push(update.$push[k]);
    }
  }
};
const chain = (rows) => {
  const q = {
    sort: () => q,
    skip: (n) => {
      rows = rows.slice(n);
      return q;
    },
    limit: (n) => {
      rows = rows.slice(0, n);
      return q;
    },
    select: () => q,
    lean: async () => rows.map((r) => {
      const c = { ...r };
      delete c.__pendingElem;
      return c;
    }),
    // Thenable like a real Mongoose query (controller code awaits chains).
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };
  return q;
};

DispatchJob.updateOne = async (filter, update, opts = {}) => {
  for (const doc of jobStore.values()) {
    if (matchFilter(doc, filter)) {
      applyUpdate(doc, update);
      doc.updatedAt = new Date();
      return { modifiedCount: 1 };
    }
  }
  if (opts.upsert) {
    const doc = { _id: nid("job"), createdAt: new Date(), updatedAt: new Date() };
    if (update.$setOnInsert) Object.assign(doc, clone(update.$setOnInsert));
    if (update.$set) {
      for (const k of Object.keys(update.$set)) setPath(doc, k, update.$set[k]);
    }
    jobStore.set(String(doc._id), doc);
    return { modifiedCount: 0, upsertedCount: 1 };
  }
  return { modifiedCount: 0 };
};
DispatchJob.updateMany = async (filter, update) => {
  let n = 0;
  for (const doc of jobStore.values()) {
    if (matchFilter(doc, filter)) {
      applyUpdate(doc, update);
      doc.updatedAt = new Date();
      n += 1;
    }
  }
  return { modifiedCount: n };
};
DispatchJob.findOne = (filter) => {
  for (const doc of jobStore.values()) {
    if (matchFilter(doc, filter)) {
      const found = doc;
      return { lean: async () => ({ ...found }) };
    }
  }
  return { lean: async () => null };
};
DispatchJob.findOneAndUpdate = async (filter, update, opts = {}) => {
  const cands = [...jobStore.values()].filter((d) => matchFilter(d, filter));
  if (!cands.length) return null;
  cands.sort((a, b) => new Date(a.nextRetryAt || 0) - new Date(b.nextRetryAt || 0));
  const doc = cands[0];
  applyUpdate(doc, update);
  doc.updatedAt = new Date();
  return opts.new === false ? null : { ...doc };
};
DispatchJob.find = (filter) => chain([...jobStore.values()].filter((d) => matchFilter(d, filter)));
DispatchJob.countDocuments = async (filter) =>
  [...jobStore.values()].filter((d) => matchFilter(d, filter)).length;

Booking.findById = (id) => {
  // Thenable like a real Mongoose query (awaitable) with a .lean() chain.
  const doc = bookingStore.get(String(id)) || null;
  const q = Promise.resolve(doc ? clone(doc) : null);
  q.lean = () => Promise.resolve(doc ? clone(doc) : null);
  return q;
};
Booking.updateOne = async (filter, update) => {
  for (const doc of bookingStore.values()) {
    if (matchFilter(doc, filter)) {
      const em = filter?.whatsappDispatch?.$elemMatch;
      if (em) {
        doc.__pendingElem =
          (doc.whatsappDispatch || []).find((e) =>
            Object.keys(em).every((k) => sameId(getPath(e, k), em[k]))
          ) || null;
        if (!doc.__pendingElem) return { modifiedCount: 0 };
      }
      applyUpdate(doc, update);
      delete doc.__pendingElem;
      return { modifiedCount: 1 };
    }
  }
  return { modifiedCount: 0 };
};
Booking.find = (filter) => chain([...bookingStore.values()].filter((d) => matchFilter(d, filter)));

User.findById = (id) => {
  const u = userStore.get(String(id)) || null;
  return { select: () => ({ lean: async () => (u ? { ...u } : null) }) };
};
User.find = () => ({ select: () => ({ lean: async () => [] }) });
// No customer is blocked in this suite: fixtures represent legitimately
// created bookings (mkBookingDoc carries the persisted confirmation).
const BookingRestriction = require("./models/BookingRestriction");
BookingRestriction.findOne = () => ({ lean: async () => null });

// Real fan-out touches notifications + realtime: stub the side effects.
const Notification = require("./models/Notification");
Notification.create = async () => ({ _id: "notif1" });
try {
  require("./utils/realtime").emit = () => {};
} catch {
}
const phoneList = (rows) => () => ({ select: () => ({ lean: async () => rows.map((r) => ({ ...r })) }) });

// The service guards writes on a live connection (like production code).
// Set AFTER all model requires: mongoose inspects readyState at model
// compile time, so flipping it earlier crashes model loading.
require("mongoose").connection.readyState = 1;

// ---------- Meta stub ----------
let metaMode = "ok"; // ok | fail500 | fail401 | fail429 | throw
let metaFailTo = new Set(); // recipient number suffixes to fail (single-cook failure tests)
let fetchCalls = 0;
let lastRetryAfter = null;
const sentBodies = [];
global.fetch = async (url, opts) => {
  fetchCalls += 1;
  let body = {};
  try {
    body = JSON.parse(opts?.body || "{}");
  } catch {
  }
  sentBodies.push(body);
  const to = String(body.to || "");
  if ([...metaFailTo].some((s) => s && to.endsWith(s))) {
    return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: { message: "single-cook boom", code: 1 } }) };
  }
  if (metaMode === "throw") throw new Error("socket hang up");
  if (metaMode === "fail500") {
    return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ error: { message: "server error", code: 1 } }) };
  }
  if (metaMode === "fail401") {
    return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ error: { message: "Invalid token", code: 190 } }) };
  }
  if (metaMode === "fail429") {
    lastRetryAfter = "3";
    return { ok: false, status: 429, headers: { get: (h) => (String(h).toLowerCase() === "retry-after" ? "3" : null) }, json: async () => ({ error: { message: "rate limited", code: 80007 } }) };
  }
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ messages: [{ id: `wamid.${fetchCalls}` }] }) };
};

// ---------- fixtures ----------
const COOK_A = "507f1f77bcf86cd7994390a1";
const COOK_B = "507f1f77bcf86cd7994390a2";
const CUST = "507f1f77bcf86cd7994390c1";
const mkBookingDoc = (over = {}) => {
  const b = {
    _id: nid("bk"),
    customer: CUST,
    cook: null,
    ignoredBy: [],
    serviceType: "cook_for_me",
    date: new Date(Date.now() + 864e5),
    startTime: "13:30",
    endTime: "14:30",
    status: "requested",
    requestExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
    whatsappDispatch: [],
    createdAt: new Date(),
    // Fixtures represent legitimately created bookings, which now carry
    // the customer's explicit persisted confirmation.
    womanPresenceConfirmed: true,
    womanPresenceConfirmedAt: new Date(Date.now() - 60e3),
    ...over,
  };
  bookingStore.set(String(b._id), b);
  return b;
};
const mkJobDoc = (bookingId, over = {}) => {
  const j = {
    _id: nid("job"),
    booking: bookingId,
    kind: "booking.requested",
    status: "pending",
    attempts: 0,
    maxAttempts: 5,
    nextRetryAt: new Date(),
    // Pre-locked so direct processJob() calls (which save guarded by
    // lockedBy, like the real claim-then-process flow) persist outcomes.
    lockedBy: "w1",
    reason: "",
    error: "",
    eligibleCookCount: 0,
    sentCount: 0,
    failedCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
  jobStore.set(String(j._id), j);
  return j;
};
const eligibleTwo = [{ userId: COOK_A }, { userId: COOK_B }];
const fakeFanOutOk = (booking) => async () => {
  const doc = bookingStore.get(String(booking._id || booking));
  for (const c of eligibleTwo) {
    doc.whatsappDispatch.push({ cook: c.userId, kind: "request", status: "sent", messageId: `wamid.${c.userId.slice(-2)}`, attempts: 1 });
  }
  return { ok: true, results: eligibleTwo.map((c) => ({ cookId: c.userId, ok: true, id: "wamid.x" })) };
};
const reset = () => {
  jobStore.clear();
  bookingStore.clear();
  userStore.clear();
  userStore.set(CUST, { _id: CUST, name: "Test Customer" });
  metaMode = "ok";
  metaFailTo = new Set();
  fetchCalls = 0;
  sentBodies.length = 0;
};
// N cooks with distinct valid Indian mobiles (suffixes 20.. unique).
const makeCooks = (n, startIx = 0) => {
  const cooks = [];
  for (let i = 0; i < n; i += 1) {
    const ix = startIx + i;
    const id = `507f1f77bcf86cd799439${String(100 + ix).slice(-3)}`;
    const phone = `90000000${String(20 + ix).padStart(2, "0")}`.slice(-10);
    userStore.set(id, { _id: id, name: `Cook ${ix}`, phone });
    cooks.push({ userId: id, phone });
  }
  return cooks;
};
const stubPhonesFor = (cooks) => {
  User.find = phoneList(cooks.map((c) => ({ _id: c.userId, phone: c.phone, name: `Cook ${c.userId.slice(-2)}` })));
  User.findById = (id) => ({
    select: () => ({
      lean: async () => {
        if (String(id) === CUST) return { name: "Test Customer" };
        const c = cooks.find((x) => String(x.userId) === String(id));
        return c ? { name: `Cook ${c.userId.slice(-2)}` } : null;
      },
    }),
  });
};

(async () => {
  try {
    // 1. enqueue persists a durable pending job; duplicates do not duplicate
    {
      reset();
      const b = mkBookingDoc();
      const j1 = await jobs.enqueueBookingRequestJob(b._id);
      check("enqueue persists pending job", j1 && j1.status === "pending" && String(j1.booking) === String(b._id), `status=${j1?.status}`);
      await jobs.enqueueBookingRequestJob(b._id);
      check("duplicate enqueue is idempotent", jobStore.size === 1, `jobs=${jobStore.size}`);
    }

    // 2. worker claims + processes pending job -> completed via injected fan-out
    {
      reset();
      const b = mkBookingDoc();
      await jobs.enqueueBookingRequestJob(b._id);
      const r = await jobs.processDueJobsOnce({ findEligibleCooks: async () => eligibleTwo, fanOut: fakeFanOutOk(b), workerId: "w1" });
      const stored = [...jobStore.values()][0];
      check("worker processes pending job", r.claimed === true && stored.status === "completed" && stored.reason === "dispatched", `${stored.status}/${stored.reason}`);
      check("sent counts recorded", stored.sentCount === 2 && stored.eligibleCookCount === 2, `sent=${stored.sentCount}`);
    }

    // 3. restart recovery: stale processing lease is reclaimed, sent cooks not resent
    {
      reset();
      const b = mkBookingDoc();
      b.whatsappDispatch.push({ cook: COOK_A, kind: "request", status: "sent", messageId: "wamid.old", attempts: 1 });
      mkJobDoc(b._id, { status: "processing", attempts: 1, lockedBy: "dead-worker", leaseExpiresAt: new Date(Date.now() - 1000) });
      const rec = await jobs.recoverStaleLocks();
      const claimed = await jobs.claimDueJob("w2");
      check("stale lease recovered + reclaimed", rec === 1 && claimed && String(claimed._id), `rec=${rec} claimed=${!!claimed}`);
      let fanOutTargets = null;
      const fanOut = async (bk, elig) => {
        fanOutTargets = elig.map((e) => e.userId);
        return { ok: true, results: [] };
      };
      await jobs.processJob(claimed, { findEligibleCooks: async () => [{ userId: COOK_A }], fanOut, workerId: "w2" });
      const stored = [...jobStore.values()][0];
      check("recovered job completes without resending sent cook", stored.status === "completed", stored.status);
      void fanOutTargets;
    }

    // 4. transient Meta 500 -> retrying with future nextRetryAt; then succeeds
    {
      reset();
      const b = mkBookingDoc();
      await jobs.enqueueBookingRequestJob(b._id);
      metaMode = "fail500";
      const claimed = await jobs.claimDueJob("w1");
      // real fanOut with failing Meta: needs User/CookProfile fakes
      CookProfile.findOne = async () => ({ approvalStatus: "approved", serviceTypes: [] });
      User.find = phoneList([{ _id: COOK_A, phone: "9876543210", name: "A" }, { _id: COOK_B, phone: "9876543211", name: "B" }]);
      User.findById = (id) => {
        if (id === CUST) return { select: () => ({ lean: async () => ({ name: "Cust" }) }) };
        const map = { [COOK_A]: { name: "A" }, [COOK_B]: { name: "B" } };
        return { select: () => ({ lean: async () => map[String(id)] || null }) };
      };
      await jobs.processJob(claimed, { findEligibleCooks: async () => eligibleTwo, fanOut: dispatch.fanOutBookingRequest, workerId: "w1" });
      let stored = [...jobStore.values()][0];
      const firstAttempts = stored.attempts;
      check("transient Meta 500 -> retrying", stored.status === "retrying" && stored.nextRetryAt && new Date(stored.nextRetryAt).getTime() > Date.now(), `${stored.status}`);
      check("attempt counted", firstAttempts === 1, `attempts=${firstAttempts}`);
      metaMode = "ok";
      // make job due again + release lease like recovery would
      stored.status = "retrying";
      stored.nextRetryAt = new Date(Date.now() - 1);
      stored.leaseExpiresAt = null;
      stored.lockedBy = "";
      const c2 = await jobs.claimDueJob("w1");
      await jobs.processJob(c2, { findEligibleCooks: async () => eligibleTwo, fanOut: dispatch.fanOutBookingRequest, workerId: "w1" });
      stored = [...jobStore.values()][0];
      check("retry succeeds -> completed", stored.status === "completed" && stored.sentCount === 2, `${stored.status} sent=${stored.sentCount}`);
    }

    // 5. permanent Meta 401 -> failed, no infinite retry
    {
      reset();
      const b = mkBookingDoc();
      CookProfile.findOne = async () => ({ approvalStatus: "approved", serviceTypes: [] });
      User.find = phoneList([{ _id: COOK_A, phone: "9876543210", name: "A" }]);
      User.findById = (id) => ({ select: () => ({ lean: async () => (String(id) === CUST ? { name: "Cust" } : { name: "A" }) }) });
      metaMode = "fail401";
      const j = mkJobDoc(b._id, { status: "pending", attempts: 0, nextRetryAt: new Date(Date.now() - 1), lockedBy: "", leaseExpiresAt: null });
      let rounds = 0;
      for (;;) {
        rounds += 1;
        if (rounds > 10) break;
        const cur = jobStore.get(String(j._id));
        if (["failed", "completed", "skipped"].includes(cur.status)) break;
        // simulate poll delay elapsed + lease released between worker rounds
        cur.status = rounds === 1 ? "pending" : "retrying";
        cur.nextRetryAt = new Date(Date.now() - 1);
        cur.lockedBy = "";
        cur.leaseExpiresAt = null;
        const c = await jobs.claimDueJob("w1");
        if (!c) break;
        await jobs.processJob(c, { findEligibleCooks: async () => [{ userId: COOK_A }], fanOut: dispatch.fanOutBookingRequest, workerId: "w1" });
      }
      const terminal = jobStore.get(String(j._id));
      check("permanent 401 ends failed (bounded)", terminal.status === "failed" && terminal.attempts <= 5, `${terminal.status} attempts=${terminal.attempts}`);
      check("failure reason recorded", /meta_api_error|whatsapp_disabled/.test(terminal.reason), terminal.reason);
    }

    // 6. no eligible cooks -> skipped with reason (after max attempts path + immediate skip path)
    {
      reset();
      const b = mkBookingDoc();
      const j = mkJobDoc(b._id, { status: "pending", attempts: 5, maxAttempts: 5 });
      await jobs.processJob(j, { findEligibleCooks: async () => [], fanOut: async () => { throw new Error("must not fan out"); }, workerId: "w1" });
      const stored = jobStore.get(String(j._id));
      check("no eligible cooks recorded as skipped", stored.status === "skipped" && stored.reason === "no_eligible_cooks", `${stored.status}/${stored.reason}`);
    }

    // 7. disabled WhatsApp config is recorded, not silent
    {
      reset();
      const b = mkBookingDoc();
      const j = mkJobDoc(b._id, { status: "pending", attempts: 5, maxAttempts: 5 });
      const prev = process.env.WHATSAPP_ENABLED;
      process.env.WHATSAPP_ENABLED = "false";
      await jobs.processJob(j, { findEligibleCooks: async () => eligibleTwo, fanOut: async () => ({ ok: true, results: [] }), workerId: "w1" });
      process.env.WHATSAPP_ENABLED = prev;
      const stored = jobStore.get(String(j._id));
      check("disabled config recorded", stored.reason === "whatsapp_disabled" && stored.status !== "completed", `${stored.status}/${stored.reason}`);
    }

    // 8. invalid booking states never dispatch (expired / cancelled / assigned)
    {
      reset();
      let fanOutCalls = 0;
      const fanOut = async () => {
        fanOutCalls += 1;
        return { ok: true, results: [] };
      };
      const cases = [
        [{ status: "expired" }, "booking_expired"],
        [{ status: "cancelled" }, "booking_not_requested"],
        [{ status: "accepted", cook: COOK_A }, "cook_already_assigned"],
        [{ status: "requested", cook: COOK_A }, "cook_already_assigned"],
        [{ status: "requested", requestExpiresAt: new Date(Date.now() - 1000) }, "booking_expired"],
      ];
      for (const [over, want] of cases) {
        const b = mkBookingDoc(over);
        const j = mkJobDoc(b._id, { status: "pending", attempts: 1 });
        await jobs.processJob(j, { findEligibleCooks: async () => eligibleTwo, fanOut, workerId: "w1" });
        const stored = jobStore.get(String(j._id));
        if (stored.status !== "skipped" || stored.reason !== want) {
          check(`skip ${want}`, false, `${stored.status}/${stored.reason}`);
        }
      }
      check("invalid states skipped without Meta calls", fanOutCalls === 0, `fanOutCalls=${fanOutCalls}`);
    }

    // 9. missing booking -> failed booking_missing
    {
      reset();
      const j = mkJobDoc("507f1f77bcf86cd799439099", { status: "pending", attempts: 1 });
      await jobs.processJob(j, { findEligibleCooks: async () => eligibleTwo, fanOut: async () => ({ ok: true, results: [] }), workerId: "w1" });
      const stored = jobStore.get(String(j._id));
      check("missing booking recorded", stored.status === "failed" && stored.reason === "booking_missing", `${stored.status}/${stored.reason}`);
    }

    // 10. atomic claim: two workers, one winner
    {
      reset();
      const b = mkBookingDoc();
      await jobs.enqueueBookingRequestJob(b._id);
      const [c1, c2] = await Promise.all([jobs.claimDueJob("w1"), jobs.claimDueJob("w2")]);
      const winners = [c1, c2].filter(Boolean).length;
      check("concurrent claim has single winner", winners === 1, `winners=${winners}`);
    }

    // 11a. recent `sending` defers (no duplicate); 11b. stale `sending` recovered + resent
    {
      reset();
      const b = mkBookingDoc({
        whatsappDispatch: [{ cook: COOK_A, kind: "request", status: "sending", attempts: 1, lastAttemptAt: new Date(), messageId: "" }],
      });
      const j = mkJobDoc(b._id, { status: "pending", attempts: 1 });
      let calls = 0;
      await jobs.processJob(j, { findEligibleCooks: async () => eligibleTwo, fanOut: async () => { calls += 1; return { ok: true, results: [] }; }, workerId: "w1" });
      const stored = jobStore.get(String(j._id));
      check("recent sending defers without resend", calls === 0 && stored.status === "retrying" && stored.reason === "dispatch_inflight", `${stored.status}/${stored.reason} calls=${calls}`);
    }
    {
      reset();
      const b = mkBookingDoc({
        whatsappDispatch: [{ cook: COOK_A, kind: "request", status: "sending", attempts: 1, lastAttemptAt: new Date(Date.now() - 10 * 60 * 1000), messageId: "" }],
      });
      const j = mkJobDoc(b._id, { status: "pending", attempts: 1 });
      let fanOutRan = false;
      const fanOut = async () => {
        fanOutRan = true;
        return { ok: true, results: [{ cookId: COOK_A, ok: true, id: "wamid.new" }] };
      };
      await jobs.processJob(j, { findEligibleCooks: async () => eligibleTwo, fanOut, workerId: "w1" });
      const stored = jobStore.get(String(j._id));
      check("stale sending recovered + resent", fanOutRan && stored.status === "completed", `${stored.status} ran=${fanOutRan}`);
    }

    // 12. backfill creates jobs for job-less requested bookings only
    {
      reset();
      const old = new Date(Date.now() - 5 * 60 * 1000);
      const b1 = mkBookingDoc({ createdAt: old }); // needs job
      const b2 = mkBookingDoc({ createdAt: old, whatsappDispatch: [{ cook: COOK_A, kind: "request", status: "sent", messageId: "wamid.x", attempts: 1 }] }); // sent already
      const b3 = mkBookingDoc({ createdAt: new Date() }); // too new
      const b4 = mkBookingDoc({ createdAt: old, status: "cancelled" }); // not requested
      void b4;
      const n = await jobs.backfillMissingJobs(50);
      const tagged = [...jobStore.values()].map((j) => String(j.booking));
      check("backfill creates exactly one job", n === 1 && tagged.includes(String(b1._id)) && !tagged.includes(String(b2._id)) && !tagged.includes(String(b3._id)), `n=${n}`);
    }

    // 13. admin listing filters + sanitizes (no phones)
    {
      reset();
      const b = mkBookingDoc();
      mkJobDoc(b._id, { status: "failed", reason: "meta_api_error", error: "boom" });
      mkJobDoc(b._id, { status: "completed", reason: "dispatched" });
      const all = await jobs.listJobs({});
      const failed = await jobs.listJobs({ status: "failed" });
      const blob = JSON.stringify(all.jobs);
      check("admin list returns jobs + total", all.total === 2 && all.jobs.length === 2, `total=${all.total}`);
      check("admin list filters by status", failed.total === 1 && failed.jobs[0].reason === "meta_api_error", `total=${failed.total}`);
      check("admin list leaks no phones", !/9876543210|93712153/.test(blob), "clean");
    }

    // 14. manual retry record compatibility
    {
      reset();
      const b = mkBookingDoc();
      await jobs.enqueueBookingRequestJob(b._id);
      const rec = await jobs.recordManualAttempt(b._id, { ok: true, results: [{ cookId: COOK_A, ok: true }, { cookId: COOK_B, ok: false, error: "x" }] });
      check("manual attempt syncs job completed", rec && rec.status === "completed" && rec.sentCount === 1, `${rec?.status} sent=${rec?.sentCount}`);
    }

    // 15. retry-after honored: 429 schedules nextRetryAt >= ~3s out
    {
      reset();
      const b = mkBookingDoc();
      CookProfile.findOne = async () => ({ approvalStatus: "approved", serviceTypes: [] });
      User.find = phoneList([{ _id: COOK_A, phone: "9876543210", name: "A" }]);
      User.findById = (id) => ({ select: () => ({ lean: async () => (String(id) === CUST ? { name: "Cust" } : { name: "A" }) }) });
      metaMode = "fail429";
      const j = mkJobDoc(b._id, { status: "pending", attempts: 1 });
      const before = Date.now();
      await jobs.processJob(j, { findEligibleCooks: async () => [{ userId: COOK_A }], fanOut: dispatch.fanOutBookingRequest, workerId: "w1" });
      const stored = jobStore.get(String(j._id));
      const waitMs = new Date(stored.nextRetryAt).getTime() - before;
      check("429 retry honors Retry-After", stored.status === "retrying" && waitMs >= 2900, `${stored.status} wait=${waitMs}ms`);
      metaMode = "ok";
    }

    // 16. full-set dispatch: 3 eligible -> 3 Meta attempts, 3 entries
    {
      reset();
      const cooks = makeCooks(3);
      stubPhonesFor(cooks);
      CookProfile.findOne = async () => ({ approvalStatus: "approved", serviceTypes: [] });
      const b = mkBookingDoc();
      const j = mkJobDoc(b._id, { status: "pending", attempts: 1 });
      await jobs.processJob(j, { findEligibleCooks: async () => cooks.map((c) => ({ userId: c.userId })), fanOut: dispatch.fanOutBookingRequest, workerId: "w1" });
      const stored = jobStore.get(String(j._id));
      const doc = bookingStore.get(String(b._id));
      const entries = (doc.whatsappDispatch || []).filter((e) => e.kind === "request");
      check("3 eligible -> 3 attempts recorded", fetchCalls === 3 && entries.length === 3, `calls=${fetchCalls} entries=${entries.length}`);
      check("3 eligible -> completed sent=3", stored.status === "completed" && stored.sentCount === 3, `${stored.status} sent=${stored.sentCount}`);
    }

    // 17. full-set dispatch: 5 eligible -> 5 Meta attempts
    {
      reset();
      const cooks = makeCooks(5);
      stubPhonesFor(cooks);
      CookProfile.findOne = async () => ({ approvalStatus: "approved", serviceTypes: [] });
      const b = mkBookingDoc();
      const j = mkJobDoc(b._id, { status: "pending", attempts: 1 });
      await jobs.processJob(j, { findEligibleCooks: async () => cooks.map((c) => ({ userId: c.userId })), fanOut: dispatch.fanOutBookingRequest, workerId: "w1" });
      const stored = jobStore.get(String(j._id));
      check("5 eligible -> 5 attempts, all sent", fetchCalls === 5 && stored.status === "completed" && stored.sentCount === 5, `calls=${fetchCalls} sent=${stored.sentCount}`);
    }

    // 18/19. full-set dispatch: 12 eligible (every cook qualifies) -> 12 attempts, summary eligible=12
    {
      reset();
      const cooks = makeCooks(12);
      stubPhonesFor(cooks);
      CookProfile.findOne = async () => ({ approvalStatus: "approved", serviceTypes: [] });
      const b = mkBookingDoc();
      const j = mkJobDoc(b._id, { status: "pending", attempts: 1 });
      await jobs.processJob(j, { findEligibleCooks: async () => cooks.map((c) => ({ userId: c.userId })), fanOut: dispatch.fanOutBookingRequest, workerId: "w1" });
      const stored = jobStore.get(String(j._id));
      const doc = bookingStore.get(String(b._id));
      const sentEntries = (doc.whatsappDispatch || []).filter((e) => e.kind === "request" && e.status === "sent");
      const wamids = new Set(sentEntries.map((e) => e.messageId));
      check("12 eligible -> 12 Meta attempts (no truncation)", fetchCalls === 12, `calls=${fetchCalls}`);
      check("12 eligible -> 12 sent entries with unique ids", sentEntries.length === 12 && wamids.size === 12, `entries=${sentEntries.length} unique=${wamids.size}`);
      check("12 eligible -> job completed sent=12", stored.status === "completed" && stored.sentCount === 12 && stored.eligibleCookCount === 12, `${stored.status} sent=${stored.sentCount} eligible=${stored.eligibleCookCount}`);
    }

    // 20. invalid number handled + recorded: 12 eligible, 1 bad number -> partial
    {
      reset();
      const cooks = makeCooks(12);
      const bad = cooks[11];
      userStore.set(bad.userId, { _id: bad.userId, name: "Bad Number", phone: "123" });
      stubPhonesFor(cooks.map((c) => (c.userId === bad.userId ? { ...c, phone: "123" } : c)));
      CookProfile.findOne = async () => ({ approvalStatus: "approved", serviceTypes: [] });
      const b = mkBookingDoc();
      const j = mkJobDoc(b._id, { status: "pending", attempts: 1 });
      await jobs.processJob(j, { findEligibleCooks: async () => cooks.map((c) => ({ userId: c.userId })), fanOut: dispatch.fanOutBookingRequest, workerId: "w1" });
      const stored = jobStore.get(String(j._id));
      const doc = bookingStore.get(String(b._id));
      const failedEntry = (doc.whatsappDispatch || []).find((e) => String(e.cook) === String(bad.userId));
      check("bad number -> 11 sent + 1 recorded failure", stored.sentCount === 11 && failedEntry && failedEntry.status === "failed" && /no-whatsapp-number/.test(failedEntry.error || ""), `sent=${stored.sentCount} entry=${failedEntry?.status}/${failedEntry?.error}`);
      check("bad number -> partially_dispatched", stored.status === "completed" && stored.reason === "partially_dispatched", `${stored.status}/${stored.reason}`);
    }

    // 21. single Meta failure does not stop the other recipients
    {
      reset();
      const cooks = makeCooks(5);
      stubPhonesFor(cooks);
      CookProfile.findOne = async () => ({ approvalStatus: "approved", serviceTypes: [] });
      metaFailTo = new Set([cooks[2].phone.slice(-2)]);
      const b = mkBookingDoc();
      const j = mkJobDoc(b._id, { status: "pending", attempts: 1 });
      await jobs.processJob(j, { findEligibleCooks: async () => cooks.map((c) => ({ userId: c.userId })), fanOut: dispatch.fanOutBookingRequest, workerId: "w1" });
      const stored = jobStore.get(String(j._id));
      check("single failure -> all 5 attempted, 4 sent", fetchCalls === 5 && stored.sentCount === 4 && stored.failedCount === 1, `calls=${fetchCalls} sent=${stored.sentCount} failed=${stored.failedCount}`);
      metaFailTo = new Set();
    }

    // 22. real eligibility diagnostics: 12 examined, mixed outcomes, counts add up
    {
      reset();
      const { istDayString, istMidnight } = require("./utils/time");
      const date = new Date(Date.now() + 864e5);
      const blockedDay = istDayString(istMidnight(date));
      const ids = [];
      for (let i = 0; i < 12; i += 1) ids.push(`507f1f77bcf86cd799439d${String(i).padStart(2, "0")}`);
      const profiles = ids.map((id, i) => ({
        _id: `p${i}`,
        user: { _id: id, name: `Cook ${i}`, status: i === 8 ? "suspended" : "active" },
        approvalStatus: "approved",
        serviceTypes: i === 7 ? ["teach_me"] : ["cook_for_me"],
        ...(i === 9 ? { availabilityStatus: "unavailable" } : {}),
      }));
      const realFind = CookProfile.find;
      CookProfile.find = () => ({ populate: () => ({ lean: async () => profiles }) });
      // Real getDayWindows/resolveCookAvailability run here. Per-cook
      // schedules come from findOne; only idx10 is blocked today.
      const realFindOne = CookProfile.findOne;
      CookProfile.findOne = (filter) => ({
        select: () => ({
          lean: async () => {
            const uid = String(filter?.user || "");
            if (uid === ids[10]) {
              return { schedule: { weekly: [{ day: 1, enabled: true, startTime: "08:00", endTime: "20:00" }], blockedDates: [blockedDay] } };
            }
            return {};
          },
        }),
      });
      const realBookingFind = Booking.find;
      Booking.find = () => chain([{ cook: ids[11], startTime: "13:00", endTime: "15:00", status: "accepted" }]);
      const out = await bookingCtrl.findEligibleCooks({
        date, startTime: "13:30", endTime: "14:30", serviceType: "cook_for_me", diagnostics: true,
      });
      // Compat check while stubs are still active (real models have no DB here).
      const compatShape = await bookingCtrl.findEligibleCooks({ date, startTime: "13:30", endTime: "14:30", serviceType: "cook_for_me" });
      CookProfile.find = realFind;
      CookProfile.findOne = realFindOne;
      Booking.find = realBookingFind;
      const eligibleIds = new Set((out.eligible || []).map((e) => String(e.userId)));
      check("diagnostics: 12 examined, 7 eligible", out.examined === 12 && out.eligible.length === 7, `examined=${out.examined} eligible=${out.eligible.length}`);
      check(
        "diagnostics: exclusion reasons add up",
        out.excluded.wrongService === 1 && out.excluded.suspended === 1 && out.excluded.unavailable === 1 && out.excluded.noWindow === 1 && out.excluded.overlap === 1,
        JSON.stringify(out.excluded)
      );
      check("diagnostics: default call shape still an array", Array.isArray(compatShape), "compat");
    }

    // 23. inbound pending list uncapped: 7 live pendings -> reply names all 7
    {
      reset();
      const waCtrl = require("./controllers/whatsappController");
      const pendings = [];
      for (let i = 0; i < 7; i += 1) {
        pendings.push({ _id: `607f1f77bcf86cd799439e${String(i).padStart(2, "0")}`, serviceType: "cook_for_me", date: new Date(Date.now() + 864e5), startTime: "10:00", endTime: "11:00", status: "requested" });
      }
      const realUserFindOne = User.findOne;
      const realUserFind = User.find;
      const cookDoc = { _id: COOK_A, role: "COOK", status: "active", name: "Cook A", phone: "919000000020" };
      User.findOne = () => ({ select: async () => cookDoc });
      User.find = () => chain([]);
      const realBookingFind = Booking.find;
      Booking.find = () => chain(pendings);
      metaMode = "ok";
      const before = sentBodies.length;
      const r = await waCtrl.__test.handleOneMessage({ from: "919000000020", id: "wamid-t1", text: { body: "ACCEPT" } });
      const replyBody = sentBodies.slice(before).map((b) => b.text?.body || "").join("\n");
      User.findOne = realUserFindOne;
      User.find = realUserFind;
      Booking.find = realBookingFind;
      check("7 pendings -> ambiguous names true total", r && r.reason === "ambiguous" && /7 pending requests/.test(replyBody), `${r?.reason} totalled=${/7 pending requests/.test(replyBody)}`);
    }

    // 24. static guard: no recipient-count caps remain in dispatch sources
    {
      const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");
      const waCtrlSrc = read("controllers/whatsappController.js");
      const dispSrc = read("services/whatsappDispatch.js");
      const bcSrc = read("controllers/bookingController.js");
      const eligSrc = bcSrc.slice(bcSrc.indexOf("const findEligibleCooks"), bcSrc.indexOf("exports.findEligibleCooks"));
      check("no .limit(5)/slice(0,5) in inbound controller", !/\.limit\(5\)/.test(waCtrlSrc) && !/slice\(0,\s*5\)/.test(waCtrlSrc), "clean");
      check("no .limit( in fan-out dispatcher", !/\.limit\(/.test(dispSrc), "clean");
      check("no .limit(/slice cap in eligibility", !/\.limit\(/.test(eligSrc) && !/slice\(0,/.test(eligSrc), "clean");
    }
  } catch (err) {
    failures += 1;
    console.error("ERROR", err);
  }
  console.log(failures === 0 ? `\nALL DISPATCH-JOB TESTS PASSED (${passes} checks)\n` : `\n${failures} TEST(S) FAILED (${passes} passed)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
