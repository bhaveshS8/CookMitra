import { useEffect } from "react";
import { useSelector } from "react-redux";

/**
 * Custom hook to listen to real-time SSE events from /api/realtime/stream
 * and dispatch custom DOM events so components (dashboard, modals, notification popups)
 * react instantly.
 *
 * The stream URL respects REACT_APP_API_URL (dev: http://localhost:5000/api)
 * so local dev (frontend on :3000, backend on :5000) connects to the backend
 * instead of 404ing on the dev server; same-origin deployments fall back to
 * the relative path.
 */
const resolveStreamUrl = (token) => {
  const configured = process.env.REACT_APP_API_URL || "";
  const suffix = `/realtime/stream?token=${encodeURIComponent(token)}`;
  if (configured) {
    try {
      const base = configured.replace(/\/+$/, "");
      if (/\/api$/.test(base)) return `${base.replace(/\/api$/, "")}/api${suffix}`;
      return `${base}/api${suffix}`;
    } catch {
      // fall through to relative
    }
  }
  return `/api${suffix}`;
};

export const useRealtime = () => {
  const user = useSelector((s) => s.auth?.user);
  const token = useSelector((s) => s.auth?.token) || localStorage.getItem("token");

  useEffect(() => {
    if (!user || !token) return undefined;

    const streamUrl = resolveStreamUrl(token);
    let eventSource = null;
    try {
      eventSource = new EventSource(streamUrl);

      eventSource.addEventListener("booking_request", (e) => {
        try {
          const data = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent("realtime-booking-request", { detail: data }));
          window.dispatchEvent(new CustomEvent("notifications-updated"));
        } catch {
          // ignore parse error
        }
      });

      eventSource.addEventListener("booking_assigned", (e) => {
        try {
          const data = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent("realtime-booking-assigned", { detail: data }));
          window.dispatchEvent(new CustomEvent("notifications-updated"));
        } catch {
          // ignore parse error
        }
      });

      eventSource.addEventListener("booking_ignored", (e) => {
        try {
          const data = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent("realtime-booking-ignored", { detail: data }));
        } catch {
          // ignore parse error
        }
      });

      eventSource.addEventListener("booking_expired", (e) => {
        try {
          const data = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent("realtime-booking-expired", { detail: data }));
          window.dispatchEvent(new CustomEvent("notifications-updated"));
        } catch {
          // ignore parse error
        }
      });

      eventSource.onerror = () => {
        // EventSource automatically retries on disconnect
      };
    } catch {
      // EventSource fallback: silent failure (polling is active)
    }

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, [user?._id, user?.id, token]);
};
