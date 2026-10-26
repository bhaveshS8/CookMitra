process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = "test";

const path = require("path");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { Types } = mongoose;

let mongod;
let baseUri;
let passes = 0;
let failures = 0;

const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes += 1;
  else failures += 1;
};

const script = path.join(__dirname, "scripts", "migrate-event-booking-indexes.js");
const auditScript = path.join(__dirname, "scripts", "audit-event-indexes.js");
const uriFor = (name) => `${baseUri}${name}`;

const runAudit = (uri, args = []) => {
  try {
    const out = execFileSync(process.execPath, [auditScript, ...args], {
      cwd: __dirname,
      encoding: "utf8",
      env: { ...process.env, MONGODB_URI: uri },
      timeout: 90000,
    });
    return { exit: 0, out };
  } catch (error) {
    return {
      exit: error.status ?? 1,
      out: String(error.stdout || "") + String(error.stderr || ""),
    };
  }
};

const run = (name, args = [], uri = uriFor(name)) => {
  try {
    const out = execFileSync(process.execPath, [script, "--target", name, ...args], {
      cwd: __dirname,
      encoding: "utf8",
      env: { ...process.env, MONGODB_URI: uri },
      timeout: 90000,
    });
    return { exit: 0, out };
  } catch (error) {
    return {
      exit: error.status ?? 1,
      out: String(error.stdout || "") + String(error.stderr || ""),
    };
  }
};

const runMissingTarget = (uri) => {
  try {
    const out = execFileSync(process.execPath, [script], {
      cwd: __dirname,
      encoding: "utf8",
      env: { ...process.env, MONGODB_URI: uri },
      timeout: 90000,
    });
    return { exit: 0, out };
  } catch (error) {
    return {
      exit: error.status ?? 1,
      out: String(error.stdout || "") + String(error.stderr || ""),
    };
  }
};

const seed = async (name, fn) => {
  await mongoose.connect(uriFor(name), { serverSelectionTimeoutMS: 15000 });
  try {
    await fn(mongoose.connection.db);
  } finally {
    await mongoose.disconnect();
  }
};

const indexes = async (name) => {
  await mongoose.connect(uriFor(name), { serverSelectionTimeoutMS: 15000 });
  try {
    return await mongoose.connection.db.collection("eventbookings").indexes();
  } finally {
    await mongoose.disconnect();
  }
};

const bookingDoc = (over = {}) => ({
  customerId: new Types.ObjectId(),
  idempotencyKey: `key-${Math.random().toString(36).slice(2, 12)}`,
  ...over,
});

const expectedDefinition = (index) =>
  index &&
  index.name === "customerId_1_idempotencyKey_1" &&
  JSON.stringify(index.key) === JSON.stringify({ customerId: 1, idempotencyKey: 1 }) &&
  index.unique === true &&
  JSON.stringify(index.partialFilterExpression) === JSON.stringify({ idempotencyKey: { $gt: "" } });

