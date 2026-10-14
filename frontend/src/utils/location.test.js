import React from "react";

global.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react-dom/test-utils";
import { configureStore } from "@reduxjs/toolkit";
import locationReducer, {
  initLocation,
  requestPreciseLocation,
  setManualLocation,
  clearLocation,
} from "../store/locationSlice";
import * as geo from "../utils/geolocation";

jest.mock("../utils/geolocation", () => {
  const actual = jest.requireActual("../utils/geolocation");
  return {
    ...actual,
    getCurrentPositionRobust: jest.fn(),
    reverseGeocode: jest.fn(),
    fetchIpLocation: jest.fn(),
  };
});

const GPS = { lat: 18.5204, lng: 73.8567, accuracy: 25, timestamp: Date.now() };
const GEO = {
  city: "Pune", area: "Hadapsar", state: "Maharashtra", street: "Magarpatta Road",
  suburb: "Hadapsar", postcode: "411028", houseNumber: "A-402",
  displayName: "A-402, Magarpatta Road, Hadapsar, Pune, Maharashtra 411028",
};

const makeStore = () =>
  configureStore({ reducer: { location: locationReducer } });

describe("geolocation utils (simulated browser GPS)", () => {
  const setNavigator = (value) => {
    Object.defineProperty(window.navigator, "geolocation", {
      value,
      configurable: true,
      writable: true,
    });
  };
  const clearNavigator = () => {
    try {
      delete window.navigator.geolocation;
    } catch {
      setNavigator(undefined);
    }
  };
  afterEach(() => {
    clearNavigator();
    jest.restoreAllMocks();
  });

  test("watch success commits the best fix", async () => {
    const actual = jest.requireActual("../utils/geolocation");
    setNavigator({
      watchPosition: (ok) => {
        setTimeout(() => ok({ coords: { latitude: 18.5, longitude: 73.8, accuracy: 30 }, timestamp: Date.now() }), 5);
        return 7;
      },
      clearWatch: jest.fn(),
      getCurrentPosition: jest.fn(),
    });
    const pos = await actual.getCurrentPositionRobust({ watchMs: 60 });
    expect(pos.lat).toBe(18.5);
    expect(pos.lng).toBe(73.8);
  });

  test("good-enough fix settles the watch early", async () => {
    const actual = jest.requireActual("../utils/geolocation");
    let cleared = false;
    setNavigator({
      watchPosition: (ok) => {
        setTimeout(() => ok({ coords: { latitude: 1, longitude: 2, accuracy: 20 }, timestamp: Date.now() }), 5);
        setTimeout(() => ok({ coords: { latitude: 1, longitude: 2, accuracy: 10 }, timestamp: Date.now() }), 5000);
        return 9;
      },
      clearWatch: () => { cleared = true; },
      getCurrentPosition: jest.fn(),
    });
    const t0 = Date.now();
    await actual.getCurrentPositionRobust({ watchMs: 200 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(cleared).toBe(true);
  });

  test("permission denied / unavailable / timeout map to guidance", async () => {
    const actual = jest.requireActual("../utils/geolocation");
    const failWith = (code) => {
      setNavigator({
        watchPosition: (ok, err) => {
          setTimeout(() => err({ code, message: "x" }), 5);
          return 1;
        },
        clearWatch: jest.fn(),
        getCurrentPosition: (ok, err) => setTimeout(() => err({ code, message: "x" }), 5),
      });
    };
    failWith(1);
    await expect(actual.getCurrentPositionRobust({ watchMs: 30 })).rejects.toThrow(/permission blocked/i);
    failWith(2);
    await expect(actual.getCurrentPositionRobust({ watchMs: 30 })).rejects.toThrow(/GPS|position/i);
    failWith(3);
    await expect(actual.getCurrentPositionRobust({ watchMs: 30 })).rejects.toThrow(/timed out|retry/i);
  });

  test("unsupported API and insecure context are distinguished", async () => {
    const actual = jest.requireActual("../utils/geolocation");
    clearNavigator();
    await expect(actual.getCurrentPositionRobust({ watchMs: 20 })).rejects.toThrow(/not supported/i);
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    try {
      await expect(actual.getCurrentPositionRobust({ watchMs: 20 })).rejects.toThrow(/secure page/i);
    } finally {
      Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    }
  });

  test("reverseGeocode times out fast and validates inputs", async () => {
    const actual = jest.requireActual("../utils/geolocation");
    const realFetch = global.fetch;
    // Faithful fetch double: rejects on abort like a real stalled request.
    global.fetch = (url, opts) => new Promise((_, reject) => {
      opts?.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
    try {
      const t0 = Date.now();
      const out = await actual.reverseGeocode(18.5, 73.8, { timeoutMs: 40 });
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(out).toEqual({ city: "", area: "", state: "", street: "", suburb: "", postcode: "", houseNumber: "", displayName: "" });
    } finally {
      global.fetch = realFetch;
    }
    const realFetch2 = global.fetch;
    let called = false;
    global.fetch = () => { called = true; return Promise.resolve({ ok: true, json: async () => ({}) }); };
    try {
      await actual.reverseGeocode(NaN, 73.8);
      expect(called).toBe(false);
    } finally {
      global.fetch = realFetch2;
    }
  });

  test("reverseGeocode merges providers, Nominatim fills gaps", async () => {
    const actual = jest.requireActual("../utils/geolocation");
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes("bigdatacloud")) {
        return { ok: true, json: async () => ({ city: "Pune", principalSubdivision: "MH", postcode: "411028" }) };
      }
      return {
        ok: true,
        json: async () => ({
          address: { suburb: "Hadapsar", road: "Magarpatta Road", house_number: "A-402" },
          display_name: "A-402, Magarpatta Road, Hadapsar",
        }),
      };
    };
    try {
      const out = await actual.reverseGeocode(18.5, 73.8);
      expect(out.city).toBe("Pune");
      expect(out.area).toBe("Hadapsar");
      expect(out.street).toBe("Magarpatta Road");
      expect(out.houseNumber).toBe("A-402");
    } finally {
      global.fetch = realFetch;
    }
  });

  test("withTimeout bounds hanging work", async () => {
    const actual = jest.requireActual("../utils/geolocation");
    const t0 = Date.now();
    await expect(actual.withTimeout(new Promise(() => {}), 30, "slow")).rejects.toThrow("slow");
    expect(Date.now() - t0).toBeLessThan(2000);
    await expect(actual.withTimeout(Promise.resolve(7), 30)).resolves.toBe(7);
  });

  test("fetchIpLocation times out to null", async () => {
    const actual = jest.requireActual("../utils/geolocation");
    const realFetch = global.fetch;
    global.fetch = (url, opts) => new Promise((_, reject) => {
      opts?.signal?.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
    try {
      const t0 = Date.now();
      const out = await actual.fetchIpLocation({ timeoutMs: 40 });
      expect(out).toBeNull();
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      global.fetch = realFetch;
    }
  });

  test("stale watch fixes are ignored", async () => {
    const actual = jest.requireActual("../utils/geolocation");
    setNavigator({
      watchPosition: (ok) => {
        setTimeout(() => ok({
          coords: { latitude: 1, longitude: 2, accuracy: 10 },
          timestamp: Date.now() - 10 * 60 * 1000,
        }), 5);
        return 3;
      },
      clearWatch: jest.fn(),
      getCurrentPosition: (ok) => setTimeout(() => ok({
        coords: { latitude: 5, longitude: 6, accuracy: 40 }, timestamp: Date.now(),
      }), 5),
    });
    const pos = await actual.getCurrentPositionRobust({ watchMs: 40 });
    // Stale watch fix (10 min old) must lose to the fresh single shot.
    expect(pos.lat).toBe(5);
    expect(pos.lng).toBe(6);
  });
});

describe("location slice", () => {
  beforeEach(() => {
    window.localStorage.clear();
    try { window.sessionStorage.clear(); } catch { /* ignore */ }
    geo.getCurrentPositionRobust.mockReset();
    geo.reverseGeocode.mockReset();
    geo.fetchIpLocation.mockReset();
    geo.reverseGeocode.mockResolvedValue({ ...GEO });
    geo.fetchIpLocation.mockResolvedValue(null);
  });

  test("GPS + geocode success commits coords, label, storage", async () => {
    geo.getCurrentPositionRobust.mockResolvedValue({ ...GPS });
    const store = makeStore();
    await store.dispatch(requestPreciseLocation());
    const s = store.getState().location;
    expect(s.status).toBe("ready");
    expect(s.location.lat).toBe(18.5204);
    expect(s.location.source).toBe("gps");
    expect(s.location.city).toBe("Pune");
    expect(JSON.parse(window.localStorage.getItem("cm-user-location-v1")).lat).toBe(18.5204);
  });

  test("geocode failure still commits GPS with neutral label (P0 regression)", async () => {
    geo.getCurrentPositionRobust.mockResolvedValue({ ...GPS });
    geo.reverseGeocode.mockRejectedValue(new Error("hangup"));
    const store = makeStore();
    await store.dispatch(requestPreciseLocation());
    const s = store.getState().location;
    expect(s.status).toBe("ready");
    expect(s.location.lat).toBe(18.5204);
    expect(s.location.lng).toBe(73.8567);
    expect(s.location.label).toBe("Current location");
  });

  test("concurrent detections: late first result never wins", async () => {
    let resolveFirst;
    geo.getCurrentPositionRobust
      .mockReturnValueOnce(new Promise((res) => { resolveFirst = res; }))
      .mockResolvedValue({ lat: 2, lng: 3, accuracy: 30, timestamp: Date.now() });
    const store = makeStore();
    const p1 = store.dispatch(requestPreciseLocation());
    const p2 = await store.dispatch(requestPreciseLocation());
    expect(store.getState().location.location.lat).toBe(2);
    await act(async () => {
      resolveFirst({ ...GPS });
      await p1;
    });
    // The stale first run must not overwrite the newer fix or its status.
    expect(store.getState().location.location.lat).toBe(2);
    expect(store.getState().location.status).toBe("ready");
    void p2;
  });

  test("clear during flight cancels the pending commit", async () => {
    let resolveGps;
    geo.getCurrentPositionRobust.mockReturnValue(new Promise((res) => { resolveGps = res; }));
    const store = makeStore();
    const p = store.dispatch(requestPreciseLocation());
    store.dispatch(clearLocation());
    await act(async () => {
      resolveGps({ ...GPS });
      await p;
    });
    const s = store.getState().location;
    expect(s.location).toBeNull();
    expect(s.status).toBe("idle");
  });

  test("manual choice during flight wins over late GPS", async () => {
    let resolveGps;
    geo.getCurrentPositionRobust.mockReturnValue(new Promise((res) => { resolveGps = res; }));
    const store = makeStore();
    const p = store.dispatch(requestPreciseLocation());
    await store.dispatch(setManualLocation({ label: "Home", city: "Pune", lat: 1, lng: 2 }));
    await act(async () => {
      resolveGps({ ...GPS });
      await p;
    });
    expect(store.getState().location.location.label).toBe("Home");
    expect(store.getState().location.location.source).toBe("manual");
  });

  test("denied permission surfaces denied status + manual fallback", async () => {
    geo.getCurrentPositionRobust.mockRejectedValue(new Error("Location permission blocked — x"));
    const store = makeStore();
    await store.dispatch(requestPreciseLocation());
    const s = store.getState().location;
    expect(s.status).toBe("denied");
    expect(s.location).toBeNull();
    expect(s.error).toMatch(/denied/i);
  });

  test("generic failure surfaces error status", async () => {
    geo.getCurrentPositionRobust.mockRejectedValue(new Error("Could not determine your position"));
    const store = makeStore();
    await store.dispatch(requestPreciseLocation());
    const s = store.getState().location;
    expect(s.status).toBe("error");
    expect(s.error).toMatch(/position/i);
  });

  test("poor fix keeps a FRESH saved pin, commits fresh when stale", async () => {
    geo.getCurrentPositionRobust.mockResolvedValue({ lat: 9, lng: 9, accuracy: 500, timestamp: Date.now() });
    geo.reverseGeocode.mockResolvedValue({ ...GEO });
    // Fresh pin (10 min old).
    window.localStorage.setItem("cm-user-location-v1", JSON.stringify({
      label: "Old", city: "Pune", lat: 1, lng: 1, source: "gps", savedAt: Date.now() - 10 * 60 * 1000,
    }));
    const store = makeStore();
    await store.dispatch(requestPreciseLocation());
    expect(store.getState().location.location.lat).toBe(1);
    expect(store.getState().location.error).toMatch(/approximate/i);
    // Stale pin (3 days old): the fresh poor fix must win.
    window.localStorage.setItem("cm-user-location-v1", JSON.stringify({
      label: "Old", city: "Pune", lat: 1, lng: 1, source: "gps", savedAt: Date.now() - 3 * 24 * 3600 * 1000,
    }));
    const store2 = makeStore();
    await store2.dispatch(requestPreciseLocation());
    expect(store2.getState().location.location.lat).toBe(9);
  });

  test("failure never resurrects a stale pin", async () => {
    geo.getCurrentPositionRobust.mockRejectedValue(new Error("Could not determine your position"));
    window.localStorage.setItem("cm-user-location-v1", JSON.stringify({
      label: "Old", city: "Pune", lat: 1, lng: 1, source: "gps", savedAt: Date.now() - 3 * 24 * 3600 * 1000,
    }));
    const store = makeStore();
    await store.dispatch(requestPreciseLocation());
    const s = store.getState().location;
    expect(s.location).toBeNull();
    expect(s.status).toBe("error");
  });

  test("explicit retry works after automatic failure", async () => {
    geo.getCurrentPositionRobust
      .mockRejectedValueOnce(new Error("timeout x"))
      .mockResolvedValueOnce({ ...GPS });
    const store = makeStore();
    await store.dispatch(requestPreciseLocation());
    expect(store.getState().location.status).toBe("error");
    await store.dispatch(requestPreciseLocation({ forceRefine: true }));
    expect(store.getState().location.location.lat).toBe(18.5204);
    expect(store.getState().location.status).toBe("ready");
  });

  test("initLocation: manual stored wins, fresh GPS reused, cold start detects", async () => {
    // Manual stored: no detection attempted.
    window.localStorage.setItem("cm-user-location-v1", JSON.stringify({
      label: "Home", city: "Pune", lat: 1, lng: 1, source: "manual", savedAt: Date.now(),
    }));
    let store = makeStore();
    await store.dispatch(initLocation());
    expect(geo.getCurrentPositionRobust).not.toHaveBeenCalled();
    expect(store.getState().location.location.label).toBe("Home");
    // Fresh GPS stored: reused without detection.
    geo.getCurrentPositionRobust.mockClear();
    window.localStorage.setItem("cm-user-location-v1", JSON.stringify({
      label: "G", city: "Pune", lat: 2, lng: 2, source: "gps", savedAt: Date.now(),
    }));
    store = makeStore();
    await store.dispatch(initLocation());
    expect(geo.getCurrentPositionRobust).not.toHaveBeenCalled();
    expect(store.getState().location.location.lat).toBe(2);
  });

  test("initLocation cold start with granted permission detects", async () => {
    window.localStorage.clear();
    try { window.sessionStorage.clear(); } catch { /* ignore */ }
    Object.defineProperty(window.navigator, "permissions", {
      value: { query: async () => ({ state: "granted" }) },
      configurable: true,
    });
    geo.getCurrentPositionRobust.mockResolvedValue({ ...GPS });
    const store = makeStore();
    await store.dispatch(initLocation());
    expect(geo.getCurrentPositionRobust).toHaveBeenCalledTimes(1);
    expect(store.getState().location.location.lat).toBe(18.5204);
    delete window.navigator.permissions;
  });
});
