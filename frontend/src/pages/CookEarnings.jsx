import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { formatCurrency, formatDate } from "../utils/constants";
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

  if (loading) return <div className="dashboard-container"><p className="cook-loading-text">Loading your earnings…</p></div>;
  const busy = loading || refreshing;
  const ov = earnings?.overview || {};
  // Never present failed data as ₹0: without overview data show a dash.
  const money = (v) => (earnings ? formatCurrency(v ?? 0) : "—");

  return (
    <div className="dashboard-container ce-page">
      <div className="ce-head">
        <div>
          <h1>My Earnings</h1>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => load(true)} disabled={busy}>
            {refreshing ? "Refreshing…" : "↻ Refresh"}
          </button>
          <Link className="btn btn-outline btn-sm" to="/dashboard/cook-bookings">← Back to bookings</Link>
        </div>
      </div>

      {loadError && (
        <div className="error-alert-banner" role="alert" style={{ marginBottom: "1rem" }}>
          {loadError}{" "}
          <button type="button" className="btn btn-outline btn-sm" onClick={() => load(true)} disabled={busy}>
            Try again
          </button>
        </div>
      )}

      <section className="ce-grid ce-overview" aria-label="Earnings overview">
        <div className="ce-card"><span className="ce-label">This week (booking earnings)</span><strong>{money(ov.thisWeek)}</strong></div>
        <div className="ce-card"><span className="ce-label">Pending booking earnings</span><strong>{money(ov.pending)}</strong></div>
        <div className="ce-card"><span className="ce-label">Paid booking earnings</span><strong>{money(ov.paid)}</strong></div>
        <div className="ce-card"><span className="ce-label">Today (booking earnings)</span><strong>{money(ov.today)}</strong></div>
        <div className="ce-card" title="Lifetime booking earnings = pending + paid"><span className="ce-label">Lifetime booking earnings</span><strong>{money(ov.lifetime)}</strong></div>
      </section>

      <section aria-label="Booking earnings">
        <h2 className="ce-h2">Booking earnings</h2>
        {!earnings ? (
          <p className="ce-empty">Your booking earnings will appear here once they load.</p>
        ) : !earnings?.bookings?.length ? (
          <p className="ce-empty">No paid bookings yet — completed bookings show up here with your earnings split.</p>
        ) : (
          <div className="ce-list">
            {(earnings.bookings || []).map((b) => (
              <div className="ce-card ce-row" key={b._id}>
                <div className="ce-row-top">
                  <strong>{b.duration ? `${b.duration} Hour Booking` : "Booking"}</strong>
                  <span className={`badge ${statusClass(b.payoutStatus)}`}>{STATUS_LABEL[b.payoutStatus] || b.payoutStatus || "Unknown"}</span>
                </div>
                <div className="ce-kv"><span>{b.customer || "Customer"} · {b.date ? formatDate(b.date) : "date to be confirmed"} · #{String(b._id || "?").slice(-6).toUpperCase()}</span></div>
                <div className="ce-money">
                  <span>Customer price: <strong>{formatCurrency(b.finalCustomerPrice)}</strong></span>
                  <span>Platform deduction ({Number.isFinite(Number(b.platformDeductionPercent)) ? Number(b.platformDeductionPercent) : 15}%): <strong>{formatCurrency(b.platformDeduction)}</strong></span>
                  <span className="ce-earn">Your booking earnings: <strong>{formatCurrency(b.cookPayout)}</strong></span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Payment history">
        <h2 className="ce-h2">Payment history</h2>
        {!cycles?.length ? <p className="ce-empty">No payout cycles yet — weekly payouts appear here once approved.</p> : (
          <div className="ce-list">
            {cycles.map((c) => (
              <div className="ce-card ce-row" key={c._id}>
                <div className="ce-row-top"><strong>Week of {c.weekStart ? formatDate(c.weekStart) : "—"}</strong><span className={`badge ${statusClass(c.status)}`}>{STATUS_LABEL[c.status] || c.status || "Unknown"}</span></div>
                <p className="ce-kv">{c.bookingCount ?? 0} bookings · Gross {formatCurrency(c.grossCustomerValue)} · Deductions {formatCurrency(c.totalDeductions)} · <strong>Booking earnings {formatCurrency(c.cookEarnings)}</strong></p>
                <p className="ce-kv">Ref {c.payoutRef || c.paymentReference || "—"}{c.paymentDate ? ` · Paid ${formatDate(c.paymentDate)}` : ""}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default CookEarnings;
