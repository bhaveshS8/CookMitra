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

jest.mock("../api/axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn(), patch: jest.fn() },
}));
jest.mock("../utils/analytics", () => ({
  AnalyticsEvents: { BOOKING_REQUESTED: "booking_requested", SLOT_SELECTED: "slot_selected" },
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
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const GPS_FIX = {
  lat: 18.5204,
  lng: 73.8567,
  accuracy: 25,
  timestamp: Date.now(),
  savedAt: Date.now(),
  source: "gps",
  label: "Hadapsar, Pune",
  fullAddress: "A-402, Magarpatta Road, Hadapsar, Pune",
  displayName: "",
  city: "Pune",
  area: "Hadapsar",
  street: "Magarpatta Road",
  state: "Maharashtra",
  postcode: "411028",
  exactLine: "A-402",
  hasHouseNumber: true,
};

describe("CookBooking location consistency", () => {
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
      window.sessionStorage.clear();
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
  const setupApi = (saved = []) => {
    API.get.mockImplementation((url) => {
      if (String(url).includes("/bookings/my/locations")) return Promise.resolve({ data: saved });
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
        return Promise.reject({ response: { status: 400, data: { message: "no" } } });
      }
      if (String(url).includes("/bookings")) {
        bookingPosts.push(body);
        return Promise.resolve({ data: { _id: "bk1" } });
      }
      return Promise.reject({ response: { status: 404, data: {} } });
    });
  };

  const renderPage = async (siteLocation = GPS_FIX) => {
    const store = configureStore({
      reducer: { auth: authReducer, toast: toastReducer, location: locationReducer },
      preloadedState: {
        auth: {
          user: { _id: "cust1", name: "T", role: "customer", phone: "9000000001", address: "" },
          loading: false,
        },
        toast: { toasts: [] },
        location: { location: siteLocation, status: "ready", error: null },
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
      setInput(container.querySelector('input[name="flatNo"]'), "B-9");
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

  const findCook = async () => {
    await act(async () => {
      click(container.querySelector(".od-cta"));
    });
  };

  test("unaccepted GPS never becomes a pin (suggestion only)", async () => {
    setupApi();
    await renderPage();
    await goToStep3();
    // The suggestion is offered, not applied.
    expect(container.querySelector('[data-testid="od-detected-suggestion"]')).not.toBeNull();
    await fillVenue();
    await answerYes();
    await findCook();
    expect(bookingPosts.length).toBe(1);
    // Typed address books WITHOUT the background GPS pin.
    expect(bookingPosts[0].location).toBeUndefined();
    expect(bookingPosts[0].address).toContain("B-9");
  });

  test("explicitly accepted GPS attaches its pin", async () => {
    setupApi();
    await renderPage();
    await goToStep3();
    await act(async () => {
      click(byText(container, "button", "Use detected location"));
    });
    await act(async () => {
      setInput(container.querySelector('input[name="customDishes"]'), "Dal, Rice");
    });
    await answerYes();
    await findCook();
    expect(bookingPosts.length).toBe(1);
    expect(bookingPosts[0].location).toEqual({ lat: 18.5204, lng: 73.8567 });
    expect(bookingPosts[0].address).toContain("Magarpatta");
  });

  test("editing after a saved place drops the stale pin", async () => {
    setupApi([
      {
        address: "A-402, Sunshine Society, Hadapsar",
        addressDetails: { flatNo: "A-402", society: "Sunshine Society", landmark: "", city: "Hadapsar" },
        location: { lat: 18.5, lng: 73.8 },
        timesUsed: 2,
      },
    ]);
    await renderPage(null);
    await goToStep3();
    await act(async () => {
      setSelect(container.querySelector("#od-saved-select"), "0");
    });
    // Pin bound: would attach…
    await fillVenue();
    await act(async () => {
      setInput(container.querySelector('input[name="customDishes"]'), "Dal, Rice");
    });
    await answerYes();
    // …but the flat-number edit broke the binding first.
    await act(async () => {
      setInput(container.querySelector('input[name="flatNo"]'), "B-9-edited");
    });
    await findCook();
    expect(bookingPosts.length).toBe(1);
    expect(bookingPosts[0].location).toBeUndefined();
    expect(bookingPosts[0].address).toContain("B-9-edited");
  });

  test("saved place picked intact keeps its pin", async () => {
    setupApi([
      {
        address: "A-402, Sunshine Society, Hadapsar",
        addressDetails: { flatNo: "A-402", society: "Sunshine Society", landmark: "", city: "Hadapsar" },
        location: { lat: 18.5, lng: 73.8 },
        timesUsed: 2,
      },
    ]);
    await renderPage(null);
    await goToStep3();
    await act(async () => {
      setSelect(container.querySelector("#od-saved-select"), "0");
    });
    await act(async () => {
      setInput(container.querySelector('input[name="customDishes"]'), "Dal, Rice");
    });
    await answerYes();
    await findCook();
    expect(bookingPosts.length).toBe(1);
    expect(bookingPosts[0].location).toEqual({ lat: 18.5, lng: 73.8 });
  });

  test("search pick with coordinates attaches the pin", async () => {
    setupApi([
      {
        address: "A-402, Sunshine Society, Hadapsar",
        addressDetails: { flatNo: "A-402", society: "Sunshine Society", landmark: "", city: "Hadapsar" },
        location: { lat: 18.5, lng: 73.8 },
        timesUsed: 2,
      },
    ]);
    await renderPage(null);
    await goToStep3();
    await act(async () => {
      setInput(container.querySelector("#od-place-search"), "sunshine");
      await sleep(450);
    });
    expect(container.querySelector(".place-search-list")).not.toBeNull();
    await act(async () => {
      click(container.querySelector(".place-search-opt"));
    });
    await act(async () => {
      setInput(container.querySelector('input[name="customDishes"]'), "Dal, Rice");
    });
    await answerYes();
    await findCook();
    expect(bookingPosts.length).toBe(1);
    expect(bookingPosts[0].location).toEqual({ lat: 18.5, lng: 73.8 });
    expect(bookingPosts[0].address).toContain("Sunshine");
  });
});
