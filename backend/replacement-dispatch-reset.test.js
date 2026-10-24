// Replacement-round dispatch reset — root-cause regression suite.
//
// Bug: after a cook cancelled, the durable job row was reset to pending
// but per-recipient Booking.whatsappDispatch[] entries stayed `sent`, so
// the fan-out skipped every previously-notified cook as "already-sent"
// and the job finished `completed` with ZERO sends — silently.
//
// Proves: (1) reset reopens the job row; (2) reset reopens per-recipient
// request entries (non-request kinds untouched); (3) the worker re-fans
// out to previously-notified cooks; (4) duplicate cancels reset only
// once; (5) the replacement event reaches only its intended audience.
// Hermetic: models stubbed, no DB, no network.
// Run: node backend/replacement-dispatch-reset.test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.WHATSAPP_ENABLED = "true";
process.env.WHATSAPP_TOKEN = "test_token";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";

const mongoose = require("mongoose");
const DispatchJob = require("./models/DispatchJob");
const Booking = require("./models/Booking");
const User = require("./models/User");
const Notification = require("./models/Notification");
const CancellationAudit = require("./models/CancellationAudit");
const CookProfile = require("./models/CookProfile");
const realtime = require("./utils/realtime");
const dispatchJobs = require("./services/bookingDispatchJobs");
const bookingController = require("./controllers/bookingController");

let passes = 0; let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); ok ? passes++ : failures++; };

const realReadyState = mongoose.connection.readyState;
try { mongoose.connection.readyState = 1; } catch { mongoose.connection.readyState = 1; }

const H = 60 * 60 * 1000;

// ---------- fake stores for reset unit ----------
let jobRow = null;
let bookingDoc = null;
DispatchJob.updateOne = async (filter, update) => {
  if (!jobRow) return { modifiedCount: 0 };
  if (update.$set) {
    if (update.$set.status) jobRow.status = update.$set.status;
    if (update.$set.attempts !== undefined) jobRow.attempts = update.$set.attempts;
    if (update.$set.nextRetryAt !== undefined) jobRow.nextRetryAt = update.$set.nextRetryAt;
    if (update.$set.leaseExpiresAt !== undefined) jobRow.leaseExpiresAt = update.$set.leaseExpiresAt;
  }
  return { modifiedCount: 1 };
};
const realBookingUpdateOne = Booking.updateOne;
Booking.updateOne = async (filter, update, opts) => {
  if (opts && opts.arrayFilters) {
    // Emulate $[e] with kind=request filter.
    let n = 0;
    for (const e of bookingDoc.whatsappDispatch || []) {
      if (e && e.kind === "request") {
        if (update.$set) {
          for (const [k, v] of Object.entries(update.$set)) {
            const leaf = k.split(".").pop();
            e[leaf] = v;
          }
        }
        n += 1;
      }
    }
    bookingDoc._arrayFilterCalls = (bookingDoc._arrayFilterCalls || 0) + 1;
    return { modifiedCount: n > 0 ? 1 : 0 };
  }
  return { modifiedCount: 0 };
};

