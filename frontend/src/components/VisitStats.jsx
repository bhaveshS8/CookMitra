import React, { useState } from "react";
import { useFetch } from "../hooks/useFetch";
import { Eye, Users, RefreshCw, MapPin } from "lucide-react";
import VisitChart from "./VisitChart";

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

const VisitStats = () => {
  const [range, setRange] = useState(30);
  const { data, loading, error, refetch } = useFetch(`/stats/public/visits?days=${range}`);

  const days = data?.days || [];
  const totals = data?.totals || { visits: 0, uniques: 0 };
  const topPaths = data?.topPaths || [];
  const topCities = data?.topCities || [];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem", flexWrap: "wrap", gap: "0.75rem" }}>
        <div>
          <h2 style={{ fontSize: "1.4rem", margin: 0 }}>Site Visits</h2>
          <p style={{ color: "var(--slate-500)", margin: "0.25rem 0 0", fontSize: "0.9rem" }}>
            One count per browser-tab session · bots excluded · days in IST · GPS-verified areas are precise; the rest are approximate (IP-based).
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              className={`btn btn-sm ${range === r.days ? "btn-primary" : "btn-outline"}`}
              onClick={() => setRange(r.days)}
            >
              {r.label}
            </button>
          ))}
          <button type="button" className="btn btn-outline btn-sm" onClick={() => refetch()} disabled={loading} title="Refresh">
            <RefreshCw size={15} /> {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <p style={{ color: "#dc2626" }}>{error}</p>}

      <div className="dashboard-stats-grid" style={{ marginBottom: "1.5rem" }}>
        <div className="dashboard-stat-card">
          <div className="stat-icon-wrapper"><Eye size={20} /></div>
          <div>
            <div className="stat-metric-number">{loading ? "…" : totals.visits.toLocaleString("en-IN")}</div>
            <div className="stat-metric-title">Visits · last {range} days</div>
          </div>
        </div>
        <div className="dashboard-stat-card" title="Distinct anonymous browsers per IST day, summed across the range — the same visitor counts again on another day.">
          <div className="stat-icon-wrapper"><Users size={20} /></div>
          <div>
            <div className="stat-metric-number">{loading ? "…" : totals.uniques.toLocaleString("en-IN")}</div>
            <div className="stat-metric-title">Unique visitor-days · last {range} days</div>
          </div>
        </div>
      </div>

      <div style={{ background: "white", borderRadius: "var(--radius-lg)", border: "1px solid var(--border-subtle)", padding: "1.25rem", marginBottom: "1.5rem" }}>
        <h3 style={{ fontSize: "1rem", margin: "0 0 1rem" }}>Visit analytics</h3>
        {loading ? (
          <p style={{ color: "var(--slate-500)", margin: 0 }}>Loading…</p>
        ) : (
          <VisitChart days={days} />
        )}
      </div>

      <div style={{ background: "white", borderRadius: "var(--radius-lg)", border: "1px solid var(--border-subtle)", padding: "1.25rem", marginBottom: "1.5rem" }}>
        <h3 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Top pages · last {range} days</h3>
        {topPaths.length === 0 ? (
          <p style={{ color: "var(--slate-500)", margin: 0 }}>No page data yet.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {topPaths.map((p) => (
              <li
                key={p.path}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0", borderBottom: "1px solid var(--slate-100)", fontSize: "0.9rem" }}
              >
                <code style={{ overflowWrap: "anywhere" }}>{p.path}</code>
                <strong style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                  {Number(p.visits).toLocaleString("en-IN")} visits
                </strong>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ background: "white", borderRadius: "var(--radius-lg)", border: "1px solid var(--border-subtle)", padding: "1.25rem" }}>
        <h3 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>
          Top locations / areas · last {range} days
          {topCities.reduce((a, c) => a + (Number(c.gpsVisits) || 0), 0) > 0 && (
            <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", fontWeight: 800, color: "#065f46", background: "#d1fae5", borderRadius: 99, padding: "0.15rem 0.6rem", whiteSpace: "nowrap" }}>
              {topCities.reduce((a, c) => a + (Number(c.gpsVisits) || 0), 0).toLocaleString("en-IN")} GPS-verified
            </span>
          )}
        </h3>
        {topCities.length === 0 ? (
          <p style={{ color: "var(--slate-500)", margin: 0 }}>No location data yet.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {topCities.map((c) => {
              const exact = [c.area, c.city, c.state, c.country].filter(Boolean).join(", ") || "Unknown";
              const gps = Number(c.gpsVisits) || 0;
              const precise = gps > 0;
              return (
                <li
                  key={`${c.area || ""}|${c.city || ""}|${c.state || ""}|${c.country || ""}`}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0", borderBottom: "1px solid var(--slate-100)", fontSize: "0.9rem" }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block" }}>{exact}</span>
                    <span style={{ display: "flex", alignItems: "center", gap: "0.35rem", marginTop: "0.2rem", flexWrap: "wrap" }}>
                      {c.area && c.city ? (
                        <span style={{ color: "var(--slate-500)", fontSize: "0.8rem" }}>
                          {c.area} · {c.city}
                        </span>
                      ) : null}
                      <span
                        title={precise ? `${gps.toLocaleString("en-IN")} of ${Number(c.visits).toLocaleString("en-IN")} visits verified by device GPS` : "Approximate area from network IP"}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.2rem",
                          fontSize: "0.68rem",
                          fontWeight: 800,
                          letterSpacing: "0.02em",
                          borderRadius: 99,
                          padding: "0.1rem 0.5rem",
                          whiteSpace: "nowrap",
                          ...(precise
                            ? { color: "#065f46", background: "#d1fae5", border: "1px solid rgba(5,150,105,0.3)" }
                            : { color: "var(--slate-500)", background: "var(--slate-100)", border: "1px solid var(--slate-200)" }),
                        }}
                      >
                        {precise && <MapPin size={11} aria-hidden="true" />}
                        {precise ? "GPS-precise" : "IP estimate"}
                      </span>
                    </span>
                  </span>
                  <strong style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                    {Number(c.visits).toLocaleString("en-IN")} visits
                  </strong>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default VisitStats;
