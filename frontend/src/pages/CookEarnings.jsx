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

const incentiveClass = (s) =>
  s === "paid" ? "badge-emerald" : s === "approved" || s === "qualified" ? "badge-blue" : s === "rejected" || s === "expired" ? "badge-slate" : s === "held" ? "badge-rose" : "badge-amber";

const clampPct = (v) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));

const FALLBACK_SLABS = [
  { leads: 10, reward: 500 },
  { leads: 20, reward: 1000 },
  { leads: 30, reward: 1500 },
  { leads: 50, reward: 2500 },
];

const CookEarnings = () => {
  const [earnings, setEarnings] = useState(null);
  const [incentives, setIncentives] = useState([]);
  const [slabs, setSlabs] = useState(FALLBACK_SLABS);
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
      // Track each API independently: an incentive/payout outage must not
      // wipe the core overview, and a failed refresh must not wipe the
      // last good data with zeros/empties.
      const [e, i, p, s] = await Promise.all([
        API.get("/cook/earnings").then((x) => ({ ok: true, data: x.data })).catch(() => ({ ok: false })),
        API.get("/cook/incentives/progress").then((x) => ({ ok: true, data: x.data })).catch(() => ({ ok: false })),
        API.get("/cook/payouts").then((x) => ({ ok: true, data: x.data })).catch(() => ({ ok: false })),
        // Slab strip is server-driven (config), with a static fallback so a
        // slabs outage never blanks the section.
        API.get("/cook/incentives").then((x) => ({ ok: true, data: x.data })).catch(() => ({ ok: false })),
      ]);
      if (seqRef.current !== seq) return; // stale response: ignore
      if (!e.ok) {
        // Core stats failed: surface it loudly, keep previous good data.
        setLoadError("Couldn't load your earnings. Please try again.");
      } else {
        setEarnings(e.data);
      }
      if (i.ok) setIncentives(Array.isArray(i.data) ? i.data : i.data?.incentives || []);
      if (p.ok) setCycles(Array.isArray(p.data) ? p.data : []);
      if (s.ok && Array.isArray(s.data?.slabs) && s.data.slabs.length) {
        const serverSlabs = s.data.slabs
          .map((sl) => ({ leads: Number(sl.leads), reward: Number(sl.reward) }))
          .filter((sl) => Number.isFinite(sl.leads) && sl.leads > 0 && Number.isFinite(sl.reward) && sl.reward >= 0);
        if (serverSlabs.length) setSlabs(serverSlabs);
      }
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
        <div className="ce-card" title="Approved/paid incentive rewards plus approved/paid referral rewards — kept separate from booking earnings"><span className="ce-label">Incentive + referral rewards</span><strong>{money(ov.bonuses)}</strong></div>
        <div className="ce-card"><span className="ce-label">Today (booking earnings)</span><strong>{money(ov.today)}</strong></div>
        <div className="ce-card" title="Lifetime booking earnings = pending + paid; incentive and referral rewards are reported separately above"><span className="ce-label">Lifetime booking earnings</span><strong>{money(ov.lifetime)}</strong></div>
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

      <section aria-label="Incentives">
        <h2 className="ce-h2">Incentives</h2>
        <div className="ce-grid ce-slabs">
          {slabs.map((s) => (
            <div className="ce-card ce-slab" key={s.leads}><strong>{s.leads} Leads → {formatCurrency(s.reward)}</strong></div>
          ))}
        </div>
        <div className="ce-list">
          {!(incentives || []).length ? (
            <p className="ce-empty">No incentives yet — verified customer leads unlock rewards here.</p>
          ) : (incentives || []).map((i) => {
            const target = Number(i.target) || 0;
            const verified = Math.max(0, Number(i.verifiedLeadCount) || 0);
            const pct = target > 0 ? clampPct((verified / target) * 100) : 0;
            const remaining = Math.max(0, Number.isFinite(Number(i.remaining)) ? Number(i.remaining) : target - verified);
            return (
              <div className="ce-card" key={i.code || `${target}-${i.reward}`}>
                <div className="ce-row-top"><strong>{i.code || "Lead"} Incentive</strong><span className={`badge ${incentiveClass(i.status)}`}>{String(i.status || "in progress").replace(/_/g, " ")}</span></div>
                <p className="ce-kv">{verified} / {target} verified leads · {remaining} more needed · Reward {formatCurrency(i.reward)}</p>
                <div className="ce-bar" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100" aria-label={`${i.code || "Lead"} incentive progress`}><span style={{ width: `${pct}%` }} /></div>
                <p className="ce-kv">Deadline: {i.deadline || i.endDate ? formatDate(i.deadline || i.endDate) : "—"}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section aria-label="Payment history">
        <h2 className="ce-h2">Payment history</h2>
        {!cycles?.length ? <p className="ce-empty">No payout cycles yet — weekly payouts appear here once approved.</p> : (
          <div className="ce-list">
            {cycles.map((c) => (
              <div className="ce-card ce-row" key={c._id}>
                <div className="ce-row-top"><strong>Week of {c.weekStart ? formatDate(c.weekStart) : "—"}</strong><span className={`badge ${statusClass(c.status)}`}>{STATUS_LABEL[c.status] || c.status || "Unknown"}</span></div>
                <p className="ce-kv">{c.bookingCount ?? 0} bookings · Gross {formatCurrency(c.grossCustomerValue)} · Deductions {formatCurrency(c.totalDeductions)} · Booking earnings {formatCurrency(c.cookEarnings)} · Bonuses {formatCurrency(c.bonuses)} · Referrals {formatCurrency(c.referralEarnings)} · <strong>Cycle total payable (booking earnings only) {formatCurrency(c.totalPayable)}</strong></p>
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
