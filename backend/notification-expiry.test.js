// Notification retention: items older than the window are auto-deleted by
// MongoDB's TTL monitor (~every 60s), read or unread. Pure schema
// inspection: TTL deletion itself is a database background process and is
// not simulated here.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = process.env.NODE_ENV || "test";
delete process.env.NOTIFICATION_TTL_DAYS;

let failures = 0, passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  ok ? passes++ : failures++;
};

const Notification = require("./models/Notification");
const idx = Notification.schema.indexes();

const ttl = idx.find(
  ([spec, opts]) => spec && spec.createdAt === 1 && Number.isFinite(opts?.expireAfterSeconds)
);
check("TTL index on createdAt exists", Boolean(ttl), JSON.stringify(idx.map(([s, o]) => [s, o?.expireAfterSeconds])));
check(
  "default retention is 7 days (604800s)",
  ttl?.[1]?.expireAfterSeconds === 7 * 24 * 60 * 60,
  `expireAfterSeconds=${ttl?.[1]?.expireAfterSeconds}`
);
check(
  "per-user read-state index preserved",
  idx.some(([spec]) => spec && spec.user === 1 && spec.read === 1),
  JSON.stringify(idx.map(([s]) => s))
);

console.log(failures === 0 ? `\nALL NOTIFICATION-EXPIRY TESTS PASSED (${passes} checks)\n` : `\n${failures} TEST(S) FAILED (${passes} passed)\n`);
process.exit(failures === 0 ? 0 : 1);
