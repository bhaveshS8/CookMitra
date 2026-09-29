import React, { useMemo, useState, useCallback } from "react";
import {
  BarChart3,
  CalendarDays,
  ChefHat,
  Clock,
  MapPin,
  Users,
  Wallet,
  RefreshCw,
  IndianRupee,
  Timer,
} from "lucide-react";
import { useFetch } from "../hooks/useFetch";
import { formatCurrency } from "../utils/constants";
import { resolveFileUrl } from "./CookDocUploads";

// Admin booking analytics — renders server-calculated KPIs from
// GET /api/analytics/bookings. The frontend never computes money or booking
// lifecycle totals; it only formats, filters (via query params) and
// visualizes authoritative backend values.
//
// Money labels match backend/utils/analytics.js definitions:
// - Gross Collected = captured real payments (excl. test mode).
// - Refunds = successful refunds only (processed/manual).
// - Net Collected = Gross − Refunds.
// - Platform Earnings / Cook Earnings = net split (sum == Net).
// - Cook Paid / Pending = settled vs pending payout entitlement.

const monthLabel = (ym) => {
  const [y, m] = String(ym || "").split("-");
  const yi = Number(y);
  const mi = Number(m);
  if (!Number.isInteger(yi) || !Number.isInteger(mi) || mi < 1 || mi > 12) return String(ym || "—");
  return new Date(yi, mi - 1, 1).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
  });
};

// Never render NaN/Infinity/undefined money. Backend sends integer rupees;
// anything non-finite displays as ₹0 (explicit zero, never blank).
const safeInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

const safeNum = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const fmtMoney = (v) => formatCurrency(safeInt(v));

