// Minimal analytics layer (P0 instrumentation).
//
// Why this exists: the marketing plan needs CAC, repeat rate, and funnel
// drop-off — none of which are measurable without client events.
// Design:
// - GA4 (gtag.js) and Meta Pixel are loaded ONLY when their IDs are set via
//   env vars, so local dev / pre-launch builds fire no third-party requests.
// - Every helper is a no-op (and never throws) when unconfigured, so call
//   sites stay unconditional.
// - A single `track(event, params)` fan-out keeps event names consistent.
//
// Env (frontend/.env):
//   REACT_APP_GA_MEASUREMENT_ID=G-XXXXXXXXXX   (Google Analytics 4)
//   REACT_APP_META_PIXEL_ID=1234567890        (Meta Pixel, optional)
const GA_ID = process.env.REACT_APP_GA_MEASUREMENT_ID;
const PIXEL_ID = process.env.REACT_APP_META_PIXEL_ID;

const hasGa = typeof GA_ID === "string" && /^G-[A-Z0-9]+$/i.test(GA_ID.trim());
const hasPixel = typeof PIXEL_ID === "string" && /^\d{5,}$/.test(PIXEL_ID.trim());

let gaLoaded = false;
let pixelLoaded = false;

// Load gtag.js once. Queues early events on window.dataLayer (gtag's own
// pattern) so events fired before the script arrives are not lost.
const ensureGa = () => {
  if (!hasGa || gaLoaded || typeof document === "undefined") return;
  gaLoaded = true;
  try {
    window.dataLayer = window.dataLayer || [];
    const gtag = (...args) => window.dataLayer.push(args);
    window.gtag = window.gtag || gtag;
    window.gtag("js", new Date());
    window.gtag("config", GA_ID.trim(), { send_page_view: false });
    const s = document.createElement("script");
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID.trim())}`;
    document.head.appendChild(s);
  } catch {
    // Analytics must never break the app.
  }
};

// Load Meta Pixel once (standard snippet, guarded).
const ensurePixel = () => {
  if (!hasPixel || pixelLoaded || typeof document === "undefined") return;
  pixelLoaded = true;
  try {
    /* eslint-disable */
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = !0;
      n.version = "2.0";
      n.queue = [];
      t = b.createElement(e);
      t.async = !0;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    /* eslint-enable */
    window.fbq("init", PIXEL_ID.trim());
  } catch {
    // Analytics must never break the app.
  }
};

/**
 * Canonical event names — import these instead of string literals so a
 * rename stays consistent across every call site.
 */
export const AnalyticsEvents = {
  PAGE_VIEW: "page_view",
  BOOKING_START: "booking_start",
  SLOT_SELECTED: "slot_selected",
  BOOKING_REQUESTED: "booking_requested",
  PAYMENT_SUCCESS: "payment_success",
  COOK_SIGNUP_START: "cook_signup_start",
  COOK_SIGNUP_COMPLETE: "cook_signup_complete",
  COUPON_APPLIED: "coupon_applied",
};

/**
 * Fire an analytics event to every configured provider. Safe to call when
 * nothing is configured (no-op). `params` must be a flat JSON-safe object.
 */
export const track = (event, params = {}) => {
  if (!event || typeof window === "undefined") return;
  try {
    ensureGa();
    ensurePixel();
    if (hasGa && typeof window.gtag === "function") {
      window.gtag("event", event, params);
    }
    if (hasPixel && typeof window.fbq === "function") {
      window.fbq("trackCustom", event, params);
    }
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.debug(`[analytics] ${event}`, params);
    }
  } catch {
    // Analytics must never break the app.
  }
};

/** True when at least one provider is configured (for conditional UI). */
export const isAnalyticsConfigured = () => hasGa || hasPixel;

// In-house visit counter (POST /api/stats/public/visit) — answers "how many
// users visit the website" without any third party. One ping per browser
// session (sessionStorage guard); the visitor id lives in localStorage so
// repeat visits count as one unique per day. The ping also carries the
// approximate city (IP-based, city-level only — raw IPs are never sent or
// stored). Fire-and-forget: failures are swallowed so tracking can never
// break the app.
const VISIT_SESSION_KEY = "cm-visit-sent";
const VISITOR_KEY = "cm-vid";
// Never hold the ping longer than this waiting for the city lookup.
const VISIT_CITY_TIMEOUT_MS = 2500;

const getVisitorId = () => {
  try {
    let vid = localStorage.getItem(VISITOR_KEY);
    if (!vid) {
      vid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(VISITOR_KEY, vid);
    }
    return vid;
  } catch {
    return null;
  }
};

export const trackSiteVisit = (path = "/") => {
  try {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem(VISIT_SESSION_KEY)) return;
    sessionStorage.setItem(VISIT_SESSION_KEY, "1");
    const vid = getVisitorId();
    if (!vid) return;
    const send = (loc) => {
      // Lazy import keeps analytics.js free of module cycles.
      import("../api/axios")
        .then(({ default: API }) =>
          API.post("/stats/public/visit", {
            vid,
            path,
            city: loc?.city || "",
            state: loc?.state || "",
            country: loc?.country || "",
          })
        )
        .catch(() => {
          // ignore — counting must never break browsing
        });
    };
    // Resolve the approximate city first, but never delay the ping past
    // the timeout — a slow lookup still counts the visit, just without a city.
    let settled = false;
    const done = (loc) => {
      if (settled) return;
      settled = true;
      send(loc);
    };
    const timer = setTimeout(() => done(null), VISIT_CITY_TIMEOUT_MS);
    import("./geolocation")
      .then(({ fetchIpLocation }) => fetchIpLocation())
      .then((loc) => {
        clearTimeout(timer);
        done(loc);
      })
      .catch(() => {
        clearTimeout(timer);
        done(null);
      });
  } catch {
    // ignore — counting must never break browsing
  }
};
