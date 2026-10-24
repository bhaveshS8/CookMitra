import React from "react";

global.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import AdminWeeklyPayouts, {
  validateReceiptFile,
  RECEIPT_MAX_BYTES,
} from "./AdminWeeklyPayouts";
import {
  mondayOfWeekIST,
  weekKeyIST,
  formatWeekLabel,
} from "../utils/weeklyPayout";

jest.mock("../api/axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn(), patch: jest.fn() },
}));
jest.mock("../store/hooks", () => ({
  useShowToast: () => jest.fn(),
}));

const API = require("../api/axios").default;

describe("weeklyPayout week helpers (IST Monday–Sunday)", () => {
  test("monday maps to itself at 00:00 IST", () => {
    expect(mondayOfWeekIST("2026-10-05")?.toISOString()).toBe("2026-10-04T18:30:00.000Z");
  });
  test("sunday night stays in the same week", () => {
    expect(mondayOfWeekIST(new Date("2026-10-11T18:00:00Z"))?.toISOString()).toBe(
      "2026-10-04T18:30:00.000Z"
    );
  });
  test("next monday starts a new week", () => {
    expect(mondayOfWeekIST("2026-10-12")?.toISOString()).toBe("2026-10-11T18:30:00.000Z");
  });
  test("week key is the IST monday date", () => {
    expect(weekKeyIST("2026-10-07")).toBe("2026-10-05");
  });
  test("week label spans Mon–Sun", () => {
    expect(formatWeekLabel(mondayOfWeekIST("2026-10-07"))).toMatch(/5 Oct.*11 Oct/);
  });
  test("garbage input returns null", () => {
    expect(mondayOfWeekIST("junk")).toBe(null);
    expect(weekKeyIST("junk")).toBe(null);
  });
});

describe("validateReceiptFile", () => {
  const png = { type: "image/png", size: 1024, name: "r.png" };
  test("missing file rejected", () => {
    expect(validateReceiptFile(null)).toMatch(/required/);
  });
  test("non-image rejected", () => {
    expect(validateReceiptFile({ type: "application/pdf", size: 100 })).toMatch(/JPG, PNG or WEBP/);
  });
  test("oversize rejected", () => {
    expect(validateReceiptFile({ ...png, size: RECEIPT_MAX_BYTES + 1 })).toMatch(/5MB/);
  });
  test("empty file rejected", () => {
    expect(validateReceiptFile({ ...png, size: 0 })).toMatch(/empty/);
  });
  test("valid photo accepted", () => {
    expect(validateReceiptFile(png)).toBe("");
  });
});

describe("AdminWeeklyPayouts tabs", () => {
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

  const pendingPayload = {
    week: { label: "5 Oct – 11 Oct" },
    totals: { totalPayable: 889.95, settled: 0, remaining: 889.95, cookCount: 2, cycleCount: 2, bookingCount: 3 },
    records: [
      {
        _id: "c1c1c1c1c1c1c1c1c1c1c1",
        cook: { _id: "k1k1k1k1k1k1k1k1k1k1k1", name: "Asha", phone: "9876543210" },
        bookingCount: 2,
        grossCustomerValue: 698,
        cookEarnings: 593.3,
        totalPayable: 593.3,
        settledAmount: 0,
        remainingPayable: 593.3,
        status: "approved",
        week: { label: "5 Oct – 11 Oct" },
      },
    ],
  };
  const completedPayload = {
    week: { label: "5 Oct – 11 Oct" },
    totals: { totalPayable: 593.3, settled: 593.3, remaining: 0, totalPaid: 593.3, cookCount: 1, cycleCount: 1, bookingCount: 2 },
    records: [
      {
        ...pendingPayload.records[0],
        status: "paid",
        settledAmount: 593.3,
        remainingPayable: 0,
        paymentMethod: "upi",
        paymentReference: "UPI-WEEK-001",
        receiptUrl: "/uploads/cook-docs/payout_admin_1.png",
        settledBy: { name: "Ops Admin" },
        paidAt: "2026-10-13T00:00:00.000Z",
      },
    ],
  };

  const renderTab = async (mode, payload) => {
    API.get.mockResolvedValue({ data: payload });
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AdminWeeklyPayouts mode={mode} />
        </MemoryRouter>
      );
    });
  };
  const text = () => container.textContent || "";

  test("pending tab shows week totals and settle action", async () => {
    await renderTab("pending", pendingPayload);
    expect(text()).toMatch(/Pending Payouts/);
    expect(text()).toMatch(/Earning week/);
    expect(text()).toMatch(/Asha/);
    expect(text()).toMatch(/2 eligible bookings/);
    expect(text()).toMatch(/Remaining/);
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      /Settle payout/.test(b.textContent)
    );
    expect(btn).toBeTruthy();
  });

  test("pending tab opens the settlement dialog", async () => {
    await renderTab("pending", pendingPayload);
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      /Settle payout/.test(b.textContent)
    );
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(text()).toMatch(/Settle weekly payout/);
    expect(text()).toMatch(/Transaction \/ reference ID/);
    expect(text()).toMatch(/Receipt \/ proof photo/);
    expect(text()).toMatch(/remaining payable/);
  });

  test("completed tab shows payment evidence and receipt viewer", async () => {
    await renderTab("completed", completedPayload);
    expect(text()).toMatch(/Completed Payments/);
    expect(text()).toMatch(/UPI-WEEK-001/);
    expect(text()).toMatch(/Ops Admin/);
    expect(text()).toMatch(/UPI/);
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      /View receipt/.test(b.textContent)
    );
    expect(btn).toBeTruthy();
  });

  test("empty states are helpful", async () => {
    await renderTab("pending", { week: { label: "x" }, totals: {}, records: [] });
    expect(text()).toMatch(/No pending payouts this week/);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AdminWeeklyPayouts mode="completed" />
        </MemoryRouter>
      );
    });
    API.get.mockResolvedValue({ data: { week: { label: "x" }, totals: {}, records: [] } });
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AdminWeeklyPayouts mode="completed" key="c" />
        </MemoryRouter>
      );
    });
    expect(text()).toMatch(/No completed payments this week/);
  });
});
