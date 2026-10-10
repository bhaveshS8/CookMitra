import React from "react";

global.IS_REACT_ACT_ENVIRONMENT = true;

import { renderToString } from "react-dom/server";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import WomanPresenceCheck from "./WomanPresenceCheck";
import {
  VERIFICATION_QUESTION,
  YES_LABEL,
  NO_LABEL,
  BLOCKED_TITLE,
  BLOCKED_BODY,
  formatCountdown,
  remainingSecondsUntil,
  presenceGuardMessage,
  isBlockedResponse,
  BLOCKED_CODE,
} from "../utils/womanPresence";

// NOTE on responsive testing: jsdom (CRA jest) has no layout engine, so
// scrollWidth/clientWidth overflow assertions are meaningless here. The
// component renders fluid markup (no fixed widths — enforced by the CSS
// static test below), and 320/375/425px rendering must be confirmed in a
// real browser (see Phase-11 notes). These tests lock the contract that
// makes that true: full-width containers, wrapping text, stable states.

jest.mock("../api/axios", () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));

const API = require("../api/axios").default;

const wpBase = (overrides = {}) => ({
  presence: null,
  restriction: null,
  status: "ready",
  busy: false,
  error: "",
  remaining: 0,
  blocked: false,
  legacy: false,
  selectYes: jest.fn(),
  selectNo: jest.fn(),
  submitDecline: jest.fn(),
  retryStatus: jest.fn(),
  applyServerBlock: jest.fn(),
  ...overrides,
});

const htmlOf = (wp) => renderToString(<WomanPresenceCheck wp={wp} />);

describe("womanPresence pure helpers", () => {
  test("countdown formats mm:ss", () => {
    expect(formatCountdown(3599)).toBe("59:59");
    expect(formatCountdown(60)).toBe("1:00");
    expect(formatCountdown(5)).toBe("0:05");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-3)).toBe("0:00");
  });

  test("remainingSecondsUntil uses the server expiry as truth", () => {
    const until = new Date("2026-10-10T10:01:00.000Z").getTime();
    expect(remainingSecondsUntil(new Date(until).toISOString(), until - 18 * 1000)).toBe(18);
    expect(remainingSecondsUntil(new Date(until).toISOString(), until + 1000)).toBe(0);
    expect(remainingSecondsUntil("not-a-date", Date.now())).toBe(0);
  });

  test("presenceGuardMessage: explicit answer enables the Find Cooks action", () => {
    expect(presenceGuardMessage(null)).toMatch(/Checking/i);
    expect(presenceGuardMessage(wpBase({ status: "loading" }))).toMatch(/Checking/i);
    expect(presenceGuardMessage(wpBase({ status: "error" }))).toMatch(/Checking/i);
    expect(presenceGuardMessage(wpBase({ blocked: true, restriction: { blockedUntil: "x" } }))).toMatch(
      /temporarily unavailable/i
    );
    expect(presenceGuardMessage(wpBase({ busy: true, presence: "no" }))).toMatch(/Recording/i);
    expect(presenceGuardMessage(wpBase({ presence: null }))).toMatch(/answer/i);
    // YES and NO both enable the click itself: YES books, while NO routes
    // the click into decline-recording (the timer starts only on backend
    // confirmation, never on selection).
    expect(presenceGuardMessage(wpBase({ presence: "yes" }))).toBeNull();
    expect(presenceGuardMessage(wpBase({ presence: "no" }))).toBeNull();
    expect(presenceGuardMessage(wpBase({ status: "loading", presence: "no" }))).toBeNull();
    expect(presenceGuardMessage(wpBase({ status: "error", presence: "yes" }))).toBeNull();
    // ...but a KNOWN block or an in-flight decline still gates the click.
    expect(
      presenceGuardMessage(wpBase({ presence: "no", blocked: true, restriction: { blockedUntil: "x" } }))
    ).not.toBeNull();
    expect(presenceGuardMessage(wpBase({ presence: "no", busy: true }))).not.toBeNull();
  });

  test("isBlockedResponse detects server blocks", () => {
    expect(isBlockedResponse({ blocked: true })).toBe(true);
    expect(isBlockedResponse({ code: BLOCKED_CODE })).toBe(true);
    expect(isBlockedResponse({ blocked: false })).toBe(false);
    expect(isBlockedResponse(null)).toBe(false);
  });

  test("legacy compatibility mode gates on explicit YES only", () => {
    const legacy = { ...wpBase({ legacy: true }), status: "ready" };
    expect(presenceGuardMessage({ ...legacy, presence: null })).toMatch(/answer/i);
    expect(presenceGuardMessage({ ...legacy, presence: "no" })).toMatch(/answer/i);
    expect(presenceGuardMessage({ ...legacy, presence: "yes" })).toBeNull();
    // Legacy ignores even a stale error status — no server state exists.
    expect(presenceGuardMessage({ ...legacy, status: "error", presence: "yes" })).toBeNull();
  });
});

