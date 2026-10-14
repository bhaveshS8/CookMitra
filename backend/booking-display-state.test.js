
const fs = require("fs");
const path = require("path");

let failures = 0;
let passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (ok) passes += 1;
  else failures += 1;
};

const src = fs.readFileSync(
  path.join(__dirname, "..", "frontend", "src", "utils", "constants.js"),
  "utf8"
);
const cjs = src.replace(/^export\s+(?=const|function)/gm, "") + "\nmodule.exports = { getBookingDisplayState, isBookingOverdue, canRescheduleBooking, sessionEndDate, sessionStartDate };\n";
const mod = new module.constructor();
mod._compile(cjs, path.join(__dirname, "constants.display.cjs"));
const { getBookingDisplayState, isBookingOverdue, canRescheduleBooking } = mod.exports;

const H = 60 * 60 * 1000;
const at = (ms) => new Date(ms);

(async () => {
  const now = Date.now();

  {
    const future = { status: "confirmed", serviceStartedAt: null, serviceEndsAt: null, date: at(now + 2 * H), startTime: "10:00", endTime: "12:00", durationHours: 2 };
    const f2 = { status: "confirmed", serviceStartedAt: at(now + H), serviceEndsAt: at(now + 2 * H) };
    check("1. future booking -> UPCOMING", getBookingDisplayState(f2, now) === "UPCOMING", getBookingDisplayState(f2, now));
    check("1. future booking not overdue", isBookingOverdue(f2, now) === false, "");
    const running = { status: "confirmed", serviceStartedAt: at(now - H), serviceEndsAt: at(now + H) };
    check("2. running booking -> IN_PROGRESS", getBookingDisplayState(running, now) === "IN_PROGRESS", getBookingDisplayState(running, now));
    void future;
  }

  for (const status of ["requested", "accepted", "confirmed", "in_progress"]) {
    const b = { status, serviceStartedAt: at(now - 3 * H), serviceEndsAt: at(now - H) };
    check(`3-4. ${status} past end -> OVERDUE`, getBookingDisplayState(b, now) === "OVERDUE", getBookingDisplayState(b, now));
  }

  for (const [status, want] of [["completed", "COMPLETED"], ["cancelled", "CANCELLED"], ["rejected", "REJECTED"], ["expired", "EXPIRED"]]) {
    const b = { status, serviceStartedAt: at(now - 3 * H), serviceEndsAt: at(now - 2 * H) };
    check(`5-7. ${status} past end -> ${want}`, getBookingDisplayState(b, now) === want, getBookingDisplayState(b, now));
  }

  {
    const base = { status: "confirmed", serviceStartedAt: at(now - 2 * H) };
    const before = { ...base, serviceEndsAt: at(now + 1000) };
    check("9. one second before end -> IN_PROGRESS", getBookingDisplayState(before, now) === "IN_PROGRESS", getBookingDisplayState(before, now));
    const exact = { ...base, serviceEndsAt: at(now) };
    check("8. exactly at end -> OVERDUE", getBookingDisplayState(exact, now) === "OVERDUE", getBookingDisplayState(exact, now));
    const after = { ...base, serviceEndsAt: at(now - 1000) };
    check("10. one second after end -> OVERDUE", getBookingDisplayState(after, now) === "OVERDUE", getBookingDisplayState(after, now));
  }

  {
    check("13. missing end -> UPCOMING (safe)", getBookingDisplayState({ status: "confirmed" }, now) === "UPCOMING", "");
    check("13. garbage end -> UPCOMING (safe)", getBookingDisplayState({ status: "accepted", date: "nope", startTime: "xx", endTime: "yy" }, now) === "UPCOMING", "");
    check("13. null booking -> UNKNOWN", getBookingDisplayState(null, now) === "UNKNOWN", "");
  }

  {
    const y = new Date(now - 24 * H);
    const p = (n) => String(n).padStart(2, "0");
    const ds = `${y.getFullYear()}-${p(y.getMonth() + 1)}-${p(y.getDate())}`;
    for (const [s, e] of [["17:00", "18:00"], ["17:00", "20:00"], ["08:00", "12:00"]]) {
      const b = { status: "confirmed", date: `${ds}T00:00:00`, startTime: s, endTime: e, durationHours: 2 };
      check(`14. past static slot ${s}-${e} -> OVERDUE`, getBookingDisplayState(b, now) === "OVERDUE", getBookingDisplayState(b, now));
    }
    const t = new Date(now + 24 * H);
    const ts = `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
    const f = { status: "accepted", date: `${ts}T00:00:00`, startTime: "17:00", endTime: "20:00", durationHours: 3 };
    check("14. future static slot -> UPCOMING", getBookingDisplayState(f, now) === "UPCOMING", getBookingDisplayState(f, now));
  }

  {
    const b = { status: "completed", serviceStartedAt: at(now - 3 * H), serviceEndsAt: at(now - H) };
    check("15. completed past end -> COMPLETED", getBookingDisplayState(b, now) === "COMPLETED", "");
  }

  {
    const overdue = { status: "confirmed", date: at(now - 3 * H), startTime: "10:00", endTime: "12:00", durationHours: 2, rescheduleCount: 0, serviceStartedAt: at(now - 3 * H), serviceEndsAt: at(now - H) };
    check("12. overdue booking offers no reschedule chip", canRescheduleBooking(overdue, { role: "customer" }, now) === false, "");
    const tm = new Date(now + 48 * H);
    const p2 = (n) => String(n).padStart(2, "0");
    const tds = `${tm.getFullYear()}-${p2(tm.getMonth() + 1)}-${p2(tm.getDate())}`;
    const upcoming = { status: "confirmed", date: `${tds}T00:00:00`, startTime: "10:00", endTime: "12:00", durationHours: 2, rescheduleCount: 0 };
    check("12. upcoming booking keeps reschedule chip", canRescheduleBooking(upcoming, { role: "customer" }, now) === true, "");
  }

  {
    check("classifier exported from shipped constants.js", typeof getBookingDisplayState === "function" && typeof isBookingOverdue === "function", "");
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) {
    console.log("FAILURES PRESENT");
    process.exit(1);
  } else {
    console.log("ALL TESTS PASSED");
  }
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
