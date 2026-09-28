// visit-stats.test.js — unit tests for the in-house visit counter helpers
// (utils/visits.js). Pure functions, no DB needed.
// Run:  node visit-stats.test.js  — exits non-zero on any failure.
const { istDayString, isBot, normalizeVisitInput } = require("./utils/visits");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) failures++;
};

(async () => {
  try {
    console.log("\n═══ VISIT HELPERS ═══");

    // IST day format.
    const today = istDayString();
    check("istDayString returns YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(today), today);
    // 2026-09-18 00:30 IST is still 2026-09-17 UTC — the IST day must win.
    const istMidnight = istDayString(new Date("2026-09-17T19:00:00.000Z"));
    check("istDayString uses IST, not UTC", istMidnight === "2026-09-18", istMidnight);

    // Bot filtering.
    check("bot UA ignored", isBot("Mozilla/5.0 (compatible; Googlebot/2.1)") === true);
    check("crawler UA ignored", isBot("ahrefsbot/7.0") === true);
    check("headless UA ignored", isBot("HeadlessChrome/120") === true);
    check(
      "real browser counted",
      isBot(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
      ) === false
    );
    check("missing UA counted (not a bot)", isBot(undefined) === false);

    // Input normalization.
    const good = normalizeVisitInput({ vid: "abc123XYZ-_9", path: "/cook-on-demand" });
    check("valid input passes", good.vid === "abc123XYZ-_9" && good.path === "/cook-on-demand");
    check("query string stripped", normalizeVisitInput({ vid: "abcdefgh", path: "/?a=1" }).path === "/");
    check("hash stripped", normalizeVisitInput({ vid: "abcdefgh", path: "/#offers" }).path === "/");
    check(
      "non-slash path defaults to /",
      normalizeVisitInput({ vid: "abcdefgh", path: "https://evil.com" }).path === "/"
    );
    check("missing vid rejected", normalizeVisitInput({ path: "/" }).error !== undefined);
    check("short vid rejected", normalizeVisitInput({ vid: "abc" }).error !== undefined);
    check("vid with spaces rejected", normalizeVisitInput({ vid: "ab cd 1234" }).error !== undefined);

    // City fields (approximate location, city-level only).
    const withCity = normalizeVisitInput({ vid: "abcdefgh", path: "/", city: "Pune", state: "Maharashtra", country: "India" });
    check(
      "city/state/country pass through",
      withCity.city === "Pune" && withCity.state === "Maharashtra" && withCity.country === "India",
      JSON.stringify({ city: withCity.city, state: withCity.state, country: withCity.country })
    );
    const noCity = normalizeVisitInput({ vid: "abcdefgh", path: "/" });
    check(
      "missing city defaults to empty (visit still counts)",
      noCity.city === "" && noCity.state === "" && noCity.country === "" && !noCity.error
    );
    const longCity = normalizeVisitInput({ vid: "abcdefgh", path: "/", city: "X".repeat(200) });
    check("overlong city truncated to 80 chars", longCity.city.length === 80, `len=${longCity.city.length}`);

    // Route wiring: visit endpoints exist with the right guards.
    console.log("\n═══ VISIT ROUTES (wiring + guards) ═══");
    const statsRoutes = require("./routes/stats");
    const byPath = {};
    for (const layer of statsRoutes.stack) {
      const r = layer.route;
      if (!r) continue;
      byPath[r.path] = byPath[r.path] || {};
      for (const m of Object.keys(r.methods)) {
        byPath[r.path][m] = (byPath[r.path][m] || 0) + 1;
      }
    }
    check("POST /visit is public", byPath["/visit"] && byPath["/visit"].post === 1);
    check("GET /visits exists", byPath["/visits"] && byPath["/visits"].get === 1);
    // Admin guard: GET /visits must carry more middleware than the public
    // POST /visit (auth + authorize).
    const handlers = (path, method) => {
      const layer = statsRoutes.stack.find(
        (l) => l.route && l.route.path === path && l.route.methods[method]
      );
      return layer ? layer.route.stack.length : 0;
    };
    check(
      "GET /visits is admin-gated (auth middleware present)",
      handlers("/visits", "get") > handlers("/visit", "post"),
      `visit=${handlers("/visit", "post")} handlers, visits=${handlers("/visits", "get")} handlers`
    );
  } catch (err) {
    failures++;
    console.error("ERROR", err);
  }

  console.log(failures === 0 ? "\nALL VISIT-STATS TESTS PASSED\n" : `\n${failures} TEST(S) FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
