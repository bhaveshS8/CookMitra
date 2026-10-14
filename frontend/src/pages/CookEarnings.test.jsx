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
  overview: { today: 100, thisWeek: 500, pending: 800, paid: 1200, lifetime: 2000 },
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

const CYCLES = [
  { _id: "c1", weekStart: "2026-09-28T00:00:00.000Z", status: "paid", bookingCount: 2, grossCustomerValue: 698, totalDeductions: 104.7, cookEarnings: 593.3, bonuses: 0, referralEarnings: 0, totalPayable: 593.3, payoutRef: "CP-REF1", paymentDate: "2026-10-05T00:00:00.000Z" },
];

const setupApi = ({ earnings = EARNINGS, cycles = CYCLES } = {}) => {
  API.get.mockImplementation((url) => {
    if (url === "/cook/earnings") {
      return earnings instanceof Error ? Promise.reject(earnings) : Promise.resolve({ data: earnings });
    }
    if (url === "/cook/payouts") {
      return cycles instanceof Error ? Promise.reject(cycles) : Promise.resolve({ data: cycles });
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

  test("successful load renders overview, booking row and cycle", async () => {
    setupApi();
    await renderPage();
    expect(text()).toMatch(/My Earnings/);
    expect(text()).toMatch(/Booking earnings/);
    expect(text()).toMatch(/Neha/);
    expect(text()).toMatch(/Your booking earnings/);
    expect(text()).toMatch(/Pending Weekly Payment/);
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
    // shows dashes (cycle rows below may legitimately show ₹0).
    const overview = container.querySelector('section[aria-label="Earnings overview"]').textContent || "";
    expect(overview).not.toMatch(/₹0/);
    expect(overview).toMatch(/—/);
    // Retry works.
    setupApi();
    await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(text()).toMatch(/Neha/);
  });

  test("payout failure does not block the core overview", async () => {
    setupApi({ cycles: new Error("down") });
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
    setupApi({ earnings: { overview: { today: 0, thisWeek: 0, pending: 0, paid: 0, lifetime: 0 }, bookings: [] }, cycles: [] });
    await renderPage();
    expect(text()).toMatch(/No paid bookings yet/);
    expect(text()).toMatch(/No payout cycles yet/);
  });

  test("all eight payout statuses have labels", async () => {
    const statuses = ["pending_weekly", "pending", "approved", "paid", "held", "not_eligible", "under_verification", "rejected"];
    setupApi({
      earnings: {
        overview: { today: 0, thisWeek: 0, pending: 0, paid: 0, lifetime: 0 },
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
      cycles: statuses.map((s, k) => ({ _id: `cy${k}`, weekStart: "2026-09-28T00:00:00.000Z", status: s, bookingCount: 1, grossCustomerValue: 199, totalDeductions: 29.85, cookEarnings: 169.15, bonuses: 0, referralEarnings: 0, totalPayable: 169.15, payoutRef: `R${k}` })),
    });
    await renderPage();
    const t = text();
    for (const label of ["Pending Weekly Payment", "Pending", "Approved", "Paid", "Held", "Not Eligible", "Under Verification", "Rejected"]) {
      expect(t).toMatch(new RegExp(label));
    }
  });

  test("overview labels distinguish booking earnings", async () => {
    setupApi();
    await renderPage();
    const overview = container.querySelector('section[aria-label="Earnings overview"]').textContent || "";
    for (const label of ["Pending booking earnings", "Paid booking earnings", "Lifetime booking earnings"]) {
      expect(overview).toContain(label);
    }
    expect(overview).not.toMatch(/Incentive/);
  });

  test("Back to bookings navigates to the cook bookings page", async () => {
    setupApi();
    await renderPage();
    const link = container.querySelector('a[href="/dashboard/cook-bookings"]');
    expect(link && link.textContent).toMatch(/Back to bookings/);
  });
});
