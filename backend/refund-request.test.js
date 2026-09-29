// Standalone regression test for CUSTOMER POST-SERVICE REFUND REQUESTS.
// Run:  node backend/refund-request.test.js  — exits non-zero on any failure.
//
// Rule: scheduledEnd + 1h <= now, booking NOT completed (nor cancelled /
// rejected / expired), paid non-test payment with a positive refundable
// amount, and no existing refund request. The customer files { reason, note }
// only — the amount is always computed server-side. Approved work reuses the
// existing payoutController approve/reject/settle paths (tested in
// finance-audit.test.js); this file proves the request gate + its integration
// points (queue visibility, caps, ledger, notifications, history).
//
// Drives the REAL refundController with in-memory fakes (no DB).

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const Booking = require("./models/Booking");
const User = require("./models/User");
const Notification = require("./models/Notification");
const LedgerEntry = require("./models/LedgerEntry");
const controller = require("./controllers/refundController");

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes += 1;
  else failures += 1;
};

const CUSTOMER = { id: "cust1", role: "CUSTOMER" };
const STRANGER = { id: "cust9", role: "CUSTOMER" };
const COOK = { id: "cook1", role: "COOK" };
const ADMIN = { id: "admin1", role: "ADMIN" };

// ── In-memory fakes ─────────────────────────────────────────────────────────
let bookingDoc = null;
let claimImpl = null;
const claimCalls = [];
const notificationLog = [];
const ledgerRows = [];

// Service ran 3h ago for 2h (ended 1h ago + margin): eligible by default.
const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);

const baseDoc = (over = {}) => {
  const doc = {
    _id: "booking1",
    customer: "cust1",
    cook: "cook1",
    serviceType: "cook_for_me",
    date: hoursAgo(3),
    startTime: "10:00",
    endTime: "12:00",
    durationHours: 2,
    address: "12 MG Road",
    amount: 1110,
    status: "confirmed",
    serviceStartedAt: hoursAgo(3),
    serviceEndsAt: hoursAgo(1.5),
    cookArrived: true,
    hoursCompleted: false,
    payment: {
      status: "paid",
      paidAmount: 1110,
      razorpayPaymentId: "pay_1",
      refundStatus: "none",
      refundAmount: 0,
      testMode: false,
    },
    statusHistory: [],
    reschedules: [],
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this;
    },
    toObject() {
      const { save, toObject, ...rest } = this;
      return { ...rest };
    },
  };
  if (over.payment) {
    doc.payment = { ...doc.payment, ...over.payment };
    delete over.payment;
  }
  return Object.assign(doc, over);
};

const reset = (over = {}) => {
  bookingDoc = baseDoc(over);
  claimImpl = null;
  claimCalls.length = 0;
  notificationLog.length = 0;
  ledgerRows.length = 0;
  return bookingDoc;
};

Booking.findById = async (id) => (String(id) === "booking1" && bookingDoc ? bookingDoc : null);
Booking.findOneAndUpdate = async (filter, update, opts) => {
  claimCalls.push({ filter, update, opts });
  if (typeof claimImpl === "function") return claimImpl(filter, update, opts);
  return null;
};
User.find = () => ({
  select: () => ({ limit: () => ({ lean: async () => [{ _id: "admin1" }, { _id: "admin2" }] }) }),
});
Notification.create = async (payload) => {
  notificationLog.push(payload);
  return payload;
};
LedgerEntry.create = async (e) => {
  ledgerRows.push(e);
  return e;
};

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (s) => {
    res.statusCode = s;
    return res;
  };
  res.json = (p) => {
    res.body = p;
    return res;
  };
  return res;
};

const callRequest = (user, body) =>
  new Promise((resolve, reject) => {
    const req = { params: { id: "booking1" }, user, body };
    const res = makeRes();
    Promise.resolve(controller.requestRefund(req, res, reject)).then(() =>
      resolve({ status: res.statusCode, payload: res.body })
    );
  });

const callEligibility = (user) =>
  new Promise((resolve, reject) => {
    const req = { params: { id: "booking1" }, user };
    const res = makeRes();
    Promise.resolve(controller.getRefundEligibility(req, res, reject)).then(() =>
      resolve({ status: res.statusCode, payload: res.body })
    );
  });

