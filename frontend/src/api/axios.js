import axios from "axios";

const resolveBaseURL = () => {
  const configured = process.env.REACT_APP_API_URL || "";
  // Guard against the classic deploy bug: building production with a dev
  // frontend/.env (REACT_APP_API_URL=http://localhost:5000/api) bakes
  // localhost into the bundle, so the live site tries to call the visitor's
  // own machine. If we are served from a non-local host but the baked URL
  // points at localhost, ignore it and use same-origin /api.
  if (typeof window !== "undefined" && configured) {
    try {
      const parsed = new URL(
        configured,
        window.location.origin
      );
      const bakedHost = parsed.hostname;
      const servedHost = window.location.hostname;
      const isBakedLocal =
        bakedHost === "localhost" ||
        bakedHost === "127.0.0.1" ||
        bakedHost === "[::1]";
      const isServedLocal =
        servedHost === "localhost" ||
        servedHost === "127.0.0.1" ||
        servedHost === "::1" ||
        servedHost === "";
      if (isBakedLocal && !isServedLocal) {
        // eslint-disable-next-line no-console
        console.warn(
          `Ignoring baked REACT_APP_API_URL (${configured}) pointing at localhost while served from ${servedHost} — using same-origin /api instead. Rebuild without frontend/.env localhost value for production.`
        );
        return "/api";
      }
    } catch {
      // Unparseable value — fall through to same-origin.
      return "/api";
    }
  }
  return configured || "/api";
};

const API = axios.create({
  // Same-origin default: when the backend serves the built frontend (single
  // service deployment), "/api" just works. Separate-hosting deployments set
  // REACT_APP_API_URL at build time; local dev sets it in frontend/.env.
  baseURL: resolveBaseURL(),
  // Fail fast instead of hanging forever when the backend is unreachable —
  // hung requests pile up and make the app look frozen.
  timeout: 15000,
  // Send the hardened __Host-cm_session httpOnly cookie alongside the
  // Authorization header (P0-3 migration: cookie is the future, Bearer is
  // kept for compatibility until all clients migrate off localStorage).
  withCredentials: true,
});

// Session token lives in localStorage ("Keep me signed in") or
// sessionStorage (session-only login) — read both, in that order.
export const getStoredToken = () => {
  try {
    return localStorage.getItem("token") || sessionStorage.getItem("token");
  } catch {
    return null;
  }
};

export const clearStoredSession = () => {
  try {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    sessionStorage.removeItem("token");
    sessionStorage.removeItem("user");
  } catch {
    // ignore
  }
};

API.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

API.interceptors.response.use(
  (response) => response,
  (error) => {
    // Expired/invalid tokens bounce to login — except for login/register
    // attempts themselves, where a 401 is a form error ("Invalid
    // credentials") that must reach the page instead of reloading it.
    const url = error.config?.url || "";
    const isAuthForm =
      url.includes("/auth/login") ||
      url.includes("/auth/register") ||
      url.includes("/auth/google");
    // Coupon preview is an inline form error, not a session expiry — a guest
    // typing a code must see "please log in" in place, not lose the whole
    // in-progress booking form to a full-page redirect.
    const isInlinePreview =
      url.includes("/coupons/validate");
    if (error.response?.status === 401 && !isAuthForm && !isInlinePreview) {
      clearStoredSession();
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    // Admin-blocked accounts get 403 (not 401) on every request — sign them
    // out immediately so the stale localStorage session can't linger.
    // Only the explicit blocked-account message triggers this; other 403s
    // (role mismatches) pass through to the page untouched.
    const blockedMsg = error.response?.data?.message || "";
    if (
      error.response?.status === 403 &&
      /blocked by an administrator/i.test(blockedMsg) &&
      window.location.pathname !== "/login"
    ) {
      clearStoredSession();
      window.location.href = "/login";
    }
    return Promise.reject(error);
  }
);

export default API;
