import React, { useEffect, useState } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate } from "../utils/constants";

// Admin → Cook Partner Incentives (§14): leads, incentives, referrals, payouts.
const TABS = [
  { id: "leads", label: "Leads" },
  { id: "incentives", label: "Incentives" },
  { id: "referrals", label: "Referrals" },
  { id: "payouts", label: "Weekly payouts" },
];

const AdminIncentivesPanel = () => {
  const showToast = useShowToast();
  const [tab, setTab] = useState("leads");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [reason, setReason] = useState("");
  const [buildForm, setBuildForm] = useState({ cookId: "", weekStart: "", weekEnd: "" });
  const [payRef, setPayRef] = useState("");

  const base = (t) =>
    t === "leads" ? "/admin/cook-incentives/leads" : t === "incentives" ? "/admin/cook-incentives/incentives" : t === "referrals" ? "/admin/cook-incentives/referrals" : "/admin/cook-payouts/payouts";

  const load = async (t = tab) => {
    setLoading(true);
    try {
      const res = await API.get(base(t));
      const d = res.data;
      setRows(Array.isArray(d) ? d : d?.items || d?.data || []);
    } catch (err) {
      showToast(err.response?.data?.message || "Could not load data", "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const act = async (method, url, body) => {
    try {
      const fn = method === "post" ? API.post : API.patch;
      const res = await fn(url, body || {});
      showToast("Done", "success");
      load();
      return res.data;
    } catch (err) {
      showToast(err.response?.data?.message || "Action failed", "error");
      return null;
    }
  };

  const buildCycle = async (e) => {
    e.preventDefault();
    if (!buildForm.cookId.trim()) {
      showToast("Cook id is required", "error");
      return;
    }
    await act("post", "/admin/cook-payouts/payouts/build", {
      cookId: buildForm.cookId.trim(),
      ...(buildForm.weekStart ? { weekStart: buildForm.weekStart } : {}),
      ...(buildForm.weekEnd ? { weekEnd: buildForm.weekEnd } : {}),
    });
  };

  return (
    <div className="cook-card">
      <h3 style={{ marginBottom: "0.5rem" }}>Cook Partner Incentives</h3>
      <div className="tabs-navigation-bar" style={{ marginBottom: "0.75rem" }}>
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`tab-btn ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {loading ? <p className="cook-loading-text">Loading…</p> : (
        <div style={{ display: "grid", gap: "0.6rem" }}>
          {tab === "payouts" && (
            <form onSubmit={buildCycle} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "end" }}>
              <label style={{ fontSize: "0.85rem" }}>Cook id<br /><input value={buildForm.cookId} onChange={(e) => setBuildForm({ ...buildForm, cookId: e.target.value })} placeholder="24-hex user id" style={{ minWidth: "220px" }} /></label>
              <label style={{ fontSize: "0.85rem" }}>Week start<br /><input type="date" value={buildForm.weekStart} onChange={(e) => setBuildForm({ ...buildForm, weekStart: e.target.value })} /></label>
              <label style={{ fontSize: "0.85rem" }}>Week end<br /><input type="date" value={buildForm.weekEnd} onChange={(e) => setBuildForm({ ...buildForm, weekEnd: e.target.value })} /></label>
              <button className="btn btn-primary btn-sm" type="submit">Build weekly cycle</button>
            </form>
          )}
          {tab !== "payouts" && (
            <label style={{ fontSize: "0.85rem" }}>Reason (for reject / hold / duplicate)<br />
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required for rejections" style={{ minWidth: "min(320px, 100%)" }} />
            </label>
          )}
          {tab === "payouts" && (
            <label style={{ fontSize: "0.85rem" }}>Payment reference (for Mark paid)<br />
              <input value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="UPI / bank transaction id" style={{ minWidth: "min(320px, 100%)" }} />
            </label>
          )}
          {!rows.length && <p style={{ color: "var(--slate-500)" }}>Nothing here yet.</p>}
          {rows.map((r) => (
            <div key={r._id} className="booking-item-card cook-booking-card cb-card" style={{ padding: "0.75rem" }}>
              {tab === "leads" && (
                <>
                  <strong>{r.customerName}</strong> <span className="badge badge-amber">{r.status}</span>
                  <p style={{ fontSize: "0.85rem", margin: "0.25rem 0" }}>{r.location} · {r.normalizedPhone} · cook {r.cook?.name || r.cook} · verification {r.verificationStatus}</p>
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                    <button className="btn btn-primary btn-sm" type="button" onClick={() => act("post", `/admin/cook-incentives/leads/${r._id}/verify`)}>Verify</button>
                    <button className="btn btn-danger-outline btn-sm" type="button" onClick={() => act("post", `/admin/cook-incentives/leads/${r._id}/reject`, { reason: reason || "Invalid lead" })}>Reject</button>
                    <button className="btn btn-outline btn-sm" type="button" onClick={() => act("post", `/admin/cook-incentives/leads/${r._id}/duplicate`, { reason: reason || "Duplicate lead" })}>Duplicate</button>
                  </div>
                </>
              )}
              {tab === "incentives" && (
                <>
                  <strong>{r.code}</strong> <span className="badge badge-blue">{r.status}</span>
                  <p style={{ fontSize: "0.85rem", margin: "0.25rem 0" }}>cook {r.cook?.name || r.cook} · target {r.target} · verified {r.verifiedLeadCount ?? r.liveVerifiedCount ?? 0} · reward {formatCurrency(r.reward)}</p>
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                    <button className="btn btn-primary btn-sm" type="button" onClick={() => act("post", `/admin/cook-incentives/incentives/${r._id}/approve`)}>Approve</button>
                    <button className="btn btn-danger-outline btn-sm" type="button" onClick={() => act("post", `/admin/cook-incentives/incentives/${r._id}/reject`, { reason: reason || "Not qualified" })}>Reject</button>
                    <button className="btn btn-outline btn-sm" type="button" onClick={() => act("post", `/admin/cook-incentives/incentives/${r._id}/hold`, { reason: reason || "Under review" })}>Hold</button>
                  </div>
                </>
              )}
              {tab === "referrals" && (
                <>
                  <strong>{r.referrer?.name || r.referrer} → {r.referredCook?.name || r.referredCook}</strong> <span className="badge badge-blue">{r.status}</span>
                  <p style={{ fontSize: "0.85rem", margin: "0.25rem 0" }}>bookings {r.liveVerifiedBookings ?? r.verifiedBookings ?? 0}/{r.bookingTarget} · reward {formatCurrency(r.reward)}</p>
                  <button className="btn btn-primary btn-sm" type="button" onClick={() => act("post", `/admin/cook-incentives/referrals/${r._id}/approve`)}>Approve</button>
                </>
              )}
              {tab === "payouts" && (
                <>
                  <strong>{r.payoutRef}</strong> <span className="badge badge-blue">{r.status}</span>
                  <p style={{ fontSize: "0.85rem", margin: "0.25rem 0" }}>{r.bookingCount} bookings · gross {formatCurrency(r.grossCustomerValue)} · payable {formatCurrency(r.totalPayable)} · week {r.weekStart ? formatDate(r.weekStart) : ""}</p>
                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                    <button className="btn btn-primary btn-sm" type="button" onClick={() => act("post", `/admin/cook-payouts/payouts/${r._id}/approve`)}>Approve</button>
                    <button className="btn btn-primary btn-sm" type="button" onClick={() => act("post", `/admin/cook-payouts/payouts/${r._id}/pay`, { reference: payRef || `MANUAL-${Date.now()}` })}>Mark paid</button>
                    <button className="btn btn-outline btn-sm" type="button" onClick={() => act("post", `/admin/cook-payouts/payouts/${r._id}/hold`, { reason: reason || "Under verification" })}>Hold</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default AdminIncentivesPanel;
