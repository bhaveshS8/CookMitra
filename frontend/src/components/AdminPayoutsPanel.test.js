import React from "react";

global.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import AdminPayoutsPanel from "./AdminPayoutsPanel";

jest.mock("../api/axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn(), patch: jest.fn() },
}));
jest.mock("../store/hooks", () => ({
  useShowToast: () => jest.fn(),
}));

const API = require("../api/axios").default;

// Queue rows shaped exactly like GET /payouts/queue enriches them.
const legacyRow = {
  _id: "b1b1b1b1b1b1b1b1b1b1b1",
  serviceType: "cook_for_me",
  date: "2026-10-10T00:00:00.000Z",
  startTime: "10:00",
  endTime: "12:00",
  amount: 349,
  commission: 52.35,
  cookPayout: 296.65,
  cook: { name: "Asha", phone: "9876543210" },
  payoutEligible: false,
  payoutBlockers: ["Service was never started (no OTP verification)", "Cook arrival was never recorded"],
  payoutOverrideAllowed: true,
  cookPayoutDetails: { upiId: "asha@upi" },
};
const moneyBlockedRow = {
  ...legacyRow,
  _id: "c2c2c2c2c2c2c2c2c2c2c2",
  payoutBlockers: ["Customer refund is pending — resolve it first"],
  payoutOverrideAllowed: false,
};

describe("AdminPayoutsPanel (cook payouts tab)", () => {
  let container;
  let root;
  beforeEach(() => {
    API.post.mockReset();
    API.get.mockReset();
    API.patch.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderPanel = async (rows) => {
    API.get.mockImplementation((url) => {
      if (String(url).startsWith("/payouts/queue")) {
        return Promise.resolve({ data: { data: rows, pagination: { page: 1, limit: 25, total: rows.length, totalPages: 1 } } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    await act(async () => {
      root.render(<AdminPayoutsPanel view="payouts" />);
    });
  };
  const text = () => container.textContent || "";
  const buttons = () => Array.from(container.querySelectorAll("button"));

  test("legacy overridable row offers Verify & mark paid (not disabled)", async () => {
    await renderPanel([legacyRow]);
    expect(text()).toMatch(/Asha/);
    const mark = buttons().find((b) => /mark paid/i.test(b.textContent));
    expect(mark).toBeTruthy();
    expect(mark.disabled).toBe(false);
    expect(mark.textContent).toMatch(/Verify/);
  });

  test("money-blocked row stays disabled with no override", async () => {
    await renderPanel([moneyBlockedRow]);
    const mark = buttons().find((b) => /mark paid/i.test(b.textContent));
    expect(mark).toBeTruthy();
    expect(mark.disabled).toBe(true);
    expect(text()).not.toMatch(/Verification override/);
  });

  test("settle form shows override controls and sends them on confirm", async () => {
    API.patch.mockResolvedValue({ data: { _id: legacyRow._id } });
    await renderPanel([legacyRow]);
    await act(async () => {
      buttons().find((b) => /mark paid/i.test(b.textContent)).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(text()).toMatch(/Verification override/);
    const confirm = buttons().find((b) => /Confirm paid/i.test(b.textContent));
    // Blocked until transfer ticked AND override ticked with a reason.
    expect(confirm.disabled).toBe(true);
    const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
    expect(boxes.length).toBe(2);
    const refInput = container.querySelector('input[placeholder="UPI / bank ref"]');
    const reasonInput = container.querySelector('input[placeholder^="How was it verified"]');
    expect(refInput && reasonInput).toBeTruthy();
    const setNative = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setNative(refInput, "UPI-LEG-001");
      setNative(reasonInput, "Called customer, service confirmed delivered");
      boxes[0].click();
      boxes[1].click();
    });
    expect(buttons().find((b) => /Confirm paid/i.test(b.textContent)).disabled).toBe(false);
    await act(async () => {
      buttons().find((b) => /Confirm paid/i.test(b.textContent)).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(API.patch).toHaveBeenCalledTimes(1);
    expect(API.patch.mock.calls[0][0]).toBe(`/payouts/${legacyRow._id}/settle`);
    expect(API.patch.mock.calls[0][1]).toEqual({
      reference: "UPI-LEG-001",
      verificationOverride: true,
      overrideReason: "Called customer, service confirmed delivered",
    });
  });

  test("eligible row settles without any override payload", async () => {
    API.patch.mockResolvedValue({ data: { _id: "e1" } });
    await renderPanel([{ ...legacyRow, payoutEligible: true, payoutBlockers: [], payoutOverrideAllowed: false }]);
    await act(async () => {
      buttons().find((b) => /mark paid/i.test(b.textContent)).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(text()).not.toMatch(/Verification override/);
    const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]'));
    expect(boxes.length).toBe(1);
  });
});
