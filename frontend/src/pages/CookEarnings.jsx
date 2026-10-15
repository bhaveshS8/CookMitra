import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { formatCurrency, formatDate } from "../utils/constants";
import {
  Wallet,
  TrendingUp,
  Clock3,
  BadgeCheck,
  CalendarDays,
  RefreshCw,
  ArrowLeft,
  ReceiptText,
  History,
  UserRound,
  Hash,
  CircleAlert,
  Landmark,
} from "lucide-react";
import "./CookEarnings.css";

const STATUS_LABEL = {
  pending_weekly: "Pending Weekly Payment",
  pending: "Pending",
  approved: "Approved",
  paid: "Paid",
  held: "Held",
  not_eligible: "Not Eligible",
  under_verification: "Under Verification",
  rejected: "Rejected",
};

const statusClass = (s) =>
  s === "paid" ? "badge-emerald" : s === "approved" ? "badge-blue" : s === "held" ? "badge-rose" : s === "not_eligible" ? "badge-slate" : "badge-amber";

const CookEarnings = () => {
  const [earnings, setEarnings] = useState(null);
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  // Sequence guard: a slow earlier request must never overwrite fresher data.
  const seqRef = useRef(0);

  const load = async (isRefresh = false) => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setLoadError("");
    try {
      // Track each API independently: a payout outage must not wipe the
      // core overview, and a failed refresh must not wipe the last good
      // data with zeros/empties.
      const [e, p] = await Promise.all([
        API.get("/cook/earnings").then((x) => ({ ok: true, data: x.data })).catch(() => ({ ok: false })),
        API.get("/cook/payouts").then((x) => ({ ok: true, data: x.data })).catch(() => ({ ok: false })),
      ]);
      if (seqRef.current !== seq) return; // stale response: ignore
      if (!e.ok) {
        // Core stats failed: surface it loudly, keep previous good data.
        setLoadError("Couldn't load your earnings. Please try again.");
      } else {
        setEarnings(e.data);
      }
      if (p.ok) setCycles(Array.isArray(p.data) ? p.data : []);
    } finally {
      if (seqRef.current !== seq) return;
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="dashboard-container ce-page"><p className="cook-loading-text ce-loading"><span className="ce-spinner" aria-hidden="true" />Loading your earnings…</p></div>;
  const busy = loading || refreshing;
  const ov = earnings?.overview || {};
  // Never present failed data as ₹0: without overview data show a dash.
  const money = (v) => (earnings ? formatCurrency(v ?? 0) : "—");
  const bookingCount = earnings?.bookings?.length ?? 0;

  const stats = [
    { key: "lifetime", label: "Lifetime booking earnings", value: money(ov.lifetime), icon: <Wallet size={20} />, modifier: "ce-stat--hero", title: "Lifetime booking earnings = pending + paid" },
    { key: "week", label: "This week (booking earnings)", value: money(ov.thisWeek), icon: <TrendingUp size={20} />, modifier: "ce-stat--amber" },
    { key: "pending", label: "Pending booking earnings", value: money(ov.pending), icon: <Clock3 size={20} />, modifier: "ce-stat--amber-soft" },
    { key: "paid", label: "Paid booking earnings", value: money(ov.paid), icon: <BadgeCheck size={20} />, modifier: "ce-stat--emerald" },
    { key: "today", label: "Today (booking earnings)", value: money(ov.today), icon: <CalendarDays size={20} />, modifier: "ce-stat--blue" },
  ];

  return (
    <div className="dashboard-container ce-page">
      <div className="ce-hero">
        <div className="ce-hero-inner">
          <span className="ce-hero-icon" aria-hidden="true">
            <Wallet size={26} />
          </span>
          <div className="ce-hero-copy">
            <span className="ce-eyebrow">Cook payouts</span>
            <h1>My Earnings</h1>
            <p className="ce-hero-sub">
              Track what you have earned from bookings and when weekly payouts land.
            </p>
            <div className="ce-hero-pills">
              <span className="ce-pill ce-pill--bright">
                <Wallet size={13} /> Lifetime {money(ov.lifetime)}
              </span>
              <span className="ce-pill">
                <ReceiptText size={13} /> {bookingCount} booking{bookingCount === 1 ? "" : "s"}
              </span>
            </div>
          </div>
          <div className="ce-hero-actions">
            <button type="button" className="ce-glass-btn" onClick={() => load(true)} disabled={busy}>
              <RefreshCw size={15} className={refreshing ? "ce-spin" : ""} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <Link className="ce-glass-btn" to="/dashboard/cook-bookings">
              <ArrowLeft size={15} /> Back to bookings
            </Link>
          </div>
        </div>
      </div>

      {loadError && (
        <div className="error-alert-banner ce-error" role="alert">
          <CircleAlert size={16} aria-hidden="true" />
          <span>{loadError}</span>{" "}
          <button type="button" className="btn btn-outline btn-sm" onClick={() => load(true)} disabled={busy}>
            Try again
          </button>
        </div>
      )}

      <section className="ce-grid ce-overview" aria-label="Earnings overview">
        {stats.map((s) => (
          <div className={`ce-card ce-stat ${s.modifier}`} key={s.key} title={s.title || undefined}>
            <div className="ce-stat-top">
              <span className="ce-stat-ico" aria-hidden="true">{s.icon}</span>
              <span className="ce-label">{s.label}</span>
            </div>
            <strong className="ce-stat-value">{s.value}</strong>
          </div>
        ))}
      </section>

      <section className="ce-section" aria-label="Booking earnings">
        <div className="ce-section-head">
          <span className="ce-section-ico" aria-hidden="true">
            <ReceiptText size={17} />
          </span>
          <h2 className="ce-h2">Booking earnings</h2>
          {bookingCount > 0 && <span className="ce-count">{bookingCount}</span>}
        </div>
        {!earnings ? (
          <p className="ce-empty">Your booking earnings will appear here once they load.</p>
        ) : !earnings?.bookings?.length ? (
          <div className="ce-empty-card">
            <span className="ce-empty-ico" aria-hidden="true"><ReceiptText size={24} /></span>
            <h3>No paid bookings yet</h3>
            <p className="ce-empty">No paid bookings yet — completed bookings show up here with your earnings split.</p>
          </div>
        ) : (
          <div className="ce-list">
            {(earnings.bookings || []).map((b) => (
              <div className="ce-card ce-row" key={b._id} data-status={b.payoutStatus || "pending"}>
                <div className="ce-row-top">
                  <div className="ce-row-id">
                    <span className="ce-avatar" aria-hidden="true">
                      {String(b.customer || "C")[0]?.toUpperCase() || "C"}
                    </span>
                    <div className="ce-row-id-text">
                      <strong>{b.duration ? `${b.duration} Hour Booking` : "Booking"}</strong>
                      <span className="ce-kv ce-row-meta">
                        <UserRound size={12} aria-hidden="true" />
                        {b.customer || "Customer"} · {b.date ? formatDate(b.date) : "date to be confirmed"} ·{" "}
                        <Hash size={11} aria-hidden="true" />{String(b._id || "?").slice(-6).toUpperCase()}
                      </span>
                    </div>
                  </div>
                  <span className={`badge ${statusClass(b.payoutStatus)}`}>{STATUS_LABEL[b.payoutStatus] || b.payoutStatus || "Unknown"}</span>
                </div>
                <div className="ce-money">
                  <div className="ce-money-row">
                    <span>Customer price</span>
                    <strong>Customer price: {formatCurrency(b.finalCustomerPrice)}</strong>
                  </div>
                  <div className="ce-money-row">
                    <span>Platform fee</span>
                    <strong>Platform deduction ({Number.isFinite(Number(b.platformDeductionPercent)) ? Number(b.platformDeductionPercent) : 15}%): {formatCurrency(b.platformDeduction)}</strong>
                  </div>
                  <div className="ce-money-row ce-earn">
                    <span>Your take-home</span>
                    <strong>Your booking earnings: {formatCurrency(b.cookPayout)}</strong>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="ce-section" aria-label="Payment history">
        <div className="ce-section-head">
          <span className="ce-section-ico" aria-hidden="true">
            <History size={17} />
          </span>
          <h2 className="ce-h2">Payment history</h2>
          {cycles?.length > 0 && <span className="ce-count">{cycles.length}</span>}
        </div>
        {!cycles?.length ? (
          <div className="ce-empty-card">
            <span className="ce-empty-ico" aria-hidden="true"><Landmark size={24} /></span>
            <h3>No payouts yet</h3>
            <p className="ce-empty">No payout cycles yet — weekly payouts appear here once approved.</p>
          </div>
        ) : (
          <div className="ce-list">
            {cycles.map((c) => (
              <div className="ce-card ce-row ce-cycle" key={c._id} data-status={c.status || "pending"}>
                <div className="ce-row-top">
                  <div className="ce-row-id">
                    <span className="ce-avatar ce-avatar--cycle" aria-hidden="true">
                      <Landmark size={17} />
                    </span>
                    <div className="ce-row-id-text">
                      <strong>Week of {c.weekStart ? formatDate(c.weekStart) : "—"}</strong>
                      <span className="ce-kv">{c.bookingCount ?? 0} booking{(c.bookingCount ?? 0) === 1 ? "" : "s"} · Gross {formatCurrency(c.grossCustomerValue)} · Deductions {formatCurrency(c.totalDeductions)}</span>
                    </div>
                  </div>
                  <span className={`badge ${statusClass(c.status)}`}>{STATUS_LABEL[c.status] || c.status || "Unknown"}</span>
                </div>
                <div className="ce-cycle-foot">
                  <span className="ce-cycle-earn">Booking earnings <strong>{formatCurrency(c.cookEarnings)}</strong></span>
                  <span className="ce-kv ce-cycle-ref">Ref {c.payoutRef || c.paymentReference || "—"}{c.paymentDate ? ` · Paid ${formatDate(c.paymentDate)}` : ""}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default CookEarnings;
