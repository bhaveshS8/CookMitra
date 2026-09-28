import React from "react";
import {
  BarChart3,
  CalendarDays,
  ChefHat,
  Clock,
  MapPin,
  Users,
  Wallet,
} from "lucide-react";
import { useFetch } from "../hooks/useFetch";
import { formatCurrency } from "../utils/constants";

// Admin booking analytics — one endpoint (/analytics/bookings), rendered as
// stat cards + CSS bar rows (no chart library dependency).

const monthLabel = (ym) => {
  const [y, m] = String(ym || "").split("-");
  if (!y || !m) return ym;
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
  });
};

const BarList = ({ rows, valueKey, labelKey = "label", renderLabel, renderExtra, emptyText }) => {
  if (!rows || rows.length === 0) return <p className="anx-empty">{emptyText}</p>;
  const max = Math.max(1, ...rows.map((r) => r[valueKey] || 0));
  return (
    <div className="anx-bars">
      {rows.map((r, i) => (
        <div key={i} className="anx-bar-row">
          <span className="anx-bar-label">{renderLabel ? renderLabel(r) : r[labelKey]}</span>
          <span className="anx-bar-track">
            <span
              className="anx-bar-fill"
              style={{ width: `${Math.round(((r[valueKey] || 0) / max) * 100)}%` }}
            />
          </span>
          <span className="anx-bar-value">{renderExtra ? renderExtra(r) : r[valueKey]}</span>
        </div>
      ))}
    </div>
  );
};

const AnalyticsPanel = () => {
  const { data, loading, error } = useFetch("/analytics/bookings");

  if (loading) {
    return (
      <div className="loading-spinner-wrapper">
        <div className="spinner" />
        <p>Crunching booking numbers…</p>
      </div>
    );
  }
  if (error) {
    return <div className="error-message">{error}</div>;
  }

  const t = data?.totals || {};
  const money = (t.paidBookings ?? 0) || t.revenue || 0
    ? { paidBookings: t.paidBookings ?? 0, revenue: t.revenue ?? 0, commission: t.commission ?? 0, cookPayouts: t.cookPayouts ?? 0 }
    : { paidBookings: 0, revenue: 0, commission: 0, cookPayouts: 0 };
  const topCooks = data?.topCooks || [];
  const topAreas = data?.topAreas || [];
  const topCustomers = data?.topCustomers || [];
  const byHours = data?.byHours || [];
  const byMonth = (data?.byMonth || []).slice(-12);

  const stats = [
    { icon: BarChart3, label: "Total Bookings", value: t.totalBookings ?? 0 },
    { icon: CalendarDays, label: "Completed", value: t.completed ?? 0 },
    { icon: Clock, label: "Active Now", value: t.active ?? 0 },
    { icon: CalendarDays, label: "Lost (cancel/expired)", value: t.lost ?? 0 },
    { icon: Wallet, label: "Revenue (paid)", value: formatCurrency(money.revenue) },
    { icon: BarChart3, label: "Platform Earnings", value: formatCurrency(money.commission) },
    { icon: ChefHat, label: "Cook Payouts", value: formatCurrency(money.cookPayouts) },
    { icon: Clock, label: "Hours Booked", value: `${t.totalHours ?? 0} hrs` },
  ];

  return (
    <div className="analytics-panel">
      <div className="anx-overview">
        {stats.map((s) => (
          <div key={s.label} className="dashboard-stat-card anx-stat">
            <div className="stat-icon-wrapper anx-stat-icon">
              <s.icon size={22} />
            </div>
            <div className="anx-stat-text">
              <div className="stat-metric-number">{s.value}</div>
              <div className="stat-metric-title">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="anx-cols">
        <section className="anx-sec">
          <h3>
            <MapPin size={16} /> Most Booked Areas
          </h3>
          <BarList
            rows={topAreas}
            valueKey="bookings"
            renderLabel={(r) => r.area}
            renderExtra={(r) => `${r.bookings} · ${formatCurrency(r.revenue || 0)}`}
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
            renderLabel={(r) => `${r.hours} hr session`}
            renderExtra={(r) => `${r.bookings}`}
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
                  <img src={r.photoUrl} alt="" />
                ) : (
                  <span className="anx-person-fallback">{(r.name || "C")[0]}</span>
                )}
                <span className="anx-person-name">{r.name || "Unknown cook"}</span>
              </span>
            )}
            renderExtra={(r) => `${r.bookings} · ${r.hours || 0}h`}
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
            renderExtra={(r) => `${r.bookings} · ${formatCurrency(r.revenue || 0)}`}
            emptyText="No bookings yet."
          />
        </section>
      </div>

      <section className="anx-sec anx-months">
        <h3>
          <CalendarDays size={16} /> Booking Trend (last 12 months)
        </h3>
        <BarList
          rows={byMonth}
          valueKey="bookings"
          renderLabel={(r) => monthLabel(r.month)}
          renderExtra={(r) => `${r.bookings} · ${formatCurrency(r.revenue || 0)}`}
          emptyText="No bookings yet."
        />
      </section>
    </div>
  );
};

export default AnalyticsPanel;