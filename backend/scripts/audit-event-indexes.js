#!/usr/bin/env node
// Read-only Events index inventory and drift check.
// Usage: node scripts/audit-event-indexes.js [--json]
// Connection: MONGODB_URI or --uri <mongodb-uri>.
// This script NEVER creates, drops, renames, or modifies indexes/documents.
const mongoose = require("mongoose");

const MODELS = [
  ["EventBooking", "models/EventBooking"],
  ["EventPricing", "models/EventPricing"],
  ["EventType", "models/EventType"],
  ["EventLedgerEntry", "models/EventLedgerEntry"],
  ["EventOutbox", "models/EventOutbox"],
  ["WebhookEvent", "models/WebhookEvent"],
  ["Notification", "models/Notification"],
];

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? String(process.argv[i + 1] || "").trim() : "";
};

const defaultName = (keys) =>
  Object.entries(keys)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");

const expectedIndexes = (model) =>
  model.schema.indexes().map(([keys, options = {}]) => ({
    name: options.name || defaultName(keys),
    key: keys,
    unique: options.unique === true,
    sparse: options.sparse === true,
    expireAfterSeconds: options.expireAfterSeconds,
    partialFilterExpression: options.partialFilterExpression,
  }));

const actualIndexes = (indexes) =>
  indexes.map((index) => ({
    name: index.name,
    key: index.key,
    unique: index.unique === true,
    sparse: index.sparse === true,
    expireAfterSeconds: index.expireAfterSeconds,
    partialFilterExpression: index.partialFilterExpression,
  }));

const stable = (value) => {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
    .join(",")}}`;
};

const sameDefinition = (a, b) =>
  stable(a.key) === stable(b.key) &&
  a.unique === b.unique &&
  a.sparse === b.sparse &&
  a.expireAfterSeconds === b.expireAfterSeconds &&
  stable(a.partialFilterExpression) === stable(b.partialFilterExpression);

async function main() {
  const uri = argValue("--uri") || String(process.env.MONGODB_URI || "").trim();
  if (!uri) {
    console.error("MONGODB_URI is not set and --uri was not provided.");
    process.exit(2);
  }
  if (process.argv.includes("--apply") || process.argv.includes("--drop")) {
    console.error("This is a READ-ONLY audit. Index changes require the separately approved migration procedure.");
    process.exit(2);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const report = {
    database: mongoose.connection.db.databaseName,
    readOnly: true,
    generatedAt: new Date().toISOString(),
    collections: {},
    ok: true,
  };

  try {
    for (const [name, modulePath] of MODELS) {
      const model = require(`../${modulePath}`);
      const collection = model.collection.collectionName;
      let present = [];
      let collectionFound = true;
      try {
        present = await mongoose.connection.db.collection(collection).indexes();
      } catch (error) {
        if (error?.codeName !== "NamespaceNotFound" && error?.code !== 26) throw error;
        collectionFound = false;
      }
      const actual = actualIndexes(present);
      const expected = expectedIndexes(model);
      const missing = expected.filter((index) => !actual.some((item) => item.name === index.name));
      const mismatched = expected
        .filter((index) => actual.some((item) => item.name === index.name))
        .filter((index) => !sameDefinition(index, actual.find((item) => item.name === index.name)));
      const expectedNames = new Set(expected.map((index) => index.name).concat("_id_"));
      const extra = actual.filter((index) => !expectedNames.has(index.name));
      const entry = {
        collection,
        collectionFound,
        expected,
        actual,
        missing,
        mismatched,
        extra,
      };
      if (missing.length || mismatched.length) report.ok = false;
      report.collections[name] = entry;
    }
  } finally {
    await mongoose.disconnect();
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`READ-ONLY index audit: ${report.database}`);
    for (const [name, entry] of Object.entries(report.collections)) {
      console.log(`\n${name} -> ${entry.collection}${entry.collectionFound ? "" : " (collection absent)"}`);
      console.log(`  present: ${entry.actual.map((index) => index.name).join(", ") || "none"}`);
      for (const index of entry.missing) console.log(`  MISSING: ${index.name}`);
      for (const index of entry.mismatched) console.log(`  MISMATCH: ${index.name}`);
      for (const index of entry.extra) console.log(`  EXTRA (review): ${index.name}`);
    }
    console.log(report.ok ? "\nAUDIT OK: all schema-declared indexes are present with matching definitions." : "\nAUDIT FAILED: missing or mismatched indexes found. Do not mutate Production; follow docs/EVENT_INDEX_MIGRATION.md.");
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch(async (error) => {
  console.error(`AUDIT ERROR: ${error.message}`);
  await mongoose.disconnect().catch(() => {});
  process.exit(2);
});
