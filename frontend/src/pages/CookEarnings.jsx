import React, { useEffect, useState } from "react";
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
  const [incentives, setIncentives] = useState([]);
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [e, i, p] = await Promise.all([
        API.get("/cook/earnings").then((x) => x.data).catch(() => null),
        API.get("/cook/incentives/progress").then((x) => x.data).catch(() => []),
        API.get("/cook/payouts").then((x) => x.data).catch(() => []),
      ]);
      setEarnings(e);
      setIncentives(Array.isArray(i) ? i : i?.incentives || []);
      setCycles(Array.isArray(p) ? p : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="dashboard-container"><p className="cook-loading-text">Loading your earnings…</p></div>;
  const ov = earnings?.overview || {};

  return (
    <div className="dashboard-container ce-page">
      <div className="ce-head">
        <div>
          <h1>My Earnings</h1>
        </div>
        <Link className="btn btn-outline btn-sm" to="/dashboard/cook-bookings">← Back to bookings</Link>
      </div>

      <section className="ce-grid ce-overview" aria-label="Earnings overview">
        <div className="ce-card"><span className="ce-label">This week</span><strong>{formatCurrency(ov.thisWeek ?? 0)}</strong></div>
        <div className="ce-card"><span className="ce-label">Pending</span><strong>{formatCurrency(ov.pending ?? 0)}</strong></div>
        <div className="ce-card"><span className="ce-label">Paid</span><strong>{formatCurrency(ov.paid ?? 0)}</strong></div>
        <div className="ce-card"><span className="ce-label">Bonuses</span><strong>{formatCurrency(ov.bonuses ?? 0)}</strong></div>
        <div className="ce-card"><span className="ce-label">Today</span><strong>{formatCurrency(ov.today ?? 0)}</strong></div>
        <div className="ce-card"><span className="ce-label">Lifetime</span><strong>{formatCurrency(ov.lifetime ?? 0)}</strong></div>
      </section>

      <section aria-label="Booking earnings">
        <h2 className="ce-h2">Booking earnings</h2>
        {!earnings?.bookings?.length ? null : (
          <div className="ce-list">
            {(earnings.bookings || []).map((b) => (
              <div className="ce-card ce-row" key={b._id}>
                <div className="ce-row-top">
                  <strong>{b.duration ? `${b.duration} Hour Booking` : "Booking"}</strong>
                  <span className={`badge ${statusClass(b.payoutStatus)}`}>{STATUS_LABEL[b.payoutStatus] || b.payoutStatus}</span>
                </div>
                <div className="ce-kv"><span>{b.customer} · {b.date ? formatDate(b.date) : ""} · #{String(b._id).slice(-6).toUpperCase()}</span></div>
                <div className="ce-money">
                  <span>Customer price: <strong>{formatCurrency(b.finalCustomerPrice)}</strong></span>
                  <span>Platform deduction (15%): <strong>{formatCurrency(b.platformDeduction)}</strong></span>
                  <span className="ce-earn">Your earnings: <strong>{formatCurrency(b.cookPayout)}</strong></span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Incentives">
        <h2 className="ce-h2">Incentives</h2>
        <div className="ce-grid ce-slabs">
          {[{ leads: 10, reward: 500 }, { leads: 20, reward: 1000 }, { leads: 30, reward: 1500 }, { leads: 50, reward: 2500 }].map((s) => (
            <div className="ce-card ce-slab" key={s.leads}><strong>{s.leads} Leads → {formatCurrency(s.reward)}</strong></div>
          ))}
        </div>
        <div className="ce-list">
          {(incentives || []).map((i) => {
            const pct = i.target ? Math.min(100, Math.round(((i.verifiedLeadCount || 0) / i.target) * 100)) : 0;
            return (
              <div className="ce-card" key={i.code}>
                <div className="ce-row-top"><strong>{i.code} Incentive</strong><span className={`badge ${i.status === "paid" ? "badge-emerald" : i.status === "approved" ? "badge-blue" : "badge-amber"}`}>{String(i.status).replace(/_/g, " ")}</span></div>
                <p className="ce-kv">{i.verifiedLeadCount || 0} / {i.target} verified leads · {(i.remaining ?? Math.max(0, i.target - (i.verifiedLeadCount || 0)))} more needed · Reward {formatCurrency(i.reward)}</p>
                <div className="ce-bar" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100"><span style={{ width: `${pct}%` }} /></div>
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
                <div className="ce-row-top"><strong>Week of {formatDate(c.weekStart)}</strong><span className={`badge ${statusClass(c.status)}`}>{STATUS_LABEL[c.status] || c.status}</span></div>
                <p className="ce-kv">{c.bookingCount} bookings · Gross {formatCurrency(c.grossCustomerValue)} · Deductions {formatCurrency(c.totalDeductions)} · Earnings {formatCurrency(c.cookEarnings)} · Bonuses {formatCurrency(c.bonuses)} · Referrals {formatCurrency(c.referralEarnings)} · <strong>Total {formatCurrency(c.totalPayable)}</strong></p>
                <p className="ce-kv">Ref {c.payoutRef}{c.paymentDate ? ` · Paid ${formatDate(c.paymentDate)}` : ""}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

export default CookEarnings;