describe("WomanPresenceCheck rendering", () => {
  test("question with both options unselected by default (no preselect)", () => {
    const html = htmlOf(wpBase());
    expect(html).toContain(VERIFICATION_QUESTION);
    expect(html).toContain(YES_LABEL);
    expect(html).toContain(NO_LABEL);
    expect(html).toContain('role="radiogroup"');
    // Neither radio may be checked initially.
    expect(html.match(/aria-checked="true"/g) || []).toHaveLength(0);
    expect(html).not.toContain("Booking temporarily unavailable");
  });

  test("YES selected is reflected; NO stays unselected", () => {
    const html = htmlOf(wpBase({ presence: "yes" }));
    const yesChecked = (html.match(/aria-checked="true"/g) || []).length;
    expect(yesChecked).toBe(1);
    // No helper texts below the options.
    expect(html).not.toContain("continue with Find Cook");
    expect(html).not.toContain("1-hour restriction will apply");
  });

  test("blocked notice shows exact message + countdown, no question", () => {
    const html = htmlOf(
      wpBase({
        blocked: true,
        presence: "no",
        restriction: { blockedUntil: new Date(Date.now() + 59 * 60 * 1000 + 42000).toISOString() },
        remaining: 3582,
      })
    );
    expect(html).toContain(BLOCKED_TITLE);
    for (const para of BLOCKED_BODY.split("\n\n")) expect(html).toContain(para);
    expect(html).toContain("59:42");
    expect(html).not.toContain(VERIFICATION_QUESTION);
    expect(html).toContain('role="alert"');
  });

  test("decline failure shows safe error + retry, never false success", () => {
    const html = htmlOf(wpBase({ presence: "no", error: "Could not record your response. Please retry." }));
    expect(html).toContain("Could not record your response");
    expect(html).toContain("Retry");
    expect(html).not.toContain(BLOCKED_TITLE);
  });

  test("loading keeps the question interactive (never a dead spinner)", () => {
    const html = htmlOf(wpBase({ status: "loading" }));
    expect(html).toContain(VERIFICATION_QUESTION);
    expect(html).toContain(YES_LABEL);
    expect(html).toContain(NO_LABEL);
    expect(html).toContain("Verifying booking eligibility");
    // Submit must still be gated until the server state resolves.
    expect(presenceGuardMessage(wpBase({ status: "loading" }))).not.toBeNull();
  });

  test("status-error state renders safely", () => {
    const errHtml = htmlOf(wpBase({ status: "error", error: "" }));
    expect(errHtml).toContain("Could not check booking eligibility");
    expect(errHtml).toContain("Retry");
  });
});

describe("WomanPresenceCheck responsive CSS contract (static)", () => {
  const fs = require("fs");
  const path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "WomanPresenceCheck.css"), "utf8");

  test("no fixed pixel widths that can overflow 320px viewports", () => {
    const fixedWidths = [...css.matchAll(/(?:^|[;{}])\s*(?:width|min-width)\s*:\s*(\d+(?:\.\d+)?)px/gi)]
      .map((m) => Number(m[1]))
      .filter((n) => n > 0 && n <= 2000);
    // Icon-size boxes (<=48px, flex:none) are fine; anything wider must be %.
    const wide = fixedWidths.filter((n) => n > 48);
    expect(wide).toEqual([]);
  });

  test("fluid rules present: 100% widths, min-width:0, border-box, wrapping", () => {
    expect(css).toMatch(/width:\s*100%/);
    expect(css).toMatch(/min-width:\s*0/);
    expect(css).toMatch(/box-sizing:\s*border-box/);
    expect(css).toMatch(/overflow-wrap:\s*break-word/);
  });

  test("tap targets are comfortably usable (>=44px min-height)", () => {
    expect(css).toMatch(/\.wp-option\s*\{[^}]*min-height:\s*48px/);
  });
});

