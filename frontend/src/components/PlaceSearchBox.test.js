import React from "react";

global.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import PlaceSearchBox, { localPlaceSource, SEARCH_MIN_LENGTH } from "./PlaceSearchBox";

const setInput = (el, v) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const SAVED = [
  { address: "A-402, Sunshine Society, Hadapsar", addressDetails: { flatNo: "A-402", society: "Sunshine Society", landmark: "", city: "Hadapsar" }, location: { lat: 18.5, lng: 73.8 }, timesUsed: 3 },
  { address: "B-7, Lakeview, Manjri", addressDetails: { flatNo: "B-7", society: "Lakeview", landmark: "", city: "Manjri" }, location: null, timesUsed: 1 },
];

describe("localPlaceSource", () => {
  const src = localPlaceSource({ savedPlaces: SAVED, areas: ["Hadapsar", "Manjri"] });
  test("matches saved places and areas, caps results", () => {
    const r = src("hadapsar");
    expect(r.length).toBeGreaterThan(0);
    expect(r.length).toBeLessThanOrEqual(6);
    expect(r[0].kind).toBe("saved");
    expect(r[0].lat).toBe(18.5);
    const areas = src("manj");
    expect(areas.some((p) => p.kind === "area" && p.lat === null)).toBe(true);
  });
  test("minimum length enforced, no-match is empty", () => {
    expect(src("h")).toEqual([]);
    expect(src("zzz-no-such-place")).toEqual([]);
  });
  test("area hits carry no coordinates (never a pin)", () => {
    for (const p of src("hadapsar").filter((p) => p.kind === "area")) {
      expect(p.lat).toBeNull();
      expect(p.lng).toBeNull();
    }
  });
  test("SEARCH_MIN_LENGTH is 2", () => {
    expect(SEARCH_MIN_LENGTH).toBe(2);
  });
});

describe("PlaceSearchBox", () => {
  let container;
  let root;
  let picks;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    picks = [];
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderBox = async (props = {}) => {
    await act(async () => {
      root.render(
        <PlaceSearchBox
          id="ps-test"
          value=""
          onChange={() => {}}
          onPick={(p) => picks.push(p)}
          getSuggestions={async () => []}
          {...props}
        />
      );
    });
  };
  const rerenderBox = async (props = {}) => {
    await act(async () => {
      root.render(
        <PlaceSearchBox
          id="ps-test"
          value=""
          onChange={() => {}}
          onPick={(p) => picks.push(p)}
          getSuggestions={async () => []}
          {...props}
        />
      );
    });
  };
  const input = () => container.querySelector(".place-search-input");

  test("short queries show nothing and call nothing", async () => {
    const spy = jest.fn(async () => []);
    await renderBox({ getSuggestions: spy });
    await act(async () => {
      root.render(
        <PlaceSearchBox id="ps-test" value="h" onChange={() => {}} onPick={(p) => picks.push(p)} getSuggestions={spy} />
      );
    });
    await act(async () => { await sleep(400); });
    expect(spy).not.toHaveBeenCalled();
    expect(container.querySelector(".place-search-list")).toBeNull();
  });

  test("debounced suggestions render; stale responses discarded", async () => {
    const resolvers = {};
    const spy = jest.fn((q) => new Promise((res) => { resolvers[q] = res; }));
    let value = "";
    const render = async () => {
      await act(async () => {
        root.render(
          <PlaceSearchBox id="ps-test" value={value} onChange={(v) => { value = v; }} onPick={(p) => picks.push(p)} getSuggestions={spy} />
        );
      });
    };
    await render();
    await act(async () => {
      setInput(input(), "had");
    });
    await render(); // parent commits the keystroke
    await act(async () => { await sleep(400); });
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => {
      setInput(input(), "hadapsar");
    });
    await render(); // parent commits the keystroke
    await act(async () => { await sleep(400); });
    expect(spy).toHaveBeenCalledTimes(2);
    // Old query resolves late with junk — must be ignored.
    await act(async () => {
      resolvers.had([{ label: "STALE", city: "", area: "", state: "", lat: 1, lng: 1, kind: "saved" }]);
      resolvers.hadapsar([{ label: "FRESH", city: "", area: "", state: "", lat: 2, lng: 2, kind: "saved" }]);
    });
    expect(container.textContent).toContain("FRESH");
    expect(container.textContent).not.toContain("STALE");
  });

  test("keyboard: arrows move, Enter picks highlighted only", async () => {
    const rows = [
      { label: "One", city: "", area: "", state: "", lat: 1, lng: 1, kind: "saved" },
      { label: "Two", city: "", area: "", state: "", lat: 2, lng: 2, kind: "saved" },
    ];
    let value = "on";
    await act(async () => {
      root.render(
        <PlaceSearchBox id="ps-test" value={value} onChange={(v) => { value = v; }} onPick={(p) => picks.push(p)} getSuggestions={async () => rows} />
      );
    });
    await act(async () => { await sleep(400); });
    // Enter with nothing highlighted picks nothing.
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(picks.length).toBe(0);
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(picks.length).toBe(1);
    expect(picks[0].label).toBe("One");
    // Escape closes the list.
    await act(async () => {
      input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".place-search-list")).toBeNull();
  });

  test("click picks the row atomically; error + retry shown on failure", async () => {
    const row = { label: "Home", city: "Pune", area: "", state: "", lat: 1, lng: 2, kind: "saved" };
    let fail = true;
    const spy = jest.fn(async () => {
      if (fail) throw new Error("down");
      return [row];
    });
    let value = "hom";
    await act(async () => {
      root.render(
        <PlaceSearchBox id="ps-test" value={value} onChange={(v) => { value = v; }} onPick={(p) => picks.push(p)} getSuggestions={spy} />
      );
    });
    await act(async () => { await sleep(400); });
    expect(container.textContent).toMatch(/isn't working/i);
    fail = false;
    await act(async () => {
      container.querySelector(".place-search-retry").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Home");
    await act(async () => {
      container.querySelector(".place-search-opt").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(picks.length).toBe(1);
    expect(picks[0]).toEqual(row);
    // List closes after picking.
    expect(container.querySelector(".place-search-list")).toBeNull();
  });

  test("attribution renders when provided", async () => {
    await renderBox({ attribution: "Test attribution" });
    expect(container.textContent).toContain("Test attribution");
  });
});
