import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
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
  const showToast = useShowToast();
  const [earnings, setEarnings] = useState(null);
  const [incentives, setIncentives] = useState([]);
  const [leads, setLeads] = useState([]);
  const [referral, setReferral] = useState(null);
  const [cycles, setCycles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [leadForm, setLeadForm] = useState({ customerName: "", mobileNumber: "", location: "", requiredService: "cook_with_me", notes: "" });
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [e, i, l, r, p] = await Promise.all([
        API.get("/cook/earnings").then((x) => x.data).catch(() => null),
        API.get("/cook/incentives/progress").then((x) => x.data).catch(() => []),
        API.get("/cook/leads").then((x) => x.data).catch(() => []),
        API.get("/cook/referral").then((x) => x.data).catch(() => null),
        API.get("/cook/payouts").then((x) => x.data).catch(() => []),
      ]);
      setEarnings(e);
      setIncentives(Array.isArray(i) ? i : i?.incentives || []);
      setLeads(Array.isArray(l) ? l : []);
      setReferral(r);
      setCycles(Array.isArray(p) ? p : []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copyText = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copied`, "success");
    } catch {
      showToast("Copy failed — please copy manually", "error");
    }
  };

  const shareReferral = () => {
    const link = referral?.referralLink ? `${window.location.origin}${referral.referralLink}` : "";
    const text = `Join Cook Mitra as a cook with my referral ${referral?.referralCode}: ${link}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
  };

  const submitLead = async (ev) => {
    ev.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await API.post("/cook/leads", leadForm);
      showToast("Lead submitted — our team will verify it", "success");
      setLeadForm({ customerName: "", mobileNumber: "", location: "", requiredService: "cook_with_me", notes: "" });
      const l = await API.get("/cook/leads").then((x) => x.data).catch(() => []);
      setLeads(Array.isArray(l) ? l : []);
    } catch (err) {
      showToast(err.response?.data?.message || "Could not submit lead", "error");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="dashboard-container"><p className="cook-loading-text">Loading your earnings…</p></div>;
  const ov = earnings?.overview || {};

  return (
    <div className="dashboard-container ce-page">
      <div className="ce-head">
        <div>
          <h1>My Earnings</h1>
          <p className="ce-sub">Booking payouts (85% of final price) + incentives + referrals.</p>
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
        {!earnings?.bookings?.length ? <p className="ce-empty">No paid bookings yet — your 85% share appears here.</p> : (
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

      <section aria-label="My leads">
        <h2 className="ce-h2">My leads</h2>
        <form className="ce-card ce-form" onSubmit={submitLead}>
          <div className="ce-form-grid">
            <input placeholder="Customer name" value={leadForm.customerName} onChange={(e) => setLeadForm({ ...leadForm, customerName: e.target.value })} maxLength={80} required />
            <input placeholder="10-digit mobile" value={leadForm.mobileNumber} onChange={(e) => setLeadForm({ ...leadForm, mobileNumber: e.target.value.replace(/\D/g, "").slice(0, 10) })} inputMode="numeric" required />
            <input placeholder="Location" value={leadForm.location} onChange={(e) => setLeadForm({ ...leadForm, location: e.target.value })} maxLength={120} required />
            <select value={leadForm.requiredService} onChange={(e) => setLeadForm({ ...leadForm, requiredService: e.target.value })}>
              <option value="cook_for_me">Cook for me</option>
              <option value="cook_with_me">Cook with me</option>
              <option value="teach_me">Teach me</option>
              <option value="preparation_help">Preparation help</option>
              <option value="other">Other</option>
            </select>
          </div>
          <textarea placeholder="Notes (optional)" value={leadForm.notes} onChange={(e) => setLeadForm({ ...leadForm, notes: e.target.value })} maxLength={500} rows={2} />
          <button className="btn btn-primary btn-sm" disabled={submitting} type="submit">{submitting ? "Submitting…" : "Submit lead"}</button>
        </form>
        <div className="ce-list">
          {(leads || []).map((l) => (
            <div className="ce-card ce-row" key={l._id}>
              <div className="ce-row-top"><strong>{l.customerName}</strong><span className={`badge ${l.status === "verified" ? "badge-emerald" : ["rejected", "invalid", "duplicate"].includes(l.status) ? "badge-rose" : "badge-amber"}`}>{String(l.status).replace(/_/g, " ")}</span></div>
              <p className="ce-kv">{l.location} · {l.requiredService?.replace(/_/g, " ")} · verification: {String(l.verificationStatus).replace(/_/g, " ")}{l.rejectionReason ? ` — ${l.rejectionReason}` : ""}</p>
            </div>
          ))}
          {!leads?.length && <p className="ce-empty">No leads yet — submit your first customer lead above.</p>}
        </div>
      </section>

      <section aria-label="Referrals">
        <h2 className="ce-h2">My referrals</h2>
        <div className="ce-card">
          <p className="ce-kv">Referral code: <strong>{referral?.referralCode || "—"}</strong></p>
          <p className="ce-kv">Referral link: <strong>{referral?.referralLink ? `${window.location.origin}${referral.referralLink}` : "—"}</strong></p>
          <p className="ce-kv">Reward {formatCurrency(referral?.reward ?? 250)} after {referral?.bookingTarget ?? 10} verified bookings · {referral?.totalReferrals ?? 0} referred · {referral?.totalSuccessfulReferrals ?? 0} successful</p>
          <div className="ce-btn-row">
            <button className="btn btn-outline btn-sm" type="button" onClick={() => referral?.referralCode && copyText(referral.referralCode, "Referral code")}>Copy code</button>
            <button className="btn btn-outline btn-sm" type="button" onClick={() => referral?.referralLink && copyText(`${window.location.origin}${referral.referralLink}`, "Referral link")}>Copy link</button>
            <button className="btn btn-outline btn-sm" type="button" onClick={shareReferral}>Share on WhatsApp</button>
            <Link className="btn btn-outline btn-sm" to="/dashboard/cook-profile">View profile</Link>
          </div>
        </div>
        <div className="ce-list">
          {(referral?.referrals || []).map((r) => {
            const done = r.liveVerifiedBookings ?? r.verifiedBookings ?? 0;
            const pct = Math.min(100, Math.round((done / (r.bookingTarget || 10)) * 100));
            return (
              <div className="ce-card" key={r._id}>
                <div className="ce-row-top"><strong>{r.referredCook?.name || "Referred cook"}</strong><span className={`badge ${r.status === "paid" ? "badge-emerald" : r.status === "approved" ? "badge-blue" : "badge-amber"}`}>{String(r.status).replace(/_/g, " ")}</span></div>
                <p className="ce-kv">Verified bookings: {done} / {r.bookingTarget || 10} · Reward {formatCurrency(r.reward)}</p>
                <div className="ce-bar" role="progressbar" aria-valuenow={pct} aria-valuemin="0" aria-valuemax="100"><span style={{ width: `${pct}%` }} /></div>
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
