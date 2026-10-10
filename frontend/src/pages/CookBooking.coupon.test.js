import React from "react";

global.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { MemoryRouter } from "react-router-dom";
import authReducer from "../store/authSlice";
import toastReducer from "../store/toastSlice";
import locationReducer from "../store/locationSlice";
import CookBooking from "./CookBooking";
import { formatCurrency } from "../utils/constants";

jest.mock("../api/axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn(), patch: jest.fn() },
}));
jest.mock("../utils/analytics", () => ({
  AnalyticsEvents: {
    BOOKING_REQUESTED: "booking_requested",
    SLOT_SELECTED: "slot_selected",
  },
  track: jest.fn(),
}));

const API = require("../api/axios").default;

const setInput = (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const setSelect = (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
  setter.call(el, v);
  el.dispatchEvent(new Event("change", { bubbles: true }));
};
const click = (el) => {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};
const byText = (container, tag, text) =>
  [...container.querySelectorAll(tag)].find((el) => (el.textContent || "").includes(text));

describe("CookBooking Step-3 coupon flow", () => {
  let container;
  let root;
  let bookingPosts;
  beforeEach(() => {
    API.get.mockReset();
    API.post.mockReset();
    API.patch.mockReset();
    bookingPosts = [];
    window.matchMedia = window.matchMedia || (() => ({ matches: false }));
    try {
      window.localStorage.clear();
    } catch {
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const cook = { user: { _id: "cook1", name: "Chef A" }, slots: [{ startTime: "10:00", endTime: "12:00" }] };
  const setupApi = () => {
    API.get.mockImplementation((url) => {
      if (String(url).includes("/bookings/my/locations")) return Promise.resolve({ data: [] });
      if (String(url).includes("/bookings/verification/status")) {
        return Promise.resolve({ data: { blocked: false } });
      }
      if (String(url).includes("/availability/search")) {
        return Promise.resolve({ data: { cooks: [cook], suggestions: [], totalCooks: 1 } });
      }
      if (String(url).endsWith("/cooks")) {
        return Promise.resolve({ data: [cook] });
      }
      return Promise.reject({ response: { status: 404, data: {} } });
    });
    API.post.mockImplementation((url, body) => {
      if (String(url).includes("/coupons/validate")) {
        if (String(body?.code) === "WELCOME50") {
          return Promise.resolve({ data: { code: "WELCOME50", discount: 50, payable: 299, fullFee: 349 } });
        }
        return Promise.reject({ response: { status: 400, data: { message: "This coupon is not valid for this booking." } } });
      }
      if (String(url).includes("/bookings")) {
        bookingPosts.push(body);
        return Promise.resolve({ data: { _id: "bk1" } });
      }
      return Promise.reject({ response: { status: 404, data: {} } });
    });
  };

  const renderPage = async () => {
    const store = configureStore({
      reducer: { auth: authReducer, toast: toastReducer, location: locationReducer },
      preloadedState: {
        auth: {
          user: { _id: "cust1", name: "T", role: "customer", phone: "9000000001", address: "" },
          loading: false,
        },
        toast: { toasts: [] },
        location: { location: null, status: "idle", error: null },
      },
    });
    await act(async () => {
      root.render(
        <Provider store={store}>
          <MemoryRouter initialEntries={["/cook-on-demand"]}>
            <CookBooking />
          </MemoryRouter>
        </Provider>
      );
    });
  };

  const goToStep3 = async () => {
    // Step 1 -> 2-hour session booked for tomorrow (slot never in the past,
    // and WELCOME50's ₹349 minimum is genuinely satisfied).
    await act(async () => {
      click(byText(container, "button", "Tomorrow"));
    });
    await act(async () => {
      click(byText(container, "button", "2 hrs"));
    });
    await act(async () => {
      container.querySelector(".ondemand-form-card").dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true })
      );
    });
    expect(container.textContent).toContain("Pick a time slot");
    // Step 2 -> pick the only slot and continue.
    await act(async () => {
      click(container.querySelector(".slot-chip-pick"));
    });
    await act(async () => {
      click(byText(container, "button", "Continue"));
    });
    expect(container.textContent).toContain("What dishes do you need?");
  };

  const fillVenue = async () => {
    await act(async () => {
      setInput(container.querySelector('input[name="flatNo"]'), "A-402");
      setInput(container.querySelector('input[name="society"]'), "Sunshine");
      setSelect(container.querySelector('select[name="city"]'), "Hadapsar");
      setInput(container.querySelector('input[name="customDishes"]'), "Dal, Rice");
    });
  };

  const answerYes = async () => {
    await act(async () => {
      click(container.querySelector('[data-testid="wp-yes"]'));
    });
  };

  const applyCoupon = async (code) => {
    await act(async () => {
      setInput(container.querySelector(".coupon-input"), code);
    });
    await act(async () => {
      click(container.querySelector(".coupon-apply-btn"));
    });
  };

  test("valid coupon updates Step-3 totals from the server response", async () => {
    setupApi();
    await renderPage();
    await goToStep3();
    await fillVenue();
    await answerYes();
    // Before the coupon: full 1-hour slab.
    expect(container.textContent).toContain(formatCurrency(349));
    await applyCoupon("welcome50");
    // Step 3 shows the server-validated breakdown: code + discount + final.
    expect(container.textContent).toContain("Coupon WELCOME50");
    expect(container.textContent).toContain(formatCurrency(50));
    expect(container.textContent).toContain(formatCurrency(299));
  });

  test("removing the coupon restores the full Step-3 price", async () => {
    setupApi();
    await renderPage();
    await goToStep3();
    await fillVenue();
    await answerYes();
    await applyCoupon("WELCOME50");
    expect(container.textContent).toContain(formatCurrency(299));
    await act(async () => {
      click(container.querySelector(".coupon-remove"));
    });
    expect(container.textContent).not.toContain("Coupon WELCOME50");
    expect(container.textContent).toContain(formatCurrency(349));
  });

  test("Find Cook sends the validated coupon code for server-side booking", async () => {
    setupApi();
    await renderPage();
    await goToStep3();
    await fillVenue();
    await answerYes();
    await applyCoupon("WELCOME50");
    await act(async () => {
      click(container.querySelector(".od-cta"));
    });
    expect(bookingPosts.length).toBe(1);
    expect(bookingPosts[0].couponCode).toBe("WELCOME50");
    expect(bookingPosts[0].womanPresenceConfirmed).toBe(true);
    expect(bookingPosts[0].durationHours).toBe(2);
  });

  test("invalid coupon leaves Step-3 totals untouched with a clear error", async () => {
    setupApi();
    await renderPage();
    await goToStep3();
    await fillVenue();
    await answerYes();
    await applyCoupon("BOGUS99");
    expect(container.textContent).toMatch(/not valid/i);
    expect(container.textContent).toContain(formatCurrency(349));
    expect(container.textContent).not.toContain("Coupon BOGUS99");
  });
});
