import React, { useEffect, useMemo, useRef, useState } from "react";

// Visit analytics graph — daily visits (area) + unique visitors (line).
// Pure SVG, no chart library: responsive, offline-friendly, matches the
// dashboard palette. Props: days = [{ day: "YYYY-MM-DD", visits, uniques }].
const H = 260;
const PAD = { top: 16, right: 12, bottom: 30, left: 42 };

// Round up to a "nice" axis step (1 / 2 / 2.5 / 5 × 10^n).
const niceCeil = (v) => {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const f = v / Math.pow(10, exp);
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
};

const shortLabel = (day) =>
  new Date(`${day}T00:00:00+05:30`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });

const fullLabel = (day) =>
  new Date(`${day}T00:00:00+05:30`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

const VisitChart = ({ days = [] }) => {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    if (!wrapRef.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setWidth(w);
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const W = width || 640;
  const innerW = Math.max(10, W - PAD.left - PAD.right);
  const innerH = H - PAD.top - PAD.bottom;

  const model = useMemo(() => {
    const pts = days.map((d) => ({
      day: d.day,
      visits: Number(d.visits) || 0,
      uniques: Number(d.uniques) || 0,
    }));
    const maxV = Math.max(1, ...pts.map((p) => Math.max(p.visits, p.uniques)));
    const step = niceCeil(maxV / 4);
    const yMax = Math.max(step * 4, maxV);
    const n = pts.length;
    const x = (i) => (n <= 1 ? PAD.left + innerW / 2 : PAD.left + (i * innerW) / (n - 1));
    const y = (v) => PAD.top + innerH * (1 - v / yMax);
    const line = (key) =>
      pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
    const area = `${line("visits")} L${x(n - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(PAD.top + innerH).toFixed(1)} Z`;
    const ticks = [0, 1, 2, 3, 4].map((t) => t * step);
    // ~7 evenly spaced x labels regardless of range length.
    const labelIdx = n <= 7 ? pts.map((_, i) => i) : Array.from({ length: 7 }, (_, k) => Math.round((k * (n - 1)) / 6));
    const peak = pts.reduce((best, p) => (p.visits > (best?.visits ?? -1) ? p : best), null);
    const avg = n ? pts.reduce((s, p) => s + p.visits, 0) / n : 0;
    return { pts, n, x, y, line, area, ticks, yMax, labelIdx, peak, avg };
  }, [days, innerW, innerH]);

  if (model.n === 0) {
    return (
      <p style={{ color: "var(--slate-500)", margin: 0 }}>
        No visits recorded yet — the graph appears here from the first visitor session.
      </p>
    );
  }

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const stepX = model.n <= 1 ? innerW : innerW / (model.n - 1);
    const idx = Math.min(model.n - 1, Math.max(0, Math.round((px - PAD.left) / stepX)));
    setHover(idx);
  };

  const hp = hover != null ? model.pts[hover] : null;
  // Keep the tooltip inside the chart on both edges.
  const tipLeft = hover != null ? Math.min(Math.max((model.x(hover) / W) * 100, 18), 82) : 0;

  return (
    <div>
      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "0.75rem", fontSize: "0.78rem", fontWeight: 700, color: "var(--slate-600)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
          <span style={{ width: "22px", height: "10px", borderRadius: "3px", background: "linear-gradient(180deg, #fb923c, #c2410c)" }} />
          Visits
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
          <span style={{ width: "22px", height: "3px", borderRadius: "2px", background: "#059669" }} />
          Unique visitors
        </span>
        {model.peak && model.peak.visits > 0 && (
          <span style={{ color: "var(--slate-400)", fontWeight: 600 }}>
            Peak {model.peak.visits.toLocaleString("en-IN")} on {shortLabel(model.peak.day)} · Avg {Math.round(model.avg).toLocaleString("en-IN")}/day
          </span>
        )}
      </div>

      <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          role="img"
          aria-label={`Visits graph: ${model.n} days, peak ${model.peak ? `${model.peak.visits} visits on ${model.peak.day}` : "no data"}`}
          style={{ display: "block", overflow: "visible" }}
        >
          <defs>
            <linearGradient id="visit-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f97316" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#f97316" stopOpacity="0.04" />
            </linearGradient>
          </defs>

          {/* Gridlines + y labels */}
          {model.ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={model.y(t)}
                y2={model.y(t)}
                stroke="#e2e8f0"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 8}
                y={model.y(t) + 4}
                textAnchor="end"
                fontSize="11"
                fill="#94a3b8"
                fontWeight="600"
              >
                {t >= 1000 ? `${Math.round(t / 100) / 10}k` : t}
              </text>
            </g>
          ))}

          {/* X labels */}
          {model.labelIdx.map((i) => (
            <text
              key={model.pts[i].day}
              x={model.x(i)}
              y={H - 8}
              textAnchor="middle"
              fontSize="11"
              fill="#94a3b8"
              fontWeight="600"
            >
              {shortLabel(model.pts[i].day)}
            </text>
          ))}

          {/* Visits area + uniques line */}
          <path d={model.area} fill="url(#visit-area)" />
          <path d={model.line("visits")} fill="none" stroke="#ea580c" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          <path d={model.line("uniques")} fill="none" stroke="#059669" strokeWidth="2" strokeDasharray="6 3" strokeLinejoin="round" strokeLinecap="round" />

          {/* Hover guide + dots */}
          {hp && (
            <g>
              <line
                x1={model.x(hover)}
                x2={model.x(hover)}
                y1={PAD.top}
                y2={PAD.top + innerH}
                stroke="#cbd5e1"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              <circle cx={model.x(hover)} cy={model.y(hp.visits)} r="4.5" fill="#ea580c" stroke="#fff" strokeWidth="2" />
              <circle cx={model.x(hover)} cy={model.y(hp.uniques)} r="4" fill="#059669" stroke="#fff" strokeWidth="2" />
            </g>
          )}
        </svg>

        {hp && (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: `${tipLeft}%`,
              transform: "translateX(-50%)",
              background: "var(--slate-900)",
              color: "#fff",
              borderRadius: "10px",
              padding: "0.45rem 0.65rem",
              fontSize: "0.74rem",
              fontWeight: 700,
              whiteSpace: "nowrap",
              boxShadow: "0 8px 20px rgba(0,0,0,0.25)",
              pointerEvents: "none",
              zIndex: 2,
            }}
          >
            <div style={{ color: "#cbd5e1", fontWeight: 600 }}>{fullLabel(hp.day)}</div>
            <div>🔶 {hp.visits.toLocaleString("en-IN")} visits</div>
            <div>🟢 {hp.uniques.toLocaleString("en-IN")} unique</div>
          </div>
        )}
      </div>
    </div>
  );
};

export default VisitChart;
