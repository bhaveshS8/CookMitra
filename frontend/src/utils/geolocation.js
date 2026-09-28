// Shared browser-geolocation helper with GPS retry + user-friendly errors.
//
// Why this exists: a single getCurrentPosition call with a short timeout
// fails silently in the common cases — cold GPS fixes take longer than the
// timeout, plain-HTTP pages (non-localhost) are blocked by the browser, and
// permission/timeout/unavailable all need different guidance.
//
// Accuracy handling: resolves with { lat, lng, accuracy, timestamp } where
// `accuracy` is the GPS fix radius in metres reported by the browser.
// Callers MUST surface `accuracy` ("±14 m") and warn when it is poor (>100 m)
// instead of silently trusting a stale/cached network fix.

// Good enough to treat the pin as the venue (<50 m), usable with caution
// (<150 m), poor above that.
export const ACCURACY_GOOD_M = 50;
export const ACCURACY_OK_M = 150;

export const formatAccuracy = (accuracy) => {
  if (accuracy == null || !Number.isFinite(accuracy)) return "unknown accuracy";
  if (accuracy < 1000) return `±${Math.round(accuracy)} m`;
  return `±${(accuracy / 1000).toFixed(1)} km`;
};

export const accuracyGrade = (accuracy) => {
  if (accuracy == null || !Number.isFinite(accuracy)) return "unknown";
  if (accuracy <= ACCURACY_GOOD_M) return "good";
  if (accuracy <= ACCURACY_OK_M) return "fair";
  return "poor";
};

const singleShot = (options) =>
  new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });

// Watch GPS briefly and keep the most accurate fix (lowest accuracy number).
// Resolves early once a GOOD fix arrives, otherwise resolves with the best
// fix seen when `watchMs` elapses. Rejects only if no fix at all arrives.
const bestOfWatch = ({ watchMs = 9000, goodEnoughM = ACCURACY_GOOD_M } = {}) =>
  new Promise((resolve, reject) => {
    let best = null;
    let done = false;
    let watchId = null;
    let lastError = null;

    const finish = (result, error) => {
      if (done) return;
      done = true;
      try {
        if (watchId != null) navigator.geolocation.clearWatch(watchId);
      } catch {
        // ignore
      }
      if (result) resolve(result);
      else reject(error || lastError || new Error("No position fix received"));
    };

    const onFix = (pos) => {
      const candidate = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      };
      if (!best || (candidate.accuracy ?? Infinity) < (best.accuracy ?? Infinity)) {
        best = candidate;
      }
      // Good enough — stop early instead of waiting out the full window.
      if ((candidate.accuracy ?? Infinity) <= goodEnoughM) {
        finish(best, null);
      }
    };

    const onError = (err) => {
      lastError = err;
      // Permission denial can never succeed — fail fast.
      if (err?.code === 1) finish(null, err);
    };

    try {
      watchId = navigator.geolocation.watchPosition(onFix, onError, {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0,
      });
    } catch (err) {
      reject(err);
      return;
    }

    setTimeout(() => {
      if (best) finish(best, null);
      else finish(null, lastError);
    }, watchMs);
  });

