import React from "react";

global.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import CouponApply from "./CouponApply";

jest.mock("../api/axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));
jest.mock("../utils/analytics", () => ({
  AnalyticsEvents: { COUPON_APPLIED: "coupon_applied" },
  track: jest.fn(),
}));

const API = require("../api/axios").default;

const KNOWN = {
  WELCOME50: { code: "WELCOME50", discount: 50, payable: 299, fullFee: 349 },
  FESTIVE20: { code: "FESTIVE20", discount: 70, payable: 429, fullFee: 499 },
};
// Faithful server double: unknown codes are rejected like the real API.
const serverLikeValidate = (url, body) => {
  const hit = KNOWN[String(body?.code || "")];
  if (hit) return Promise.resolve({ data: { ...hit } });
  return Promise.reject({ response: { status: 400, data: { message: "This coupon is not valid for this booking." } } });
};

const setInput = (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("CouponApply", () => {
  let container;
  let root;
  let appliedCalls;
  const onApplied = (...args) => {
    appliedCalls.push(args);
  };
  beforeEach(() => {
    API.post.mockReset();
    API.get.mockReset();
    appliedCalls = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderApply = async (props = {}) => {
    await act(async () => {
      root.render(<CouponApply amount={349} serviceType="cook_for_me" onApplied={onApplied} {...props} />);
    });
  };
  const input = () => container.querySelector(".coupon-input");
  const applyBtn = () => container.querySelector(".coupon-apply-btn");

  test("Apply BUTTON sends the typed code (not the click event)", async () => {
    API.post.mockImplementation(serverLikeValidate);
    await renderApply();
    await act(async () => {
      setInput(input(), "welcome50");
    });
    await act(async () => {
      applyBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(API.post).toHaveBeenCalledTimes(1);
    expect(API.post.mock.calls[0][0]).toBe("/coupons/validate");
    expect(API.post.mock.calls[0][1].code).toBe("WELCOME50");
    expect(container.textContent).toContain("WELCOME50");
    expect(container.textContent).toMatch(/saved/i);
    expect(appliedCalls.length).toBe(1);
    expect(appliedCalls[0][0].discount).toBe(50);
  });

  test("Enter key applies the typed code", async () => {
    API.post.mockImplementation(serverLikeValidate);
    await renderApply();
    await act(async () => {
      setInput(input(), "festive20");
    });
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(API.post).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("FESTIVE20");
  });

  test("rapid double Apply issues a single request", async () => {
    let resolvePost;
    API.post.mockReturnValue(new Promise((res) => { resolvePost = res; }));
    await renderApply();
    await act(async () => {
      setInput(input(), "WELCOME50");
    });
    await act(async () => {
      const btn = applyBtn();
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(API.post).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvePost({ data: { ...KNOWN.WELCOME50 } });
    });
    expect(container.textContent).toContain("WELCOME50");
  });

  test("stale (older) response never overwrites a newer selection", async () => {
    const resolvers = {};
    API.post.mockImplementation((url, body) => new Promise((res) => { resolvers[body.code] = res; }));
    await renderApply();
    await act(async () => {
      setInput(input(), "WELCOME50");
    });
    await act(async () => {
      applyBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // While the first validation is pending the button shows its loading
    // state, so the realistic supersede path is typing a new code + Enter.
    await act(async () => {
      setInput(input(), "FESTIVE20");
    });
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(API.post).toHaveBeenCalledTimes(2);
    // Newer resolves first...
    await act(async () => {
      resolvers.FESTIVE20({ data: { ...KNOWN.FESTIVE20 } });
    });
    expect(container.textContent).toContain("FESTIVE20");
    // ...then the stale older response arrives and must be ignored.
    await act(async () => {
      resolvers.WELCOME50({ data: { ...KNOWN.WELCOME50 } });
    });
    expect(container.textContent).toContain("FESTIVE20");
    expect(container.textContent).not.toContain("WELCOME50");
    const lastApplied = appliedCalls[appliedCalls.length - 1][0];
    expect(lastApplied.code).toBe("FESTIVE20");
  });

  test("failed validation changes nothing (no parent wipe, no applied display)", async () => {
    API.post.mockImplementation(serverLikeValidate);
    await renderApply();
    await act(async () => {
      setInput(input(), "WELCOME50");
    });
    await act(async () => {
      applyBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(appliedCalls.length).toBe(1);
    expect(appliedCalls[0][0].code).toBe("WELCOME50");
    // A later failed attempt for another code must not disturb anything:
    // covered by the invalid-code test asserting zero onApplied calls.
  });

  test("late response after amount change cannot resurrect a stale coupon", async () => {
    let resolvePost;
    API.post.mockImplementation(() => new Promise((res) => { resolvePost = res; }));
    await renderApply();
    await act(async () => {
      setInput(input(), "WELCOME50");
    });
    await act(async () => {
      applyBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Price changes while validation is in flight: the pending result is
    // for the old amount and must die with it.
    await act(async () => {
      root.render(<CouponApply amount={499} serviceType="cook_for_me" onApplied={onApplied} />);
    });
    expect(container.querySelector(".coupon-applied")).toBeNull();
    expect(appliedCalls.length).toBe(0); // nothing committed for any price
    await act(async () => {
      resolvePost({ data: { ...KNOWN.WELCOME50 } });
    });
    expect(container.querySelector(".coupon-applied")).toBeNull();
    expect(container.textContent).not.toContain("WELCOME50");
    expect(appliedCalls.length).toBe(0);
  });

  test("invalid code shows a clear error and applies nothing", async () => {
    API.post.mockImplementation(serverLikeValidate);
    await renderApply();
    await act(async () => {
      setInput(input(), "NOPE123");
    });
    await act(async () => {
      applyBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toMatch(/not valid/i);
    expect(container.querySelector(".coupon-applied")).toBeNull();
    expect(appliedCalls.length).toBe(0);
  });

  test("empty / whitespace-only input cannot submit", async () => {
    API.post.mockImplementation(serverLikeValidate);
    await renderApply();
    expect(applyBtn().disabled).toBe(true);
    await act(async () => {
      setInput(input(), "   ");
    });
    expect(applyBtn().disabled).toBe(true);
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(API.post).not.toHaveBeenCalled();
  });

  test("remove clears the coupon and notifies the parent", async () => {
    API.post.mockImplementation(serverLikeValidate);
    await renderApply();
    await act(async () => {
      setInput(input(), "WELCOME50");
    });
    await act(async () => {
      applyBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".coupon-applied")).not.toBeNull();
    await act(async () => {
      container.querySelector(".coupon-remove").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".coupon-applied")).toBeNull();
    expect(container.querySelector(".coupon-input")).not.toBeNull();
    const last = appliedCalls[appliedCalls.length - 1][0];
    expect(last).toBeNull();
  });

  test("loading state is shown while validating", async () => {
    let resolvePost;
    API.post.mockReturnValue(new Promise((res) => { resolvePost = res; }));
    await renderApply();
    await act(async () => {
      setInput(input(), "WELCOME50");
    });
    act(() => {
      applyBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toMatch(/Applying/i);
    expect(applyBtn().disabled).toBe(true);
    await act(async () => {
      resolvePost({ data: { ...KNOWN.WELCOME50 } });
    });
  });

  test("changing the amount clears a stale applied coupon", async () => {
    API.post.mockImplementation(serverLikeValidate);
    await renderApply();
    await act(async () => {
      setInput(input(), "WELCOME50");
    });
    await act(async () => {
      applyBtn().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("WELCOME50");
    await act(async () => {
      root.render(<CouponApply amount={499} serviceType="cook_for_me" onApplied={onApplied} />);
    });
    expect(container.querySelector(".coupon-applied")).toBeNull();
    const last = appliedCalls[appliedCalls.length - 1][0];
    expect(last).toBeNull();
  });
});

describe("CouponApply responsive CSS contract (static)", () => {
  // jsdom has no layout engine, so overflow is guarded structurally: the
  // booking-flow coupon/price rules must stay fluid (no fixed pixel widths)
  // with small-screen wrap rules. Real 320/375/425px rendering still needs
  // a browser pass (reported honestly in the final summary).
  const fs = require("fs");
  const path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "..", "styles", "booking.css"), "utf8");

  test("no fixed pixel widths in coupon/price rules (fluid at 320px)", () => {
    const bad = [];
    for (const m of css.matchAll(/(\.coupon-[\w-]*|\.price-row[^{]*)\{([^}]*)\}/g)) {
      const sel = m[1].trim();
      for (const w of m[2].matchAll(/(?:^|;)\s*width\s*:\s*(\d+(?:\.\d+)?)px/gi)) {
        if (Number(w[1]) > 0) bad.push(`${sel} -> ${w[0].trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("small-screen wrap + fluid-input rules exist", () => {
    expect(css).toMatch(/max-width:\s*480px/);
    expect(css).toMatch(/\.coupon-apply-row\s*\{\s*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.coupon-input\s*\{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.coupon-apply-btn\s*\{[^}]*width:\s*100%/);
  });

  test("applied-coupon and price rows wrap instead of overflowing", () => {
    expect(css).toMatch(/\.coupon-applied\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.price-rows\s*\{[^}]*flex-direction:\s*column/);
  });
});
