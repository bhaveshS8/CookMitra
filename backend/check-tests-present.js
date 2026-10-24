// Fail-closed guard: zero tests must never report success.
// Run as first step of `npm test`. Exits 1 if no *.test.js files exist
// or if critical safety suites are missing. Pure filesystem inspection:
// no DB, no network, no secrets.
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.js"));
console.log(`found ${files.length} backend test file(s)`);

const CRITICAL = [
  "staging-preflight.test.js",
  "finance-audit.test.js",
  "refund-hardening.test.js",
  "cancellation-refund.test.js",
  "cook-cancel-replacement.test.js",
  "payout-settle.test.js",
  "weekly-payout.test.js",
  "payout-weekly-guards.test.js",
];

let failed = false;
if (files.length === 0) {
  console.error("FAIL: zero test files present — refusing successful verification");
  failed = true;
}
for (const c of CRITICAL) {
  if (!files.includes(c)) {
    console.error(`FAIL: critical suite missing: ${c}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log("test guard ok");
