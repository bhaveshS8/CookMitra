process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "wh_test_secret_abc123";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mongoose = require("mongoose");

let passes = 0, failures = 0;
const check = (n, ok, d) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`);
  ok ? passes++ : failures++;
};

const Booking = require("./models/Booking");
const Notification = require("./models/Notification");
Notification.create = async (d) => d;
const savedBookingUpdateOne = Booking.updateOne;
const savedBookingFindOne = Booking.findOne;
const savedBookingFindById = Booking.findById;
const savedBookingFindOneAndUpdate = Booking.findOneAndUpdate;
const restoreBooking = () => {
  Booking.updateOne = savedBookingUpdateOne;
  Booking.findOne = savedBookingFindOne;
  Booking.findById = savedBookingFindById;
  Booking.findOneAndUpdate = savedBookingFindOneAndUpdate;
};
const savedReadyState = mongoose.connection.readyState;
const setDbReady = (on) => {
  try {
    Object.defineProperty(mongoose.connection, "readyState", {
      value: on ? 1 : 0, configurable: true,
    });
  } catch {
    mongoose.connection.readyState = on ? 1 : 0;
  }
};

const makeRes = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};

(async () => {
  try {
    const paymentCtrl = require("./controllers/paymentController");
    const WebhookEvent = require("./models/WebhookEvent");
    const savedWECreate = WebhookEvent.create;
    const savedWEUpdate = WebhookEvent.updateOne;

    const orderId = "order_wh1";
    const paymentId = "pay_wh1";
    const rawPayload = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: 34900, currency: "INR", status: "captured" } } },
    });
    const sig = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(Buffer.from(rawPayload)).digest("hex");
    const whReq = () => ({
      headers: { "x-razorpay-signature": sig },
      body: Buffer.from(rawPayload),
    });

    {
      WebhookEvent.create = async () => { throw new Error("mongo down"); };
      let touched = false;
      Booking.findOne = async () => { touched = true; return null; };
      const r = makeRes();
      await paymentCtrl.handleWebhook(whReq(), r);
      check("W-FC dedup outage fails closed (500 + retry)", r.statusCode === 500 && r.body?.retry === true, `s=${r.statusCode}`);
      check("W-FC booking untouched on dedup outage", touched === false, `touched=${touched}`);
    }

    {
      WebhookEvent.create = async () => { const e = new Error("dup"); e.code = 11000; throw e; };
      let confirmed = false;
      Booking.findOneAndUpdate = async () => { confirmed = true; return null; };
      Booking.findOne = async () => { confirmed = true; return null; };
      const r = makeRes();
      await paymentCtrl.handleWebhook(whReq(), r);
      check("W-DUP redelivery acked as duplicate", r.statusCode === 200 && r.body?.handled === "duplicate", JSON.stringify(r.body));
      check("W-DUP no confirm attempted", confirmed === false, `confirmed=${confirmed}`);
    }

    {
      WebhookEvent.create = async (e) => e;
      WebhookEvent.updateOne = async () => ({});
      const doc = {
        _id: "bwh", customer: "c1", cook: "k1", amount: 349, status: "accepted",
        date: new Date(), startTime: "10:00",
        payment: { status: "pending", razorpayOrderId: orderId },
        statusHistory: [],
      };
      Booking.findOne = async () => doc;
      let claimFilter = null;
      Booking.findOneAndUpdate = async (filter, update, opts) => {
        claimFilter = filter;
        if (filter.status !== "accepted" || filter["payment.status"]?.["$ne"] !== "paid") return null;
        return { ...doc, status: "confirmed", payment: { ...doc.payment, status: "paid", razorpayPaymentId: paymentId } };
      };
      const LedgerEntry = require("./models/LedgerEntry");
      const savedLedger = LedgerEntry.create;
      LedgerEntry.create = async (e) => e;
      const r = makeRes();
      await paymentCtrl.handleWebhook(whReq(), r);
      LedgerEntry.create = savedLedger;
      check("W-ATOMIC confirm flips accepted+unpaid", r.statusCode === 200 && r.body?.handled === true, JSON.stringify(r.body));
      check("W-ATOMIC claim pins unpaid status", claimFilter?.status === "accepted" && !!claimFilter["payment.status"], JSON.stringify(claimFilter));
    }
    WebhookEvent.create = savedWECreate;
    WebhookEvent.updateOne = savedWEUpdate;

    const bookingCtrl = require("./controllers/bookingController");
    const next = (e) => { if (e) throw e; };
    setDbReady(true);

    {
      const doc = {
        _id: "br1", customer: "c1", cook: "cook1", status: "requested", statusHistory: [],
        payment: { status: "pending" },
        save: async function () { return this; },
      };
      Booking.findOne = async () => doc;
      Booking.updateOne = async () => ({ modifiedCount: 1 });
      Booking.findById = async () => doc;
      const { expireBookingIfNeeded } = bookingCtrl;
      const r = makeRes();
      await bookingCtrl.rejectBooking(
        { params: { id: "br1" }, user: { id: "cook1", role: "cook" }, body: {} },
        r, next
      );
      check("R-ATOMIC reject wins via claim", r.statusCode === 200, `s=${r.statusCode}`);
    }

    {
      const stale = { _id: "br2", customer: "c1", cook: "cook1", status: "requested", statusHistory: [], payment: { status: "pending" }, save: async function () { this.saved = true; return this; } };
      let reads = 0;
      Booking.findOne = async () => (++reads === 1 ? stale : { ...stale, status: "accepted" });
      Booking.updateOne = async () => ({ modifiedCount: 0 });
      Booking.findById = async () => ({ ...stale, status: "accepted" });
      const r = makeRes();
      await bookingCtrl.rejectBooking(
        { params: { id: "br2" }, user: { id: "cook1", role: "cook" }, body: {} },
        r, next
      );
      check("R-ATOMIC loser gets 409 + code", r.statusCode === 409 && r.body?.code === "BOOKING_INVALID_STATE", `s=${r.statusCode} code=${r.body?.code}`);
      check("R-ATOMIC loser never saves stale doc", stale.saved !== true, `saved=${stale.saved}`);
    }

    {
      const doc = {
        _id: "bc1", customer: "c1", cook: "cook1", status: "confirmed", statusHistory: [],
        payment: { status: "paid", paidAmount: 349 }, serviceStartedAt: new Date(),
        save: async function () { return this; },
        toObject: function () { const { save, toObject, ...rest } = this; return { ...rest }; },
      };
      Booking.findOne = async () => doc;
      Booking.updateOne = async (filter) => {
        const ok = filter.status?.$in && filter["payment.status"] === "paid";
        return { modifiedCount: ok ? 1 : 0 };
      };
      const User = require("./models/User");
      const savedUserFind = User.findById;
      User.findById = () => ({ select: async () => ({ name: "K", phone: "9000000001" }) });
      const r = makeRes();
      await bookingCtrl.completeBooking({ params: { id: "bc1" }, user: { id: "cook1", role: "cook" } }, r, next);
      User.findById = savedUserFind;
      check("C-ATOMIC complete wins via claim", r.statusCode === 200, `s=${r.statusCode}`);
    }

    {
      const doc = { _id: "bc2", customer: "c1", cook: "cook1", status: "confirmed", statusHistory: [], payment: { status: "paid" }, serviceStartedAt: new Date(), save: async function () { this.saved = true; return this; } };
      let reads = 0;
      Booking.findOne = async () => (++reads === 1 ? doc : { ...doc, status: "cancelled" });
      Booking.updateOne = async () => ({ modifiedCount: 0 });
      Booking.findById = async () => ({ ...doc, status: "cancelled" });
      const r = makeRes();
      await bookingCtrl.completeBooking({ params: { id: "bc2" }, user: { id: "cook1", role: "cook" } }, r, next);
      check("C-ATOMIC cancel-wins gives 409 + code", r.statusCode === 409 && r.body?.code === "BOOKING_INVALID_STATE", `s=${r.statusCode} code=${r.body?.code}`);
    }
    setDbReady(false);
    restoreBooking();

    const { validateUploadedContent } = require("./middleware/upload");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cookmitra-upload-"));
    const mk = (name, bytes) => { const p = path.join(tmp, name); fs.writeFileSync(p, Buffer.from(bytes)); return p; };
    const runVal = (files) => new Promise((resolve) => {
      const req = { files };
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      validateUploadedContent(req, res, () => resolve({ next: true, res }));
    });
    const png = mk("a.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    {
      const out = await runVal({ photo: [{ path: png, originalname: "a.png", size: 10 }] });
      check("U-OK genuine PNG passes", out.next === true, JSON.stringify(out.next));
    }
    const evil = mk("b.jpg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("<html><script>alert(1)</script>")]));
    {
      const before = fs.existsSync(evil);
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      let nexted = false;
      validateUploadedContent({ files: { photo: [{ path: evil, originalname: "b.jpg", size: 100 }] } }, res, () => { nexted = true; });
      check("U-POLYGLOT html-in-jpg refused", res.statusCode === 400 && res.body?.code === "INVALID_FILE_CONTENT" && !nexted, `s=${res.statusCode}`);
      check("U-POLYGLOT file deleted from disk", before && !fs.existsSync(evil), "deleted");
    }
    const fake = mk("c.pdf", Buffer.from("hello, this is not a pdf file at all"));
    {
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      let nexted = false;
      validateUploadedContent({ files: { pan: [{ path: fake, originalname: "c.pdf", size: 36 }] } }, res, () => { nexted = true; });
      check("U-FKEPDF wrong magic refused + deleted", res.statusCode === 400 && !nexted && !fs.existsSync(fake), `s=${res.statusCode}`);
    }
    const pdf = mk("d.pdf", Buffer.from("%PDF-1.7 fake body"));
    {
      const out = await runVal({ pan: [{ path: pdf, originalname: "d.pdf", size: 17 }] });
      check("U-OK genuine PDF passes", out.next === true, JSON.stringify(out.next));
    }
    fs.rmSync(tmp, { recursive: true, force: true });

    const payoutsSrc = fs.readFileSync(path.join(__dirname, "routes", "payouts.js"), "utf8");
    const routeChunks = payoutsSrc
      .split(/(?=router\.(get|post|patch|put|delete)\()/)
      .filter((c) => /^router\./.test(c));
    check("AUTHZ payouts route count stable", routeChunks.length === 13, `n=${routeChunks.length}`);
    const chunkFor = (h) => routeChunks.find((c) => new RegExp(`\\b${h}\\b`).test(c));
    const moneyHandlers = [
      "settlePayout", "rejectPayout", "markRefundSettled", "approveRefund",
      "rejectRefund", "getRefundQueue", "getPayoutQueue", "getPayoutHistory",
      "getLedgerSummary", "reconcileMissingPayoutLedger", "reconcileRefund",
    ];
    for (const h of moneyHandlers) {
      const chunk = chunkFor(h);
      check(
        `AUTHZ payouts ${h} requires admin`,
        !!chunk && /authorize\("admin"\)/.test(chunk),
        chunk ? chunk.slice(0, 60).replace(/\n/g, " ") : "(route missing!)"
      );
    }
    {
      const ungated = routeChunks.filter((c) => !/authorize\("/.test(c));
      check("AUTHZ every payouts route is role-gated", ungated.length === 0, ungated.map((c) => c.slice(0, 40).replace(/\n/g, " ")).join(" | "));
      const meChunk = routeChunks.find((c) => c.includes("statement/me"));
      check("AUTHZ cook statement/me stays cook-scoped", !!meChunk && /authorize\("cook"\)/.test(meChunk), "statement/me");
    }
    {
      const bookingsSrc = fs.readFileSync(path.join(__dirname, "routes", "bookings.js"), "utf8");
      const rrIdx = bookingsSrc.indexOf("refund-request");
      const rrSeg = bookingsSrc.slice(rrIdx, rrIdx + 400);
      check(
        "AUTHZ refund-request is customer-only",
        rrIdx !== -1 && /authorize\("customer"\)/.test(rrSeg),
        "refund-request gate"
      );
    }

    const { ensurePayoutIndexesOnce } = require("./utils/payoutIndexes");
    {
      const created = [];
      const fakeColl = { createIndex: async (spec, options) => { created.push(options?.name || JSON.stringify(spec)); return options?.name; } };
      const fakeConn = { readyState: 1, db: { collection: () => fakeColl } };
      const res = await ensurePayoutIndexesOnce({ connection: fakeConn, loop: false, onLog: () => {} });
      const names = created.sort().join(",");
      check("IDX ensure ok", res.ok === true, JSON.stringify(res));
      for (const n of ["uniq_payout_reference", "uniq_payout_reference_key", "uniq_refund_reference_key", "uniq_payment_razorpayPaymentId", "uniq_booking_clientKey", "idx_payment_razorpayOrderId", "idempotencyKey_1", "key_1"]) {
        check(`IDX ${n} ensured`, created.includes(n), names);
      }
    }

    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    console.error("TEST ERROR:", err);
    process.exit(1);
  } finally {
    restoreBooking();
    setDbReady(false);
    try {
      const mongoose2 = require("mongoose");
      Object.defineProperty(mongoose2.connection, "readyState", { value: savedReadyState, configurable: true });
    } catch { /* ignore */ }
  }
})();
