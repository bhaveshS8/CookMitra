const mongoose = require("mongoose");

const EXPECTED = {
  collection: "eventbookings",
  name: "customerId_1_idempotencyKey_1",
  key: { customerId: 1, idempotencyKey: 1 },
  partialFilterExpression: { idempotencyKey: { $gt: "" } },
};

const HELP = `Usage:
  MONGODB_URI="<protected connection string>" node scripts/migrate-event-booking-indexes.js --target <database> [--apply]

Without --apply this is a read-only dry run.
--target must exactly match the database name in MONGODB_URI.
The script never drops or renames indexes and never deletes documents.`;

const maskSecrets = (value) => {
  try {
    return String(value)
      .replace(/\/\/([^:/?#\s]+:)([^@/?#\s]*)@/g, "//$1****@")
      .replace(/([?&](?:password|passwd|pwd|token|secret)[^=]*=)[^&\s]*/gi, "$1****");
  } catch {
    return "<unparseable>";
  }
};

const argValue = (args, name) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] || "";
  return "";
};

const sameObject = (actual, expected) => {
  try {
    return JSON.stringify(actual) === JSON.stringify(expected);
  } catch {
    return false;
  }
};

const sameKeyOrder = (actual, expected) => {
  if (!actual || typeof actual !== "object") return false;
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  if (actualKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key, index) => actualKeys[index] === key && actual[key] === expected[key]);
};

const definitionMatches = (index) =>
  index.name === EXPECTED.name &&
  sameKeyOrder(index.key, EXPECTED.key) &&
  index.unique === true &&
  index.sparse !== true &&
  !index.collation &&
  sameObject(index.partialFilterExpression, EXPECTED.partialFilterExpression);

const describeIndex = (index) =>
  JSON.stringify({
    name: index.name,
    key: index.key,
    unique: index.unique === true,
    sparse: index.sparse === true,
    partialFilterExpression: index.partialFilterExpression || null,
  });

