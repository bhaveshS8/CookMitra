// Pure helpers behind the in-house visit counter (models: DailyStat,
// DailyVisitor, VisitSession, PageStat, CityStat; routes in routes/stats.js).
// Kept dependency-free so visit-stats.test.js can assert them without MongoDB.
//
// Semantics (see also routes/stats.js):
// - A "visit" is one accepted ping per browser-tab session. The frontend
//   sends one ping per tab (sessionStorage gate) with a per-tab session id
//   (`sid`); the server counts a visit only for the first accepted
//   (day, vid, sid) triple and answers repeats idempotently.
// - "uniques" are unique visitor-DAYS: distinct `vid` values per IST day
//   (DailyVisitor). The same browser counts again on another day.

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// Calendar day in Asia/Kolkata as YYYY-MM-DD — the site's audience is
// Indian, so "today" means IST, not UTC.
const istDayString = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

// Full IST calendar-day range ending today: [today-(days-1) .. today].
// Used to zero-fill chart series so a quiet day renders as 0 instead of
// vanishing (which would misleadingly join its neighbours).
const istDayRange = (days) => {
  const n = Math.min(Math.max(Math.round(Number(days)) || 30, 1), 365);
  const out = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(istDayString(new Date(now - i * 86400000)));
  }
  return out;
};

// `days` query contract for GET /visits: integer days of history ending
// today (IST). Unparseable/missing values fall back to 30; out-of-range
// values clamp to [1, 365]. Never throws; objects/arrays can never become
// operators (Number({...}) is NaN → default).
const parseDaysParam = (value) => {
  if (value === undefined || value === null || value === "") return 30;
  const v = Math.round(Number(value));
  if (!Number.isFinite(v)) return 30;
  return Math.min(Math.max(v, 1), 365);
};

// Crawlers, monitors and headless probes must not inflate the numbers.
// UA-based only (bypassable by a determined attacker — this is hygiene, not
// a security boundary). Case-insensitive; normal browser UAs contain none
// of these tokens. Missing/empty UA is COUNTED: privacy browsers strip it
// and bots usually fake a real one, so rejecting it would lose real visits.
const BOT_PATTERN =
  /bot|crawl|spider|slurp|mediapartners|baidu|yandex|sogou|exabot|facebot|ia_archiver|ahrefs|semrush|mj12bot|dotbot|uptime|monitor|pingdom|headless|phantom|selenium|webdriver|puppeteer|playwright|lighthouse|pagespeed|curl|wget|python|go-http|okhttp|axios/i;

const isBot = (userAgent) => BOT_PATTERN.test(String(userAgent || ""));

// Segments that identify one specific record rather than a route shape
// (booking/cooking detail pages embed them). Replaced with ":id" so the
// top-pages list stays bounded by route shape instead of splintering one
// row per booking.
const DYNAMIC_SEGMENT_RE =
  /^(?:[0-9a-f]{24}|[0-9A-F]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,})$/;

// Validate + normalize the POST /visit body. Returns { vid, sid, path,
// city, state, country } or { error } — the route answers 400 on garbage
// instead of writing junk. Everything client-supplied is untrusted:
// - vid/sid must look like the anonymous ids the frontend mints
//   (8-64 [A-Za-z0-9_-]); all-identical-char values ("aaaa…") are cheap
//   bot output and are rejected. Objects/arrays coerce to strings that can
//   never match, so Mongo operator payloads ({$gt:""}) are rejected, not
//   stored.
// - path is normalized to a bounded route shape (query/hash stripped,
//   slashes collapsed, dynamic id segments folded, length capped). Never
//   400s on path alone — junk folds to "/" so the visit still counts.
// - city/state/country are optional approximate labels: non-strings become
//   "", control characters are stripped, whitespace collapsed, length
//   capped at 80, and anything outside letters/numbers/common punctuation
//   is dropped to "" (visit still counts, city row skipped).
const cleanPlace = (v) => {
  if (v == null) return "";
  if (typeof v !== "string") return "";
  let s = v.normalize ? v.normalize("NFKC") : v;
  s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!s) return "";
  // Letters (any script), numbers, marks + everyday punctuation. Emoji,
  // zero-width/format chars and symbols fall back to "unknown city".
  if (!/^[\p{L}\p{N}\p{M} .,'’()\-/&]+$/u.test(s)) return "";
  return s;
};

const normalizePath = (raw) => {
  if (typeof raw !== "string") return "/";
  let p = raw.trim().slice(0, 200);
  if (!p.startsWith("/")) return "/";
  // Store the route only — query strings and hashes would splinter the
  // top-pages list into thousands of distinct rows.
  p = p.split("?")[0].split("#")[0].trim() || "/";
  p = p.replace(/\/{2,}/g, "/");
  const segs = p
    .split("/")
    .filter(Boolean)
    .map((s) => (DYNAMIC_SEGMENT_RE.test(s) ? ":id" : s))
    .slice(0, 8);
  // Allow only safe path characters; anything exotic folds to "/".
  const joined = `/${segs.join("/")}`;
  if (!/^[A-Za-z0-9\-._~/: %]*$/.test(joined)) return "/";
  return (joined || "/").slice(0, 120);
};

const validId = (v) => {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!ID_RE.test(s)) return false;
  // All-identical chars ("aaaaaaaa", "--------") is generator output, never
  // the frontend's `${time36}-${random}` shape.
  if (/^(.)\1+$/.test(s)) return false;
  return true;
};

const normalizeVisitInput = (body = {}) => {
  const src = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const vid = typeof src.vid === "string" ? src.vid.trim() : "";
  if (!validId(vid)) {
    return { error: "A valid vid is required" };
  }
  const sid = typeof src.sid === "string" ? src.sid.trim() : "";
  if (!validId(sid)) {
    return { error: "A valid sid is required" };
  }
  return {
    vid,
    sid,
    path: normalizePath(src.path),
    city: cleanPlace(src.city),
    state: cleanPlace(src.state),
    country: cleanPlace(src.country),
  };
};

module.exports = { istDayString, istDayRange, parseDaysParam, isBot, normalizeVisitInput, normalizePath };
