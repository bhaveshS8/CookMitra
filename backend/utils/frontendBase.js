// Single source of truth for the public frontend origin used in
// emailed reset links + WhatsApp booking/review links.
//
// Honors (in order): FRONTEND_BASE_URL, FRONTEND_URL, CLIENT_URL.
// - Trims whitespace, strips trailing slash, takes first entry of comma lists.
// - Ignores stale localhost values when a real (non-localhost) value exists.
//   This is the exact live bug: CLIENT_URL=http://localhost:3000 left over from
//   dev shadows a correct FRONTEND_BASE_URL, so emails still point at localhost.
const isLocalhost = (v) => /localhost|127\.0\.0\.1|::1/i.test(String(v || ""));

const clean = (v) => {
  let s = String(v || "").trim();
  if (!s) return "";
  // CLIENT_URL may be a comma-separated CORS list — first entry is the app origin.
  if (s.includes(",")) s = s.split(",")[0].trim();
  return s.replace(/\/$/, "");
};

const PRODUCTION_BASE_URL = "https://cookmitra.org";

function resolveFrontendBaseUrl(env = process.env) {
  const candidates = [env.FRONTEND_BASE_URL, env.FRONTEND_URL, env.CLIENT_URL]
    .map(clean)
    .filter(Boolean);
  // In production a reset/booking link must never point at localhost. If the
  // deployment forgot to set FRONTEND_BASE_URL (or only left a stale dev
  // CLIENT_URL), fall back to the canonical public web origin instead of
  // refusing to send the email.
  if (env.NODE_ENV === "production") {
    return candidates.find((c) => !isLocalhost(c)) || PRODUCTION_BASE_URL;
  }
  if (candidates.length === 0) return "";
  // Prefer the first real domain; only fall back to localhost when nothing else exists.
  return candidates.find((c) => !isLocalhost(c)) || candidates[0];
}

module.exports = { resolveFrontendBaseUrl, isLocalhost, PRODUCTION_BASE_URL };
