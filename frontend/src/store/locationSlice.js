import { createSlice, createAsyncThunk } from "@reduxjs/toolkit";
import {
  getCurrentPositionRobust,
  reverseGeocode,
  formatLocationLabel,
  formatAccuracy,
  accuracyGrade,
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
  }
};

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
    }
    return dispatch(requestPreciseLocation()).unwrap().catch(() => null);
  }
);

export const requestPreciseLocation = createAsyncThunk(
  "location/requestPrecise",
  async (opts, { rejectWithValue }) => {
    try {
      const forceRefine = Boolean(opts?.forceRefine);
      const c = await getCurrentPositionRobust();
      const geo = await reverseGeocode(c.lat, c.lng);
      const area = geo.area || geo.suburb || geo.street || "";
      const grade = accuracyGrade(c.accuracy);
      const houseLine = [geo.houseNumber, geo.street].filter(Boolean).join(" ").trim();
      const displayShort = geo.displayName ? String(geo.displayName).split(",").slice(0, 2).join(",").trim() : "";
      const exactOk = grade !== "poor";
      const label =
        formatLocationLabel({ area, city: geo.city, state: geo.state }) || "Current location";
      const next = {
        label,
        city: geo.city || "",
        area,
        state: geo.state || "",
        street: geo.street || "",
        postcode: geo.postcode || "",
        exactLine: exactOk ? houseLine || displayShort || "" : "",
        hasHouseNumber: exactOk && Boolean(geo.houseNumber),
        displayName: geo.displayName || "",
        accuracyNote:
          grade === "poor"
            ? `GPS accuracy is ${formatAccuracy(c.accuracy)} — the pin is approximate. Step outdoors with a clear sky view and re-detect for an exact address.`
            : grade === "fair"
              ? `GPS accuracy is ${formatAccuracy(c.accuracy)} — close, but re-detect outdoors if the house number looks off.`
              : "",
        lat: c.lat,
        lng: c.lng,
        accuracy: c.accuracy ?? null,
        timestamp: c.timestamp || Date.now(),
        source: "gps",
      };
      if (grade === "poor" && !forceRefine) {
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          const prev = raw ? JSON.parse(raw) : null;
          if (prev && Number.isFinite(prev.lat) && Number.isFinite(prev.lng)) {
            return {
              location: { ...prev, source: prev.source || "stored" },
              error: `GPS is approximate right now (${formatAccuracy(next.accuracy)}) — kept your saved pin. Step outdoors and tap Re-detect for an exact fix.`,
            };
          }
        } catch {
        }
      }
      persist(next);
      return { location: next, error: "" };
    } catch (err) {
      const msg = err?.message || "Could not detect your location";
      const denied = /permission|blocked|denied|secure page/i.test(msg);
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
