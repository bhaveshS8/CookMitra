import React, { useEffect, useState } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate } from "../utils/constants";

const TABS = [
  { id: "leads", label: "Leads" },
  { id: "incentives", label: "Incentives" },
  { id: "referrals", label: "Referrals" },
  { id: "payouts", label: "Weekly payouts" },
];

// One badge style per status family — glanceable, no per-tab hardcoding.
const statusBadge = (status) => {
  const s = String(status || "").toLowerCase();
  if (/reject|fail|invalid|duplicate/.test(s)) return "badge-rose";
  if (/approv|verif|paid|process|complete|active/.test(s)) return "badge-emerald";
  if (/hold|review|pending|new|scheduled/.test(s)) return "badge-amber";
  return "badge-slate";
};

const prettyStatus = (status) => String(status || "—").replace(/_/g, " ");

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

  // Sequence guard: fast tab switches must not let a stale response
  // overwrite the current tab's rows.
  const seqRef = React.useRef(0);
  const load = async (t = tab) => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setLoading(true);
    try {
      const res = await API.get(base(t));
      if (seqRef.current !== seq) return;
      const d = res.data;
      setRows(Array.isArray(d) ? d : d?.items || d?.data || []);
    } catch (err) {
      if (seqRef.current !== seq) return;
      showToast(err.response?.data?.message || "Could not load data", "error");
    } finally {
      if (seqRef.current === seq) setLoading(false);
    }
  };

  useEffect(() => {
    load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // In-flight guard: double-clicking an action fires it only once.
  const [actingId, setActingId] = useState(null);
  const actingRef = React.useRef(false);
  const act = async (method, url, body, rowId) => {
    if (actingRef.current) return null;
    actingRef.current = true;
    if (rowId) setActingId(rowId);
    try {
      const fn = method === "post" ? API.post : API.patch;
      const res = await fn(url, body || {});
      showToast("Done", "success");
      load();
      return res.data;
    } catch (err) {
      showToast(err.response?.data?.message || "Action failed", "error");
      return null;
    } finally {
      actingRef.current = false;
      if (rowId) setActingId(null);
    }
  };

  const markPaid = (row) => {
    // Never auto-invent a reference: the payout trail needs the real id.
    if (!payRef.trim()) {
      showToast("Enter the UPI / bank transaction id first", "error");
      return;
    }
    act("post", `/admin/cook-payouts/payouts/${row._id}/pay`, { reference: payRef.trim() }, row._id);
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

  const busy = actingId !== null;
  const btn = (label, onClick, rowId, kind = "primary") => (
    <button
      key={label}
      className={`btn btn-sm ${kind === "primary" ? "btn-primary" : kind === "danger" ? "btn-danger-outline" : "btn-outline"}`}
      type="button"
      disabled={busy}
      onClick={onClick}
    >
      {actingId === rowId ? "Working…" : label}
    </button>
  );

  const actionsFor = (r) => {
    if (tab === "leads") return [
      btn("Verify", () => act("post", `/admin/cook-incentives/leads/${r._id}/verify`, {}, r._id), r._id),
      btn("Reject", () => act("post", `/admin/cook-incentives/leads/${r._id}/reject`, { reason: reason || "Invalid lead" }, r._id), r._id, "danger"),
      btn("Duplicate", () => act("post", `/admin/cook-incentives/leads/${r._id}/duplicate`, { reason: reason || "Duplicate lead" }, r._id), r._id, "ghost"),
    ];
    if (tab === "incentives") return [
      btn("Approve", () => act("post", `/admin/cook-incentives/incentives/${r._id}/approve`, {}, r._id), r._id),
      btn("Reject", () => act("post", `/admin/cook-incentives/incentives/${r._id}/reject`, { reason: reason || "Not qualified" }, r._id), r._id, "danger"),
      btn("Hold", () => act("post", `/admin/cook-incentives/incentives/${r._id}/hold`, { reason: reason || "Under review" }, r._id), r._id, "ghost"),
    ];
    if (tab === "referrals") return [
      btn("Approve", () => act("post", `/admin/cook-incentives/referrals/${r._id}/approve`, {}, r._id), r._id),
    ];
    return [
      btn("Approve", () => act("post", `/admin/cook-payouts/payouts/${r._id}/approve`, {}, r._id), r._id),
      btn("Mark paid", () => markPaid(r), r._id),
      btn("Hold", () => act("post", `/admin/cook-payouts/payouts/${r._id}/hold`, { reason: reason || "Under verification" }, r._id), r._id, "ghost"),
    ];
  };

  const titleFor = (r) => {
    if (tab === "leads") return r.customerName || "Lead";
    if (tab === "incentives") return r.code || "Incentive";
    if (tab === "referrals") return `${r.referrer?.name || "Referrer"} → ${r.referredCook?.name || "Cook"}`;
    return r.payoutRef || "Payout";
  };

  const metaFor = (r) => {
    if (tab === "leads") return `${r.location || "—"} · ${r.normalizedPhone || "—"} · Cook: ${r.cook?.name || r.cook || "—"}`;
    if (tab === "incentives") return `Cook: ${r.cook?.name || r.cook || "—"} · Target: ${r.target ?? "—"} · Verified: ${r.verifiedLeadCount ?? r.liveVerifiedCount ?? 0} · Reward: ${formatCurrency(r.reward)}`;
    if (tab === "referrals") return `Bookings: ${r.liveVerifiedBookings ?? r.verifiedBookings ?? 0}/${r.bookingTarget ?? "—"} · Reward: ${formatCurrency(r.reward)}`;
    const week = r.weekStart ? formatDate(r.weekStart) : "";
    const weekEnd = r.weekEnd ? ` → ${formatDate(r.weekEnd)}` : "";
    return `${r.bookingCount ?? 0} bookings · Payable: ${formatCurrency(r.totalPayable)}${week ? ` · Week: ${week}${weekEnd}` : ""}`;
  };

  return (
    <div className="inc-panel">
      <div className="admin-section-head">
        <h3>Cook Partner Incentives</h3>
        <div className="admin-section-actions">
          {!loading && rows.length > 0 && (
            <span className="admin-filter-count">{rows.length}</span>
          )}
          <button type="button" className="btn btn-outline btn-sm" onClick={() => load()} disabled={loading}>
            Refresh
          </button>
        </div>
      </div>

      <div className="tabs-navigation-bar inc-tabs" role="tablist" aria-label="Incentive queues">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`tab-btn ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === "payouts" && (
        <form onSubmit={buildCycle} className="inc-inputs">
          <div className="booking-form-group">
            <label>Cook id</label>
            <input className="form-control" value={buildForm.cookId} onChange={(e) => setBuildForm({ ...buildForm, cookId: e.target.value })} placeholder="24-hex user id" />
          </div>
          <div className="booking-form-group">
            <label>Week start</label>
            <input className="form-control" type="date" value={buildForm.weekStart} onChange={(e) => setBuildForm({ ...buildForm, weekStart: e.target.value })} />
          </div>
          <div className="booking-form-group">
            <label>Week end</label>
            <input className="form-control" type="date" value={buildForm.weekEnd} onChange={(e) => setBuildForm({ ...buildForm, weekEnd: e.target.value })} />
          </div>
          <button className="btn btn-primary btn-sm" type="submit">Build cycle</button>
        </form>
      )}

      <div className="inc-inputs">
        <div className="booking-form-group">
          <label>Reason <span className="inc-hint">for reject / hold / duplicate</span></label>
          <input className="form-control" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required for rejections" />
        </div>
        {tab === "payouts" && (
          <div className="booking-form-group">
            <label>Payment reference <span className="inc-hint">for Mark paid</span></label>
            <input className="form-control" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="UPI / bank transaction id" />
          </div>
        )}
      </div>

      {loading ? (
        <p className="cook-loading-text">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="anx-empty">Nothing here yet.</p>
      ) : (
        <div className="inc-list">
          {rows.map((r) => (
            <div key={r._id} className="inc-row">
              <div className="inc-row-head">
                <strong className="inc-row-title">{titleFor(r)}</strong>
                <span className={`badge ${statusBadge(r.status)}`}>{prettyStatus(r.status)}</span>
              </div>
              <p className="inc-row-meta">{metaFor(r)}</p>
              <div className="inc-row-actions">{actionsFor(r)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default AdminIncentivesPanel;
