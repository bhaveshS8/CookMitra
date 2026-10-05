import React, { useState, useEffect, useRef } from "react";
import { MapPin, LocateFixed, X, AlertCircle, Navigation } from "lucide-react";
import { useDispatch } from "react-redux";
import { useSiteLocation } from "../store/hooks";
import { requestPreciseLocation, clearLocation } from "../store/locationSlice";
import { formatAccuracy, accuracyGrade } from "../utils/geolocation";

const LocationPicker = () => {
  const { location, status, error, isLocating } = useSiteLocation();
  const dispatch = useDispatch();
  const handlePrecise = () => dispatch(requestPreciseLocation({ forceRefine: true }));
  const handleClear = () => dispatch(clearLocation());
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pillText = isLocating
    ? "Detecting…"
    : location?.label || "Set location";

  const sourceNote =
    location?.source === "gps"
      ? `Precise GPS location${Number.isFinite(location?.accuracy) ? ` · ${formatAccuracy(location.accuracy)}` : ""}`
      : location?.source === "ip"
        ? "Approximate area (IP)"
        : location?.source === "manual"
          ? "Chosen by you"
          : location?.source === "stored"
            ? "Saved location"
            : "";

  const gpsGrade = location?.source === "gps" || Number.isFinite(location?.accuracy)
    ? accuracyGrade(location?.accuracy)
    : null;
  const accuracyHint = error
    ? ""
    : location?.accuracyNote ||
      (gpsGrade === "poor"
        ? "Approximate pin — step outdoors with a clear sky view, then tap Re-detect for your exact house address."
        : gpsGrade === "fair"
          ? "Close pin — re-detect outdoors if the house number looks off."
          : "");

  return (
    <div className="loc-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`loc-pill ${location ? "has-loc" : ""} ${isLocating ? "is-busy" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={location ? `Your location: ${location.label}. Change location` : "Set your location"}
        title={location ? location.label : "Detect or set your location"}
      >
        {isLocating ? (
          <span className="loc-spinner" aria-hidden="true" />
        ) : (
          <MapPin size={15} aria-hidden="true" />
        )}
        <span className="loc-pill-label">{pillText}</span>
        <span className="loc-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="loc-dropdown" role="dialog" aria-label="Choose your location">
          <div className="loc-drop-head">
            <span className="loc-drop-title">Your location</span>
            {location && (
              <button type="button" className="loc-clear" onClick={handleClear}>
                <X size={13} /> Clear
              </button>
            )}
          </div>

          {location && (
            <div className="loc-current">
              <MapPin size={14} aria-hidden="true" />
              <div>
                <div className="loc-current-label">{location.label}</div>
                {sourceNote && <div className="loc-source">{sourceNote}</div>}
              </div>
            </div>
          )}

          <button
            type="button"
            className="btn btn-outline btn-sm loc-gps-btn"
            onClick={handlePrecise}
            disabled={isLocating}
          >
            <LocateFixed size={15} />
            {isLocating ? "Detecting…" : location ? "Re-detect my location" : "Use my current location"}
          </button>

          {location?.exactLine ? (
            <div className="loc-current-sub">
              <Navigation size={12} aria-hidden="true" /> {location.exactLine}
            </div>
          ) : null}
          {accuracyHint ? (
            <p className="loc-error" role="note" style={{ borderColor: "var(--amber-300, #fcd34d)" }}>
              <AlertCircle size={14} aria-hidden="true" /> {accuracyHint}
            </p>
          ) : null}

          {error && (
            <p className="loc-error" role="alert">
              <AlertCircle size={14} aria-hidden="true" /> {error}
            </p>
          )}

          <p className="loc-footnote">
            {status === "denied"
              ? "GPS is blocked for this site — nothing else on the site is affected."
              : "Denying GPS never blocks browsing."}
          </p>
        </div>
      )}
    </div>
  );
};

export default LocationPicker;