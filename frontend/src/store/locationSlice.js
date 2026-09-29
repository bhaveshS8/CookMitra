import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import {
  getCurrentPositionRobust,
  reverseGeocode,
  formatLocationLabel,
  fetchIpLocation,
} from "../utils/geolocation";

const STORAGE_KEY = "cm-user-location-v1";
const AUTO_ASK_KEY = "cm-loc-auto-asked";

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
    // storage unavailable (private mode) — location still works for this visit
  }
};

// First-visit bootstrap: reuse the stored place when available (no permission
// prompt at all). Otherwise one automatic GPS attempt per browser session.
export const initLocation = createAsyncThunk(
  "location/init",
  async (_, { dispatch }) => {
    const stored = loadStored();
    if (stored) {
      dispatch(locationSlice.actions.locationRestored(stored));
      return stored;
    }
    try {
      if (sessionStorage.getItem(AUTO_ASK_KEY)) return null;
      sessionStorage.setItem(AUTO_ASK_KEY, "1");
    } catch {
      // storage unavailable — still attempt once
    }
    return dispatch(requestPreciseLocation()).unwrap().catch(() => null);
  }
);

// Precise browser-GPS detection + reverse-geocode into "Area, City".
// Only call from a user gesture or the one first-visit auto-attempt.
export const requestPreciseLocation = createAsyncThunk(
  "location/requestPrecise",
  async (_, { rejectWithValue }) => {
    try {
      const c = await getCurrentPositionRobust();
      const geo = await reverseGeocode(c.lat, c.lng);
      const area = geo.area || geo.suburb || geo.street || "";
      const label =
        formatLocationLabel({ area, city: geo.city, state: geo.state }) || "Current location";
      const next = {
        label,
        city: geo.city || "",
        area,
        state: geo.state || "",
        lat: c.lat,
        lng: c.lng,
        accuracy: c.accuracy ?? null,
        timestamp: c.timestamp || Date.now(),
        source: "gps",
      };
      persist(next);
      return { location: next, error: "" };
    } catch (err) {
      const msg = err?.message || "Could not detect your location";
      const denied = /permission|blocked|denied|secure page/i.test(msg);
      // Any GPS failure falls back to an approximate IP city so detection
      // always yields something useful. Previously only permission-denial
      // got this fallback — the common desktop outcome (GPS timeout /
      // position unavailable after a long spin) ended with nothing, even
      // though an approximate city was one cheap lookup away.
      try {
        const ip = await fetchIpLocation();
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
        // ignore — fall through to the error states below
      }
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

// Manual place pick (search result). Synchronous — normalisation + persist
// happen here so every caller shares one code path.
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
    // idle: nothing yet | locating: GPS/IP in flight | ready: we have a
    // place | denied: permission blocked | error: GPS failed otherwise
    status: "idle",
    error: "",
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
        // ignore
      }
      state.location = null;
      state.status = "idle";
      state.error = "";
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(requestPreciseLocation.pending, (state) => {
        state.status = "locating";
        state.error = "";
      })
      .addCase(requestPreciseLocation.fulfilled, (state, action) => {
        state.location = action.payload.location;
        state.error = action.payload.error;
        state.status = "ready";
      })
      .addCase(requestPreciseLocation.rejected, (state, action) => {
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
      });
  },
});

export const { locationRestored, clearLocation } = locationSlice.actions;
export default locationSlice.reducer;
