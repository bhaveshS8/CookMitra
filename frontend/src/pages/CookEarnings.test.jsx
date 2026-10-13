import React from "react";

global.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import CookEarnings from "./CookEarnings";

jest.mock("../api/axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));

const API = require("../api/axios").default;

const EARNINGS = {
  overview: { today: 100, thisWeek: 500, pending: 800, paid: 1200, lifetime: 2000, bonuses: 250 },
  bookings: [
    {
      _id: "b1b1b1b1b1b1b1b1b1b1b1",
      customer: "Neha",
      date: "2026-10-10T00:00:00.000Z",
      duration: 2,
      finalCustomerPrice: 349,
      platformDeduction: 52.35,
      platformDeductionPercent: 15,
      cookPayout: 296.65,
      payoutStatus: "pending_weekly",
    },
  ],
  totalBookings: 1,
  truncated: false,
};

const INCENTIVES = [
  { code: "JOINING", target: 10, verifiedLeadCount: 12, remaining: 0, reward: 500, status: "qualified", deadline: "2026-10-08T00:00:00.000Z" },
];

const CYCLES = [
  { _id: "c1", weekStart: "2026-09-28T00:00:00.000Z", status: "paid", bookingCount: 2, grossCustomerValue: 698, totalDeductions: 104.7, cookEarnings: 593.3, bonuses: 0, referralEarnings: 0, totalPayable: 593.3, payoutRef: "CP-REF1", paymentDate: "2026-10-05T00:00:00.000Z" },
];

const SLABS = {
  incentives: [],
  slabs: [
    { leads: 10, reward: 500, days: 7, code: "JOINING" },
    { leads: 20, reward: 1000, days: 10, code: "PERFORMANCE" },
    { leads: 30, reward: 1500, days: 15, code: "ACHIEVEMENT" },
    { leads: 50, reward: 2500, days: 30, code: "CHAMPION" },
  ],
};

const setupApi = ({ earnings = EARNINGS, incentives = INCENTIVES, cycles = CYCLES, slabs = SLABS } = {}) => {
  API.get.mockImplementation((url) => {
    if (url === "/cook/earnings") {
      return earnings instanceof Error ? Promise.reject(earnings) : Promise.resolve({ data: earnings });
    }
    if (url === "/cook/incentives/progress") {
      return incentives instanceof Error ? Promise.reject(incentives) : Promise.resolve({ data: incentives });
    }
    if (url === "/cook/payouts") {
      return cycles instanceof Error ? Promise.reject(cycles) : Promise.resolve({ data: cycles });
    }
    if (url === "/cook/incentives") {
      return slabs instanceof Error ? Promise.reject(slabs) : Promise.resolve({ data: slabs });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
};

describe("CookEarnings", () => {
  let container;
  let root;
  beforeEach(() => {
    API.get.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderPage = async () => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <CookEarnings />
        </MemoryRouter>
      );
    });
  };
  const text = () => container.textContent || "";

  test("loading indicator shows first", async () => {
    setupApi();
    let resolveAll;
    const gate = new Promise((r) => { resolveAll = r; });
    API.get.mockReturnValue(gate);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <CookEarnings />
        </MemoryRouter>
      );
    });
    expect(text()).toMatch(/Loading your earnings/);
    await act(async () => { resolveAll({ data: EARNINGS }); });
  });

  test("successful load renders overview, booking row, incentive and cycle", async () => {
    setupApi();
    await renderPage();
    expect(text()).toMatch(/My Earnings/);
    expect(text()).toMatch(/Booking earnings/);
    expect(text()).toMatch(/Neha/);
    expect(text()).toMatch(/Your booking earnings/);
    expect(text()).toMatch(/Pending Weekly Payment/);
    expect(text()).toMatch(/12 \/ 10 verified leads/);
    expect(text()).toMatch(/Week of/);
    expect(text()).toMatch(/CP-REF1/);
    // Dynamic deduction label uses the server percent.
    expect(text()).toMatch(/Platform deduction \(15%\)/);
  });

  test("core API failure shows error + Try again, never ₹0 overview", async () => {
    setupApi({ earnings: new Error("down") });
    await renderPage();
    expect(text()).toMatch(/Couldn't load your earnings/);
    const btn = container.querySelector(".error-alert-banner button");
    expect(btn && btn.textContent).toMatch(/Try again/);
    // No overview zeros masquerading as data: the overview section itself
    // shows dashes (incentive/cycle rows below may legitimately show ₹0).
    const overview = container.querySelector('section[aria-label="Earnings overview"]').textContent || "";
    expect(overview).not.toMatch(/₹0/);
    expect(overview).toMatch(/—/);
    // Retry works.
    setupApi();
    await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(text()).toMatch(/Neha/);
  });

  test("incentive/payout failure does not block the core overview", async () => {
    setupApi({ incentives: new Error("down"), cycles: new Error("down") });
    await renderPage();
    expect(text()).toMatch(/My Earnings/);
    expect(text()).toMatch(/Neha/);
    expect(text()).not.toMatch(/Couldn't load your earnings/);
  });

  test("failed refresh preserves last good data", async () => {
    setupApi();
    await renderPage();
    expect(text()).toMatch(/Neha/);
    setupApi({ earnings: new Error("down") });
    const buttons = Array.from(container.querySelectorAll("button"));
    const refresh = buttons.find((b) => /Refresh/.test(b.textContent));
    await act(async () => { refresh.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    // Error banner appears but the previous booking row survives.
    expect(text()).toMatch(/Couldn't load your earnings/);
    expect(text()).toMatch(/Neha/);
  });

  test("empty states are helpful", async () => {
    setupApi({ earnings: { overview: { today: 0, thisWeek: 0, pending: 0, paid: 0, lifetime: 0, bonuses: 0 }, bookings: [] }, incentives: [], cycles: [] });
    await renderPage();
    expect(text()).toMatch(/No paid bookings yet/);
    expect(text()).toMatch(/No incentives yet/);
    expect(text()).toMatch(/No payout cycles yet/);
  });

  test("all eight payout statuses have labels", async () => {
    const statuses = ["pending_weekly", "pending", "approved", "paid", "held", "not_eligible", "under_verification", "rejected"];
    setupApi({
      earnings: {
        overview: { today: 0, thisWeek: 0, pending: 0, paid: 0, lifetime: 0, bonuses: 0 },
        bookings: statuses.map((s, k) => ({
          _id: `row${k}`,
          customer: "C",
          date: "2026-10-10T00:00:00.000Z",
          duration: 1,
          finalCustomerPrice: 199,
          platformDeduction: 29.85,
          platformDeductionPercent: 15,
          cookPayout: 169.15,
          payoutStatus: s,
        })),
      },
      incentives: [],
      cycles: statuses.map((s, k) => ({ _id: `cy${k}`, weekStart: "2026-09-28T00:00:00.000Z", status: s, bookingCount: 1, grossCustomerValue: 199, totalDeductions: 29.85, cookEarnings: 169.15, bonuses: 0, referralEarnings: 0, totalPayable: 169.15, payoutRef: `R${k}` })),
    });
    await renderPage();
    const t = text();
    for (const label of ["Pending Weekly Payment", "Pending", "Approved", "Paid", "Held", "Not Eligible", "Under Verification", "Rejected"]) {
      expect(t).toMatch(new RegExp(label));
    }
  });

  test("incentive progress clamps at 100% and badges terminal states", async () => {
    setupApi({
      incentives: [
        { code: "CHAMPION", target: 50, verifiedLeadCount: 99, remaining: 0, reward: 2500, status: "paid", deadline: null },
        { code: "JOINING", target: 10, verifiedLeadCount: 3, remaining: 7, reward: 500, status: "rejected", deadline: null },
      ],
    });
    await renderPage();
    const bars = container.querySelectorAll('[role="progressbar"]');
    expect(bars[0].getAttribute("aria-valuenow")).toBe("100");
    expect(bars[0].querySelector("span").style.width).toBe("100%");
    expect(text()).toMatch(/paid/);
    expect(text()).toMatch(/rejected/);
  });

  test("overview labels distinguish booking earnings from rewards", async () => {
    setupApi();
    await renderPage();
    const overview = container.querySelector('section[aria-label="Earnings overview"]').textContent || "";
    for (const label of ["Pending booking earnings", "Paid booking earnings", "Lifetime booking earnings", "Incentive + referral rewards"]) {
      expect(overview).toContain(label);
    }
    expect(text()).toMatch(/Cycle total payable \(booking earnings only\)/);
  });

  test("Back to bookings navigates to the cook bookings page", async () => {
    setupApi();
    await renderPage();
    const link = container.querySelector('a[href="/dashboard/cook-bookings"]');
    expect(link && link.textContent).toMatch(/Back to bookings/);
  });

  test("slab strip is server-driven, falls back when slabs API fails", async () => {
    setupApi({
      slabs: {
        incentives: [],
        slabs: [
          { leads: 5, reward: 200, days: 7, code: "CUSTOM" },
          { leads: 15, reward: 700, days: 14, code: "CUSTOM2" },
        ],
      },
    });
    await renderPage();
    expect(text()).toMatch(/5 Leads/);
    expect(text()).toMatch(/15 Leads/);
    expect(text()).not.toMatch(/10 Leads/);
  });

  test("slab strip keeps defaults when slabs API fails", async () => {
    setupApi({ slabs: new Error("down") });
    await renderPage();
    expect(text()).toMatch(/10 Leads/);
    expect(text()).toMatch(/50 Leads/);
  });
});
