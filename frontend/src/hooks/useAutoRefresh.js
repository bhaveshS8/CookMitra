import { useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// useAutoRefresh — reusable background auto-refresh for long-lived tabs.
//
// Dashboards (admin "Platform Bookings", customer "My Bookings", …) show
// booking cards that go stale while the page is open. Previously the only way
// to see a change was a manual reload, and any refresh re-fetched the list
// from scratch (spinner + blank). This hook keeps those tabs current by
// re-running a hook's `refetch` on a fixed interval *in the background*:
//
//   • It never triggers the first-load "Loading…" state — `useFetch` already
//     keeps the existing rows on screen while it revalidates, so the cards
//     simply update in place.
//   • It pauses while the browser tab is hidden (no wasted requests), and
//     fires one refresh immediately when the tab or window regains
//     focus/visibility — so a user who switches away and returns sees fresh
//     data at once rather than waiting up to a full interval.
//
// Usage:
//   const { refetch } = useFetch("/bookings");
//   useAutoRefresh(refetch, { intervalMs: 15000 });
//
// `refetch` is captured in a ref, so an unstable function identity (it is
// rebuilt whenever the URL changes) does not restart the timer on every render.
// ---------------------------------------------------------------------------
export const useAutoRefresh = (refetch, { intervalMs = 30000, enabled = true } = {}) => {
  const refetchRef = useRef(refetch);

  // Keep the latest callback without re-arming the interval/timers below.
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  useEffect(() => {
    if (!enabled || typeof refetchRef.current !== "function") return undefined;
    if (typeof intervalMs !== "number" || intervalMs <= 0) return undefined;

    const runSilently = () => {
      // Hidden tabs skip the poll so a backgrounded dashboard does not keep
      // hammering the API for a user who is not watching it.
      if (document.hidden) return;
      try {
        refetchRef.current?.();
      } catch {
        // A refetch failure is already surfaced by useFetch's own error state.
      }
    };

    const id = setInterval(runSilently, intervalMs);

    // Catch-up refresh the moment the tab/window becomes active again.
    const onWake = () => {
      if (!document.hidden) {
        try {
          refetchRef.current?.();
        } catch {
          // ignore
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
