import React from "react";

global.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import ComplaintForm from "./ComplaintForm";

jest.mock("../api/axios", () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));
jest.mock("../store/hooks", () => ({
  useShowToast: () => jest.fn(),
}));

const API = require("../api/axios").default;

const setTextarea = (el, v) => {
  const proto = window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
// Fallback for jsdom builds where the area prototype lacks its own setter.
const typeMessage = (el, v) => {
  try {
    setTextarea(el, v);
  } catch {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("ComplaintForm (booking details report form)", () => {
  let container;
  let root;
  beforeEach(() => {
    API.post.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderForm = async (props = {}) => {
    await act(async () => {
      root.render(
        <ComplaintForm
          bookingId="b1b1b1b1b1b1b1b1b1b1b1"
          filedBy="cook"
          counterpartyName="Neha"
          {...props}
        />
      );
    });
  };
  const text = () => container.textContent || "";

  test("cook submit posts booking+category+message and shows filed state", async () => {
    API.post.mockResolvedValue({ data: { _id: "c1", status: "open" } });
    await renderForm();
    const area = container.querySelector("#complaint-message");
    await act(async () => {
      typeMessage(area, "The customer was not available at the address.");
    });
    const btn = container.querySelector('button[type="submit"]');
    expect(btn.disabled).toBe(false);
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(API.post).toHaveBeenCalledTimes(1);
    expect(API.post.mock.calls[0][0]).toBe("/complaints");
    expect(API.post.mock.calls[0][1]).toEqual({
      booking: "b1b1b1b1b1b1b1b1b1b1b1",
      category: "behaviour",
      message: "The customer was not available at the address.",
    });
    expect(text()).toMatch(/Complaint filed/);
    expect(text()).toMatch(/Neha/);
  });

  test("customer form defaults to a mappable reason code", async () => {
    API.post.mockResolvedValue({ data: { _id: "c2", status: "open" } });
    await renderForm({ filedBy: "customer", counterpartyName: "Asha" });
    const area = container.querySelector("#complaint-message");
    await act(async () => {
      typeMessage(area, "The cook never arrived at the venue at all.");
    });
    await act(async () => {
      container.querySelector('button[type="submit"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(API.post).toHaveBeenCalledTimes(1);
    // Must be one the server accepts (mapped by CUSTOMER_REASON_MAP).
    expect(["COOK_DID_NOT_ARRIVE", "MAJOR_SERVICE_DEVIATION", "SERVICE_QUALITY_ISSUE", "UNPROFESSIONAL_BEHAVIOR", "OTHER"]).toContain(
      API.post.mock.calls[0][1].category
    );
    expect(text()).toMatch(/Complaint filed/);
  });

  test("short message never posts and explains the minimum", async () => {
    await renderForm();
    const area = container.querySelector("#complaint-message");
    await act(async () => {
      typeMessage(area, "short");
    });
    expect(container.querySelector('button[type="submit"]').disabled).toBe(true);
    await act(async () => {
      container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(API.post).not.toHaveBeenCalled();
    expect(text()).toMatch(/at least 10 characters/);
  });

  test("server rejection surfaces the server message", async () => {
    API.post.mockRejectedValue({ response: { status: 409, data: { message: "A complaint for this booking is already under review." } } });
    await renderForm();
    const area = container.querySelector("#complaint-message");
    await act(async () => {
      typeMessage(area, "Another detailed report about this booking here.");
    });
    await act(async () => {
      container.querySelector('button[type="submit"]').dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(text()).toMatch(/already under review/);
    expect(text()).not.toMatch(/Complaint filed/);
  });
});
