// Pure helpers behind the in-house visit counter (models: DailyStat,
// DailyVisitor, PageStat; routes in routes/stats.js). Kept dependency-free
// so visit-stats.test.js can assert them without MongoDB.

// Calendar day in Asia/Kolkata as YYYY-MM-DD — the site's audience is
// Indian, so "today" means IST, not UTC.
const istDayString = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

// Crawlers, monitors and headless probes must not inflate the numbers.
const BOT_PATTERN =
  /bot|crawl|spider|slurp|mediapartners|baidu|yandex|sogou|exabot|facebot|ia_archiver|ahrefs|semrush|mj12bot|dotbot|uptime|monitor|pingdom|headless/i;

const isBot = (userAgent) => BOT_PATTERN.test(String(userAgent || ""));

// Validate + normalize the POST /visit body. Returns { vid, path, city,
// state, country } or { error } — the route answers 400 on garbage instead
// of writing junk. Location is approximate city-level only (resolved by the
// browser from its network IP); raw IPs are never accepted or stored.
const cleanPlace = (v) => String(v || "").trim().slice(0, 80);

const normalizeVisitInput = (body = {}) => {
  const vid = String(body.vid || "").trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(vid)) {
    return { error: "A valid vid is required" };
  }
  let path = String(body.path || "/").slice(0, 200);
  if (!path.startsWith("/")) path = "/";
  // Store the route only — query strings and hashes would splinter the
  // top-pages list into thousands of distinct rows.
  path = path.split("?")[0].split("#")[0].trim() || "/";
  return { vid, path, city: cleanPlace(body.city), state: cleanPlace(body.state), country: cleanPlace(body.country) };
};

module.exports = { istDayString, isBot, normalizeVisitInput };
