// Automated validation for scripts/check-payout-indexes.js (read-only ops
// checklist). Each fixture gets a fresh isolated in-memory MongoDB; the
// script runs as a child process exactly as an operator would run it.
// Covers: healthy DB, missing index, duplicate refs, diverged/ambiguous/
// audit-gap cycles, connection failure, malformed config, secret masking.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = "test";

const { execSync, execFileSync } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { Types } = mongoose;

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes++;
  else failures++;
};

const runChecklist = (uri) => {
  try {
    const out = execFileSync("node", ["scripts/check-payout-indexes.js"], {
      encoding: "utf8",
      env: { ...process.env, MONGODB_URI: uri || "" },
      timeout: 90000,
    });
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status ?? 1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
};

async function freshDb(seed) {
  const mongod = await MongoMemoryServer.create();
  const uri = await mongod.getUri();
  await mongoose.connect(uri);
  await Promise.all([
    require("./models/CookPayout").init(),
    require("./models/Booking").init(),
  ]);
  if (seed) await seed(mongoose.connection.db);
  await mongoose.disconnect();
  return { mongod, uri };
}

const paidCycleDoc = (over = {}) => ({
  cook: new Types.ObjectId(),
  weekStart: new Date("2026-09-28"),
  weekEnd: new Date("2026-10-04"),
  payoutRef: `CP-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
  bookings: [],
  bookingCount: 0,
  grossCustomerValue: 0,
  totalDeductions: 0,
  cookEarnings: 0,
  bonuses: 0,
  referralEarnings: 0,
  totalPayable: 0,
  status: "paid",
  paymentReference: `REF-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
  ...over,
});

async function main() {
  // 1. Healthy database (paid cycle fully evidenced + audited).
  {
    const { mongod, uri } = await freshDb(async (db) => {
      const c = await db.collection("cookpayouts").insertOne(paidCycleDoc({ payoutRef: "CP-OK" }));
      await db.collection("cookeventlogs").insertOne({
        actor: new Types.ObjectId(),
        actorRole: "ADMIN",
        event: "payout_paid",
        cook: new Types.ObjectId(),
        refId: c.insertedId,
        refModel: "CookPayout",
        detail: "seed",
      });
    });
    const r = runChecklist(uri);
    check("healthy DB exits 0", r.exit === 0, `exit=${r.exit}`);
    check("healthy DB reports ALL CHECKS PASSED", /ALL CHECKS PASSED/.test(r.out));
    await mongod.stop();
  }

  // 2. Missing unique index.
  {
    const { mongod, uri } = await freshDb(async (db) => {
      await db.collection("cookpayouts").dropIndex("uniq_cookpayout_payref");
    });
    const r = runChecklist(uri);
    check("missing index exits non-zero", r.exit !== 0, `exit=${r.exit}`);
    check("missing index names uniq_cookpayout_payref", /uniq_cookpayout_payref present/.test(r.out) && /MISSING/.test(r.out));
    await mongod.stop();
  }

  // 3. Duplicate payment references (index dropped first so dups can exist).
  {
    const { mongod, uri } = await freshDb(async (db) => {
      await db.collection("cookpayouts").dropIndex("uniq_cookpayout_payref");
      await db.collection("cookpayouts").insertMany([
        paidCycleDoc({ payoutRef: "CP-DUP-A", paymentReference: "DUP-REF-1" }),
        paidCycleDoc({ payoutRef: "CP-DUP-B", paymentReference: "DUP-REF-1" }),
      ]);
    });
    const r = runChecklist(uri);
    check("duplicate refs exit non-zero", r.exit !== 0, `exit=${r.exit}`);
    check("duplicate refs detected", /no duplicate non-empty paymentReference/.test(r.out));
    await mongod.stop();
  }

  // 4. Diverged + ambiguous + audit-gap cycles.
  {
    const { mongod, uri } = await freshDb(async (db) => {
      const cookId = new Types.ObjectId();
      const custId = new Types.ObjectId();
      const b = await db.collection("bookings").insertOne({
        customer: custId,
        cook: cookId,
        serviceType: "cook_for_me",
        date: new Date(),
        startTime: "10:00",
        endTime: "12:00",
        address: "x",
        durationHours: 2,
        amount: 349,
        status: "completed",
        payment: { status: "paid", refundStatus: "none" },
        payoutInfo: { finalCustomerPrice: 349, cookPayoutAmount: 296.65, payoutStatus: "approved", payoutCycleRef: "CP-DIV" },
      });
      await db.collection("cookpayouts").insertOne(paidCycleDoc({ payoutRef: "CP-DIV", bookings: [b.insertedId] }));
      await db.collection("cookpayouts").insertOne(paidCycleDoc({ payoutRef: "CP-AMB", paymentReference: "" }));
    });
    const r = runChecklist(uri);
    check("divergence/ambiguity/audit-gap exit non-zero", r.exit !== 0, `exit=${r.exit}`);
    check("diverged cycle flagged", /DIVERGED cycle CP-DIV/.test(r.out));
    check("ambiguous cycle flagged", /AMBIGUOUS cycle CP-AMB/.test(r.out));
    check("audit gap flagged", /AUDIT-GAP cycle/.test(r.out));
    await mongod.stop();
  }

  // 5. Connection failure + malformed config: fail closed, leak nothing.
  {
    const bad = runChecklist("mongodb://127.0.0.1:9/none?directConnection=true");
    check("unreachable DB exits non-zero", bad.exit !== 0, `exit=${bad.exit}`);
    check("unreachable DB reports failure, not success", /CONNECTION FAILED/.test(bad.out) && !/ALL CHECKS PASSED/.test(bad.out));
    const malformed = runChecklist("http://not-a-mongo-uri");
    check("malformed URI exits non-zero without success", malformed.exit !== 0 && !/ALL CHECKS PASSED/.test(malformed.out), `exit=${malformed.exit}`);
    const missing = runChecklist("");
    check("missing MONGODB_URI refuses fast (exit 2)", missing.exit === 2, `exit=${missing.exit}`);
    const secretUri = "mongodb://operator:s3cr3t-pw@127.0.0.1:9/db?directConnection=true";
    const leaked = runChecklist(secretUri);
    check("credentials never printed on failure", !leaked.out.includes("s3cr3t-pw"), "password leaked into output");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
