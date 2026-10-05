import { useEffect, useRef } from "react";

export const useAutoRefresh = (refetch, { intervalMs = 30000, enabled = true } = {}) => {
  const refetchRef = useRef(refetch);

  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  useEffect(() => {
    if (!enabled || typeof refetchRef.current !== "function") return undefined;
    if (typeof intervalMs !== "number" || intervalMs <= 0) return undefined;

    const runSilently = () => {
      if (document.hidden) return;
      try {
        refetchRef.current?.();
      } catch {
      }
    };

    const id = setInterval(runSilently, intervalMs);

    const onWake = () => {
      if (!document.hidden) {
        try {
          refetchRef.current?.();
        } catch {
        }
      }
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [intervalMs, enabled]);
};

export default useAutoRefresh;
