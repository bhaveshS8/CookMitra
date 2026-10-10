import React, { useEffect, useRef, useState } from "react";

// Place search box with provider-agnostic suggestions.
//
// Contract (shared by booking flows + location picker):
// - debounced (~300ms), minimum 2 characters, stale responses discarded
// - keyboard: ArrowUp/Down to move, Enter picks the HIGHLIGHTED result
//   only (never auto-selects the first), Escape closes
// - screen-reader listbox wiring; loading / empty / error + retry states
// - selecting a result is one atomic parent update (address + pin together)
// - a provider is just `getSuggestions(query) -> [{ label, city, area,
//   state, lat?, lng? }]`; without one, parents pass a local source and
//   manual entry stays fully functional.
export const SEARCH_DEBOUNCE_MS = 300;
export const SEARCH_MIN_LENGTH = 2;

// Local, offline-capable source: saved places + served areas. Area-level
// hits carry no coordinates (an area is not a building entrance) — picking
// one fills text only, never a pin.
export const localPlaceSource = ({ savedPlaces = [], areas = [] } = {}) => (query) => {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < SEARCH_MIN_LENGTH) return [];
  const out = [];
  for (const s of savedPlaces || []) {
    const label = String(s?.address || "");
    const d = s?.addressDetails || {};
    const hay = `${label} ${d.flatNo || ""} ${d.society || ""} ${d.landmark || ""} ${d.city || ""}`.toLowerCase();
    if (label && hay.includes(q)) {
      out.push({
        kind: "saved",
        label,
        city: d.city || "",
        area: d.society || "",
        state: "",
        details: { flatNo: d.flatNo || "", society: d.society || "", landmark: d.landmark || "", city: d.city || "" },
        lat: Number.isFinite(s?.location?.lat) ? s.location.lat : null,
        lng: Number.isFinite(s?.location?.lng) ? s.location.lng : null,
      });
    }
  }
  for (const a of areas || []) {
    const name = String(a || "");
    if (name && name.toLowerCase().includes(q)) {
      out.push({ kind: "area", label: name, city: name, area: "", state: "", lat: null, lng: null });
    }
  }
  return out.slice(0, 6);
};

const PlaceSearchBox = ({
  id = "place-search",
  label = "Search area or saved place",
  placeholder = "Type at least 2 letters…",
  value,
  onChange,
  onPick,
  getSuggestions,
  attribution = null,
}) => {
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(-1);
  const seq = useRef(0);
  const boxRef = useRef(null);
  const listId = `${id}-listbox`;

  useEffect(() => {
    const q = String(value || "");
    if (q.trim().length < SEARCH_MIN_LENGTH) {
      seq.current += 1;
      setResults([]);
      setOpen(false);
      setLoading(false);
      setError("");
      setActive(-1);
      return undefined;
    }
    setLoading(true);
    setError("");
    const my = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await getSuggestions(q);
        if (seq.current !== my) return; // stale: newer query won
        setResults(Array.isArray(r) ? r : []);
        setOpen(true);
        setActive(-1);
      } catch {
        if (seq.current !== my) return;
        setResults([]);
        setOpen(true);
        setError("Search isn't working right now — keep typing your address manually below.");
      } finally {
        if (seq.current === my) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [value, getSuggestions]);

  useEffect(() => {
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const pick = (place) => {
    if (!place) return;
    seq.current += 1; // invalidate any in-flight suggest
    setOpen(false);
    setResults([]);
    setActive(-1);
    setError("");
    onPick?.(place);
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!open || !results.length) return;
      e.preventDefault();
      setActive((a) => {
        const d = e.key === "ArrowDown" ? 1 : -1;
        return (a + d + results.length) % results.length;
      });
    } else if (e.key === "Enter") {
      if (open && active >= 0 && results[active]) {
        e.preventDefault();
        pick(results[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  };

  const retry = () => {
    seq.current += 1;
    setError("");
    setLoading(true);
    const my = seq.current;
    Promise.resolve()
      .then(() => getSuggestions(String(value || "")))
      .then((r) => {
        if (seq.current !== my) return;
        setResults(Array.isArray(r) ? r : []);
        setOpen(true);
        setLoading(false);
      })
      .catch(() => {
        if (seq.current !== my) return;
        setLoading(false);
        setError("Search isn't working right now — keep typing your address manually below.");
      });
  };

  return (
    <div className="place-search" ref={boxRef}>
      <label className="place-search-label" htmlFor={id}>
        {label}
      </label>
      <div className="place-search-row">
        <input
          id={id}
          type="text"
          className="form-control place-search-input"
          autoComplete="off"
          spellCheck="false"
          placeholder={placeholder}
          value={value ?? ""}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-opt-${active}` : undefined}
          onChange={(e) => {
            onChange?.(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if ((results.length || error) && String(value || "").trim().length >= SEARCH_MIN_LENGTH) setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {loading && (
          <span className="place-search-spin" aria-hidden="true" />
        )}
      </div>
      {open && (
        <ul className="place-search-list" role="listbox" id={listId} aria-label="Matching places">
          {results.map((p, i) => (
            <li
              key={`${p.kind}-${p.label}-${i}`}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={`place-search-opt${i === active ? " active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(p)}
            >
              <span className="place-search-opt-label">{p.label}</span>
              <span className="place-search-opt-kind">{p.kind === "saved" ? "Saved place" : "Area"}</span>
            </li>
          ))}
          {!results.length && !loading && !error && (
            <li className="place-search-empty">
              No matches — keep typing your address manually below.
            </li>
          )}
          {error && (
            <li className="place-search-error" role="alert">
              <span>{error}</span>
              <button type="button" className="place-search-retry" onClick={retry}>
                Retry
              </button>
            </li>
          )}
        </ul>
      )}
      {attribution && <p className="place-search-attr">{attribution}</p>}
    </div>
  );
};

export default PlaceSearchBox;
