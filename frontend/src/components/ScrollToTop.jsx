import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { AnalyticsEvents, track, trackSiteVisit } from "../utils/analytics";

// Resets scroll to the top on every route navigation (path or query change)
// so each page opened via a link/button starts at the top.
// Also fires a single page_view event per navigation (P0 instrumentation for
// the marketing funnel — traffic source -> page) and the in-house visit
// ping (once per browser session — answers "how many users visit").
const ScrollToTop = () => {
  const { pathname, search } = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    track(AnalyticsEvents.PAGE_VIEW, {
      page_path: `${pathname}${search || ""}`,
    });
    trackSiteVisit(pathname || "/");
  }, [pathname, search]);

  return null;
};

export default ScrollToTop;
