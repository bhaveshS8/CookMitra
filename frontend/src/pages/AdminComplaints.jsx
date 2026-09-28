import React, { useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { useFetch } from "../hooks/useFetch";
import { useShowToast } from "../store/hooks";
import { formatDate, timeAgo } from "../utils/constants";
import {
  ArrowLeft,
  ShieldAlert,
  RefreshCw,
  Inbox,
  Search,
  CheckCircle2,
  XCircle,
  AlertCircle,
  MessageCircle,
  Clock,
} from "lucide-react";

const STATUS_TABS = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "in_review", label: "In review" },
  { key: "resolved", label: "Resolved" },
  { key: "rejected", label: "Rejected" },
];

const STATUS_BADGE = {
  open: "badge-amber",
  in_review: "badge-blue",
  resolved: "badge-emerald",
  rejected: "badge-slate",
};

const CATEGORY_LABEL = {
  behaviour: "Behaviour",
  payment: "Payment",
  address: "Address",
  no_show: "No-show",
  safety: "Safety",
  other: "Other",
};

const AdminComplaints = () => {
  const { data: complaints, loading, error, refetch } = useFetch("/complaints");
  const showToast = useShowToast();
  const [filter, setFilter] = useState("all");
  const [notes, setNotes] = useState({});
  const [savingId, setSavingId] = useState(null);

  const list = complaints || [];
  const counts = STATUS_TABS.reduce((acc, t) => {
    acc[t.key] = t.key === "all" ? list.length : list.filter((c) => c.status === t.key).length;
    return acc;
  }, {});
  const visible = filter === "all" ? list : list.filter((c) => c.status === filter);

  const setStatus = async (id, status) => {
    setSavingId(id);
    try {
      // Send adminNote only when the textarea has content — otherwise an
      // untouched (empty) box would wipe a previously saved internal note.
      const note = (notes[id] || "").trim();
      await API.patch(`/complaints/${id}/status`, note ? { status, adminNote: note } : { status });
      showToast(`Complaint marked as ${status.replace("_", " ")}`, "success");
      setNotes((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Could not update complaint", "error");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="dashboard-container">
      <div style={{ marginBottom: "1rem" }}>
        <Link to="/admin" className="back-link-bar">
          <ArrowLeft size={16} /> Back to Admin
        </Link>
      </div>

      <div className="dashboard-header-row">
        <div>
          <span className="badge badge-festive" style={{ marginBottom: "0.5rem" }}>
            <ShieldAlert size={14} /> Moderation
          </span>
          <h1>Cook Complaints ({list.length})</h1>
          <p style={{ color: "var(--slate-600)", margin: 0 }}>
            Issues cooks reported about customers — newest first.
          </p>
        </div>
        <button className="btn btn-outline btn-sm" onClick={() => refetch()} disabled={loading}>
          <RefreshCw size={15} /> {loading ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      <div className="tabs-navigation-bar" style={{ marginBottom: "1.25rem" }}>
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            className={`tab-btn ${filter === t.key ? "active" : ""}`}
            onClick={() => setFilter(t.key)}
          >
            {t.label} <span className="tab-count-pill">{counts[t.key] ?? 0}</span>
          </button>
        ))}
      </div>

      {loading && <p style={{ color: "var(--slate-500)" }}>Loading complaints...</p>}
      {error && <p style={{ color: "#dc2626" }}>{error}</p>}

      {!loading && !error && visible.length === 0 && (
        <div className="empty-state-card">
          <div className="empty-state-icon">
            {filter === "all" ? <Inbox size={28} /> : <Search size={28} />}
          </div>
          <h3>{filter === "all" ? "No complaints" : `No ${filter.replace("_", " ")} complaints`}</h3>
          <p>Cooks file complaints from a booking page when something goes wrong with a customer.</p>
        </div>
      )}

      <div className="bookings-list-modern">
        {visible.map((c) => (
          <div key={c._id} className="booking-item-card">
            <div className="booking-item-top">
              <div className="booking-party-info">
                <h3 style={{ margin: 0 }}>
                  {c.cook?.name || "Cook"} <span style={{ fontWeight: 400 }}>→ {c.customer?.name || "Customer"}</span>
                </h3>
                <span style={{ fontSize: "0.8rem", color: "var(--slate-500)" }}>
                  {c.createdAt ? timeAgo(c.createdAt) : ""} • {CATEGORY_LABEL[c.category] || c.category}
                  {c.booking ? ` • ${c.booking.serviceType?.replace(/_/g, " ")} on ${formatDate(c.booking.date)}` : " • no booking attached"}
                </span>
              </div>
              <span className={`badge ${STATUS_BADGE[c.status] || "badge-slate"}`}>
                {String(c.status).replace("_", " ").toUpperCase()}
              </span>
            </div>

            <p style={{ margin: "0 0 0.75rem", fontSize: "0.92rem", color: "var(--slate-700)" }}>
              {c.message}
            </p>

            {(c.cook?.phone || c.customer?.phone) && (
              <p style={{ margin: "0 0 0.75rem", fontSize: "0.82rem", color: "var(--slate-500)" }}>
                {c.cook?.phone && <>Cook: {c.cook.phone} · </>}
                {c.customer?.phone && <>Customer: {c.customer.phone}</>}
                {c.booking?._id && (
                  <> · <Link to={`/bookings/${c.booking._id}`}>Open booking</Link></>
                )}
              </p>
            )}

            {c.adminNote && (
              <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "var(--slate-600)", background: "var(--slate-50)", padding: "0.55rem 0.8rem", borderRadius: "var(--radius-sm)" }}>
                <strong>Admin note:</strong> {c.adminNote}
              </p>
            )}

            {["open", "in_review"].includes(c.status) ? (
              <div>
                <textarea
                  className="form-control"
                  rows={2}
                  placeholder="Internal note for the cook (optional)…"
                  value={notes[c._id] || ""}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [c._id]: e.target.value }))}
                  disabled={savingId === c._id}
                  style={{ marginBottom: "0.6rem" }}
                />
                <div className="booking-actions-row" style={{ marginTop: 0 }}>
                  {c.status === "open" && (
                    <button
                      className="btn btn-outline btn-sm"
                      disabled={savingId === c._id}
                      onClick={() => setStatus(c._id, "in_review")}
                    >
                      <Clock size={15} /> {savingId === c._id ? "Saving…" : "Start review"}
                    </button>
                  )}
                  <button
                    className="btn btn-success btn-sm"
                    disabled={savingId === c._id}
                    onClick={() => setStatus(c._id, "resolved")}
                  >
                    <CheckCircle2 size={15} /> {savingId === c._id ? "Saving…" : "Resolve"}
                  </button>
                  <button
                    className="btn btn-danger-outline btn-sm"
                    disabled={savingId === c._id}
                    onClick={() => setStatus(c._id, "rejected")}
                  >
                    <XCircle size={15} /> Reject
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", color: "var(--slate-400)" }}>
                {c.status === "resolved" ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                Closed{c.updatedAt ? ` • ${timeAgo(c.updatedAt)}` : ""}
              </div>
            )}
          </div>
        ))}
      </div>

      {visible.length > 0 && (
        <p style={{ fontSize: "0.78rem", color: "var(--slate-400)", marginTop: "1rem", display: "flex", alignItems: "center", gap: "0.35rem" }}>
          {["open", "in_review"].includes(filter) || filter === "all" ? (
            <><AlertCircle size={13} /> Resolving or rejecting notifies the cook automatically.</>
          ) : (
            <><MessageCircle size={13} /> Closed complaints are kept for the record.</>
          )}
        </p>
      )}
    </div>
  );
};

export default AdminComplaints;
