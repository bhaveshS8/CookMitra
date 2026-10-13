import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { AnalyticsEvents, track, trackSiteVisit } from "../utils/analytics";

const ScrollToTop = () => {
  const { pathname, search } = useLocation();

  // Reset scroll only on real page changes. Search-only updates (e.g. the
  // profile `?tab=` switcher) must keep the user's scroll position instead
  // of jumping the page back to the top.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    track(AnalyticsEvents.PAGE_VIEW, {
      page_path: `${pathname}${search || ""}`,
    });
    trackSiteVisit(pathname || "/");
    // `search` is intentionally read but not depended on (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return null;
};

export default ScrollToTop;
