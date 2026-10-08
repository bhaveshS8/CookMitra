
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

const bestOfWatch = ({ watchMs = 9000, goodEnoughM = ACCURACY_GOOD_M, maxAgeMs = 120000 } = {}) =>
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
      }
      if (result) resolve(result);
      else reject(error || lastError || new Error("No position fix received"));
    };

    const onFix = (pos) => {
      if (Number.isFinite(pos.timestamp) && Date.now() - pos.timestamp > maxAgeMs) return;
      const candidate = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      };
      if (!best || (candidate.accuracy ?? Infinity) < (best.accuracy ?? Infinity)) {
        best = candidate;
      }
      if ((candidate.accuracy ?? Infinity) <= goodEnoughM) {
        finish(best, null);
      }
    };

    const onError = (err) => {
      lastError = err;
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

export const reverseGeocode = async (lat, lng) => {
  const out = {
    city: "",
    area: "",
    state: "",
    street: "",
    suburb: "",
    postcode: "",
    houseNumber: "",
    displayName: "",
  };
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
      const body = await r.json();
      const a = body.address || {};
      return {
        city: a.city || a.town || a.village || a.county || a.state || "",
        area: a.suburb || a.neighbourhood || a.hamlet || a.quarter || a.residential || "",
        state: a.state || "",
        street: a.road || "",
        suburb: a.suburb || a.neighbourhood || a.hamlet || "",
        postcode: a.postcode || "",
        houseNumber: a.house_number || "",
        displayName: body.display_name || "",
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
  out.houseNumber = nomi.houseNumber || "";
  out.displayName = nomi.displayName || "";
  return out;
};

export const formatLocationLabel = ({ area, city, state } = {}) => {
  const a = (area || "").trim();
  const c = (city || "").trim();
  const s = (state || "").trim();
  if (a && c && a.toLowerCase() !== c.toLowerCase()) return `${a}, ${c}`;
  if (c && s && c.toLowerCase() !== s.toLowerCase()) return `${c}, ${s}`;
  return c || a || s || "";
};

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

export const fetchIpLocation = async () => {
  try {
    const r = await fetch("https://ipwho.is/");
    if (r.ok) {
      const d = await r.json();
      if (d && d.success !== false) {
        const city = d.city || "";
        const area = d.district || d.suburb || d.locality || "";
        const state = d.region || "";
        const country = d.country || "";
        if (city || state || area) return { city, area, state, country, label: formatLocationLabel({ area, city, state }) };
      }
    }
  } catch {
  }
  try {
    const r2 = await fetch("https://get.geojs.io/v1/ip/geo.json");
    if (!r2.ok) return null;
    const d2 = await r2.json();
    const city = d2.city || "";
    const area = d2.district || d2.suburb || d2.locality || "";
    const state = d2.region || "";
    const country = d2.country || d2.country_name || "";
    if (!city && !state && !area) return null;
    return { city, area, state, country, label: formatLocationLabel({ area, city, state }) };
  } catch {
    return null;
  }
};

export const getCurrentPositionRobust = ({ highAccuracyTimeout = 12000 } = {}) =>
  new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(
        new Error("Geolocation is not supported by this browser — please type your address manually")
      );
      return;
    }
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
      try {
        // Watch for up to 10s, settling early on a ≤50m fix, so entry
        // detection lands on the most precise reading available.
        const best = await bestOfWatch({ watchMs: 10000 });
        if (best && Number.isFinite(best.lat) && Number.isFinite(best.lng)) {
          resolve(best);
          return;
        }
      } catch {
      }
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
        try {
          const pos2 = await singleShot({
            enableHighAccuracy: false,
            timeout: 10000,
            maximumAge: 0,
          });
          resolve(toCoords(pos2));
        } catch (err2) {
          reject(describe(err2, "retry"));
        }
      }
    })();
  });