const PRESETS = [
  { key: "all", label: "All Time" },
  { key: "today", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
  { key: "lastMonth", label: "Last Month" },
  { key: "last3", label: "Last 3 Months" },
  { key: "last6", label: "Last 6 Months" },
  { key: "last12", label: "Last 12 Months" },
  { key: "custom", label: "Custom Range" },
];

const pad2 = (n) => String(n).padStart(2, "0");
const toYMD = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const presetRange = (key) => {
  const now = new Date();
  if (key === "all" || key === "custom") return { from: "", to: "" };
  if (key === "today") {
    const s = toYMD(now);
    return { from: s, to: s };
  }
  if (key === "week") {
    const dow = (now.getDay() + 6) % 7; // Monday-first
    const mon = new Date(now);
    mon.setDate(now.getDate() - dow);
    return { from: toYMD(mon), to: toYMD(now) };
  }
  if (key === "month") {
    return { from: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-01`, to: toYMD(now) };
  }
  if (key === "lastMonth") {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: toYMD(first), to: toYMD(last) };
  }
  const monthsBack = key === "last3" ? 3 : key === "last6" ? 6 : 12;
  const from = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1);
  return { from: toYMD(from), to: toYMD(now) };
};

const BarList = ({ rows, valueKey, renderLabel, renderExtra, emptyText }) => {
  if (!rows || rows.length === 0) return <p className="anx-empty">{emptyText}</p>;
  const max = Math.max(1, ...rows.map((r) => safeNum(r[valueKey], 0)));
  return (
    <div className="anx-bars">
      {rows.map((r, i) => {
        const v = safeNum(r[valueKey], 0);
        const w = Math.max(0, Math.min(100, Math.round((v / max) * 100)));
        return (
          <div key={i} className="anx-bar-row">
            <span className="anx-bar-label">{renderLabel ? renderLabel(r) : String(v)}</span>
            <span className="anx-bar-track">
              <span className="anx-bar-fill" style={{ width: `${w}%` }} />
            </span>
            <span className="anx-bar-value">{renderExtra ? renderExtra(r) : String(v)}</span>
          </div>
        );
      })}
    </div>
  );
};

const StatCard = ({ icon: Icon, label, value, title }) => (
  <div className="dashboard-stat-card anx-stat" title={title || label}>
    <div className="stat-icon-wrapper anx-stat-icon">
      <Icon size={22} />
    </div>
    <div className="anx-stat-text">
      <div className="stat-metric-number">{value}</div>
      <div className="stat-metric-title">{label}</div>
    </div>
  </div>
);

const AnalyticsPanel = () => {
  const [preset, setPreset] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [dateField, setDateField] = useState("service");
  const [applied, setApplied] = useState({ from: "", to: "", dateField: "service" });

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (applied.from) p.set("from", applied.from);
    if (applied.to) p.set("to", applied.to);
    if (applied.dateField) p.set("dateField", applied.dateField);
    const qs = p.toString();
    return `/analytics/bookings${qs ? `?${qs}` : ""}`;
  }, [applied]);

  const { data, loading, error, refetch } = useFetch(query);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch, refreshing]);

  const applyPreset = (key) => {
    setPreset(key);
    if (key === "all") {
      setFrom("");
      setTo("");
      setApplied({ from: "", to: "", dateField });
      return;
    }
    if (key === "custom") return; // user picks dates, then Apply
    const r = presetRange(key);
    setFrom(r.from);
    setTo(r.to);
    setApplied({ from: r.from, to: r.to, dateField });
  };

  const applyCustom = () => {
    setApplied({ from: from.trim(), to: to.trim(), dateField });
  };

  // Structured totals with legacy-flat fallback (backend sends both).
  const t = data?.totals || {};
  const op = t.operational || {};
  const fin = t.financial || {};
  const svc = t.service || {};

  const totalBookings = safeInt(t.bookings?.total ?? t.totalBookings ?? op.total ?? 0);
  const completed = safeInt(t.bookings?.completed ?? t.completed ?? op.completed ?? 0);
  const active = safeInt(t.bookings?.active ?? t.active ?? op.active ?? 0);
  const lost = safeInt(t.bookings?.lost ?? t.lost ?? op.lost ?? 0);
  const unattended = safeInt(t.bookings?.unattended ?? op.unattended ?? 0);

  const paidBookings = safeInt(fin.paidBookings ?? t.paidBookings ?? 0);
  const grossCollected = safeInt(fin.grossCollected ?? t.grossCollected ?? t.revenue ?? 0);
  const refunds = safeInt(fin.refunds ?? t.refunds ?? 0);
  const netCollected = safeInt(fin.netCollected ?? t.netCollected ?? t.revenue ?? 0);
  const platformEarnings = safeInt(fin.platformEarnings ?? t.commission ?? 0);
  const cookEarnings = safeInt(fin.cookEarnings ?? t.cookPayouts ?? 0);
  const cookPaid = safeInt(fin.cookPaid ?? t.cookPaid ?? 0);
  const cookPending = safeInt(fin.cookPending ?? t.cookPending ?? 0);
  const avgBookingValue = safeInt(fin.avgBookingValue ?? t.avgValue ?? 0);

  const scheduledHours = safeNum(svc.scheduledHours ?? t.totalHours ?? 0);
  const completedHours = safeNum(svc.completedHours ?? t.completedHours ?? 0);
  const avgDuration = safeNum(svc.avgDuration ?? 0);

  const statusBreakdown = data?.statusBreakdown || [];
  const topCooks = data?.topCooks || data?.cooks || [];
  const topAreas = data?.topAreas || data?.areas || [];
  const topCustomers = data?.topCustomers || data?.customers || [];
  const byHours = data?.byHours || data?.durationBreakdown || [];
  const byMonth = data?.monthlyTrend || data?.byMonth || [];
  const meta = data?.meta || {};

  if (loading && !data) {
    return (
      <div className="loading-spinner-wrapper">
        <div className="spinner" />
        <p>Crunching booking numbers…</p>
      </div>
    );
  }
  if (error && !data) {
    const isAuth = /401|403|session|denied|forbidden|unauthor/i.test(String(error));
    return (
      <div className="analytics-panel">
        <div className="error-message">
          {isAuth ? `Access denied — ${error}` : error}
        </div>
        <button type="button" className="btn btn-secondary" onClick={handleRefresh}>
          Retry
        </button>
      </div>
    );
  }

  const stats = [
    { icon: BarChart3, label: "Total Bookings", value: totalBookings, title: "Every booking in scope, all statuses. Active + Completed + Lost + Rejected-side rows reconcile to this total." },
    { icon: CalendarDays, label: "Completed", value: completed, title: "Service rendered and closed (status = completed)." },
    { icon: Clock, label: "Active Now", value: active, title: "In-flight bookings: requested + accepted + confirmed + in_progress." },
    { icon: CalendarDays, label: "Lost (cancel/expired/rejected/unattended)", value: lost, title: "Bookings that ended without service: cancelled + expired + rejected + unattended (no-show)." },
    { icon: Users, label: "Unattended (no-show)", value: unattended, title: "Cook never arrived/started and the session window passed." },
    { icon: Wallet, label: "Paid Bookings", value: paidBookings, title: "Real captured payments (test-mode rows excluded)." },
    { icon: IndianRupee, label: "Gross Collected", value: fmtMoney(grossCollected), title: "Total successful payments before refunds." },
    { icon: Wallet, label: "Refunds", value: fmtMoney(refunds), title: "Successful refunds only (processed/manual). Failed or pending refunds move no money." },
    { icon: Wallet, label: "Net Collected", value: fmtMoney(netCollected), title: "Total successful payments minus successful refunds." },
    { icon: BarChart3, label: "Platform Earnings (net)", value: fmtMoney(platformEarnings), title: "Platform 25% share of net collected (refunded money belongs to neither party)." },
    { icon: ChefHat, label: "Cook Earnings (net)", value: fmtMoney(cookEarnings), title: "Cook 75% share of net collected." },
    { icon: ChefHat, label: "Payout Paid / Pending", value: `${fmtMoney(cookPaid)} / ${fmtMoney(cookPending)}`, title: "Settled offline transfers vs pending entitlement on completed, refund-free bookings." },
    { icon: Wallet, label: "Avg Booking Value (net)", value: fmtMoney(avgBookingValue), title: "Net collected ÷ paid bookings (0 when no paid bookings)." },
    { icon: Timer, label: "Scheduled / Completed Hours", value: `${scheduledHours}h / ${completedHours}h`, title: "Valid 1–4h durations. Scheduled = all in-scope bookings; Completed = status completed only." },
    { icon: Clock, label: "Avg Duration", value: `${avgDuration} hrs`, title: "Scheduled hours ÷ bookings with a valid duration." },
  ];

  const trendNote =
    meta.dateDimensionMeaning ||
    "Metrics scoped by scheduled service date (Booking.date)";

  return (
    <div className="analytics-panel">
      <div className="anx-toolbar">
        <div className="anx-filters">
          <label>
            Range{" "}
            <select value={preset} onChange={(e) => applyPreset(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>
          </label>
          {preset === "custom" && (
            <>
              <label>
                From{" "}
                <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                To{" "}
                <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
              </label>
              <button type="button" className="btn btn-secondary" onClick={applyCustom} disabled={!from || !to}>
                Apply
              </button>
            </>
          )}
          <label title="Service = scheduled service date (Booking.date). Created = booking creation date (createdAt).">
            Date by{" "}
            <select
              value={dateField}
              onChange={(e) => {
                const v = e.target.value;
                setDateField(v);
                setApplied((a) => ({ ...a, dateField: v }));
              }}
            >
              <option value="service">Service date</option>
              <option value="created">Creation date</option>
            </select>
          </label>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handleRefresh}
          disabled={refreshing || loading}
          title="Re-fetch analytics from the server"
        >
          <RefreshCw size={15} /> {refreshing || loading ? "Refreshing…" : "Refresh Analytics"}
        </button>
      </div>
      {meta.generatedAt && (
        <p className="anx-meta">
          Updated {new Date(meta.generatedAt).toLocaleString("en-IN")} IST · {trendNote}
          {meta.filters?.from ? ` · ${meta.filters.from} → ${meta.filters.to}` : " · All time"}
        </p>
      )}

      <div className="anx-overview">
        {stats.map((s) => (
          <StatCard key={s.label} icon={s.icon} label={s.label} value={s.value} title={s.title} />
        ))}
      </div>

      <div className="anx-cols">
        <section className="anx-sec">
          <h3>
            <BarChart3 size={16} /> Booking Status
          </h3>
          <BarList
            rows={statusBreakdown}
            valueKey="count"
            renderLabel={(r) => `${r.status} (${safeNum(r.pct, 0)}%)`}
            renderExtra={(r) => `${safeInt(r.count)}`}
            emptyText="No bookings yet."
          />
        </section>

        <section className="anx-sec">
          <h3>
            <MapPin size={16} /> Most Booked Areas
          </h3>
          <BarList
            rows={topAreas}
            valueKey="bookings"
            renderLabel={(r) => r.area || "Unknown"}
            renderExtra={(r) => `${safeInt(r.bookings)} · ${fmtMoney(r.revenue)}`}
            emptyText="No area data yet."
          />
        </section>

        <section className="anx-sec">
          <h3>
            <Clock size={16} /> Booking Hours (duration mix)
          </h3>
          <BarList
            rows={byHours}
            valueKey="bookings"
            renderLabel={(r) => `${safeNum(r.hours, 0)} hr session`}
            renderExtra={(r) => `${safeInt(r.bookings)}`}
            emptyText="No bookings yet."
          />
        </section>

        <section className="anx-sec">
          <h3>
            <ChefHat size={16} /> Most Booked Cooks
          </h3>
          <BarList
            rows={topCooks}
            valueKey="bookings"
            renderLabel={(r) => (
              <span className="anx-person">
                {r.photoUrl ? (
                  <img src={resolveFileUrl(r.photoUrl)} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                ) : (
                  <span className="anx-person-fallback">{(r.name || "C")[0]}</span>
                )}
                <span className="anx-person-name">{r.name || "Unknown cook"}</span>
              </span>
            )}
            renderExtra={(r) => `${safeInt(r.bookings)} · ${safeNum(r.hours, 0)}h · ${fmtMoney(r.netRevenue ?? r.revenue)}`}
            emptyText="No bookings yet."
          />
        </section>

        <section className="anx-sec">
          <h3>
            <Users size={16} /> Most Booking Customers
          </h3>
          <BarList
            rows={topCustomers}
            valueKey="bookings"
            renderLabel={(r) => (
              <span className="anx-person">
                <span className="anx-person-fallback">{(r.name || "U")[0]}</span>
                <span className="anx-person-name">{r.name || "Unknown customer"}</span>
              </span>
            )}
            renderExtra={(r) => `${safeInt(r.bookings)} · ${fmtMoney(r.netRevenue ?? r.revenue)}`}
            emptyText="No bookings yet."
          />
        </section>
      </div>

      <section className="anx-sec anx-months">
        <h3>
          <CalendarDays size={16} /> Booking Trend — {dateField === "created" ? "by creation date" : "by service date"} (IST)
        </h3>
        <BarList
          rows={byMonth}
          valueKey="bookings"
          renderLabel={(r) => monthLabel(r.month)}
          renderExtra={(r) => `${safeInt(r.bookings)} · ${fmtMoney(r.revenue)}`}
          emptyText="No bookings yet."
        />
      </section>
    </div>
  );
};

export default AnalyticsPanel;
