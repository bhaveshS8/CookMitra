// JWT secret rotation helper (run by the OPERATOR, never in CI).
//
//   node backend/scripts/rotate-secrets.js --write <path-to-.env>
//
// Generates a fresh 96-hex-char JWT_SECRET with crypto randomness and writes
// it into the target .env, preserving every other line. The secret value is
// NEVER printed to stdout/logs. Without --write this is a dry run that changes
// nothing (exit 2).
//
// After rotating: restart the API on every instance (old tokens stop verifying
// immediately), then purge the compromised secret from git history — see
// docs/SECRET_ROTATION.md.
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const args = process.argv.slice(2);
const writeIdx = args.indexOf("--write");
if (writeIdx === -1 || !args[writeIdx + 1]) {
  console.error("Usage: node backend/scripts/rotate-secrets.js --write <path-to-.env>");
  console.error("Dry run only — no --write target given, nothing changed.");
  process.exit(2);
}

const target = path.resolve(args[writeIdx + 1]);
const fresh = crypto.randomBytes(48).toString("hex"); // 96 hex chars, ~384 bits

let lines = [];
if (fs.existsSync(target)) {
  lines = fs.readFileSync(target, "utf8").split(/\r?\n/);
}
let replaced = false;
lines = lines.map((line) => {
  if (/^\s*JWT_SECRET\s*=/.test(line)) {
    replaced = true;
    return `JWT_SECRET=${fresh}`;
  }
  return line;
});
if (!replaced) {
  if (lines.length === 1 && lines[0] === "") lines = [];
  lines.push(`JWT_SECRET=${fresh}`);
}
try {
  fs.writeFileSync(target, lines.join("\n"), { mode: 0o600 });
} catch (err) {
  console.error(`Failed to write ${target}: ${err && err.message}`);
  process.exit(1);
}
console.log(`JWT_SECRET rotated in ${target} (new value hidden, restrictive file mode requested).`);
console.log("Next steps:");
console.log("  1. Copy the new JWT_SECRET into every production env store (Render dashboard / server .env).");
console.log("  2. Restart the API on ALL instances (old tokens invalidate immediately).");
console.log("  3. Purge the old secret from git history — docs/SECRET_ROTATION.md.");
console.log("  4. Verify: log in, call GET /api/auth/me, confirm 200.");