describe("WomanPresenceCheck interaction (jsdom)", () => {
  let container;
  let root;
  beforeEach(() => {
    API.get.mockReset();
    API.post.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  // Minimal live-hook harness without @testing-library.
  const HookProbe = ({ user, onRequireLogin, capture }) => {
    const { useWomanPresence } = require("../utils/useWomanPresence");
    const wp = useWomanPresence(user, onRequireLogin);
    capture(wp);
    return <WomanPresenceCheck wp={wp} />;
  };

  const mount = async (user, statusResponse = { data: { blocked: false } }, getError = null) => {
    let latest = null;
    const capture = (wp) => {
      latest = wp;
    };
    if (getError) API.get.mockRejectedValue(getError);
    else API.get.mockResolvedValue(statusResponse);
    await act(async () => {
      root.render(<HookProbe user={user} capture={capture} />);
    });
    return () => latest;
  };

  test("NO alone sends nothing and starts no timer", async () => {
    const get = await mount({ role: "customer" });
    expect(get().status).toBe("ready");

    const noBtn = container.querySelector('[data-testid="wp-no"]');
    await act(async () => {
      noBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      noBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Selecting NO records nothing — the restriction starts only on the
    // Find Cooks click (submitDecline) after backend confirmation.
    expect(API.post).not.toHaveBeenCalled();
    expect(API.get).toHaveBeenCalledTimes(1); // mount status check only
    expect(get().presence).toBe("no");
    expect(get().blocked).toBe(false);
    expect(container.textContent).not.toContain(BLOCKED_TITLE);
    // ...but the Find Cooks action itself is enabled for the NO path.
    expect(presenceGuardMessage(get())).toBeNull();
  });

  test("Find Cooks action with NO records the decline and shows the block", async () => {
    const until = new Date(Date.now() + 3600 * 1000).toISOString();
    API.post.mockResolvedValue({ data: { blocked: true, blockedUntil: until } });
    const get = await mount({ role: "customer" });
    await act(async () => {
      container.querySelector('[data-testid="wp-no"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(API.post).not.toHaveBeenCalled();

    let res;
    await act(async () => {
      res = await get().submitDecline();
    });
    expect(res.ok).toBe(true);
    expect(res.blockedUntil).toBe(until);
    expect(API.post).toHaveBeenCalledTimes(1);
    expect(API.post.mock.calls[0][0]).toBe("/bookings/verification/decline");
    expect(API.post.mock.calls[0][1]).toEqual({});
    expect(get().blocked).toBe(true);
    expect(container.textContent).toContain(BLOCKED_TITLE);
    expect(container.querySelector('[data-testid="wp-countdown"]')).not.toBeNull();
  });

  test("concurrent Find Cooks clicks share one decline POST (no extension)", async () => {
    const until = new Date(Date.now() + 3600 * 1000).toISOString();
    let resolvePost;
    API.post.mockReturnValue(new Promise((res) => { resolvePost = res; }));
    const get = await mount({ role: "customer" });
    await act(async () => {
      container.querySelector('[data-testid="wp-no"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    let r1;
    let r2;
    await act(async () => {
      const p1 = get().submitDecline();
      const p2 = get().submitDecline();
      await Promise.resolve();
      expect(API.post).toHaveBeenCalledTimes(1);
      resolvePost({ data: { blocked: true, blockedUntil: until } });
      r1 = await p1;
      r2 = await p2;
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r2.busy).toBe(true);
    expect(get().blocked).toBe(true);
  });

  test("YES sends no decline and keeps the booking flow available", async () => {
    const get = await mount({ role: "customer" });
    const yesBtn = container.querySelector('[data-testid="wp-yes"]');
    await act(async () => {
      yesBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(API.post).not.toHaveBeenCalled();
    expect(get().presence).toBe("yes");
    expect(presenceGuardMessage(get())).toBeNull();
  });

  test("YES enables Find Cook immediately, even while the check is pending", async () => {
    let resolveGet;
    API.get.mockReturnValue(new Promise((res) => { resolveGet = res; }));
    let latest = null;
    await act(async () => {
      root.render(<HookProbe user={{ role: "customer" }} capture={(wp) => { latest = wp; }} />);
    });
    expect(latest.status).toBe("loading");
    await act(async () => {
      container.querySelector('[data-testid="wp-yes"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(latest.presence).toBe("yes");
    // The gate opens at once; the server remains the final authority.
    expect(presenceGuardMessage(latest)).toBeNull();
    await act(async () => {
      resolveGet({ data: { blocked: false } });
    });
    expect(latest.status).toBe("ready");
  });

  test("NO then YES before Find Cooks proceeds normally, never declines", async () => {
    const get = await mount({ role: "customer" });
    await act(async () => {
      container.querySelector('[data-testid="wp-no"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(get().presence).toBe("no");
    await act(async () => {
      container.querySelector('[data-testid="wp-yes"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(API.post).not.toHaveBeenCalled();
    expect(get().presence).toBe("yes");
    expect(get().blocked).toBe(false);
    expect(presenceGuardMessage(get())).toBeNull();
  });

  test("guest Find Cooks with NO prompts login and records nothing", async () => {
    const onLogin = jest.fn();
    let latest = null;
    await act(async () => {
      root.render(<HookProbe user={null} onRequireLogin={onLogin} capture={(wp) => { latest = wp; }} />);
    });
    await act(async () => {
      container.querySelector('[data-testid="wp-no"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(latest.presence).toBe("no");
    expect(API.post).not.toHaveBeenCalled();
    let res;
    await act(async () => {
      res = await latest.submitDecline();
    });
    expect(onLogin).toHaveBeenCalledTimes(1);
    expect(res.loginRequired).toBe(true);
    expect(API.post).not.toHaveBeenCalled();
    expect(latest.blocked).toBe(false);
  });

  test("works under React StrictMode double-effects (dev remount)", async () => {
    // Regression: the mount flag must survive StrictMode's
    // mount -> cleanup -> re-run cycle, or every decline short-circuits
    // into { ok:false } with no network request at all.
    const until = new Date(Date.now() + 3600 * 1000).toISOString();
    API.get.mockResolvedValue({ data: { blocked: false } });
    API.post.mockResolvedValue({ data: { blocked: true, blockedUntil: until } });
    let latest = null;
    await act(async () => {
      root.render(
        <React.StrictMode>
          <HookProbe user={{ role: "customer" }} capture={(wp) => { latest = wp; }} />
        </React.StrictMode>
      );
    });
    expect(API.get).toHaveBeenCalled();
    expect(latest.status).toBe("ready");
    await act(async () => {
      container.querySelector('[data-testid="wp-no"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    let res;
    await act(async () => {
      res = await latest.submitDecline();
    });
    expect(API.post).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(latest.blocked).toBe(true);
    expect(container.textContent).toContain(BLOCKED_TITLE);
  });

  test("failed decline records nothing; status revalidation decides before retry", async () => {
    const until = new Date(Date.now() + 3600 * 1000).toISOString();
    API.post.mockRejectedValue({ response: { status: 503, data: {} }, message: "down" });
    const get = await mount({ role: "customer" });
    await act(async () => {
      container.querySelector('[data-testid="wp-no"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    let res;
    await act(async () => {
      res = await get().submitDecline();
    });
    expect(res.ok).toBe(false);
    expect(get().blocked).toBe(false);
    expect(container.textContent).toMatch(/Could not record your response/);
    // Retry from the error box re-attempts the Find Cooks decline action.
    API.post.mockResolvedValue({ data: { blocked: true, blockedUntil: until } });
    await act(async () => {
      container.querySelector(".wp-retry").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(get().blocked).toBe(true);
    expect(container.textContent).toContain(BLOCKED_TITLE);
  });

  test("timed-out decline that landed is adopted, never assumed missing", async () => {    const until = new Date(Date.now() + 3600 * 1000).toISOString();
    const get = await mount({ role: "customer" });
    await act(async () => {
      container.querySelector('[data-testid="wp-no"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The POST fails, but the decline actually landed — the status
    // revalidation must adopt the block instead of reporting failure.
    API.post.mockRejectedValue({ message: "socket hang up" });
    API.get.mockResolvedValue({ data: { blocked: true, blockedUntil: until } });
    let res;
    await act(async () => {
      res = await get().submitDecline();
    });
    expect(API.post).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.blockedUntil).toBe(until);
    expect(get().blocked).toBe(true);
    expect(container.textContent).toContain(BLOCKED_TITLE);
  });

  test("server error message is surfaced instead of a generic line", async () => {
    const serverMsg = "Could not record the restriction right now. Please try again.";
    API.post.mockRejectedValue({ response: { status: 503, data: { message: serverMsg } } });
    const get = await mount({ role: "customer" });
    await act(async () => {
      container.querySelector('[data-testid="wp-no"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    let res;
    await act(async () => {
      res = await get().submitDecline();
    });
    expect(res.ok).toBe(false);
    expect(res.message).toBe(serverMsg);
    expect(get().blocked).toBe(false);
    expect(container.textContent).toContain(serverMsg);
  });

  test("unreachable server reports connection trouble, not a recorded block", async () => {
    API.post.mockRejectedValue(new Error("Network Error"));
    API.get.mockRejectedValue(new Error("Network Error"));
    const get = await mount({ role: "customer" }, undefined, new Error("Network Error"));
    await act(async () => {
      container.querySelector('[data-testid="wp-no"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    let res;
    await act(async () => {
      res = await get().submitDecline();
    });
    expect(res.ok).toBe(false);
    expect(get().blocked).toBe(false);
    expect(container.textContent).toMatch(/No response from the server/);
    expect(container.textContent).not.toContain(BLOCKED_TITLE);
  });

  test("active restriction is restored from the backend on mount (refresh)", async () => {
    const until = new Date(Date.now() + 3500 * 1000).toISOString();
    const get = await mount({ role: "customer" }, { data: { blocked: true, blockedUntil: until } });
    expect(get().blocked).toBe(true);
    expect(container.textContent).toContain(BLOCKED_TITLE);
    expect(presenceGuardMessage(get())).toMatch(/temporarily unavailable/i);
  });

  test("stalled eligibility check times out fast with retry (no endless spinner)", async () => {    const { STATUS_TIMEOUT_MS } = require("../utils/useWomanPresence");
    jest.useFakeTimers();
    try {
      // Server never answers — modeled faithfully: like axios, the pending
      // request rejects once the AbortController fires.
      API.get.mockImplementation(
        (url, config) =>
          new Promise((_, reject) => {
            config?.signal?.addEventListener("abort", () => {
              const err = new Error("canceled");
              err.code = "ERR_CANCELED";
              reject(err);
            });
          })
      );
      let latest = null;
      await act(async () => {
        root.render(<HookProbe user={{ role: "customer" }} capture={(wp) => { latest = wp; }} />);
      });
      // Question is usable while the check runs.
      expect(container.textContent).toContain(VERIFICATION_QUESTION);
      await act(async () => {
        jest.advanceTimersByTime(STATUS_TIMEOUT_MS + 500);
      });
      expect(latest.status).toBe("error");
      expect(container.textContent).toMatch(/timed out/);
      expect(container.textContent).toContain("Retry");
      // Submit stays blocked, and retry recovers when the server answers.
      expect(presenceGuardMessage(latest)).not.toBeNull();
      API.get.mockResolvedValue({ data: { blocked: false } });
      await act(async () => {
        container.querySelector(".wp-retry").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(latest.status).toBe("ready");
      expect(presenceGuardMessage(latest)).toMatch(/answer/i);
    } finally {
      jest.useRealTimers();
    }
  });

  test("404 status (old backend) enters compatibility mode: YES enables booking", async () => {
    const get = await mount({ role: "customer" }, undefined, { response: { status: 404, data: {} } });
    expect(get().legacy).toBe(true);
    expect(get().status).toBe("ready");
    expect(container.textContent).toMatch(/compatibility mode/);
    // YES enables the flow with no further server calls.
    await act(async () => {
      container.querySelector('[data-testid="wp-yes"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(API.post).not.toHaveBeenCalled();
    expect(presenceGuardMessage(get())).toBeNull();
  });

  test("404 status: NO never fabricates a server block, booking stays gated", async () => {    const get = await mount({ role: "customer" }, undefined, { response: { status: 404, data: {} } });
    expect(get().legacy).toBe(true);
    await act(async () => {
      container.querySelector('[data-testid="wp-no"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(API.post).not.toHaveBeenCalled();
    expect(get().blocked).toBe(false);
    expect(get().presence).toBe("no");
    expect(container.textContent).toMatch(/explicit YES/);
    expect(presenceGuardMessage(get())).not.toBeNull();
    expect(container.textContent).not.toContain(BLOCKED_TITLE);
  });
});