(async () => {
  // T1: terminal job row is revived.
  jobRow = { _id: "job1", booking: "b1", kind: "request", status: "completed", attempts: 5, nextRetryAt: null };
  bookingDoc = { _id: "b1", whatsappDispatch: [] };
  await dispatchJobs.resetDispatchJobForReplacement("b1");
  check("R1 terminal job reset to pending", jobRow.status === "pending" && jobRow.attempts === 0, `${jobRow.status}/${jobRow.attempts}`);
  check("R1 next retry is due now", jobRow.nextRetryAt && new Date(jobRow.nextRetryAt).getTime() <= Date.now() + 1000, "due");

  // T2: per-recipient request entries reopened; other kinds untouched.
  bookingDoc = {
    _id: "b1",
    whatsappDispatch: [
      { cook: "cookB", kind: "request", status: "sent", attempts: 1, error: "", messageId: "wamid.old" },
      { cook: "cookC", kind: "request", status: "failed", attempts: 3, error: "meta-boom", messageId: "" },
      { cook: "cookB", kind: "scheduled", status: "sent", attempts: 1, error: "", messageId: "wamid.s" },
    ],
  };
  jobRow = { _id: "job1", booking: "b1", kind: "request", status: "failed", attempts: 2 };
  await dispatchJobs.resetDispatchJobForReplacement("b1");
  const reqEntries = bookingDoc.whatsappDispatch.filter((e) => e.kind === "request");
  check("R2 sent+failed request entries reopened", reqEntries.every((e) => e.status === "pending" && e.attempts === 0 && e.error === "" && e.messageId === ""), JSON.stringify(reqEntries.map((e) => e.status)));
  const sched = bookingDoc.whatsappDispatch.find((e) => e.kind === "scheduled");
  check("R2 non-request entries untouched", sched.status === "sent" && sched.messageId === "wamid.s", sched.status);

  // T3: worker re-fans out to previously-notified cooks (no suppression).
  {
    const seen = [];
    const fakeJob = { _id: "job1", booking: "b1", kind: "request", status: "pending", attempts: 0, maxAttempts: 5 };
    const oFind = Booking.findById;
    const oUserFind = User.findById;
    Booking.findById = async () => ({
      _id: "b1", customer: "cust1", cook: null, ignoredBy: ["cook1"], status: "requested",
      date: new Date(Date.now() + 72 * H), startTime: "12:00", endTime: "14:00",
      requestExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      payment: { status: "paid" }, whatsappDispatch: [], womanPresenceConfirmed: true,
      createdAt: new Date(Date.now() - 72 * H),
    });
    User.findById = () => ({ select: () => ({ lean: async () => null }) });
    // bookingRestrictions pulls a model that needs a live connection;
    // pre-seed the require cache so processJob's lazy require stays offline.
    try {
      const brPath = require.resolve("./utils/bookingRestrictions");
      require.cache[brPath] = {
        id: brPath, filename: brPath, loaded: true,
        exports: { getRestrictionState: async () => ({ blocked: false, declinedAt: null }), WOMAN_PRESENCE_LAUNCH_MS: 0 },
      };
    } catch { }
    DispatchJob.findOneAndUpdate = async () => fakeJob;
    const r = await dispatchJobs.processDueJobsOnce({
      workerId: "test-worker",
      findEligibleCooks: async () => [{ userId: "cookB" }, { userId: "cookC" }],
      fanOut: async (bk, eligible) => { seen.push(...eligible.map((c) => String(c.userId))); return { ok: true, results: eligible.map((c) => ({ cookId: c.userId, ok: true })) }; },
    });
    Booking.findById = oFind;
    User.findById = oUserFind;
    check("R3 worker claims reset job", r?.claimed === true, JSON.stringify({ claimed: r?.claimed }));
    check("R3 previously-notified cooks re-targeted", seen.includes("cookB") && seen.includes("cookC"), seen.join(","));
  }

  // T4: duplicate cancels reset only once (full cancel path).
  {
    Booking.updateOne = realBookingUpdateOne;
    const doc = {
      _id: "b-dup", customer: "cust1", cook: "cook1", ignoredBy: [], serviceType: "cook_for_me",
      date: new Date(Date.now() + 72 * H), startTime: "12:00", endTime: "14:00", address: "12 MG Road",
      amount: 500, status: "confirmed", serviceStartedAt: null,
      requestExpiresAt: new Date(Date.now() + 4 * 60 * 1000), paymentExpiresAt: null,
      payment: { status: "paid", paidAmount: 500, refundStatus: "none", testMode: false },
      statusHistory: [], cookCancel: undefined, couponCode: "", couponReleased: false, payout: { status: "pending" },
      whatsappDispatch: [{ cook: "cookB", kind: "request", status: "sent", attempts: 1, error: "", messageId: "wamid.1" }],
      save: async function () { return this; },
    };
    let live = doc;
    const oFind = Booking.findById;
    Booking.findById = async () => live;
    let updateCalls = 0;
    Booking.updateOne = async (filter, update, opts) => {
      if (opts && opts.arrayFilters) return { modifiedCount: 0 };
      updateCalls += 1;
      const okCook = filter.cook === undefined || String(live.cook) === String(filter.cook);
      const okStatus = !filter.status || (filter.status.$in || []).includes(live.status);
      if (!(okCook && okStatus && !live.serviceStartedAt)) return { modifiedCount: 0 };
      if (update.$set) for (const [k, v] of Object.entries(update.$set)) live[k] = v;
      if (update.$addToSet) for (const [k, v] of Object.entries(update.$addToSet)) {
        if (!Array.isArray(live[k])) live[k] = [];
        if (!live[k].map(String).includes(String(v))) live[k].push(v);
      }
      if (update.$push && update.$push.statusHistory) live.statusHistory.push(update.$push.statusHistory);
      return { modifiedCount: 1 };
    };
    Notification.create = async () => ({});
    CancellationAudit.create = async () => ({});
    CookProfile.updateOne = async () => ({});
    let resets = 0, kicks = 0;
    const oReset = dispatchJobs.resetDispatchJobForReplacement;
    const oKick = dispatchJobs.kickWorker;
    dispatchJobs.resetDispatchJobForReplacement = async () => { resets += 1; return true; };
    dispatchJobs.kickWorker = () => { kicks += 1; };
    const mkRes = () => {
      const r = { statusCode: 200, body: null };
      r.status = (c) => { r.statusCode = c; return r; };
      r.json = (p) => { r.body = { ...(p.toObject ? p.toObject() : p) }; return r; };
      return r;
    };
    const nx = (e) => { if (e) throw e; };
    const r1 = mkRes();
    await bookingController.cancelBooking({ params: { id: "b-dup" }, user: { id: "cook1", role: "COOK" }, body: { reason: "ILLNESS" } }, r1, nx);
    const r2 = mkRes();
    await bookingController.cancelBooking({ params: { id: "b-dup" }, user: { id: "cook1", role: "COOK" }, body: { reason: "ILLNESS" } }, r2, nx);
    check("R4 first cancel releases to replacement", r1.statusCode === 200 && r1.body?.replacement === true, `s=${r1.statusCode}`);
    check("R4 repeat is duplicate", r2.statusCode === 200 && r2.body?.duplicate === true, `s=${r2.statusCode}`);
    check("R4 dispatch reset exactly once", resets === 1, `${resets}x`);
    Booking.findById = oFind;
    dispatchJobs.resetDispatchJobForReplacement = oReset;
    dispatchJobs.kickWorker = oKick;
  }

  // T5: realtime audience scoping.
  {
    const got = { admin: [], cook: [], cust: [] };
    const tag = (key) => ({ res: { write: (p) => got[key].push(p) } });
    const fake = [
      { userId: "a1", role: "ADMIN", ...tag("admin") },
      { userId: "c1", role: "COOK", ...tag("cook") },
      { userId: "u1", role: "CUSTOMER", ...tag("cust") },
    ];
    for (const c of fake) realtime.clients.add(c);
    try {
      realtime.emit("booking_replacement_needed", { bookingId: "b1" }, { targetRoles: ["ADMIN"] });
      check("R5 admin-scoped event reaches admins only", got.admin.length === 1 && got.cook.length === 0 && got.cust.length === 0, `a=${got.admin.length} c=${got.cook.length} u=${got.cust.length}`);
      realtime.emit("booking_request", { bookingId: "b1", replacement: true });
      check("R5 broadcast still reaches cooks", got.cook.length === 1, `cooks=${got.cook.length}`);
    } finally { for (const c of fake) realtime.clients.delete(c); }
  }

  // T6: full replacement pipeline with REAL fan-out. Recipient entries
  // start `sent` (previous round); after reset + worker pass, new WhatsApp
  // sends are ATTEMPTED to previously-notified cooks via the configured
  // Marathi template, while the cancelling cook gets nothing.
  {
    const doc = {
      _id: "b-pipe", customer: "cust1", cook: null, ignoredBy: ["cookX"],
      serviceType: "cook_for_me", date: new Date(Date.now() + 72 * H),
      startTime: "10:00", endTime: "12:00", durationHours: 2,
      address: "Flat 7, Sunshine Society, Pune", guests: 4, notes: "",
      amount: 699, status: "requested",
      requestExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      payment: { status: "paid", paidAmount: 699 },
      whatsappDispatch: [
        { cook: "cookB", kind: "request", status: "sent", attempts: 1, error: "", messageId: "wamid.old-b" },
        { cook: "cookC", kind: "request", status: "sent", attempts: 1, error: "", messageId: "wamid.old-c" },
      ],
      womanPresenceConfirmed: true, createdAt: new Date("2026-09-01T00:00:00Z"),
    };
    const oFind = Booking.findById, oUpdate = Booking.updateOne;
    const oDU = DispatchJob.updateOne, oClaim = DispatchJob.findOneAndUpdate;
    const oUserFind = User.find, oUserById = User.findById;
    const oCPO = require("./models/CookProfile").findOne;
    Booking.findById = async () => doc;
    Booking.updateOne = async (filter, update, opts) => {
      if (opts && opts.arrayFilters) {
        for (const e of doc.whatsappDispatch || []) {
          if (e && e.kind === "request" && update.$set) {
            for (const [k, v] of Object.entries(update.$set)) e[k.split(".").pop()] = v;
          }
        }
        return { modifiedCount: 1 };
      }
      if (update && update.$push && update.$push.whatsappDispatch) {
        doc.whatsappDispatch.push(update.$push.whatsappDispatch);
        return { modifiedCount: 1 };
      }
      if (update && update.$set) {
        const m = filter && filter.whatsappDispatch && filter.whatsappDispatch.$elemMatch;
        const target = m ? (doc.whatsappDispatch || []).find((e) => String(e.cook) === String(m.cook) && String(e.kind) === String(m.kind)) : null;
        if (target) {
          for (const [k, v] of Object.entries(update.$set)) target[k.split(".").pop()] = v;
          return { modifiedCount: 1 };
        }
      }
      return { modifiedCount: 1 };
    };
    let claimedOnce = false;
    DispatchJob.findOneAndUpdate = async () => {
      if (claimedOnce) return null;
      claimedOnce = true;
      return { _id: "job-pipe", booking: "b-pipe", kind: "request", status: "pending", attempts: 0, maxAttempts: 5 };
    };
    DispatchJob.updateOne = async () => ({ modifiedCount: 1 });
    User.find = () => ({ select: () => ({ lean: async () => [
      { _id: "cookB", phone: "9811111111", name: "Cook B" },
      { _id: "cookC", phone: "9822222222", name: "Cook C" },
      { _id: "cookX", phone: "9833333333", name: "Cook X" },
    ] }) });
    User.findById = () => ({ select: () => ({ lean: async () => ({ _id: "cust1", name: "Aditi Rao" }) }) });
    require("./models/CookProfile").findOne = async () => ({ user: "cookB", approvalStatus: "approved", serviceTypes: ["cook_for_me"] });
    const posts = [];
    const oFetch = global.fetch;
    global.fetch = async (url, opts) => {
      posts.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: "wamid.new" }] }) };
    };
    const oTpl = process.env.WHATSAPP_REQUEST_TEMPLATE;
    process.env.WHATSAPP_REQUEST_TEMPLATE = "new_booking_request";
    try {
      await dispatchJobs.resetDispatchJobForReplacement("b-pipe");
      const reopened = (doc.whatsappDispatch || []).filter((e) => e.kind === "request");
      check("R6 reset reopens stale sent entries", reopened.length === 2 && reopened.every((e) => e.status === "pending"), reopened.map((e) => e.status).join(","));
      const r = await dispatchJobs.processDueJobsOnce({
        workerId: "pipe-worker",
        findEligibleCooks: async () => [{ userId: "cookB" }, { userId: "cookC" }, { userId: "cookX" }],
      });
      const toNumbers = posts.map((p) => String(p.to || ""));
      check("R6 worker pass attempted sends", r?.claimed === true && posts.length >= 2, `claimed=${r?.claimed} posts=${posts.length}`);
      check("R6 previously-notified cooks re-sent", toNumbers.some((t) => t.endsWith("9811111111")) && toNumbers.some((t) => t.endsWith("9822222222")), toNumbers.join(","));
      check("R6 cancelling cook excluded", !toNumbers.some((t) => t.endsWith("9833333333")), toNumbers.join(",") || "none");
      const tpl = posts.find((p) => p.type === "template");
      check("R6 Marathi template send attempted", tpl?.template?.name === "new_booking_request" && tpl?.template?.language?.code === "mr", tpl ? `${tpl.template.name}/${tpl.template.language?.code}` : "no-template-post");
      const freshWamid = (doc.whatsappDispatch || []).filter((e) => e.kind === "request" && String(e.messageId || "").startsWith("wamid.new"));
      check("R6 provider acceptance recorded (wamid)", freshWamid.length >= 2, `${freshWamid.length} wamids`);
    } catch (e) { check("R6 replacement pipeline", false, e.message); }
    finally {
      Booking.findById = oFind; Booking.updateOne = oUpdate;
      DispatchJob.updateOne = oDU; DispatchJob.findOneAndUpdate = oClaim;
      User.find = oUserFind; User.findById = oUserById;
      require("./models/CookProfile").findOne = oCPO;
      global.fetch = oFetch;
      if (oTpl === undefined) delete process.env.WHATSAPP_REQUEST_TEMPLATE; else process.env.WHATSAPP_REQUEST_TEMPLATE = oTpl;
    }
  }

  try { mongoose.connection.readyState = realReadyState; } catch { }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
