
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const istDayString = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const istDayRange = (days) => {
  const n = Math.min(Math.max(Math.round(Number(days)) || 30, 1), 365);
  const out = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(istDayString(new Date(now - i * 86400000)));
  }
  return out;
};

const parseDaysParam = (value) => {
  if (value === undefined || value === null || value === "") return 30;
  const v = Math.round(Number(value));
  if (!Number.isFinite(v)) return 30;
  return Math.min(Math.max(v, 1), 365);
};

// a security boundary). Case-insensitive; normal browser UAs contain none
const BOT_PATTERN =
  /bot|crawl|spider|slurp|mediapartners|baidu|yandex|sogou|exabot|facebot|ia_archiver|ahrefs|semrush|mj12bot|dotbot|uptime|monitor|pingdom|headless|phantom|selenium|webdriver|puppeteer|playwright|lighthouse|pagespeed|curl|wget|python|go-http|okhttp|axios/i;

const isBot = (userAgent) => BOT_PATTERN.test(String(userAgent || ""));

const DYNAMIC_SEGMENT_RE =
  /^(?:[0-9a-f]{24}|[0-9A-F]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,})$/;

const cleanPlace = (v) => {
  if (v == null) return "";
  if (typeof v !== "string") return "";
  let s = v.normalize ? v.normalize("NFKC") : v;
  s = s.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!s) return "";
  if (!/^[\p{L}\p{N}\p{M} .,'’()\-/&]+$/u.test(s)) return "";
  return s;
};

const normalizePath = (raw) => {
  if (typeof raw !== "string") return "/";
  let p = raw.trim().slice(0, 200);
  if (!p.startsWith("/")) return "/";
  p = p.split("?")[0].split("#")[0].trim() || "/";
  p = p.replace(/\/{2,}/g, "/");
  const segs = p
    .split("/")
    .filter(Boolean)
    .map((s) => (DYNAMIC_SEGMENT_RE.test(s) ? ":id" : s))
    .slice(0, 8);
  const joined = `/${segs.join("/")}`;
  if (!/^[A-Za-z0-9\-._~/: %]*$/.test(joined)) return "/";
  return (joined || "/").slice(0, 120);
};

const validId = (v) => {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!ID_RE.test(s)) return false;
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
