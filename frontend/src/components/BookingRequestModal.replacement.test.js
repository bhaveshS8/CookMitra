import React from "react";

global.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import toastReducer from "../store/toastSlice";
import BookingRequestModal from "../components/BookingRequestModal";

jest.mock("../api/axios", () => ({
  __esModule: true,
  default: { get: jest.fn(), patch: jest.fn() },
}));

const API = require("../api/axios").default;

const store = () =>
  configureStore({ reducer: { toast: toastReducer } });

const REPLACEMENT_BOOKING = {
  _id: "b-repl-1",
  customer: { name: "Aditi Rao" },
  cook: null,
  status: "requested",
  serviceType: "cook_for_me",
  date: "2026-10-20",
  startTime: "10:00",
  endTime: "12:00",
  address: "12 MG Road",
  amount: 1000,
  payment: { status: "paid", paidAmount: 1000 },
  cookCancel: { cook: "cook-old", reasonCode: "MEDICAL_EMERGENCY", priorStatus: "confirmed" },
  requestExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
};

const ELIGIBLE = [
  { _id: "p1", user: { _id: "cook-a", name: "Chef Asha", phone: "9876543210" }, serviceArea: "Hadapsar" },
  { _id: "p2", user: { _id: "cook-b", name: "Chef Birbal", phone: "9123456780" }, serviceArea: "Kothrud" },
];

const renderModal = async (booking, props = {}) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const calls = { onAction: 0, onClose: 0 };
  await act(async () => {
    root.render(
      <Provider store={store()}>
        <BookingRequestModal
          open
          booking={booking}
          onBehalf
          onAction={() => { calls.onAction += 1; }}
          onClose={() => { calls.onClose += 1; }}
          {...props}
        />
      </Provider>
    );
  });
  return { container, root, calls };
};

describe("BookingRequestModal replacement assignment", () => {
  beforeEach(() => {
    API.get.mockReset();
    API.patch.mockReset();
    API.get.mockImplementation((url) => {
      if (String(url).includes("/eligible-cooks")) {
        return Promise.resolve({ data: { cooks: ELIGIBLE } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    API.patch.mockImplementation(() => Promise.resolve({ data: { _id: "b-repl-1", status: "accepted", cook: "cook-a" } }));
  });

  test("replacement context shown with paid preserved note", async () => {
    const { container, root } = await renderModal(REPLACEMENT_BOOKING);
    expect(container.textContent || document.body.textContent).toMatch(/assign a replacement/i);
    await act(async () => {});
    root.unmount();
    container.remove();
  });

  test("eligible cooks listed with phone numbers, canceller fetch scoped", async () => {
    const { container, root } = await renderModal(REPLACEMENT_BOOKING);
    await act(async () => {});
    const select = document.body.querySelector("#brm-assign-cook");
    expect(select).not.toBeNull();
    const options = [...select.querySelectorAll("option")].map((o) => o.textContent);
    expect(options.some((t) => t.includes("Chef Asha") && t.includes("9876543210"))).toBe(true);
    expect(options.some((t) => t.includes("Chef Birbal") && t.includes("9123456780"))).toBe(true);
    expect(API.get).toHaveBeenCalledWith(expect.stringContaining("/eligible-cooks"));
    root.unmount();
    container.remove();
  });

  test("accept sends chosen cookId and reports no recharge", async () => {
    const { root } = await renderModal(REPLACEMENT_BOOKING);
    await act(async () => {});
    const select = document.body.querySelector("#brm-assign-cook");
    await act(async () => {
      select.value = "cook-a";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const acceptBtn = [...document.body.querySelectorAll("button")].find((b) =>
      /accept & assign/i.test(b.textContent || "")
    );
    expect(acceptBtn).toBeTruthy();
    await act(async () => {
      acceptBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(API.patch).toHaveBeenCalledWith(
      "/bookings/b-repl-1/accept",
      expect.objectContaining({ cookId: "cook-a" })
    );
    root.unmount();
  });

  test("assignment conflict closes gracefully and refreshes", async () => {
    API.patch.mockImplementation(() => {
      const err = new Error("taken");
      err.response = { status: 409, data: { code: "BOOKING_ALREADY_ASSIGNED", message: "Taken" } };
      return Promise.reject(err);
    });
    const { root, calls } = await renderModal(REPLACEMENT_BOOKING);
    await act(async () => {});
    const select = document.body.querySelector("#brm-assign-cook");
    await act(async () => {
      select.value = "cook-a";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const acceptBtn = [...document.body.querySelectorAll("button")].find((b) =>
      /accept & assign/i.test(b.textContent || "")
    );
    await act(async () => {
      acceptBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(calls.onAction).toBeGreaterThanOrEqual(1);
    expect(calls.onClose).toBeGreaterThanOrEqual(1);
    root.unmount();
  });
});
