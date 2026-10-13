// Access-log URL scrubber: session-bearing query params must never land in
// plaintext log files (the realtime SSE stream carries its JWT as
// `?token=...`, and log lines get pasted into chats/tickets).
// Pure function — unit-tested in log-scrub.test.js.
const scrubRequestUrl = (url) =>
  String(url || "")
    .replace(/([?&]docToken=)[^&\s]*/g, "$1[REDACTED]")
    .replace(/([?&]token=)[^&\s]*/g, "$1[REDACTED]");

module.exports = { scrubRequestUrl };
