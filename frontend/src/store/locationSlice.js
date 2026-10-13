import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import {
  getCurrentPositionRobust,
  reverseGeocode,
  formatLocationLabel,
  formatAccuracy,
  accuracyGrade,
  fetchIpLocation,
  withTimeout,
  LOCATION_FRESH_MS,
} from "../utils/geolocation";

const STORAGE_KEY = "cm-user-location-v1";
const AUTO_ASK_KEY = "cm-loc-auto-asked";
// A saved precise GPS fix younger than this is reused as-is on entry.
const FRESH_GPS_MS = LOCATION_FRESH_MS;
// Hard cap for the whole GPS acquisition stage (watch + fallbacks).
const GPS_BUDGET_MS = 22000;

const isFreshGps = (stored) =>
  stored?.source === "gps" &&
  Number.isFinite(stored?.lat) &&
  Number.isFinite(stored?.lng) &&
  Date.now() - Number(stored?.savedAt || 0) < FRESH_GPS_MS;

// A saved pin (any source) is worth reusing only while fresh. An explicit
// manual choice is never auto-overwritten — it is handled separately.
const isFreshEnough = (stored) =>
  stored != null &&
  Number.isFinite(stored?.lat) &&
  Number.isFinite(stored?.lng) &&
  Date.now() - Number(stored?.savedAt || 0) < LOCATION_FRESH_MS;

const queryGeoPermission = async () => {
  try {
    if (typeof navigator !== "undefined" && navigator.permissions?.query) {
      const p = await navigator.permissions.query({ name: "geolocation" });
      return p?.state || "";
    }
  } catch {
  }
  return "";
};

const loadStoredPin = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const prev = raw ? JSON.parse(raw) : null;
    if (prev && Number.isFinite(prev.lat) && Number.isFinite(prev.lng)) return prev;
  } catch {
  }
  return null;
};

const loadStored = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.label) return null;
    return { ...parsed, source: parsed.source || "stored" };
  } catch {
    return null;
  }
};

const persist = (loc) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loc, savedAt: Date.now() }));
  } catch {
  }
};

export const initLocation = createAsyncThunk(
  "location/init",
  async (_, { dispatch }) => {
    const stored = loadStored();
    if (stored) {
      dispatch(locationSlice.actions.locationRestored(stored));
    }
    // Never auto-overwrite a location the user chose manually.
    if (stored?.source === "manual") return stored;
    // A fresh precise GPS fix needs no re-capture on entry.
    if (isFreshGps(stored)) return stored;

    // Capture a fresh precise fix on entry. When permission is already
    // granted this is silent (no prompt); otherwise only auto-ask when
    // there is no usable saved location to fall back to.
    const permission = await queryGeoPermission();
    let autoAsked = true;
    try {
      autoAsked = Boolean(sessionStorage.getItem(AUTO_ASK_KEY));
    } catch {
      autoAsked = true;
    }
    const shouldDetect = permission === "granted" || (!stored && !autoAsked);
    if (!shouldDetect) return stored;
    try {
      sessionStorage.setItem(AUTO_ASK_KEY, "1");
    } catch {
    }
    return dispatch(requestPreciseLocation()).unwrap().catch(() => stored);
  }
);