const duplicateGroups = async (collection) => {
  const rows = await collection
    .aggregate([
      { $match: { idempotencyKey: { $type: "string", $gt: "" } } },
      {
        $group: {
          _id: { customerId: "$customerId", idempotencyKey: "$idempotencyKey" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $count: "groups" },
    ])
    .toArray();
  return Number(rows[0]?.groups || 0);
};

const listIndexes = async (collection) => {
  try {
    return await collection.indexes();
  } catch (error) {
    if (error?.codeName === "NamespaceNotFound" || error?.code === 26) return [];
    throw error;
  }
};

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  const unknown = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply" || arg === "--help" || arg === "-h") continue;
    if (arg === "--target") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--target=")) continue;
    unknown.push(arg);
  }
  if (unknown.length) {
    console.error(`Refusing unknown argument(s): ${unknown.join(", ")}`);
    console.error(HELP);
    process.exit(2);
  }

  const target = String(argValue(args, "--target") || "").trim();
  const apply = args.includes("--apply");
  const uri = String(process.env.MONGODB_URI || "").trim();

  if (!target) {
    console.error("--target <database> is required. Refusing to guess the database.");
    process.exit(2);
  }
  if (["admin", "local", "config"].includes(target.toLowerCase())) {
    console.error("Refusing a MongoDB system database as the target.");
    process.exit(2);
  }
  if (!uri) {
    console.error("MONGODB_URI is not set. Refusing to run without an explicit target connection.");
    process.exit(2);
  }

  console.log(`Mode: ${apply ? "APPLY" : "DRY RUN (read-only)"}`);
  console.log(`Requested target: ${target}`);
  console.log(`Connection: ${maskSecrets(uri).replace(/\/[^/?]*(\?|$)/, "/<db>$1")}`);
  console.log(`Expected index: ${EXPECTED.collection}.${EXPECTED.name}`);
  console.log(`Expected definition: ${JSON.stringify({
    key: EXPECTED.key,
    unique: true,
    partialFilterExpression: EXPECTED.partialFilterExpression,
  })}`);

  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  } catch (error) {
    console.error(`CONNECTION FAILED: ${maskSecrets(error?.message || error)}`);
    process.exit(1);
  }

  try {
    const actual = String(mongoose.connection.name || "");
    if (actual !== target) {
      console.error(`TARGET MISMATCH: connected database is "${actual}", not "${target}". No changes made.`);
      process.exit(2);
    }

    const db = mongoose.connection.db;
    const collection = db.collection(EXPECTED.collection);
    let indexes = await listIndexes(collection);
    const totalDocuments = await collection.countDocuments({});
    const nonEmptyKeys = await collection.countDocuments({
      idempotencyKey: { $type: "string", $gt: "" },
    });
    const duplicates = await duplicateGroups(collection);

    console.log(`Connected database: ${actual}`);
    console.log(`Documents: ${totalDocuments}; non-empty idempotencyKey: ${nonEmptyKeys}`);
    console.log(`Duplicate non-empty key groups: ${duplicates}`);

    const exact = indexes.find((index) => index.name === EXPECTED.name);
    const sameKey = indexes.filter((index) => sameKeyOrder(index.key, EXPECTED.key));

    if (exact) {
      if (definitionMatches(exact)) {
        console.log(`PASS existing index definition: ${describeIndex(exact)}`);
        console.log("ALREADY PRESENT: no migration needed.");
        process.exit(0);
      }
      console.error(`FAIL existing index has the expected name but a different definition: ${describeIndex(exact)}`);
      console.error("Refusing to drop, rename, or overwrite it. Obtain DBA approval and review manually.");
      process.exit(1);
    }

    if (sameKey.length) {
      console.error("FAIL an index on the same key exists under a different name:");
      for (const index of sameKey) console.error(`  ${describeIndex(index)}`);
      console.error("Refusing to create a duplicate equivalent index. Obtain approval before renaming or dropping it.");
      process.exit(1);
    }

    if (duplicates > 0) {
      console.error("FAIL duplicate non-empty (customerId, idempotencyKey) groups exist. Do not create the unique index.");
      console.error("Resolve duplicates as a business/data decision. This script will not delete or merge records.");
      process.exit(1);
    }

    if (!apply) {
      console.log("DRY RUN OK: duplicate pre-check is clean and the index is missing.");
      console.log("WOULD CREATE: rerun with --apply during the approved change window.");
      process.exit(0);
    }

    const recheck = await duplicateGroups(collection);
    if (recheck > 0) {
      console.error(`FAIL duplicate groups appeared during pre-check (${recheck}). No index was created.`);
      process.exit(1);
    }

    await collection.createIndex(EXPECTED.key, {
      name: EXPECTED.name,
      unique: true,
      partialFilterExpression: EXPECTED.partialFilterExpression,
    });

    indexes = await listIndexes(collection);
    const created = indexes.find((index) => index.name === EXPECTED.name);
    const postDuplicates = await duplicateGroups(collection);
    if (!created || !definitionMatches(created)) {
      console.error("FAIL post-create verification did not find the expected index definition.");
      process.exit(1);
    }
    if (postDuplicates > 0) {
      console.error(`FAIL post-create duplicate check found ${postDuplicates} group(s).`);
      process.exit(1);
    }

    console.log(`PASS created index definition: ${describeIndex(created)}`);
    console.log("PASS post-create duplicate check: clean");
    console.log("APPLIED: record the target, timestamp, index definition, and this result.");
    console.log("ROLLBACK: no data rollback is required. Dropping the index requires incident approval because it removes duplicate protection.");
    process.exit(0);
  } catch (error) {
    console.error(`FAIL ${maskSecrets(error?.message || error)}`);
    process.exit(1);
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`FATAL ${maskSecrets(error?.message || error)}`);
  process.exit(1);
});
