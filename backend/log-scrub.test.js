// Log-scrubber tests: session tokens must never reach log files intact.

const { scrubRequestUrl } = require("./utils/scrubUrl");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) failures++;
};

const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjEifQ.sig";

check("realtime stream token redacted",
  scrubRequestUrl(`/api/realtime/stream?token=${TOKEN}`) === "/api/realtime/stream?token=[REDACTED]",
  scrubRequestUrl(`/api/realtime/stream?token=${TOKEN}`).slice(-30));
check("token among other params redacted, rest intact",
  scrubRequestUrl(`/api/x?a=1&token=${TOKEN}&b=2`) === `/api/x?a=1&token=[REDACTED]&b=2`);
check("docToken still redacted",
  scrubRequestUrl(`/api/docs/view?docToken=secret123`) === "/api/docs/view?docToken=[REDACTED]");
check("both tokens redacted independently",
  scrubRequestUrl(`/api/a?token=${TOKEN}&docToken=abc`) === "/api/a?token=[REDACTED]&docToken=[REDACTED]");
check("lookalike params untouched (mytoken, authtoken)",
  scrubRequestUrl("/api/a?mytoken=1&authtoken=2") === "/api/a?mytoken=1&authtoken=2");
check("token-free URLs untouched",
  scrubRequestUrl("/api/bookings/123") === "/api/bookings/123");
check("empty/null safe", scrubRequestUrl("") === "" && scrubRequestUrl(null) === "" && scrubRequestUrl(undefined) === "");
check("no raw token material survives",
  !scrubRequestUrl(`/api/realtime/stream?token=${TOKEN}`).includes("eyJhbGci"));

console.log(failures === 0 ? "ALL TESTS PASSED" : `${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