export const requestPreciseLocation = createAsyncThunk(
  "location/requestPrecise",
  async (opts, { getState, rejectWithValue }) => {
    // Revision guard: concurrent detections (StrictMode double-mount, rapid
    // retries) and intervening user actions (manual pick, clear) bump
    // state.generation — a stale run must never commit over newer state.
    const myGen = getState()?.location?.generation ?? 0;
    const alive = () => (getState()?.location?.generation ?? -1) === myGen;
    const superseded = () => rejectWithValue({ superseded: true });
    try {
      const forceRefine = Boolean(opts?.forceRefine);
      // 1. Coordinates first, hard-capped. A reverse-geocode outage must
      // never make working GPS look broken.
      const c = await withTimeout(
        getCurrentPositionRobust(),
        GPS_BUDGET_MS,
        "Location timed out — try again outdoors with a clear sky view, or type your address manually"
      );
      if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) {
        throw new Error("Could not determine your position — please type your address manually");
      }
      if (!alive()) return superseded();
      // 2. Address enrichment is best-effort and isolated: slow, failed, or
      // empty geocoding still commits the validated coordinates with a
      // neutral label instead of hanging or discarding the fix.
      let geo = null;
      try {
        geo = await reverseGeocode(c.lat, c.lng);
      } catch {
        geo = null;
      }
      if (!alive()) return superseded();
      const area = geo?.area || geo?.suburb || geo?.street || "";
      const grade = accuracyGrade(c.accuracy);
      const houseLine = [geo?.houseNumber, geo?.street].filter(Boolean).join(" ").trim();
      const displayShort = geo?.displayName ? String(geo.displayName).split(",").slice(0, 2).join(",").trim() : "";
      const exactOk = grade !== "poor";
      const label =
        formatLocationLabel({ area, city: geo?.city, state: geo?.state }) || "Current location";
      // Full detected address in text form (exact street address when GPS is good).
      const fullAddress = (
        geo?.displayName ||
        [houseLine, area, geo?.city, geo?.state, geo?.postcode].filter(Boolean).join(", ")
      ).trim();
      const next = {
        label,
        fullAddress,
        city: geo?.city || "",
        area,
        state: geo?.state || "",
        street: geo?.street || "",
        postcode: geo?.postcode || "",
        exactLine: exactOk ? houseLine || displayShort || "" : "",
        hasHouseNumber: exactOk && Boolean(geo?.houseNumber),
        displayName: geo?.displayName || "",
        accuracyNote:
          grade === "poor"
            ? `GPS accuracy is ${formatAccuracy(c.accuracy)} — the pin is approximate. Step outdoors with a clear sky view and re-detect for an exact address.`
            : "",
        lat: c.lat,
        lng: c.lng,
        accuracy: c.accuracy ?? null,
        timestamp: c.timestamp || Date.now(),
        source: "gps",
      };
      if (grade === "poor" && !forceRefine) {
        const prev = loadStoredPin();
        // An explicit manual choice always wins; otherwise only a FRESH
        // saved pin outranks a new poor fix (a stale pin must not bury it).
        if (prev?.source === "manual") {
          return {
            location: { ...prev, source: prev.source || "stored" },
            error: "GPS is approximate right now — kept the location you chose. Step outdoors and tap Re-detect for an exact fix.",
          };
        }
        if (prev && isFreshEnough(prev)) {
          return {
            location: { ...prev, source: prev.source || "stored" },
            error: `GPS is approximate right now (${formatAccuracy(next.accuracy)}) — kept your saved pin. Step outdoors and tap Re-detect for an exact fix.`,
          };
        }
      }
      if (!alive()) return superseded();
      persist(next);
      return { location: next, error: "" };
    } catch (err) {
      const msg = err?.message || "Could not detect your location";
      const denied = /permission|blocked|denied|secure page/i.test(msg);
      // Never replace a saved precise pin with a coarse IP guess, and never
      // resurrect a stale pin over an explicit clear.
      const prev = loadStoredPin();
      if (prev?.source === "manual" || (prev && isFreshEnough(prev))) {
        if (!alive()) return superseded();
        return {
          location: { ...prev, source: prev.source || "stored" },
          error: denied
            ? "Precise location is off — kept the location you chose. Enable GPS to refresh it."
            : "GPS unavailable — kept your saved pin. Tap Re-detect for a fresh fix.",
        };
      }
      try {
        const ip = await fetchIpLocation();
        if (!alive()) return superseded();
        if (ip?.label) {
          const approx = {
            label: ip.label,
            city: ip.city || "",
            area: "",
            state: ip.state || "",
            lat: null,
            lng: null,
            source: "ip",
          };
          persist(approx);
          return {
            location: approx,
            error: denied
              ? "Precise location is off — showing approximate area. Enable GPS for better accuracy."
              : "GPS unavailable — showing approximate area instead. Enable GPS for better accuracy.",
          };
        }
      } catch {
      }
      if (!alive()) return superseded();
      if (denied) {
        return rejectWithValue({
          location: null,
          error:
            "Location permission denied — search your area below. The site works fine without it.",
          denied: true,
        });
      }
      return rejectWithValue({
        location: null,
        error: msg || "Location lookup failed — search your area below.",
        denied: false,
      });
    }
  }
);

export const setManualLocation = createAsyncThunk(
  "location/setManual",
  async (place) => {
    if (!place) return null;
    const label = place.label || formatLocationLabel(place) || "Selected location";
    const next = {
      label,
      city: place.city || "",
      area: place.area || "",
      state: place.state || "",
      lat: Number.isFinite(place.lat) ? place.lat : null,
      lng: Number.isFinite(place.lng) ? place.lng : null,
      source: place.source || "manual",
    };
    persist(next);
    return next;
  }
);

const locationSlice = createSlice({
  name: "location",
  initialState: {
    location: null,
    status: "idle",
    error: "",
    // Revision counter: every new detection attempt, manual selection, or
    // clear bumps it. In-flight async work commits only while its captured
    // revision is still current (see requestPreciseLocation) — this is what
    // stops late GPS/geocode responses overwriting newer choices.
    generation: 0,
  },
  reducers: {
    locationRestored(state, action) {
      state.location = action.payload;
      state.status = "ready";
      state.error = "";
    },
    clearLocation(state) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
      }
      state.location = null;
      state.status = "idle";
      state.error = "";
      state.generation += 1;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(requestPreciseLocation.pending, (state) => {
        state.status = "locating";
        state.error = "";
        state.generation += 1;
      })
      .addCase(requestPreciseLocation.fulfilled, (state, action) => {
        state.location = action.payload.location;
        state.error = action.payload.error;
        state.status = "ready";
      })
      .addCase(requestPreciseLocation.rejected, (state, action) => {
        // A superseded run must not touch UI state owned by newer work.
        if (action.payload?.superseded) return;
        const payload = action.payload;
        if (payload) {
          state.error = payload.error;
          state.status = payload.denied ? "denied" : "error";
        } else {
          state.status = "error";
          state.error = "Location lookup failed — search your area below.";
        }
      })
      .addCase(setManualLocation.fulfilled, (state, action) => {
        if (!action.payload) return;
        state.location = action.payload;
        state.status = "ready";
        state.error = "";
        state.generation += 1;
      });
  },
});

export const { locationRestored, clearLocation } = locationSlice.actions;
export default locationSlice.reducer;
