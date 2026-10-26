#!/usr/bin/env node
// Post-build guard (EVT-AUD-005): a shipped bundle must never target the
// developer's localhost. `frontend/.env.production` defaults the API to
// same-origin `/api`; this check fails the build loudly if any local/CI value
// leaks a localhost API base URL into the JavaScript bundle.
const fs = require("fs");
const path = require("path");

const buildDir = path.join(__dirname, "..", "build");
const staticDir = path.join(buildDir, "static", "js");
// Match an actual local API base URL, not benign library fallbacks such as
// form-data's `window.location.href || "http://localhost"`. A leaked config
// always carries the API port/path (e.g. http://localhost:5000/api).
const LOCAL_API_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/api\b|\/)/i;

const walk = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
};

if (!fs.existsSync(buildDir)) {
  console.error("ERROR: frontend/build is missing; run the production build first.");
  process.exit(1);
}

const jsFiles = walk(staticDir).filter((file) => file.endsWith(".js"));
if (jsFiles.length === 0) {
  console.error(`ERROR: no JavaScript bundles found under ${staticDir}`);
  process.exit(1);
}

const offenders = [];
for (const file of jsFiles) {
  const source = fs.readFileSync(file, "utf8");
  const match = source.match(LOCAL_API_RE);
  if (match) offenders.push(`${path.relative(buildDir, file)} -> ${match[0]}`);
}

if (offenders.length > 0) {
  console.error("ERROR: production bundle contains a localhost API URL:");
  for (const line of offenders) console.error(`  - ${line}`);
  console.error(
    "Set REACT_APP_API_URL=/api (or a real https URL) for the production build."
  );
  process.exit(1);
}

console.log(`Build artifact check passed: ${jsFiles.length} JS bundle(s) contain no localhost API URL.`);
