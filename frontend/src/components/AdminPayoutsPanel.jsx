import React, { useState } from "react";
import API from "../api/axios";
import { useFetch } from "../hooks/useFetch";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate, formatTimeRange12 } from "../utils/constants";
import ConfirmDialog from "./ConfirmDialog";
import {
  Banknote,
  CheckCircle2,
  Clock3,
  AlertCircle,
  Copy,
  RefreshCw,
  XCircle,
} from "lucide-react";

// Admin settlement console: nothing moves money automatically — cooks are
// paid and customers refunded only by an explicit admin decision here.
// Sections: pending cook payouts (Mark paid / Reject), refunds awaiting a
// decision (Approve / Reject), and failed-refund follow-ups.
const AdminPayoutsPanel = () => {
  const showToast = useShowToast();
  const { data: queue, loading, error, refetch } = useFetch("/payouts/queue");
  const { data: refunds, refetch: refetchRefunds } = useFetch("/payouts/refunds");
  const [refFor, setRefFor] = useState(null);
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingApprove, setPendingApprove] = useState(null);
  // { kind: "refund" | "payout", id } — reason is typed into the dialog.
  const [pendingReject, setPendingReject] = useState(null);

  // Refunds split by decision state: "pending" needs approve/reject,
  // "failed"/"manual" need follow-up settlement.
  const pendingRefunds = (refunds || []).filter((b) => b.payment?.refundStatus === "pending");
  const followupRefunds = (refunds || []).filter((b) =>
    ["failed", "manual"].includes(b.payment?.refundStatus)
  );

  const settle = async (bookingId) => {
    if (!reference.trim()) {
      showToast("Enter the UPI / bank transfer reference first", "error");
      return;
    }
    setSaving(true);
    try {
      await API.patch(`/payouts/${bookingId}/settle`, { reference: reference.trim() });
      showToast("Payout recorded — the cook has been notified.", "success");
      setRefFor(null);
      setReference("");
      refetch();
    } catch (err) {
      // 409 = another admin already settled this (or reused the reference):
      // refresh so the queue shows the true state instead of a stale row.
      if (err.response?.status === 409) {
        showToast("Already handled — refreshing the queue to show the current state.", "info");
        setRefFor(null);
        setReference("");
        refetch();
      } else {
        showToast(err.response?.data?.message || "Could not record payout", "error");
      }
    } finally {
      setSaving(false);
    }
  };

  const markRefundSettled = async (bookingId) => {
    if (!reference.trim()) {
      showToast("Enter the transfer reference first", "error");
      return;
    }
    setSaving(true);
    try {
      await API.patch(`/payouts/refunds/${bookingId}/settle`, { reference: reference.trim() });
      showToast("Refund marked as settled — customer notified.", "success");
      setRefFor(null);
      setReference("");
      refetchRefunds();
    } catch (err) {
      showToast(err.response?.data?.message || "Could not update refund", "error");
    } finally {
      setSaving(false);
    }
  };

  const approveRefund = async () => {
    const bookingId = pendingApprove;
    if (!bookingId || saving) return;
    setPendingApprove(null);
    setSaving(true);
    try {
      await API.patch(`/payouts/refunds/${bookingId}/approve`);
      showToast("Refund approved — customer notified.", "success");
      refetchRefunds();
    } catch (err) {
      if (err.response?.status === 409) {
        showToast("Already being processed by another admin — refreshed.", "info");
        refetchRefunds();
      } else {
        showToast(err.response?.data?.message || "Could not approve refund", "error");
      }
    } finally {
      setSaving(false);
    }
  };

  const rejectRefund = async (reason) => {
    const bookingId = pendingReject?.id;
    if (!bookingId || saving) return;
    setPendingReject(null);
    setSaving(true);
    try {
      await API.patch(`/payouts/refunds/${bookingId}/reject`, { reason: (reason || "").trim() });
      showToast("Refund declined — customer notified.", "info");
      refetchRefunds();
    } catch (err) {
      showToast(err.response?.data?.message || "Could not decline refund", "error");
    } finally {
      setSaving(false);
    }
  };

  const rejectPayout = async (reason) => {
    const bookingId = pendingReject?.id;
    if (!bookingId || saving) return;
    setPendingReject(null);
    setSaving(true);
    try {
      await API.patch(`/payouts/${bookingId}/reject`, { reason: (reason || "").trim() });
      showToast("Payout declined — cook notified.", "info");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Could not decline payout", "error");
    } finally {
      setSaving(false);
    }
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied", "info");
    } catch {
      // clipboard may be blocked — non-fatal
    }
  };

  const payoutLabel = (d) =>
    d?.upiId ? d.upiId : d?.bankAccountLast4 ? `Bank ••${d.bankAccountLast4}` : "No payout details saved";

  return (
    <div className="admin-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1.15rem", fontWeight: 800, margin: 0 }}>Cook Payouts</h2>
        <button className="btn btn-outline btn-sm" onClick={() => { refetch(); refetchRefunds(); }}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      {error && (
        <div className="error-alert-banner">
          <AlertCircle size={16} /> {error}
        </div>
      )}
      {loading && <p style={{ color: "var(--slate-500)" }}>Loading payout queue…</p>}
      {!loading && !error && (queue?.length ? (
        <div className="bookings-list-modern">
          {queue.map((b) => {
            const cook = b.cook || {};
            const d = b.cookPayoutDetails;
            return (
              <article key={b._id} className="booking-item-card">
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0 }}>
                    <strong>{cook.name || "Cook"}</strong>
                    <span style={{ color: "var(--slate-500)", fontSize: "0.85rem" }}>
                      {" "}· {b.serviceType ? String(b.serviceType).replace(/_/g, " ") : "session"} ·{" "}
                      {formatDate(b.date)} {b.startTime ? `· ${formatTimeRange12(b.startTime, b.endTime, "-")}` : ""}
                    </span>
                    <div style={{ marginTop: "0.35rem", display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
                      <code style={{ fontSize: "0.8rem", background: "var(--slate-100)", padding: "0.15rem 0.4rem", borderRadius: 6 }}>
                        #{b._id?.substring(18)?.toUpperCase()}
                      </code>
                      {cook.phone && (
                        <button
                          className="btn btn-outline btn-sm"
                          style={{ padding: "0.15rem 0.5rem" }}
                          onClick={() => copy(cook.phone)}
                          title="Copy cook phone"
                        >
                          <Copy size={12} /> {cook.phone}
                        </button>
                      )}
                    </div>
                    <p style={{ marginTop: "0.4rem", fontSize: "0.85rem", color: "var(--slate-600)" }}>
                      Payout to: <strong>{payoutLabel(d)}</strong>
                      {d?.bankName ? ` (${d.bankName})` : ""}
                    </p>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 800, color: "var(--primary)", fontSize: "1.05rem" }}>
                      {formatCurrency(b.cookPayout)}
                    </div>
                    <div style={{ fontSize: "0.78rem", color: "var(--slate-500)" }}>
                      of {formatCurrency(b.amount)} (25% fee {formatCurrency(b.commission)})
                    </div>
                    {refFor === b._id ? (
                      <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.4rem" }}>
                        <input
                          className="form-control"
                          style={{ padding: "0.3rem 0.5rem", fontSize: "0.85rem", width: "11rem" }}
                          placeholder="UPI / bank ref"
                          value={reference}
                          autoFocus
                          onChange={(e) => setReference(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && settle(b._id)}
                        />
                        <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => settle(b._id)}>
                          <CheckCircle2 size={14} />
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          className="btn btn-primary btn-sm"
                          style={{ marginTop: "0.5rem" }}
                          onClick={() => { setRefFor(b._id); setReference(""); }}
                        >
                          <Banknote size={14} /> Mark paid
                        </button>
                        <button
                          className="btn btn-danger-outline btn-sm"
                          style={{ marginTop: "0.5rem", marginLeft: "0.4rem" }}
                          disabled={saving}
                          onClick={() => setPendingReject({ kind: "payout", id: b._id })}
                        >
                          <XCircle size={14} /> Reject
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-state-card">
          <div className="empty-state-icon"><CheckCircle2 size={26} /></div>
          <h3>No pending payouts</h3>
          <p style={{ color: "var(--slate-600)", fontSize: "0.92rem" }}>
            Every completed service's cook share has been settled. Payouts unlock only after the service is completed and service hours are marked complete.
          </p>
        </div>
      ))}
      {/* Refunds awaiting a decision — approve returns the money, reject declines it */}
      <h3 style={{ margin: "1.75rem 0 0.75rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <Clock3 size={17} style={{ color: "#d97706" }} /> Refunds awaiting decision
      </h3>
      {!pendingRefunds?.length ? (
        <p style={{ color: "var(--slate-500)", fontSize: "0.9rem" }}>Nothing awaiting a decision.</p>
      ) : (
        <div className="bookings-list-modern">
          {pendingRefunds.map((b) => (
            <article key={b._id} className="booking-item-card">
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
                <div>
                  <strong>{b.customer?.name || "Customer"}</strong>
                  <span style={{ color: "var(--slate-500)", fontSize: "0.85rem" }}>
                    {" "}· {formatCurrency(b.payment?.refundAmount || b.amount)} refund ·{" "}
                    {b.status ? String(b.status).replace(/_/g, " ") : "booking"} ·{" "}
                    {b.date ? formatDate(b.date) : ""}
                  </span>
                  <div style={{ fontSize: "0.8rem", color: "var(--slate-500)", marginTop: "0.2rem" }}>
                    Payment id: <code>{b.payment?.razorpayPaymentId || "—"}</code>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={saving}
                    onClick={() => setPendingApprove(b._id)}
                  >
                    <CheckCircle2 size={14} /> Approve
                  </button>
                  <button
                    className="btn btn-danger-outline btn-sm"
                    disabled={saving}
                    onClick={() => setPendingReject({ kind: "refund", id: b._id })}
                  >
                    <XCircle size={14} /> Reject
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {/* Refunds needing manual action */}
      <h3 style={{ margin: "1.75rem 0 0.75rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <AlertCircle size={17} style={{ color: "#d97706" }} /> Refunds needing manual action
      </h3>
      {!followupRefunds?.length ? (
        <p style={{ color: "var(--slate-500)", fontSize: "0.9rem" }}>Nothing pending — all refunds processed.</p>
      ) : (
        <div className="bookings-list-modern">
          {followupRefunds.map((b) => (
            <article key={b._id} className="booking-item-card">
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
                <div>
                  <strong>{b.customer?.name || "Customer"}</strong>
                  <span style={{ color: "var(--slate-500)", fontSize: "0.85rem" }}>
                    {" "}· {formatCurrency(b.payment?.refundAmount || b.amount)} refund ·{" "}
                    {b.payment?.refundStatus === "failed" ? "gateway refund failed" : "needs manual transfer"}
                  </span>
                  <div style={{ fontSize: "0.8rem", color: "var(--slate-500)", marginTop: "0.2rem" }}>
                    Payment id: <code>{b.payment?.razorpayPaymentId || "—"}</code>
                  </div>
                </div>
                {refFor === `refund-${b._id}` ? (
                  <div style={{ display: "flex", gap: "0.4rem" }}>
                    <input
                      className="form-control"
                      style={{ padding: "0.3rem 0.5rem", fontSize: "0.85rem", width: "11rem" }}
                      placeholder="Transfer ref"
                      value={reference}
                      autoFocus
                      onChange={(e) => setReference(e.target.value)}
                    />
                    <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => markRefundSettled(b._id)}>
                      <CheckCircle2 size={14} />
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={() => { setRefFor(`refund-${b._id}`); setReference(""); }}
                  >
                    <Clock3 size={14} /> Mark settled
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!pendingApprove}
        title="Approve this refund?"
        message="The money will be returned to the customer."
        confirmLabel="Approve refund"
        tone="emerald"
        busy={saving}
        onCancel={() => setPendingApprove(null)}
        onConfirm={approveRefund}
      />
      <ConfirmDialog
        open={!!pendingReject}
        title={pendingReject?.kind === "payout" ? "Decline this payout?" : "Decline this refund?"}
        message={
          pendingReject?.kind === "payout"
            ? "The cook will be notified."
            : "The customer will be notified."
        }
        confirmLabel={pendingReject?.kind === "payout" ? "Decline payout" : "Decline refund"}
        tone="danger"
        busy={saving}
        input={{
          label: "Reason (optional, shared with them)",
          placeholder: "Type a reason…",
        }}
        onCancel={() => setPendingReject(null)}
        onConfirm={(reason) =>
          pendingReject?.kind === "payout" ? rejectPayout(reason) : rejectRefund(reason)
        }
      />
    </div>
  );
};

export default AdminPayoutsPanel;
