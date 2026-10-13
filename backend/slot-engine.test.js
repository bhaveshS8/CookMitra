const s = require("./utils/slots");

const windows = [{ startTime: "09:00", endTime: "14:00" }];
let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (detail ? "  -> " + detail : ""));
  if (!ok) failures++;
};

const empty = s.computeStartOptions(windows, [], 3);
check("open day yields 5 start options", empty.length === 5,
  empty.map((o) => o.startTime).join(","));

const held = s.computeStartOptions(windows, [{ startTime: "10:00", endTime: "13:00" }], 3);
check("held slot hides overlapping starts", held.length === 0,
  held.map((o) => o.startTime).join(",") || "no 3h gap remains");

const partial = s.computeStartOptions(
  windows, [{ startTime: "09:00", endTime: "10:00" }], 3);
check("held slot keeps later valid starts",
  partial.length === 3 && partial[0].startTime === "10:00",
  partial.map((o) => o.startTime).join(","));


const back = s.findOverlapBooking([{ startTime: "09:00", endTime: "12:00" }], "12:00", "15:00");
check("back-to-back booking allowed", back == null, String(back));

const ov = s.findOverlapBooking(
  [{ startTime: "10:00", endTime: "13:00", status: "requested" }], "11:00", "14:00");
check("overlap with held request detected", !!ov && ov.status === "requested",
  ov ? "status=" + ov.status : "missed");

const m = s.activeSlotMatch();
const permanentOk = Array.isArray(m[0].status.$in) &&
  m[0].status.$in.join("/") === "accepted/confirmed/in_progress";
const holdOk = m[1].status === "requested" &&
  m[1].requestExpiresAt && m[1].requestExpiresAt.$gt instanceof Date;
check("permanent block clause", permanentOk, m[0].status.$in.join("/"));
check("pending-hold clause is expiry-bounded", holdOk,
  JSON.stringify(Object.keys(m[1].requestExpiresAt)[0]));

const cutoff = m[1].requestExpiresAt.$gt;
const past = new Date(Date.now() - 60 * 1000);
const live = new Date(Date.now() + 60 * 1000);
check("hold cutoff is ~now", cutoff instanceof Date && Math.abs(cutoff.getTime() - Date.now()) < 5000, String(cutoff));
check("expired hold falls outside window", past < cutoff, "past < cutoff");
check("live hold falls inside window", live > cutoff, "live > cutoff");

console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
