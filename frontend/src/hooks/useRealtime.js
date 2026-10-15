import { useEffect } from "react";
import { useSelector } from "react-redux";

const resolveStreamUrl = (token) => {
  const configured = process.env.REACT_APP_API_URL || "";
  const suffix = `/realtime/stream?token=${encodeURIComponent(token)}`;
  if (configured) {
    try {
      const base = configured.replace(/\/+$/, "");
      // Same localhost-bake guard as api/axios.js: a bundle baked with a
      // local API URL but served remotely must use same-origin /api,
      // otherwise the stream silently points at the viewer's localhost.
      const bakedHost = new URL(configured, window.location.origin).hostname;
      const servedHost = window.location.hostname;
      const bakedLocal = bakedHost === "localhost" || bakedHost === "127.0.0.1" || bakedHost === "[::1]";
      const servedLocal =
        servedHost === "localhost" || servedHost === "127.0.0.1" || servedHost === "::1" || servedHost === "";
      if (bakedLocal && !servedLocal) return `/api${suffix}`;
      if (/\/api$/.test(base)) return `${base.replace(/\/api$/, "")}/api${suffix}`;
      return `${base}/api${suffix}`;
    } catch {
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
        }
      });

      eventSource.addEventListener("booking_assigned", (e) => {
        try {
          const data = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent("realtime-booking-assigned", { detail: data }));
          window.dispatchEvent(new CustomEvent("notifications-updated"));
        } catch {
        }
      });

      eventSource.addEventListener("booking_replacement_needed", (e) => {
        try {
          const data = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent("realtime-booking-replacement-needed", { detail: data }));
          window.dispatchEvent(new CustomEvent("notifications-updated"));
        } catch {
        }
      });

      eventSource.addEventListener("booking_ignored", (e) => {
        try {
          const data = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent("realtime-booking-ignored", { detail: data }));
        } catch {
        }
      });

      eventSource.addEventListener("booking_expired", (e) => {
        try {
          const data = JSON.parse(e.data);
          window.dispatchEvent(new CustomEvent("realtime-booking-expired", { detail: data }));
          window.dispatchEvent(new CustomEvent("notifications-updated"));
        } catch {
        }
      });

      eventSource.onerror = () => {
      };
    } catch {
    }

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  // Deps intentionally use stable identity fields (not `user`): any user-object
  // change (e.g. profile/address updates) must not tear down the SSE stream.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?._id, user?.id, token]);
};
