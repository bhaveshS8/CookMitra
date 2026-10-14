process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.NODE_ENV = process.env.NODE_ENV || "test";

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const {
  istDayString,
  istDayRange,
  parseDaysParam,
  isBot,
  normalizeVisitInput,
  normalizePath,
} = require("./utils/visits");

let failures = 0, passes = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  ok ? passes++ : failures++;
};
const VID = "Abc123XY-_9";
const SID = "sess01-_AB";

const testHelpers = () => {
  console.log("\n═══ VISIT HELPERS ═══");
  const today = istDayString();
  check("istDayString returns YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(today), today);
  check("istDayString uses IST, not UTC", istDayString(new Date("2026-09-17T19:00:00.000Z")) === "2026-09-18");
  check("IST boundary 18:29:59Z -> Sep 30", istDayString(new Date("2026-09-30T18:29:59.000Z")) === "2026-09-30");
  check("IST boundary 18:30:00Z -> Oct 1", istDayString(new Date("2026-09-30T18:30:00.000Z")) === "2026-10-01");
  check("IST year boundary", istDayString(new Date("2025-12-31T18:30:00.000Z")) === "2026-01-01");

  const realNow = Date.now;
  Date.now = () => new Date("2026-09-30T19:00:00.000Z").getTime(); // Oct 1 00:30 IST
  check("istDayRange month boundary", JSON.stringify(istDayRange(3)) === JSON.stringify(["2026-09-29", "2026-09-30", "2026-10-01"]), istDayRange(3).join(","));
  Date.now = () => new Date("2026-01-01T01:00:00.000Z").getTime(); // Jan 1 06:30 IST
  check("istDayRange year boundary", JSON.stringify(istDayRange(2)) === JSON.stringify(["2025-12-31", "2026-01-01"]));
  Date.now = () => new Date("2024-03-01T01:00:00.000Z").getTime(); // Mar 1 06:30 IST (leap year)
  check("istDayRange leap day", JSON.stringify(istDayRange(2)) === JSON.stringify(["2024-02-29", "2024-03-01"]));
  Date.now = () => new Date("2026-09-29T05:00:00.000Z").getTime();
  check("istDayRange empty -> 30 days ending today", istDayRange().length === 30 && istDayRange()[29] === istDayString(new Date(Date.now())));
  check("istDayRange clamps huge", istDayRange(999999).length === 365);
  check("istDayRange clamps zero", istDayRange(0).length === 30);
  Date.now = realNow;

  check("days default", parseDaysParam(undefined) === 30 && parseDaysParam("") === 30 && parseDaysParam("abc") === 30);
  check("days valid", parseDaysParam("7") === 7 && parseDaysParam(90) === 90);
  check("days clamps", parseDaysParam(0) === 1 && parseDaysParam(-5) === 1 && parseDaysParam(999999) === 365 && parseDaysParam("1") === 1);
  check("days object injection -> default", parseDaysParam({ $gt: "" }) === 30 && parseDaysParam(["7"]) === 7);

  check("bot UA ignored", isBot("Mozilla/5.0 (compatible; Googlebot/2.1)") === true);
  check("crawler UA ignored", isBot("ahrefsbot/7.0") === true);
  check("spider UA ignored", isBot("SomeSpider/1.0") === true);
  check("headless UA ignored", isBot("HeadlessChrome/120") === true);
  check("monitor UA ignored", isBot("Pingdom/1.0") === true);
  check("selenium ignored", isBot("selenium-webdriver") === true);
  check("puppeteer ignored", isBot("puppeteer") === true);
  check("curl ignored", isBot("curl/8.0") === true);
  check("python ignored", isBot("python-requests/2.31") === true);
  check("BOT case-insensitive", isBot("GOOGLEBOT") === true);
  check("real Chrome counted", isBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36") === false);
  check("real Safari counted", isBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1") === false);
  check("missing UA counted (not a bot)", isBot(undefined) === false && isBot("") === false);

  check("valid input passes", (() => { const g = normalizeVisitInput({ vid: VID, sid: SID, path: "/cook-on-demand" }); return g.vid === VID && g.sid === SID && g.path === "/cook-on-demand"; })());
  check("missing vid rejected", normalizeVisitInput({ sid: SID, path: "/" }).error !== undefined);
  check("missing sid rejected", normalizeVisitInput({ vid: VID, path: "/" }).error !== undefined);
  check("short vid rejected", normalizeVisitInput({ vid: "abc", sid: SID }).error !== undefined);
  check("oversized vid rejected", normalizeVisitInput({ vid: "x".repeat(65), sid: SID }).error !== undefined);
  check("vid with spaces rejected", normalizeVisitInput({ vid: "ab cd 1234", sid: SID }).error !== undefined);
  check("all-identical vid rejected", normalizeVisitInput({ vid: "aaaaaaaa", sid: SID }).error !== undefined);
  check("object vid rejected (operator injection)", normalizeVisitInput({ vid: { $gt: "" }, sid: SID }).error !== undefined);
  check("object sid rejected", normalizeVisitInput({ vid: VID, sid: { $ne: null } }).error !== undefined);
  check("non-object body rejected", normalizeVisitInput("abc").error !== undefined && normalizeVisitInput(null).error !== undefined);

  check("query string stripped", normalizeVisitInput({ vid: VID, sid: SID, path: "/?a=1" }).path === "/");
  check("hash stripped", normalizeVisitInput({ vid: VID, sid: SID, path: "/#offers" }).path === "/");
  check("non-slash path defaults to /", normalizeVisitInput({ vid: VID, sid: SID, path: "https://evil.com" }).path === "/");
  check("object path folds to /", normalizeVisitInput({ vid: VID, sid: SID, path: { $gt: "" } }).path === "/");
  check("repeated slashes collapsed", normalizePath("//cook//on-demand/") === "/cook/on-demand");
  check("mongo id segment folded", normalizePath("/bookings/68c9a1b2c3d4e5f60718293a") === "/bookings/:id");
  check("uuid segment folded", normalizePath("/x/123e4567-e89b-12d3-a456-426614174000") === "/x/:id");
  check("long digit segment folded", normalizePath("/order/123456") === "/order/:id");
  check("short legit segments kept", normalizePath("/dashboard/my-bookings") === "/dashboard/my-bookings");
  check("control chars fold to /", normalizePath("/a\u0000b") === "/");
  check("overlong path capped", normalizePath(`/${"a".repeat(500)}`).length <= 120);
  check("path flood shapes bounded", (() => {
    const shapes = new Set([0, 1, 2].map((i) => normalizePath(`/bookings/68c9a1b2c3d4e5f6071829${i}a`)));
    return shapes.size === 1 && shapes.has("/bookings/:id");
  })());

  const withCity = normalizeVisitInput({ vid: VID, sid: SID, path: "/", city: "Pune", state: "Maharashtra", country: "India" });
  check("city/state/country pass through", withCity.city === "Pune" && withCity.state === "Maharashtra" && withCity.country === "India");
  const noCity = normalizeVisitInput({ vid: VID, sid: SID, path: "/" });
  check("missing city defaults to empty (visit still counts)", noCity.city === "" && !noCity.error);
  check("overlong city truncated to 80", normalizeVisitInput({ vid: VID, sid: SID, path: "/", city: "X".repeat(200) }).city.length === 80);
  check("control chars stripped", normalizeVisitInput({ vid: VID, sid: SID, path: "/", city: "Pu\u0000ne\n" }).city === "Pune");
  check("whitespace collapsed", normalizeVisitInput({ vid: VID, sid: SID, path: "/", city: "  New   Delhi  " }).city === "New Delhi");
  check("emoji city dropped to empty", normalizeVisitInput({ vid: VID, sid: SID, path: "/", city: "🔥Pune" }).city === "");
  check("object city dropped to empty", normalizeVisitInput({ vid: VID, sid: SID, path: "/", city: { $gt: "" } }).city === "");
  check("unicode letters kept", normalizeVisitInput({ vid: VID, sid: SID, path: "/", city: "Pune" }).city === "Pune");
};

const tick = () => new Promise((r) => setImmediate(r));
const dupKeyErr = () => { const e = new Error("E11000 duplicate key"); e.code = 11000; return e; };

const fakeCollection = (keyOf) => {
  const docs = new Map();
  const api = {
    docs,
    failures: new Set(), // op names to fail, e.g. "updateOne:CityStat"
    tag: "",
    async updateOne(filter, update = {}, opts = {}) {
      if (api.failures.has("updateOne")) { const e = new Error("db down"); throw e; }
      const key = keyOf(filter);
      const absentAtCheck = !docs.has(key);
      await tick(); // force race interleavings
      if (docs.has(key)) {
        if (absentAtCheck) throw dupKeyErr(); // lost the insert race
        const doc = docs.get(key);
        if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
        if (update.$set) Object.assign(doc, update.$set);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (opts.upsert) {
        const doc = { ...filter };
        if (update.$setOnInsert) Object.assign(doc, update.$setOnInsert);
        if (update.$set) Object.assign(doc, update.$set);
        if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = v;
        docs.set(key, doc);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: key };
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },
  };
  return api;
};

const matchDoc = (row, cond) =>
  Object.entries(cond).every(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.entries(v).every(([op, ov]) => (op === "$gte" ? row[k] >= ov : op === "$lt" ? row[k] < ov : op === "$ne" ? row[k] !== ov : false));
    }
    return row[k] === v;
  });

const getPath = (row, expr) => {
  const parts = String(expr).slice(1).split(".");
  let v = row;
  for (const p of parts) v = v?.[p];
  return v;
};

const runPipeline = (allDocs, pipeline) => {
  let rows = allDocs.map((d) => ({ ...d }));
  for (const stage of pipeline) {
    if (stage.$match) rows = rows.filter((r) => matchDoc(r, stage.$match));
    else if (stage.$group) {
      const groups = new Map();
      for (const r of rows) {
        const gid = stage.$group._id === null ? null
          : typeof stage.$group._id === "string" ? getPath(r, stage.$group._id)
          : Object.fromEntries(Object.entries(stage.$group._id).map(([k, v]) => [k, getPath(r, v)]));
        const gk = JSON.stringify(gid);
        if (!groups.has(gk)) {
          const init = { _id: gid };
          for (const [k, v] of Object.entries(stage.$group)) {
            if (k !== "_id" && v.$sum !== undefined) init[k] = 0;
          }
          groups.set(gk, init);
        }
        const g = groups.get(gk);
        for (const [k, v] of Object.entries(stage.$group)) {
          if (k === "_id") continue;
          g[k] += typeof v.$sum === "number" ? v.$sum : Number(getPath(r, v.$sum)) || 0;
        }
      }
      rows = [...groups.values()];
    } else if (stage.$sort) {
      const entries = Object.entries(stage.$sort);
      rows.sort((a, b) => { for (const [k, d] of entries) { if (a[k] !== b[k]) return (a[k] < b[k] ? -1 : 1) * d; } return 0; });
    } else if (stage.$limit) rows = rows.slice(0, stage.$limit);
    else if (stage.$project) {
      rows = rows.map((r) => {
        const o = {};
        for (const [k, v] of Object.entries(stage.$project)) {
          if (k === "_id" && v === 0) continue;
          else if (v === 1) { if (r[k] !== undefined) o[k] = r[k]; }
          else if (typeof v === "string" && v.startsWith("$")) o[k] = getPath(r, v);
        }
        if (stage.$project._id !== 0 && r._id !== undefined) o._id = r._id;
        return o;
      });
    }
  }
  return rows;
};

let fakes = null;
const installFakes = () => {
  const DailyStat = require("./models/DailyStat");
  const DailyVisitor = require("./models/DailyVisitor");
  const VisitSession = require("./models/VisitSession");
  const PageStat = require("./models/PageStat");
  const CityStat = require("./models/CityStat");
  const keyDay = (f) => `${f.day}`;
  const keyDayVid = (f) => `${f.day}|${f.vid}`;
  const keyDayVidSid = (f) => `${f.day}|${f.vid}|${f.sid}`;
  const keyDayPath = (f) => `${f.day}|${f.path}`;
  const keyDayCity = (f) => `${f.day}|${f.city}|${f.state}`;
  fakes = {
    DailyStat: fakeCollection(keyDay),
    DailyVisitor: fakeCollection(keyDayVid),
    VisitSession: fakeCollection(keyDayVidSid),
    PageStat: fakeCollection(keyDayPath),
    CityStat: fakeCollection(keyDayCity),
  };
  DailyStat.updateOne = (...a) => fakes.DailyStat.updateOne(...a);
  DailyVisitor.updateOne = (...a) => fakes.DailyVisitor.updateOne(...a);
  VisitSession.updateOne = (...a) => fakes.VisitSession.updateOne(...a);
  PageStat.updateOne = (...a) => fakes.PageStat.updateOne(...a);
  CityStat.updateOne = (...a) => fakes.CityStat.updateOne(...a);
  DailyStat.find = (filter = {}) => {
    const rows = [...fakes.DailyStat.docs.values()].filter((r) => matchDoc(r, filter));
    return { sort: () => ({ select: () => ({ lean: async () => rows.sort((a, b) => (a.day < b.day ? -1 : 1)) }) }) };
  };
  DailyStat.aggregate = async (p) => runPipeline([...fakes.DailyStat.docs.values()], p);
  PageStat.aggregate = async (p) => runPipeline([...fakes.PageStat.docs.values()], p);
  CityStat.aggregate = async (p) => runPipeline([...fakes.CityStat.docs.values()], p);
};

const statsRouter = () => require("./routes/stats");
const postVisit = (body, ua) => new Promise((resolve, reject) => {
  const layer = statsRouter().stack.find((l) => l.route && l.route.path === "/visit" && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { body, get: (h) => (String(h).toLowerCase() === "user-agent" ? ua || "" : "") };
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; resolve(res); return res; };
  Promise.resolve(handler(req, res, (e) => (e ? reject(e) : resolve(res)))).catch(reject);
});
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const testRoutes = async () => {
  console.log("\n═══ VISIT ROUTES (real handlers, fake DB) ═══");
  installFakes();

  let r = await postVisit({ vid: VID, sid: SID, path: "/cook-on-demand", city: "Pune", state: "Maharashtra", country: "India" }, UA);
  check("first ping 200 ok", r.statusCode === 200 && r.body?.ok === true && !r.body?.deduped, `s=${r.statusCode}`);
  check("DailyStat visits=1 uniques=1", fakes.DailyStat.docs.size === 1 && [...fakes.DailyStat.docs.values()][0].visits === 1);
  check("DailyVisitor row created", fakes.DailyVisitor.docs.size === 1);
  check("VisitSession row created", fakes.VisitSession.docs.size === 1);
  check("PageStat row created", fakes.PageStat.docs.size === 1);
  check("CityStat row created", fakes.CityStat.docs.size === 1);

  r = await postVisit({ vid: VID, sid: SID, path: "/cook-on-demand", city: "Pune", state: "Maharashtra", country: "India" }, UA);
  const d0 = [...fakes.DailyStat.docs.values()][0];
  check("replay deduped (no recount)", r.statusCode === 200 && r.body?.deduped === true && d0.visits === 1 && d0.uniques === 1, JSON.stringify(r.body));

  r = await postVisit({ vid: VID, sid: "sess02-xxxx", path: "/", city: "Pune", state: "Maharashtra", country: "India" }, UA);
  check("new session counts visit, keeps unique", r.body?.ok === true && !r.body?.deduped && d0.visits === 2 && d0.uniques === 1, `v=${d0.visits} u=${d0.uniques}`);

  r = await postVisit({ vid: "NewGuy99-_1", sid: "sess09-zzzz", path: "/", city: "", state: "", country: "" }, UA);
  check("new visitor counts visit+unique", d0.visits === 3 && d0.uniques === 2, `v=${d0.visits} u=${d0.uniques}`);
  check("no city row for empty city", fakes.CityStat.docs.size === 1);

  const before = { v: d0.visits, u: d0.uniques, s: fakes.VisitSession.docs.size };
  const results = await Promise.all(
    Array.from({ length: 10 }, () => postVisit({ vid: "Racer01-_x", sid: "race-sid-01", path: "/", city: "Pune", state: "", country: "" }, UA))
  );
  const counted = results.filter((x) => x.body?.ok && !x.body?.deduped).length;
  check("10 concurrent duplicates -> 1 counted", counted === 1 && d0.visits === before.v + 1, `counted=${counted} visits=${d0.visits}`);
  check("concurrent uniques correct", d0.uniques === before.u + 1, `uniques=${d0.uniques}`);

  const v2 = d0.visits;
  await Promise.all(Array.from({ length: 5 }, (_, i) => postVisit({ vid: `Conc${i}ab-_q`, sid: `csess${i}ab-_q`, path: "/" }, UA)));
  check("5 concurrent distinct sessions all count", d0.visits === v2 + 5, `visits=${d0.visits}`);

  const sizes = () => fakes.VisitSession.docs.size + fakes.DailyVisitor.docs.size;
  const s0 = sizes();
  for (const [name, body, code] of [
    ["missing sid 400", { vid: VID, path: "/" }, 400],
    ["missing vid 400", { sid: SID, path: "/" }, 400],
    ["oversized vid 400", { vid: "x".repeat(65), sid: SID }, 400],
    ["object vid 400", { vid: { $gt: "" }, sid: SID }, 400],
    ["bot ignored (not counted)", { vid: "BotVid01-_z", sid: "botsess01-_", path: "/" }, 200],
  ]) {
    r = await postVisit(body, name.startsWith("bot") ? "Googlebot/2.1" : UA);
    check(name, r.statusCode === code, `s=${r.statusCode}`);
  }
  check("rejections wrote nothing", sizes() === s0);
  check("bot wrote nothing", ![...fakes.VisitSession.docs.keys()].some((k) => k.includes("BotVid")));

  await postVisit({ vid: "PathAb1-_aa", sid: "ps1ab-_aa1", path: "/a" }, UA);
  await postVisit({ vid: "PathAb2-_aa", sid: "ps2ab-_aa2", path: "/b" }, UA);
  await postVisit({ vid: "PathAb3-_aa", sid: "ps3ab-_aa3", path: "/bookings/68c9a1b2c3d4e5f60718293a" }, UA);
  await postVisit({ vid: "PathAb4-_aa", sid: "ps4ab-_aa4", path: "/bookings/68c9a1b2c3d4e5f60718293b" }, UA);
  const paths = [...fakes.PageStat.docs.values()].map((d) => d.path);
  check("arbitrary paths stored (bounded rows)", paths.includes("/a") && paths.includes("/b"));
  check("booking ids fold to one :id row", paths.filter((p) => p === "/bookings/:id").length === 1, paths.join(","));

  const v3 = d0.visits;
  r = await postVisit({ vid: "CityAb1-_aa", sid: "cs1ab-_aa1", path: "/", city: "FakeCity<script>", state: "X".repeat(200), country: "Nowhere" }, UA);
  check("malicious city still counts visit", r.body?.ok === true && d0.visits === v3 + 1);
  const cities = [...fakes.CityStat.docs.values()].map((d) => d.city);
  check("no script/control payload stored", !cities.some((c) => /[<>]/.test(c)), cities.join("|"));
  check("overlong state capped at 80", [...fakes.CityStat.docs.values()].every((d) => d.state.length <= 80));

  fakes.CityStat.failures.add("updateOne");
  r = await postVisit({ vid: "Fail01-_aa1", sid: "fs1ab-_aa11", path: "/", city: "Pune", state: "", country: "" }, UA).catch((e) => ({ statusCode: 500, body: { message: e.message } }));
  check("city-write failure surfaces 500", r.statusCode === 500, `s=${r.statusCode}`);
  check("error body has message, no stack", r.body && typeof r.body.message === "string" && !r.body.stack, JSON.stringify(r.body).slice(0, 80));
  fakes.CityStat.failures.clear();

  const realDSUpdate = require("./models/DailyStat").updateOne;
  let calls = 0;
  require("./models/DailyStat").updateOne = async (...a) => {
    calls++;
    if (calls === 1) return fakes.DailyStat.updateOne(...a); // visits++
    throw new Error("uniques increment down");
  };
  r = await postVisit({ vid: "Fail02-_aa2", sid: "fs2ab-_aa22", path: "/" }, UA).catch((e) => ({ statusCode: 500, body: { message: e.message } }));
  check("uniques-increment failure surfaces 500", r.statusCode === 500, `s=${r.statusCode}`);
  require("./models/DailyStat").updateOne = (...a) => fakes.DailyStat.updateOne(...a);

  const day = [...fakes.DailyStat.docs.values()][0];
  check("INVARIANT uniques <= visits", day.uniques <= day.visits, `${day.uniques}<=${day.visits}`);
  check("INVARIANT one DailyVisitor per (day,vid)", new Set([...fakes.DailyVisitor.docs.keys()]).size === fakes.DailyVisitor.docs.size);
  check("INVARIANT visits >= 0, uniques >= 0", day.visits >= 0 && day.uniques >= 0);
};

const getVisits = (query = {}, user) => new Promise((resolve, reject) => {
  const layer = statsRouter().stack.find((l) => l.route && l.route.path === "/visits" && l.route.methods.get);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { query, user };
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; resolve(res); return res; };
  Promise.resolve(handler(req, res, (e) => (e ? reject(e) : resolve(res)))).catch(reject);
});

const testGetAndAuth = async () => {
  console.log("\n═══ GET /visits + AUTH ═══");
  const range = istDayRange(7);
  const d1 = range[1], d2 = range[4];
  fakes.DailyStat.docs.set(d1, { day: d1, visits: 5, uniques: 4 });
  fakes.DailyStat.docs.set(d2, { day: d2, visits: 7, uniques: 5 });
  fakes.PageStat.docs.set(`${d1}|/`, { day: d1, path: "/", visits: 5 });
  fakes.PageStat.docs.set(`${d2}|/cook-on-demand`, { day: d2, path: "/cook-on-demand", visits: 7 });
  fakes.CityStat.docs.set(`${d1}|Pune|Maharashtra`, { day: d1, city: "Pune", state: "Maharashtra", country: "India", visits: 5 });

  const r = await getVisits({ days: "7" }, { id: "a", role: "admin" });
  check("admin GET 200", r.statusCode === 200, `s=${r.statusCode}`);
  check("zero-filled: 7 rows for 7 days", r.body.days.length === 7, `n=${r.body.days.length}`);
  check("zero-filled: continuous keys", r.body.days.map((x) => x.month || x.day).join(",") === range.join(","));
  const gap = r.body.days.find((x) => x.day === range[0]);
  check("empty day renders 0/0", gap && gap.visits === 0 && gap.uniques === 0, JSON.stringify(gap));
  const tot = r.body.totals;
  const sumV = r.body.days.reduce((a, x) => a + x.visits, 0);
  const sumU = r.body.days.reduce((a, x) => a + x.uniques, 0);
  check("INVARIANT totals.visits == sum(days)", tot.visits === sumV, `${tot.visits}==${sumV}`);
  check("INVARIANT totals.uniques == sum(days)", tot.uniques === sumU, `${tot.uniques}==${sumU}`);
  const topSum = (r.body.topPaths || []).reduce((a, x) => a + x.visits, 0);
  check("INVARIANT top pages <= total visits", topSum <= tot.visits, `${topSum}<=${tot.visits}`);
  const citySum = (r.body.topCities || []).reduce((a, x) => a + x.visits, 0);
  check("INVARIANT top cities <= total visits", citySum <= tot.visits, `${citySum}<=${tot.visits}`);
  check("meta documents IST + uniques definition", r.body.meta?.timezone === "Asia/Kolkata" && /visitor-day/.test(r.body.meta?.uniquesDefinition || ""));

  fakes.DailyStat.docs.clear(); fakes.PageStat.docs.clear(); fakes.CityStat.docs.clear();
  const e = await getVisits({ days: "7" }, { id: "a", role: "admin" });
  check("empty range: 7 zero rows, totals 0", e.body.days.length === 7 && e.body.totals.visits === 0 && e.body.totals.uniques === 0);

  const bad = await getVisits({ days: "abc" }, { id: "a", role: "admin" });
  check("days=abc -> default 30 rows", bad.body.days.length === 30, `n=${bad.body.days.length}`);
  const big = await getVisits({ days: "999999" }, { id: "a", role: "admin" });
  check("days huge -> clamped 365", big.body.days.length === 365, `n=${big.body.days.length}`);

  const { auth, authorize } = require("./middleware/auth");
  const User = require("./models/User");
  const runAuth = (headers, account) => new Promise((resolve) => {
    User.findById = () => ({ select: () => ({ lean: async () => account }) });
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = v;
    const req = { headers: h, cookies: {}, method: "GET", header: (n) => h[String(n).toLowerCase()] || "" };
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (p) => { res.body = p; resolve(res); return res; };
    auth(req, res, () => resolve({ statusCode: 200, next: true, req }));
  });
  const adminToken = jwt.sign({ id: "a1" }, process.env.JWT_SECRET);
  const bearer = (t) => ({ authorization: `Bearer ${t}` });
  let a = await runAuth({}, { _id: "a1", role: "admin", status: "active", tokenVersion: 0 });
  check("anon blocked by auth", a.statusCode === 401, `s=${a.statusCode}`);
  const runAuthorize = (role) => new Promise((resolve) => {
    const req = { user: role ? { id: "x", role } : undefined };
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (p) => { res.body = p; resolve(res); return res; };
    authorize("admin")(req, res, () => resolve({ statusCode: 200, next: true }));
  });
  a = await runAuthorize("customer");
  check("customer GET forbidden", a.statusCode === 403, `s=${a.statusCode}`);
  a = await runAuthorize("cook");
  check("cook GET forbidden", a.statusCode === 403, `s=${a.statusCode}`);
  a = await runAuthorize("admin");
  check("admin GET allowed", a.next === true);
  const layer = statsRouter().stack.find((l) => l.route && l.route.path === "/visits" && l.route.methods.get);
  check("GET /visits has auth+authorize+handler", layer.route.stack.length === 3, `${layer.route.stack.length} layers`);
  const postLayer = statsRouter().stack.find((l) => l.route && l.route.path === "/visit" && l.route.methods.post);
  check("POST /visit stays public (single handler)", postLayer.route.stack.length === 1, `${postLayer.route.stack.length} layers`);

  const idx = (m) => m.schema.indexes().map((x) => JSON.stringify([x[0], x[1]]));
  const dv = idx(require("./models/DailyVisitor")).join(" ");
  check("DailyVisitor (day,vid) unique", /"day":1.*"vid":1.*"unique":true/.test(dv), dv);
  check("DailyVisitor TTL ~400d", /expireAfterSeconds":34560000/.test(dv), dv);
  const vs = idx(require("./models/VisitSession")).join(" ");
  check("VisitSession (day,vid,sid) unique", /"sid":1.*"unique":true/.test(vs), vs);
  check("VisitSession TTL 3d", /expireAfterSeconds":259200/.test(vs), vs);
  const ps = idx(require("./models/PageStat")).join(" ");
  check("PageStat (day,path) unique", /"path":1.*"unique":true/.test(ps));
  const cs = idx(require("./models/CityStat")).join(" ");
  check("CityStat (day,city,state) unique", /"state":1.*"unique":true/.test(cs));
  const ds = idx(require("./models/DailyStat")).join(" ");
  check("DailyStat day unique", /"day":1.*"unique":true/.test(ds));
};

const testFrontendStatics = () => {
  console.log("\n═══ FRONTEND STATICS ═══");
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", "frontend", "src", p), "utf8");
  const vs = read("components/VisitStats.jsx");
  const vc = read("components/VisitChart.jsx");
  const uf = read("hooks/useFetch.js");
  const an = read("utils/analytics.js");
  check("no dangerouslySetInnerHTML in visit rendering", !/dangerouslySetInnerHTML/.test(vs + vc));
  check("ping sends sid (server dedup key)", /sid/.test(an) && /cm-visit-sid/.test(an));
  check("unique metric labelled visitor-days", /Unique visitor-day/.test(vs));
  check("cities described as approximate", /approximate/i.test(vs));
  check("useFetch cancels stale requests", /AbortController/.test(uf) && /signal/.test(uf));
  check("useFetch guards stale responses", /seqRef|seq/.test(uf));
  const legal = read("pages/Legal.jsx");
  check("privacy discloses anonymous browser id (localStorage)", /localStorage/.test(legal) && /anonymous/.test(legal));
  check("privacy discloses IP-approx city, no raw IP stored", /never.*stored on our servers|Raw IP/i.test(legal));
};

(async () => {
  try {
    testHelpers();
    await testRoutes();
    await testGetAndAuth();
    testFrontendStatics();
  } catch (err) {
    failures++;
    console.error("ERROR", err);
  }
  console.log(failures === 0 ? `\nALL VISIT-STATS TESTS PASSED (${passes} checks)\n` : `\n${failures} TEST(S) FAILED (${passes} passed)\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
