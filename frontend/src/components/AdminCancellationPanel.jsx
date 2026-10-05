import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate } from "../utils/constants";
import { Eye, Check, X, Pause, FileText, Ban } from "lucide-react";

// Admin → Cancellations & Refunds (§25). Review workflow only — money moves
// through the existing refund approve/reject/settle endpoints.
const TABS = ["All", "Pending", "Under Review", "Approved", "Processing", "Processed", "Held", "Rejected"];

const AdminCancellationPanel = () => {
  const showToast = useShowToast();
  const [tab, setTab] = useState("All");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [note, setNote] = useState("");
  const [reference, setReference] = useState("");
  const [acting, setActing] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await API.get(`/admin/cancellations${tab === "All" ? "" : `?tab=${encodeURIComponent(tab)}`}`);
      const d = res.data;
      setRows(Array.isArray(d) ? d : d?.data || []);
    } catch (err) {
      showToast(err.response?.data?.message || "Could not load cancellations", "error");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = async (id) => {
    setDetailLoading(true);
    try {
      const res = await API.get(`/admin/cancellations/${id}`);
      setDetail(res.data);
      setNote("");
      setReference("");
    } catch (err) {
      showToast(err.response?.data?.message || "Could not load details", "error");
    } finally {
      setDetailLoading(false);
    }
  };

  const act = async (kind, bookingId) => {
    const id = bookingId || detail?.booking?._id;
    if (!id || acting) return;
    if ((kind === "hold" || kind === "reject" || kind === "note") && !note.trim()) {
      showToast("A reason/note is required for this action.", "error");
      return;
    }
    if (kind === "settle" && reference.trim().length < 4) {
      showToast("Enter the transfer reference to mark refunded.", "error");
      return;
    }
    setActing(kind);
    try {
      if (kind === "review") await API.post(`/admin/cancellations/${id}/review`, {});
      else if (kind === "hold") await API.post(`/admin/cancellations/${id}/hold`, { reason: note.trim() });
      else if (kind === "note") await API.post(`/admin/cancellations/${id}/note`, { note: note.trim() });
      else if (kind === "approve") await API.patch(`/payouts/refunds/${id}/approve`, {});
      else if (kind === "reject") await API.patch(`/payouts/refunds/${id}/reject`, { reason: note.trim() });
      else if (kind === "settle") await API.patch(`/payouts/refunds/${id}/settle`, { reference: reference.trim() });
      showToast("Action recorded.", "success");
      setNote("");
      await load();
      if (detail) {
        const res = await API.get(`/admin/cancellations/${id}`);
        setDetail(res.data);
      }
    } catch (err) {
      showToast(err.response?.data?.message || "Action failed", "error");
    } finally {
      setActing("");
    }
  };

  return (
    <div className="cook-card">
      <h3 style={{ marginBottom: "0.5rem" }}>Cancellations & Refunds</h3>
      <div className="tabs-navigation-bar" style={{ marginBottom: "0.75rem" }}>
        {TABS.map((t) => (
          <button key={t} type="button" className={`tab-btn ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {loading ? (
        <p className="cook-loading-text">Loading…</p>
      ) : !rows.length ? (
        <p style={{ color: "var(--slate-500)" }}>Nothing here yet.</p>
      ) : (
        <div className="admin-cancel-list">
          {rows.map((r) => (
            <div key={r._id} className="booking-item-card cook-booking-card cb-card admin-cancel-card">
              <div className="cb-top">
                <div>
                  <strong>#{String(r._id).slice(-6).toUpperCase()}</strong>{" "}
                  <span className="badge badge-blue">{r.refundStatus?.replace(/_/g, " ")}</span>{" "}
                  <span className="badge badge-slate">{r.cancellationCategory?.replace(/_/g, " ") || r.serviceStatus}</span>
                </div>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => openDetail(r._id)}>
                  <Eye size={14} /> View
                </button>
              </div>
              <p className="cb-note">
                {r.customer?.name || "Customer"} · {r.cook?.name || "No cook"} · Service {r.serviceDate ? formatDate(r.serviceDate) : "—"}{" "}
                {r.startTime || ""} · Cancelled {r.cancelledAt ? formatDate(r.cancelledAt) : "—"} by {r.cancelledBy || "—"}
              </p>
              <p className="cb-note">
                Amount {formatCurrency(r.bookingAmount)} · Refund {r.refundPercent}% · Gross {formatCurrency(r.grossRefund)}
                {r.nonRefundableCharges > 0 && <> · Charges {formatCurrency(r.nonRefundableCharges)}</>} ·{" "}
                <strong>Final {formatCurrency(r.finalRefund)}</strong> · Payment {r.paymentStatus}/{r.paymentRefundStatus}
                {r.refundReference && <> · Ref {r.refundReference}</>}
              </p>
            </div>
          ))}
        </div>
      )}

      {detailLoading && <p className="cook-loading-text">Loading details…</p>}
      {detail && (
        <div className="cook-card cook-spaced-top admin-cancel-detail">
          <h4>Cancellation detail #{String(detail.booking?._id).slice(-6).toUpperCase()}</h4>
          <p className="cb-note">
            Customer {detail.booking?.customer?.name} ({detail.booking?.customer?.phone}) · Cook{" "}
            {detail.booking?.cook?.name || "—"} ({detail.booking?.cook?.phone || "—"}) · Amount{" "}
            {formatCurrency(detail.booking?.amount)} · Paid {formatCurrency(detail.booking?.payment?.paidAmount)} ·
            Payment {detail.booking?.payment?.status}/{detail.booking?.payment?.refundStatus} · Service{" "}
            {detail.booking?.status} {detail.booking?.date ? formatDate(detail.booking.date) : ""}{" "}
            {detail.booking?.startTime || ""}
          </p>
          {detail.booking?.cancellationInfo?.cancelledAt && (
            <p className="cb-note">
              Category {detail.booking.cancellationInfo.cancellationCategory} · Charge{" "}
              {detail.booking.cancellationInfo.cancellationChargePercentage}% · Refund{" "}
              {detail.booking.cancellationInfo.refundPercentage}% · Gross{" "}
              {formatCurrency(detail.booking.cancellationInfo.grossRefundAmount)} · Charges{" "}
              {formatCurrency(detail.booking.cancellationInfo.nonRefundableCharges)} · Final{" "}
              <strong>{formatCurrency(detail.booking.cancellationInfo.finalRefundAmount)}</strong> · Status{" "}
              {detail.booking.cancellationInfo.refundStatus} · Policy {detail.booking.cancellationInfo.policyVersion}
              {detail.booking.cancellationInfo.adminNote && <><br />Admin note: {detail.booking.cancellationInfo.adminNote}</>}
            </p>
          )}
          {!!(detail.complaints?.length) && (
            <div>
              <strong>Complaints ({detail.complaints.length})</strong>
              {detail.complaints.map((c) => (
                <p className="cb-note" key={c._id}>
                  {c.filedBy}: {c.category} — {c.status} — {String(c.message || "").slice(0, 160)}
                  {c.reportedLate ? " (reported after 24h)" : ""}
                </p>
              ))}
            </div>
          )}
          {!!(detail.audits?.length) && (
            <div>
              <strong>Audit trail ({detail.audits.length})</strong>
              {detail.audits.map((a) => (
                <p className="cb-note" key={a._id}>
                  {a.event}: {a.previousStatus || "—"} → {a.newStatus || "—"} · {formatCurrency(a.amount || 0)} ·{" "}
                  {a.actorRole || ""} · {a.reason || ""}
                </p>
              ))}
            </div>
          )}
          <label className="cook-field">
            <span>Reason / note (required for hold, reject, note)</span>
            <textarea className="form-control" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className="cook-field">
            <span>Transfer reference (for Mark refunded)</span>
            <input className="form-control" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UPI / bank transaction id" />
          </label>
          <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-outline btn-sm" disabled={!!acting} onClick={() => act("review")}><FileText size={14} /> Under review</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={!!acting} onClick={() => act("approve")}><Check size={14} /> Approve</button>
            <button type="button" className="btn btn-danger-outline btn-sm" disabled={!!acting} onClick={() => act("reject")}><X size={14} /> Reject</button>
            <button type="button" className="btn btn-outline btn-sm" disabled={!!acting} onClick={() => act("hold")}><Pause size={14} /> Hold</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={!!acting} onClick={() => act("settle")}><Check size={14} /> Mark refunded</button>
            <button type="button" className="btn btn-outline btn-sm" disabled={!!acting} onClick={() => act("note")}><FileText size={14} /> Add note</button>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setDetail(null)}><Ban size={14} /> Close</button>
          </div>
          <p className="bd-mini-note" style={{ marginTop: "0.5rem" }}>
            Approve moves money via the existing refund pipeline; other actions only update the review workflow.{" "}
            <Link to={`/bookings/${detail.booking?._id}`}>Open booking →</Link>
          </p>
        </div>
      )}
    </div>
  );
};

export default AdminCancellationPanel;
