// Guards the public-origin resolver used by reset emails and WhatsApp links.
// Production must never emit a localhost link, even when FRONTEND_BASE_URL is
// missing (the live deployment only had an empty CLIENT_URL).
const { resolveFrontendBaseUrl, PRODUCTION_BASE_URL } = require("./frontendBase");

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  -> " + detail : ""));
  if (!ok) failures++;
};

const run = (env) => resolveFrontendBaseUrl(env);

check(
  "production with no origin configured -> canonical origin",
  run({ NODE_ENV: "production" }) === PRODUCTION_BASE_URL,
  run({ NODE_ENV: "production" })
);
check(
  "production with empty values -> canonical origin",
  run({ NODE_ENV: "production", FRONTEND_BASE_URL: "", FRONTEND_URL: "", CLIENT_URL: "" }) ===
    PRODUCTION_BASE_URL
);
check(
  "production ignores a stale localhost CLIENT_URL",
  run({ NODE_ENV: "production", CLIENT_URL: "http://localhost:3000" }) === PRODUCTION_BASE_URL
);
check(
  "production ignores 127.0.0.1 FRONTEND_URL",
  run({ NODE_ENV: "production", FRONTEND_URL: "http://127.0.0.1:3000" }) === PRODUCTION_BASE_URL
);
check(
  "production honors a real FRONTEND_BASE_URL",
  run({ NODE_ENV: "production", FRONTEND_BASE_URL: "https://cookmitra.org/" }) ===
    "https://cookmitra.org"
);
check(
  "production prefers FRONTEND_BASE_URL over CLIENT_URL",
  run({
    NODE_ENV: "production",
    FRONTEND_BASE_URL: "https://cookmitra.org",
    CLIENT_URL: "http://localhost:3000",
  }) === "https://cookmitra.org"
);
check(
  "production uses the first real origin in a comma list",
  run({ NODE_ENV: "production", CLIENT_URL: "http://localhost:3000,https://cookmitra.org" }) ===
    "https://cookmitra.org"
);
check(
  "development with no origin configured stays empty",
  run({ NODE_ENV: "development" }) === ""
);
check(
  "development keeps an explicit localhost origin",
  run({ NODE_ENV: "development", CLIENT_URL: "http://localhost:3000" }) ===
    "http://localhost:3000"
);

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
