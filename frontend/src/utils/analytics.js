// Env: REACT_APP_GA_MEASUREMENT_ID (GA4), REACT_APP_META_PIXEL_ID.
const GA_ID = process.env.REACT_APP_GA_MEASUREMENT_ID;
const PIXEL_ID = process.env.REACT_APP_META_PIXEL_ID;

const hasGa = typeof GA_ID === "string" && /^G-[A-Z0-9]+$/i.test(GA_ID.trim());
const hasPixel = typeof PIXEL_ID === "string" && /^\d{5,}$/.test(PIXEL_ID.trim());

let gaLoaded = false;
let pixelLoaded = false;

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
  }
};

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
  }
};

export const AnalyticsEvents = {
  PAGE_VIEW: "page_view",
  BOOKING_START: "booking_start",
  SLOT_SELECTED: "slot_selected",
  BOOKING_REQUESTED: "booking_requested",
  PAYMENT_SUCCESS: "payment_success",
  BOOKING_RESCHEDULED: "booking_rescheduled",
  COOK_SIGNUP_START: "cook_signup_start",
  COOK_SIGNUP_COMPLETE: "cook_signup_complete",
  COUPON_APPLIED: "coupon_applied",
};

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
  }
};

export const isAnalyticsConfigured = () => hasGa || hasPixel;

const VISIT_SESSION_KEY = "cm-visit-sent";
const VISIT_SID_KEY = "cm-visit-sid";
const VISITOR_KEY = "cm-vid";
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

const getVisitSid = () => {
  try {
    let sid = sessionStorage.getItem(VISIT_SID_KEY);
    if (!sid) {
      sid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
      sessionStorage.setItem(VISIT_SID_KEY, sid);
    }
    return sid;
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
    const sid = getVisitSid();
    if (!sid) return;
    const send = (loc) => {
      import("../api/axios")
        .then(({ default: API }) =>
          API.post("/stats/public/visit", {
            vid,
            sid,
            path,
            city: loc?.city || "",
            area: loc?.area || "",
            state: loc?.state || "",
            country: loc?.country || "",
          })
        )
        .catch(() => {
        });
    };
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
  }
};
