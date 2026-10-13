import React from "react";

global.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router-dom";
import ScrollToTop from "./ScrollToTop";

jest.mock("../utils/analytics", () => ({
  AnalyticsEvents: { PAGE_VIEW: "page_view" },
  track: jest.fn(),
  trackSiteVisit: jest.fn(),
}));

let go;
const NavProbe = () => {
  go = useNavigate();
  return null;
};

const renderAt = (entry) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <ScrollToTop />
        <NavProbe />
      </MemoryRouter>
    );
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
};

describe("ScrollToTop", () => {
  let scrollTo;

  beforeEach(() => {
    scrollTo = jest.fn();
    window.scrollTo = scrollTo;
  });

  test("mount scrolls to top once", () => {
    const cleanup = renderAt("/dashboard/profile?tab=personal");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "instant" });
    cleanup();
  });

  test("search-only change (profile tab switch) keeps scroll position", () => {
    const cleanup = renderAt("/dashboard/profile?tab=personal");
    scrollTo.mockClear();
    act(() => {
      go("/dashboard/profile?tab=addresses", { replace: true });
    });
    expect(scrollTo).not.toHaveBeenCalled();
    act(() => {
      go("/dashboard/profile?tab=security");
    });
    expect(scrollTo).not.toHaveBeenCalled();
    cleanup();
  });

  test("pathname change still resets scroll to top", () => {
    const cleanup = renderAt("/dashboard/profile?tab=activity");
    scrollTo.mockClear();
    act(() => {
      go("/dashboard/my-bookings");
    });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "instant" });
    cleanup();
  });
});
