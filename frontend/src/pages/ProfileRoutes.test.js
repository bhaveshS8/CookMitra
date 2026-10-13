import React from "react";

global.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { configureStore } from "@reduxjs/toolkit";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import authReducer from "../store/authSlice";
import toastReducer from "../store/toastSlice";
import CustomerProfile from "./CustomerProfile";
import {
  ProfilePersonalPage,
  ProfileAddressesPage,
  ProfileActivityPage,
  ProfileSecurityPage,
} from "./ProfileSectionPages";

jest.mock("../api/axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const API = require("../api/axios").default;

const ME = {
  _id: "u1",
  name: "Test User",
  email: "t@example.com",
  phone: "9876543210",
  role: "CUSTOMER",
  status: "active",
  authProvider: "local",
  createdAt: "2024-03-10T00:00:00.000Z",
  savedAddresses: [],
};
const STATS = { upcomingBookings: 1, completedBookings: 2, totalBookings: 3, reviewsGiven: 1 };

const setupApi = () => {
  API.get.mockImplementation((url) => {
    if (url === "/auth/me") return Promise.resolve({ data: ME });
    if (url === "/auth/me/stats") return Promise.resolve({ data: STATS });
    if (url === "/auth/me/addresses") return Promise.resolve({ data: [] });
    if (url === "/bookings/my") return Promise.resolve({ data: [] });
    if (url === "/reviews/my") return Promise.resolve({ data: [] });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
};

const store = () =>
  configureStore({
    reducer: { auth: authReducer, toast: toastReducer },
    preloadedState: {
      auth: { user: { ...ME, role: "customer" }, token: "t", loading: false, error: null },
    },
  });

const renderAt = async (entry, element) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Provider store={store()}>
        <MemoryRouter initialEntries={[entry]}>{element}</MemoryRouter>
      </Provider>
    );
  });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

const routes = (path) => (
  <Routes>
    <Route path="/dashboard/profile" element={<CustomerProfile />} />
    <Route path="/dashboard/profile/personal" element={<ProfilePersonalPage />} />
    <Route path="/dashboard/profile/addresses" element={<ProfileAddressesPage />} />
    <Route path="/dashboard/profile/activity" element={<ProfileActivityPage />} />
    <Route path="/dashboard/profile/security" element={<ProfileSecurityPage />} />
  </Routes>
);

const textOf = (container, selector) =>
  [...container.querySelectorAll(selector)].map((el) => el.textContent);

beforeEach(() => {
  jest.clearAllMocks();
  setupApi();
});

test("overview keeps stats and shows Manage Your Account grid", async () => {
  const { container, cleanup } = await renderAt("/dashboard/profile", routes());
  const body = container.textContent;
  expect(body).toContain("Manage Your Account");
  for (const label of ["Upcoming Bookings", "Completed Bookings", "Total Bookings", "Reviews Given"]) {
    expect(body).toContain(label);
  }
  expect(body).not.toContain("Total Spent");
  const buttons = textOf(container, ".cp-manage-grid .cp-manage-btn");
  expect(buttons).toHaveLength(4);
  for (const label of ["Personal Details", "Saved Addresses", "My Activity", "Security & Privacy"]) {
    expect(buttons.some((t) => t.includes(label))).toBe(true);
  }
  cleanup();
});

test.each([
  ["/dashboard/profile/personal", "Personal Details"],
  ["/dashboard/profile/addresses", "Saved Addresses"],
  ["/dashboard/profile/activity", "My Activity"],
  ["/dashboard/profile/security", "Security & Privacy"],
])("section page %s renders heading and Back to Profile", async (path, heading) => {
  const { container, cleanup } = await renderAt(path, routes(path));
  expect(container.querySelector("h2")?.textContent).toBe(heading);
  expect(container.textContent).toContain("Back to Profile");
  const back = [...container.querySelectorAll("a")].find((a) => a.textContent.includes("Back to Profile"));
  expect(back?.getAttribute("href")).toBe("/dashboard/profile");
  cleanup();
});

test("legacy ?tab= link redirects to the section route", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <Provider store={store()}>
        <MemoryRouter initialEntries={["/dashboard/profile?tab=addresses"]}>{routes()}</MemoryRouter>
      </Provider>
    );
  });
  await act(async () => {});
  expect(container.querySelector("h2")?.textContent).toBe("Saved Addresses");
  act(() => root.unmount());
  container.remove();
});