(async () => {
  // ── 1. Eligible read ──────────────────────────────────────────────────────
  {
    reset();
    const r = await callEligibility(CUSTOMER);
    check("1. eligible read -> 200 eligible", r.status === 200 && r.payload?.eligible === true, `s=${r.status} e=${r.payload?.eligible}`);
    check("1. payload carries amounts, no secrets", r.payload?.refundableAmount === 1110 && r.payload?.paidAmount === 1110 && !("serviceOtp" in (r.payload || {})), JSON.stringify({ a: r.payload?.refundableAmount, p: r.payload?.paidAmount }));
    const admin = await callEligibility(ADMIN);
    check("1. admin can read", admin.status === 200 && admin.payload?.eligible === true, `s=${admin.status}`);
    const stranger = await callEligibility(STRANGER);
    check("1. stranger -> 403", stranger.status === 403, `s=${stranger.status}`);
  }

  // ── 2. Exact 1-hour boundary ──────────────────────────────────────────────
  {
    reset({ serviceEndsAt: new Date(Date.now() - 59 * 60 * 1000 - 59 * 1000) });
    const early = controller.refundEligibility(bookingDoc, Date.now());
    check("2. end+59:59 -> not eligible", early.eligible === false && early.reasonCode === "too_early", early.reasonCode);
    reset({ serviceEndsAt: new Date(Date.now() - 60 * 60 * 1000) });
    const onTime = controller.refundEligibility(bookingDoc, Date.now());
    check("2. end+60:00 -> eligible", onTime.eligible === true, String(onTime.eligible));
  }

  // ── 3. Static schedule fallback (no OTP clock) ────────────────────────────
  {
    // Yesterday 17:00–20:00 IST: end+1h long past.
    const y = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    const dayStr = `${y.getFullYear()}-${p(y.getMonth() + 1)}-${p(y.getDate())}`;
    reset({ serviceStartedAt: null, serviceEndsAt: null, date: `${dayStr}T00:00:00`, startTime: "17:00", endTime: "20:00" });
    const e = controller.refundEligibility(bookingDoc, Date.now());
    check("3. static IST schedule drives eligibility", e.eligible === true, `${e.reasonCode}`);
  }

  // ── 4. Status guards ──────────────────────────────────────────────────────
  for (const status of ["completed", "cancelled", "rejected", "expired"]) {
    reset({ status });
    const e = controller.refundEligibility(bookingDoc, Date.now());
    check(`4. ${status} never eligible`, e.eligible === false && e.reasonCode === "bad_status", e.reasonCode);
  }
  for (const status of ["accepted", "confirmed", "in_progress", "unattended", "requested"]) {
    reset({ status });
    const e = controller.refundEligibility(bookingDoc, Date.now());
    check(`4. ${status} past end+1h eligible`, e.eligible === true, `${e.reasonCode}`);
  }

  // ── 5. Payment guards ─────────────────────────────────────────────────────
  {
    reset({ payment: { status: "pending" } });
    check("5. unpaid ineligible", controller.refundEligibility(bookingDoc, Date.now()).reasonCode === "no_payment", "");
    reset({ payment: { testMode: true } });
    check("5. test-mode ineligible", controller.refundEligibility(bookingDoc, Date.now()).reasonCode === "no_payment", "");
    reset({ payment: { paidAmount: 0, amount: 0 }, amount: 0 });
    check("5. zero-amount ineligible", controller.refundEligibility(bookingDoc, Date.now()).reasonCode === "no_payment", "");
    reset({ payment: { refundStatus: "pending", refundAmount: 1110 } });
    check("5. existing request blocks", controller.refundEligibility(bookingDoc, Date.now()).reasonCode === "already_requested", "");
    reset({ payment: { refundStatus: "processed", refundAmount: 1110 } });
    check("5. refunded blocks", controller.refundEligibility(bookingDoc, Date.now()).reasonCode === "no_payment", controller.refundEligibility(bookingDoc, Date.now()).reasonCode);
  }

  // ── 6. Happy path: claim, ledger, notifications, history ──────────────────
  {
    reset();
    claimImpl = async (filter, update) => {
      Object.assign(bookingDoc.payment, update.$set && Object.fromEntries(
        Object.entries(update.$set).filter(([k]) => k.startsWith("payment.")).map(([k, v]) => [k.slice(8), v])
      ));
      bookingDoc.statusHistory.push(update.$push.statusHistory);
      return bookingDoc;
    };
    const r = await callRequest(CUSTOMER, { reason: "Cook did not arrive", note: "Nobody came." });
    check("6. request -> 201", r.status === 201, `s=${r.status} ${r.payload?.message || ""}`);
    check("6. claim guarded on customer+status+paid+none", claimCalls[0]?.filter?.customer === "cust1" && claimCalls[0]?.filter?.["payment.refundStatus"] === "none" && claimCalls[0]?.filter?.["payment.status"] === "paid", JSON.stringify(claimCalls[0]?.filter));
    check("6. amount server-computed", bookingDoc.payment.refundAmount === 1110 && bookingDoc.payment.refundStatus === "pending", `${bookingDoc.payment.refundAmount}/${bookingDoc.payment.refundStatus}`);
    check("6. reason+note stored, by=customer", bookingDoc.payment.refundReason === "Cook did not arrive" && bookingDoc.payment.refundCustomerNote === "Nobody came." && bookingDoc.payment.refundRequestedBy === "customer" && bookingDoc.payment.refundRequestedAt instanceof Date, JSON.stringify({ r: bookingDoc.payment.refundReason, b: bookingDoc.payment.refundRequestedBy }));
    check("6. history entry", /Refund requested by customer/.test(String(bookingDoc.statusHistory[0]?.note)), String(bookingDoc.statusHistory[0]?.note));
    check("6. ledger refund.requested", ledgerRows.some((l) => l.type === "refund.requested" && l.amount === 1110 && l.idempotencyKey === "refund-request:booking1"), ledgerRows.map((l) => l.type).join(","));
    const to = notificationLog.map((n) => String(n.user));
    check("6. customer + admins notified", to.includes("cust1") && to.includes("admin1") && to.includes("admin2"), to.join(","));
    check("6. no duplicate customer notice", notificationLog.filter((n) => String(n.user) === "cust1").length === 1, "");
  }

  // ── 7. Client cannot set the amount ───────────────────────────────────────
  {
    reset();
    claimImpl = async (filter, update) => bookingDoc;
    const r = await callRequest(CUSTOMER, { reason: "Service was not provided", amount: 50000, refundAmount: 50000, refundStatus: "processed", refundEligible: true });
    check("7. hostile body still -> 201", r.status === 201, `s=${r.status}`);
    const set = claimCalls[0]?.update?.$set || {};
    check("7. $set carries server amount only", set["payment.refundAmount"] === 1110 && !("payment.status" in set) && set["payment.refundStatus"] === "pending", JSON.stringify(Object.keys(set)));
  }

  // ── 8. Auth + input validation ────────────────────────────────────────────
  {
    reset();
    claimImpl = async () => bookingDoc;
    const stranger = await callRequest(STRANGER, { reason: "Cook did not arrive" });
    check("8. stranger -> 403", stranger.status === 403, `s=${stranger.status}`);
    const cook = await callRequest(COOK, { reason: "Cook did not arrive" });
    check("8. cook blocked by customer ownership", cook.status === 403, `s=${cook.status}`);
    const badReason = await callRequest(CUSTOMER, { reason: "Free money please" });
    check("8. invalid reason -> 400", badReason.status === 400, `s=${badReason.status}`);
    const missing = await callRequest(CUSTOMER, {});
    check("8. missing reason -> 400", missing.status === 400, `s=${missing.status}`);
    const longNote = await callRequest(CUSTOMER, { reason: "Other", note: "x".repeat(501) });
    check("8. oversized noteRejected", longNote.status !== 201, `s=${longNote.status}`);
    check("8. no claim attempted on validation failure", claimCalls.length === 0, `calls=${claimCalls.length}`);
  }

  // ── 9. Too early / completed via POST ─────────────────────────────────────
  {
    reset({ serviceEndsAt: new Date(Date.now() - 30 * 60 * 1000) });
    claimImpl = async () => bookingDoc;
    const early = await callRequest(CUSTOMER, { reason: "Cook did not arrive" });
    check("9. too early -> 400 + no claim", early.status === 400 && /1 hour/.test(String(early.payload?.message)) && claimCalls.length === 0, `s=${early.status} ${early.payload?.message || ""}`);
    reset({ status: "completed" });
    const done = await callRequest(CUSTOMER, { reason: "Cook did not arrive" });
    check("9. completed -> 400 completed copy", done.status === 400 && /already been completed/.test(String(done.payload?.message)), `s=${done.status} ${done.payload?.message || ""}`);
  }

  // ── 10. Duplicate protection (two tabs, one winner) ───────────────────────
  {
    reset();
    let calls = 0;
    claimImpl = async () => {
      calls += 1;
      if (calls === 1) {
        bookingDoc.payment.refundStatus = "pending";
        bookingDoc.payment.refundAmount = 1110;
        return bookingDoc;
      }
      return null;
    };
    const a = await callRequest(CUSTOMER, { reason: "Cook did not arrive" });
    const b = await callRequest(CUSTOMER, { reason: "Cook did not arrive" });
    check("10. first tab -> 201", a.status === 201, `s=${a.status}`);
    check("10. second tab -> 409 already exists", b.status === 409 && /already exists/.test(String(b.payload?.message)), `s=${b.status} ${b.payload?.message || ""}`);
    check("10. single ledger row", ledgerRows.filter((l) => l.type === "refund.requested").length === 1, `n=${ledgerRows.length}`);
  }

  // ── 11. Completion race: completion wins → clean refusal ──────────────────
  {
    reset();
    claimImpl = async () => null;
    bookingDoc.status = "completed";
    const r = await callRequest(CUSTOMER, { reason: "Cook did not arrive" });
    check("11. completed race -> 400, no invalid request", r.status === 400 && bookingDoc.payment.refundStatus === "none" && ledgerRows.length === 0, `s=${r.status} rs=${bookingDoc.payment.refundStatus}`);
  }

  // ── 12. No auto-refund: request only queues ───────────────────────────────
  {
    reset();
    claimImpl = async (filter, update) => {
      Object.assign(bookingDoc.payment, Object.fromEntries(
        Object.entries(update.$set).filter(([k]) => k.startsWith("payment.")).map(([k, v]) => [k.slice(8), v])
      ));
      return bookingDoc;
    };
    await callRequest(CUSTOMER, { reason: "Service was not completed" });
    check("12. stays pending (never processed)", bookingDoc.payment.refundStatus === "pending", bookingDoc.payment.refundStatus);
    check("12. payment untouched", bookingDoc.payment.status === "paid" && bookingDoc.payment.paidAmount === 1110 && !bookingDoc.payment.refundId, JSON.stringify({ s: bookingDoc.payment.status, id: bookingDoc.payment.refundId }));
    check("12. booking status untouched", bookingDoc.status === "confirmed", bookingDoc.status);
  }

  // ── 13. Missing booking → 404 ─────────────────────────────────────────────
  {
    bookingDoc = null;
    const r = await callRequest(CUSTOMER, { reason: "Other" });
    check("13. unknown booking -> 404", r.status === 404, `s=${r.status}`);
    const e = await callEligibility(CUSTOMER);
    check("13. eligibility unknown -> 404", e.status === 404, `s=${e.status}`);
  }

  // ── 14. Route surface ─────────────────────────────────────────────────────
  {
    const fs = require("fs");
    const path = require("path");
    const routeSrc = fs.readFileSync(path.join(__dirname, "routes", "bookings.js"), "utf8");
    const postIdx = routeSrc.indexOf('"/:id/refund-request"');
    const postBlock = postIdx === -1 ? "" : routeSrc.slice(postIdx, routeSrc.indexOf("requestRefund", postIdx));
    check("14. POST refund-request mounted + customer-gated", postIdx !== -1 && /authorize\("customer"\)/.test(postBlock), "");
    check("14. POST validates reason + note", /body\("reason"\)/.test(postBlock) && /body\("note"\)/.test(postBlock), "");
    check(
      "14. amount/status/eligibility never accepted",
      !/body\("amount"\)/.test(postBlock) && !/body\("refundStatus"\)/.test(postBlock) && !/refundEligible/.test(postBlock) && !/body\("customerId"\)/.test(postBlock),
      ""
    );
    check("14. GET eligibility mounted", routeSrc.includes('"/:id/refund-eligibility"'), "");
  }

  // ── 15. Admin decision integration (existing payout paths) ─────────────────
  {
    const payout = require("./controllers/payoutController");
    const callApprove = (user, body) =>
      new Promise((resolve, reject) => {
        const req = { params: { id: "booking1" }, user, body };
        const res = makeRes();
        Promise.resolve(payout.approveRefund(req, res, reject)).then(() =>
          resolve({ status: res.statusCode, payload: res.body })
        );
      });
    // Partial approval of a customer request (gateway unconfigured in tests
    // → manual path, same guards + ledger + notify shape as full approval).
    // Faithful claim applier: honors the refundStatus filter (claim + final
    // atomic commit), applies $set dotted paths and history like Mongo would.
    reset({ payment: { refundStatus: "pending", refundAmount: 1110, refundReason: "Cook did not arrive" } });
    claimImpl = async (filter, update) => {
      const want = filter["payment.refundStatus"];
      const cur = bookingDoc.payment.refundStatus;
      const ok = !want || (typeof want === "string" ? cur === want : want.$in ? want.$in.includes(cur) : true);
      if (!ok) return null;
      for (const [k, v] of Object.entries(update.$set || {})) {
        const ks = String(k).split(".");
        let t = bookingDoc;
        for (let i = 0; i < ks.length - 1; i++) t = t[ks[i]];
        t[ks[ks.length - 1]] = v;
      }
      if (update.$push?.statusHistory) bookingDoc.statusHistory.push(update.$push.statusHistory);
      return bookingDoc;
    };
    const r = await callApprove(ADMIN, { amount: 700 });
    check("15. partial approve -> 200 manual", r.status === 200 && bookingDoc.payment.refundStatus === "manual", `s=${r.status} rs=${bookingDoc.payment.refundStatus}`);
    check("15. partial amount recorded", bookingDoc.payment.refundAmount === 700, String(bookingDoc.payment.refundAmount));
    check("15. history names the partial", /Partial refund of ₹700/.test(String(bookingDoc.statusHistory[0]?.note)), String(bookingDoc.statusHistory[0]?.note));
    check("15. ledger refund.approved = 700", ledgerRows.some((l) => l.type === "refund.approved" && l.amount === 700), ledgerRows.map((l) => `${l.type}:${l.amount}`).join(","));
    check("15. customer told partially approved", notificationLog.some((n) => /partially approved/.test(n.message) && /₹700/.test(n.message)), notificationLog.map((n) => n.message).join("|"));
    // Over-cap partial is refused.
    reset({ payment: { refundStatus: "pending", refundAmount: 1110 } });
    claimImpl = async () => bookingDoc;
    const over = await callApprove(ADMIN, { amount: 50000 });
    check("15. over-cap partial -> 400", over.status === 400 && /exceeds the refundable/.test(String(over.payload?.message)), `s=${over.status} ${over.payload?.message || ""}`);
    check("15. over-cap moves nothing", bookingDoc.payment.refundStatus === "pending", bookingDoc.payment.refundStatus);
  }

  // ── 16. Reject notifies the cook too (payout unblocked) ───────────────────
  {
    const payout = require("./controllers/payoutController");
    reset({ payment: { refundStatus: "pending", refundAmount: 1110, refundReason: "Cook did not arrive" } });
    claimImpl = async (filter, update) => {
      const want = filter["payment.refundStatus"];
      const cur = bookingDoc.payment.refundStatus;
      const ok = !want || (typeof want === "string" ? cur === want : want.$in ? want.$in.includes(cur) : true);
      if (!ok) return null;
      for (const [k, v] of Object.entries(update.$set || {})) {
        const ks = String(k).split(".");
        let t = bookingDoc;
        for (let i = 0; i < ks.length - 1; i++) t = t[ks[i]];
        t[ks[ks.length - 1]] = v;
      }
      if (update.$push?.statusHistory) bookingDoc.statusHistory.push(update.$push.statusHistory);
      return bookingDoc;
    };
    const req = { params: { id: "booking1" }, user: ADMIN, body: { reason: "Cook arrived late but served" } };
    const res = makeRes();
    await payout.rejectRefund(req, res, (e) => { if (e) throw e; });
    check("16. reject -> 200 rejected", res.statusCode === 200 && bookingDoc.payment.refundStatus === "rejected", `s=${res.statusCode} rs=${bookingDoc.payment.refundStatus}`);
    const cookNotes = notificationLog.filter((n) => String(n.user) === "cook1" && n.type === "refund_processed");
    check("16. cook hears the decline + payout unblocked", cookNotes.length === 1 && /no longer blocked/i.test(cookNotes[0].message), cookNotes.map((n) => n.message).join("|"));
    check("16. customer still told with reason", notificationLog.some((n) => String(n.user) === "cust1" && /declined/i.test(n.message)), notificationLog.map((n) => n.message).join("|"));
    check("16. decline reason stored for display", bookingDoc.payment.refundAdminNote === "Cook arrived late but served", String(bookingDoc.payment.refundAdminNote));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) {
    console.log("FAILURES PRESENT");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED");
  }
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});