// Reverse-geocode a GPS pin into address parts for auto-filling venue forms.
// Returns { city, area, state, street, suburb, postcode } ("" when unknown).
// Never throws — callers always keep the pin and ask the user to type what's
// missing. Uses BigDataCloud (fast, keyless) + Nominatim (street-level detail).
export const reverseGeocode = async (lat, lng) => {
  const out = { city: "", area: "", state: "", street: "", suburb: "", postcode: "" };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return out;

  const fromBigDataCloud = (async () => {
    try {
      const r = await fetch(
        `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`
      );
      if (!r.ok) return {};
      const d = await r.json();
      return {
        city: d.city || d.locality || "",
        state: d.principalSubdivision || "",
        postcode: d.postcode || "",
      };
    } catch {
      return {};
    }
  })();

  const fromNominatim = (async () => {
    try {
      const r = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=18&addressdetails=1`
      );
      if (!r.ok) return {};
      const a = (await r.json()).address || {};
      return {
        city: a.city || a.town || a.village || a.county || a.state || "",
        area: a.suburb || a.neighbourhood || a.hamlet || a.quarter || a.residential || "",
        state: a.state || "",
        street: a.road || "",
        suburb: a.suburb || a.neighbourhood || a.hamlet || "",
        postcode: a.postcode || "",
      };
    } catch {
      return {};
    }
  })();

  const [bdc, nomi] = await Promise.all([fromBigDataCloud, fromNominatim]);
  out.city = bdc.city || nomi.city || "";
  out.area = nomi.area || "";
  out.state = bdc.state || nomi.state || "";
  out.street = nomi.street || "";
  out.suburb = nomi.suburb || "";
  out.postcode = bdc.postcode || nomi.postcode || "";
  return out;
};

// Build a short human-readable header label such as "Kothrud, Pune" or
// "Pune, Maharashtra". Prefers area + city, falls back to city + state.
export const formatLocationLabel = ({ area, city, state } = {}) => {
  const a = (area || "").trim();
  const c = (city || "").trim();
  const s = (state || "").trim();
  if (a && c && a.toLowerCase() !== c.toLowerCase()) return `${a}, ${c}`;
  if (c && s && c.toLowerCase() !== s.toLowerCase()) return `${c}, ${s}`;
  return c || a || s || "";
};

// Forward-geocode a typed place ("Kothrud, Pune") into selectable options.
// Returns [{ label, city, state, lat, lng }]. Never throws — returns [] when
// the lookup fails or finds nothing.
export const searchLocations = async (query, limit = 5) => {
  const q = (query || "").trim();
  if (q.length < 2) return [];
  try {
    const r = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=${limit}&q=${encodeURIComponent(q)}`
    );
    if (!r.ok) return [];
    const list = await r.json();
    if (!Array.isArray(list)) return [];
    return list
      .filter((p) => p && p.lat != null && p.lon != null)
      .map((p) => {
        const a = p.address || {};
        const city = a.city || a.town || a.village || a.county || a.state || (p.display_name || "").split(",")[0].trim();
        const state = a.state || "";
        const area = a.suburb || a.neighbourhood || a.hamlet || a.quarter || "";
        return {
          label: formatLocationLabel({ area, city, state }) || (p.display_name || "").split(",").slice(0, 2).join(",").trim(),
          city,
          state,
          area,
          lat: Number(p.lat),
          lng: Number(p.lon),
        };
      })
      .filter((p) => p.label && Number.isFinite(p.lat) && Number.isFinite(p.lng));
  } catch {
    return [];
  }
};

// Approximate city from the network IP — no browser permission needed, so it
// can run on page open as a non-blocking hint until the user shares precise
// GPS or picks a place manually. Uses ipwho.is (primary) + geojs.io (backup).
// Both are keyless, HTTPS, and send `Access-Control-Allow-Origin: *`, unlike
// the previous providers (BigDataCloud ip-geolocation-full needs an API key
// and answers 403 without one; ipapi.co answers 403/CORS-less when its free
// quota is exceeded) — both of which spammed the console with 403 / CORS /
// ERR_FAILED errors on the live site.
// Returns { city, state, country, label } or null. Never throws.
// NOTE: providers are tried sequentially (not Promise.all) so a failing
// provider can't leave a dangling fetch that logs network errors after we
// already resolved.
export const fetchIpLocation = async () => {
  // Primary: https://ipwho.is/ -> { city, region, country, success }
  try {
    const r = await fetch("https://ipwho.is/");
    if (r.ok) {
      const d = await r.json();
      if (d && d.success !== false) {
        const city = d.city || "";
        const state = d.region || "";
        const country = d.country || "";
        if (city || state) return { city, state, country, label: formatLocationLabel({ city, state }) };
      }
    }
  } catch {
    // fall through to the backup provider
  }
  // Backup: https://get.geojs.io/v1/ip/geo.json -> { city, region, country }
  try {
    const r2 = await fetch("https://get.geojs.io/v1/ip/geo.json");
    if (!r2.ok) return null;
    const d2 = await r2.json();
    const city = d2.city || "";
    const state = d2.region || "";
    const country = d2.country || d2.country_name || "";
    if (!city && !state) return null;
    return { city, state, country, label: formatLocationLabel({ city, state }) };
  } catch {
    return null;
  }
};

// Resolves with { lat, lng, accuracy, timestamp }. Uses a fresh (maximumAge: 0)
// high-accuracy watch to pick the best fix, then falls back to single-shot
// attempts. Rejects with an Error whose message is safe to show to the user.
export const getCurrentPositionRobust = ({ highAccuracyTimeout = 15000 } = {}) =>
  new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(
        new Error("Geolocation is not supported by this browser — please type your address manually")
      );
      return;
    }
    // Browsers block geolocation on insecure (plain http://) pages except
    // localhost — detect it early so the user gets an explanation instead of
    // a silent failure.
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      reject(
        new Error(
          "Location needs a secure page (HTTPS or localhost) — please type your address manually or open the site over HTTPS"
        )
      );
      return;
    }

    const toCoords = (pos) => ({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      timestamp: pos.timestamp,
    });

    const describe = (err, attempt) => {
      if (err?.code === 1) {
        return new Error(
          "Location permission blocked — allow location for this site in your browser's site settings, then tap again"
        );
      }
      if (err?.code === 2) {
        return new Error(
          "Could not determine your position — turn on device location (GPS), step outdoors with a clear sky view, and retry"
        );
      }
      return new Error(
        attempt === "retry"
          ? "Location timed out — try again outdoors with a clear sky view, or type your address manually"
          : "Location is taking longer than usual — retrying…"
      );
    };

    (async () => {
      // 1) Best-of-watch: fresh high-accuracy fixes for a few seconds.
      try {
        const best = await bestOfWatch({ watchMs: 8000 });
        if (best && Number.isFinite(best.lat) && Number.isFinite(best.lng)) {
          resolve(best);
          return;
        }
      } catch {
        // fall through to single-shot attempts
      }
      // 2) Fresh high-accuracy single shot (never accept a cached fix here).
      try {
        const pos = await singleShot({
          enableHighAccuracy: true,
          timeout: highAccuracyTimeout,
          maximumAge: 0,
        });
        resolve(toCoords(pos));
        return;
      } catch (err) {
        if (err?.code === 1) {
          reject(describe(err, "first"));
          return;
        }
        // 3) One longer low-power attempt before giving up.
        try {
          const pos2 = await singleShot({
            enableHighAccuracy: false,
            timeout: 30000,
            maximumAge: 0,
          });
          resolve(toCoords(pos2));
        } catch (err2) {
          reject(describe(err2, "retry"));
        }
      }
    })();
  });
