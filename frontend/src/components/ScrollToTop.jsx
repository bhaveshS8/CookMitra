import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { AnalyticsEvents, track, trackSiteVisit } from "../utils/analytics";

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