async function main() {
  mongod = await MongoMemoryServer.create();
  baseUri = mongod.getUri();

  {
    const name = "event_index_dry_run";
    await seed(name, (db) =>
      db.collection("eventbookings").insertOne(bookingDoc({ customerId: new Types.ObjectId(), idempotencyKey: "dry-run-key" }))
    );
    const result = run(name);
    check("missing index dry run exits 0", result.exit === 0, `exit=${result.exit}`);
    check("missing index dry run reports WOULD CREATE", /WOULD CREATE/.test(result.out));
    const after = await indexes(name);
    check("dry run creates no index", !after.some((index) => index.name === "customerId_1_idempotencyKey_1"));
  }

  {
    const name = "event_index_apply";
    await seed(name, (db) =>
      db.collection("eventbookings").insertOne(bookingDoc({ customerId: new Types.ObjectId(), idempotencyKey: "apply-key" }))
    );
    const applied = run(name, ["--apply"]);
    check("clean apply exits 0", applied.exit === 0, `exit=${applied.exit}`);
    check("apply reports APPLIED", /APPLIED/.test(applied.out));
    const after = await indexes(name);
    const created = after.find((index) => index.name === "customerId_1_idempotencyKey_1");
    check("created index has exact definition", expectedDefinition(created), created ? JSON.stringify(created) : "missing");

    const again = run(name, ["--apply"]);
    check("rerun on correct index exits 0", again.exit === 0, `exit=${again.exit}`);
    check("rerun reports ALREADY PRESENT", /ALREADY PRESENT/.test(again.out));

    await seed(name, async (db) => {
      const collection = db.collection("eventbookings");
      const customerId = new Types.ObjectId();
      await collection.insertOne(bookingDoc({ customerId, idempotencyKey: "unique-key" }));
      let rejected = false;
      try {
        await collection.insertOne(bookingDoc({ customerId, idempotencyKey: "unique-key" }));
      } catch (error) {
        rejected = error?.code === 11000;
      }
      check("created index rejects duplicate non-empty key", rejected);
      await collection.insertMany([
        bookingDoc({ customerId, idempotencyKey: "" }),
        bookingDoc({ customerId, idempotencyKey: "" }),
        bookingDoc({ customerId, idempotencyKey: "" }),
      ]);
      const emptyCount = await collection.countDocuments({ customerId, idempotencyKey: "" });
      check("created index allows repeated empty keys", emptyCount === 3, `count=${emptyCount}`);
    });
  }

  {
    const name = "event_index_duplicates";
    await seed(name, async (db) => {
      const customerId = new Types.ObjectId();
      await db.collection("eventbookings").insertMany([
        bookingDoc({ customerId, idempotencyKey: "dupe-key" }),
        bookingDoc({ customerId, idempotencyKey: "dupe-key" }),
      ]);
    });
    const result = run(name, ["--apply"]);
    check("duplicate groups block apply", result.exit === 1, `exit=${result.exit}`);
    check("duplicate groups are reported", /duplicate non-empty/.test(result.out));
    const after = await indexes(name);
    check("no index created when duplicates exist", !after.some((index) => index.name === "customerId_1_idempotencyKey_1"));
  }

  {
    const name = "event_index_empty_keys";
    await seed(name, async (db) => {
      const customerId = new Types.ObjectId();
      await db.collection("eventbookings").insertMany([
        bookingDoc({ customerId, idempotencyKey: "" }),
        bookingDoc({ customerId, idempotencyKey: "" }),
      ]);
    });
    const result = run(name, ["--apply"]);
    check("repeated empty keys do not block apply", result.exit === 0, `exit=${result.exit}`);
    const after = await indexes(name);
    check("index created with repeated empty keys", after.some(expectedDefinition));
  }

  {
    const name = "event_index_wrong_definition";
    await seed(name, async (db) => {
      await db.collection("eventbookings").createIndex(
        { customerId: 1 },
        { name: "customerId_1_idempotencyKey_1" }
      );
      await db.collection("eventbookings").insertOne(bookingDoc());
    });
    const result = run(name, ["--apply"]);
    check("wrong same-name definition blocks apply", result.exit === 1, `exit=${result.exit}`);
    check("wrong same-name definition is reported", /different definition/.test(result.out));
    const after = await indexes(name);
    const existing = after.find((index) => index.name === "customerId_1_idempotencyKey_1");
    check("wrong definition is not overwritten", existing && existing.unique !== true && !existing.partialFilterExpression);
  }

  {
    const name = "event_index_equivalent_name";
    await seed(name, async (db) => {
      await db.collection("eventbookings").createIndex(
        { customerId: 1, idempotencyKey: 1 },
        {
          name: "event_booking_idempotency_alt",
          unique: true,
          partialFilterExpression: { idempotencyKey: { $gt: "" } },
        }
      );
      await db.collection("eventbookings").insertOne(bookingDoc());
    });
    const result = run(name, ["--apply"]);
    check("equivalent index under another name blocks apply", result.exit === 1, `exit=${result.exit}`);
    check("equivalent index requires manual review", /different name/.test(result.out));
    const after = await indexes(name);
    check("no duplicate equivalent index created", after.filter((index) => JSON.stringify(index.key) === JSON.stringify({ customerId: 1, idempotencyKey: 1 })).length === 1);
  }

  {
    const name = "event_index_target_mismatch";
    await seed(name, (db) => db.collection("eventbookings").insertOne(bookingDoc()));
    const result = run("different_database", [], uriFor(name));
    check("target mismatch exits 2", result.exit === 2, `exit=${result.exit}`);
    check("target mismatch makes no changes", /TARGET MISMATCH/.test(result.out));
    const after = await indexes(name);
    check("target mismatch creates no index", !after.some((index) => index.name === "customerId_1_idempotencyKey_1"));
  }

  {
    const result = runMissingTarget(uriFor("event_index_missing_target"));
    check("missing --target exits 2", result.exit === 2, `exit=${result.exit}`);
    check("missing --target refuses to guess", /--target <database> is required/.test(result.out));
  }

  {
    const result = run("event_index_missing_uri", [], "");
    check("missing MONGODB_URI exits 2", result.exit === 2, `exit=${result.exit}`);
    check("missing MONGODB_URI fails closed", /MONGODB_URI is not set/.test(result.out));
  }

  {
    const name = "event_index_audit_empty";
    const uri = uriFor(name);
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    await mongoose.disconnect();
    const empty = runAudit(uri, ["--json"]);
    check("read-only audit fails on missing declared indexes", empty.exit === 1, `exit=${empty.exit}`);
    check("read-only audit reports missing entries", /"missing": \[/.test(empty.out));
  }

  {
    const name = "event_index_audit_full";
    const uri = uriFor(name);
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
    const models = [
      require("./models/EventBooking"),
      require("./models/EventPricing"),
      require("./models/EventType"),
      require("./models/EventLedgerEntry"),
      require("./models/EventOutbox"),
      require("./models/WebhookEvent"),
      require("./models/Notification"),
    ];
    for (const model of models) await model.createIndexes();
    await mongoose.disconnect();
    const full = runAudit(uri, ["--json"]);
    check("read-only audit passes after isolated index creation", full.exit === 0, `exit=${full.exit}`);
    let report;
    try {
      report = JSON.parse(full.out);
    } catch {
      report = null;
    }
    check("audit JSON parses", Boolean(report));
    check("audit covers all Events collections", report && Object.keys(report.collections).length === 7);
    const booking = report?.collections?.EventBooking;
    const bookingNames = (booking?.actual || []).map((index) => index.name);
    check("booking idempotency index present", bookingNames.includes("customerId_1_idempotencyKey_1"));
    check("booking unique bookingId index present", bookingNames.includes("bookingId_1"));
    check("booking unique payment id index present", bookingNames.includes("payment.razorpayPaymentId_1"));
    const outboxNames = (report?.collections?.EventOutbox?.actual || []).map((index) => index.name);
    check("outbox unique event key present", outboxNames.includes("eventKey_1"));
    const notificationNames = (report?.collections?.Notification?.actual || []).map((index) => index.name);
    check("notification unique event recipient present", notificationNames.includes("eventKey_1_user_1"));
    check("notification TTL present", notificationNames.includes("createdAt_1"));
    check("audit performs no drift", report?.ok === true && Object.values(report?.collections || {}).every((entry) => entry.missing.length === 0 && entry.mismatched.length === 0));
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? "ALL TESTS PASSED" : `${failures} FAILURES`);
}

main()
  .catch((error) => {
    console.error("FATAL", error);
    failures += 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
    if (mongod) await mongod.stop().catch(() => {});
    process.exit(failures === 0 ? 0 : 1);
  });
