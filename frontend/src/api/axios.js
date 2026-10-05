import axios from "axios";

const resolveBaseURL = () => {
  const configured = process.env.REACT_APP_API_URL || "";
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
      return "/api";
    }
  }
  return configured || "/api";
};

const API = axios.create({
  baseURL: resolveBaseURL(),
  timeout: 15000,
  withCredentials: true,
});

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
    const url = error.config?.url || "";
    const isAuthForm =
      url.includes("/auth/login") ||
      url.includes("/auth/register") ||
      url.includes("/auth/google");
    const isInlinePreview =
      url.includes("/coupons/validate");
    if (error.response?.status === 401 && !isAuthForm && !isInlinePreview) {
      clearStoredSession();
      if (window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
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
