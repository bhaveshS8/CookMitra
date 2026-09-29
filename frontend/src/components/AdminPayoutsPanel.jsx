import React, { useState, useEffect, useCallback, useRef } from "react";
import API from "../api/axios";
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
// `view` splits the console across two admin tabs: "payouts" lists only cook
// payouts, "refunds" lists only customer refunds (awaiting decision +
// manual follow-ups). Sections: pending cook payouts (Mark paid / Reject),
// refunds awaiting a decision (Approve / Reject), and failed-refund follow-ups.
//
// Safety properties (server enforces all of these; the UI only reflects):
// - lists are paged with explicit totals — never a silent truncation;
// - rows the server flags ineligible show their blockers with Mark paid
//   disabled (clicking through would only 400);
// - settling requires typing the external transfer reference AND ticking an
//   explicit "transfer completed externally to THESE details" confirmation.
//   The recorded recipient is the cook's profile snapshot at settle time.
const PAGE_LIMIT = 25;

const emptyPage = { rows: [], total: 0, page: 1, totalPages: 1 };

// Paged list with explicit totals (avoids the silent 500-row backstop of
// unpaged responses). Same component drives queue + refunds; page resets
// when the URL (tab) changes.
const usePagedList = (url) => {
  const [state, setState] = useState(emptyPage);
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const abortRef = useRef(null);

  const fetchPage = useCallback(async (p) => {
    if (!url) {
      setState(emptyPage);
      setLoading(false);
      setError(null);
      return;
    }
    try {
      abortRef.current?.abort?.();
    } catch {
      // ignore
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      // Tolerate a pre-existing query string (?status=…) in the tab URL.
      const res = await API.get(`${url}${url.includes("?") ? "&" : "?"}page=${p}&limit=${PAGE_LIMIT}`, { signal: controller.signal });
      const payload = res.data || {};
      const rows = Array.isArray(payload) ? payload : payload.data || [];
      const pg = payload.pagination || {};
      setState({
        rows,
        total: Number(pg.total ?? rows.length) || 0,
        page: Number(pg.page ?? p) || p,
        totalPages: Number(pg.totalPages ?? 1) || 1,
      });
      setError(null);
    } catch (err) {
      if (err?.code === "ERR_CANCELED" || err?.name === "CanceledError" || err?.name === "AbortError") return;
      if (!err.response) setError("Cannot reach the server — is the backend running?");
      else setError(err.response?.data?.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setPage(1);
    fetchPage(1);
    return () => {
      try {
        abortRef.current?.abort?.();
      } catch {
        // ignore
      }
    };
  }, [fetchPage]);

  const gotoPage = useCallback((p) => {
    const next = Math.max(1, p);
    setPage(next);
    fetchPage(next);
  }, [fetchPage]);

  const refetch = useCallback(() => fetchPage(page), [fetchPage, page]);

  return { ...state, loading, error, page, gotoPage, refetch };
};

const Pager = ({ page, totalPages, total, onPage, label }) => {
  if (!totalPages || totalPages <= 1) {
    return total > 0 ? (
      <p style={{ color: "var(--slate-500)", fontSize: "0.82rem", margin: "0.75rem 0 0" }}>
        Showing all {total} {label}.
      </p>
    ) : null;
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
      <button type="button" className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Prev
      </button>
      <span style={{ fontSize: "0.82rem", color: "var(--slate-600)" }}>
        Page {page} of {totalPages} · {total} total {label}
      </span>
      <button type="button" className="btn btn-outline btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next →
      </button>
    </div>
  );
};

const AdminPayoutsPanel = ({ view = "payouts" }) => {
  const isRefunds = view === "refunds";
  const showToast = useShowToast();
  // Refund list filter: "" = actionable rows only (the safe default); the
  // processed/rejected options are the historical view support asks for.
  const [statusFilter, setStatusFilter] = useState("");
  // Each tab fetches ONLY what it displays: cook-payout queue on the Payouts
  // tab, refund requests on the Refunds tab. Never the other list.
  const { rows: queueRows, total: queueTotal, totalPages: queuePages, page: queuePage, loading, error, gotoPage: gotoQueuePage, refetch } =
    usePagedList(isRefunds ? null : "/payouts/queue");
  const refundsUrl = isRefunds ? `/payouts/refunds${statusFilter ? `?status=${statusFilter}` : ""}` : null;
  const { rows: refundRows, total: refundsTotal, totalPages: refundsPages, page: refundsPage, loading: refundsLoading, error: refundsError, gotoPage: gotoRefundsPage, refetch: refetchRefunds } =
    usePagedList(refundsUrl);
  const [refFor, setRefFor] = useState(null);
  const [reference, setReference] = useState("");
  const [transferConfirmed, setTransferConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  // The full booking (not just its id): the approve dialog needs the payout
  // state to require the clawback decision, and shows the exact amount.
  const [pendingApprove, setPendingApprove] = useState(null);
  // { kind: "refund" | "payout", id } — reason is typed into the dialog.
  const [pendingReject, setPendingReject] = useState(null);

  // Refunds split by decision state: "pending" needs approve/reject,
  // "processing" is a crashed approval that must be reconciled with the
  // gateway, and "failed"/"manual" need follow-up settlement. Split applies
  // to the loaded page; the header states the queue total so nothing is
  // hidden, and the status filter reaches the historical states.
  const pendingRefunds = (refundRows || []).filter((b) => b.payment?.refundStatus === "pending");
  const processingRefunds = (refundRows || []).filter((b) => b.payment?.refundStatus === "processing");
  const followupRefunds = (refundRows || []).filter((b) =>
    ["failed", "manual"].includes(b.payment?.refundStatus)
  );

  const openSettle = (bookingId) => {
    setRefFor(bookingId);
    setReference("");
    setTransferConfirmed(false);
  };

  const settle = async (booking, detailsLabel) => {
    const bookingId = booking._id;
    if (!reference.trim()) {
      showToast("Enter the UPI / bank transfer reference first", "error");
      return;
    }
    if (!transferConfirmed) {
      showToast("Tick the transfer confirmation first — it records what you actually paid", "error");
      return;
    }
    setSaving(true);
    try {
      await API.patch(`/payouts/${bookingId}/settle`, { reference: reference.trim() });
      showToast(`Payout recorded${detailsLabel ? ` (${detailsLabel})` : ""} — the cook has been notified.`, "success");
      setRefFor(null);
      setReference("");
      setTransferConfirmed(false);
      refetch();
    } catch (err) {
      // 409 = another admin already settled this (or reused the reference):
      // refresh so the queue shows the true state instead of a stale row.
      if (err.response?.status === 409) {
        showToast("Already handled — refreshing the queue to show the current state.", "info");
        setRefFor(null);
        setReference("");
        setTransferConfirmed(false);
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

  const approveRefund = async (amountInput, clawbackConfirmed) => {
    const booking = pendingApprove;
    const bookingId = booking?._id;
    if (!bookingId || saving) return;
    setPendingApprove(null);
    // Partial approval: whole rupees only (the backend re-parses strictly and
    // caps at the refundable total); blank means a full refund.
    const raw = String(amountInput ?? "").trim();
    if (raw !== "" && !/^\d+$/.test(raw)) {
      showToast("Approved amount must be whole rupees — leave blank for a full refund.", "error");
      return;
    }
    // A settled cook payout makes this a clawback decision: the console must
    // record it explicitly, exactly like the server demands.
    const needsClawback = booking?.payout?.status === "settled";
    if (needsClawback && !clawbackConfirmed) {
      showToast("Tick the clawback confirmation first — the cook was already paid.", "error");
      return;
    }
    const body = {
      ...(raw === "" ? {} : { amount: raw }),
      ...(needsClawback ? { clawback: true } : {}),
    };
    setSaving(true);
    try {
      await API.patch(`/payouts/refunds/${bookingId}/approve`, body);
      showToast(raw === "" ? "Refund approved — customer notified." : `Partial refund of ₹${raw} approved — customer notified.`, "success");
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

  // A refund stuck mid-approval can only be resolved by asking the gateway
  // what actually exists — never by guessing. Adopts an existing refund or
  // returns the row to the decision queue; a 503 leaves everything untouched.
  const reconcileRefund = async (bookingId) => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await API.post(`/payouts/refunds/${bookingId}/reconcile`);
      if (res.data?.adopted) {
        showToast("Gateway refund found — marked as processed, no manual transfer needed.", "success");
      } else {
        showToast("No gateway refund exists — the request is back in the decision queue.", "info");
      }
      refetchRefunds();
    } catch (err) {
      showToast(err.response?.data?.message || "Could not reconcile with the gateway", "error");
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

  const destinationNote = (d) =>
    d?.upiId
      ? `UPI ${d.upiId}`
      : d?.bankAccountLast4
        ? `Bank ••${d.bankAccountLast4}${d?.bankName ? ` (${d.bankName})` : ""}${d?.ifsc ? ` · ${d.ifsc}` : ""}`
        : "No payout details saved";

  return (
    <div className="admin-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", gap: "0.6rem", flexWrap: "wrap" }}>
        <h2 style={{ fontSize: "1.15rem", fontWeight: 800, margin: 0 }}>{isRefunds ? "Refunds" : "Cook Payouts"}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          {isRefunds && (
            <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", color: "var(--slate-600)" }}>
              Status
              <select
                className="form-control"
                style={{ padding: "0.3rem 0.5rem", fontSize: "0.85rem", width: "auto" }}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">Actionable (default)</option>
                <option value="pending">Pending</option>
                <option value="processing">Processing</option>
                <option value="failed">Failed</option>
                <option value="manual">Manual</option>
                <option value="processed">Processed (history)</option>
                <option value="rejected">Rejected (history)</option>
                <option value="all">All statuses</option>
              </select>
            </label>
          )}
          <button className="btn btn-outline btn-sm" onClick={() => { isRefunds ? refetchRefunds() : refetch(); }}>
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </div>

      {isRefunds ? (
        <>
          {refundsError && (
            <div className="error-alert-banner">
              <AlertCircle size={16} /> {refundsError}
            </div>
          )}
          {refundsLoading && <p style={{ color: "var(--slate-500)" }}>Loading refund requests…</p>}
        </>
      ) : (
        <>
          {error && (
            <div className="error-alert-banner">
              <AlertCircle size={16} /> {error}
            </div>
          )}
          {loading && <p style={{ color: "var(--slate-500)" }}>Loading payout queue…</p>}
        </>
      )}
      {!isRefunds && !loading && !error && (queueRows?.length ? (
        <div className="bookings-list-modern">
          {queueRows.map((b) => {
            const cook = b.cook || {};
            const d = b.cookPayoutDetails;
            // Server-computed gate: ineligible rows explain themselves and
            // cannot be marked paid from here (the server re-validates).
            const blocked = b.payoutEligible === false;
            const blockers = Array.isArray(b.payoutBlockers) ? b.payoutBlockers : [];
            const dest = destinationNote(d);
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
                    {blocked && (
                      <p style={{ marginTop: "0.35rem", fontSize: "0.82rem", color: "#b45309" }} role="note">
                        <AlertCircle size={13} style={{ display: "inline", verticalAlign: "-2px" }} />{" "}
                        Cannot pay yet: {blockers.length ? blockers.join(" · ") : "blocked by payout rules"}.
                      </p>
                    )}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 800, color: "var(--primary)", fontSize: "1.05rem" }}>
                      {formatCurrency(b.cookPayout)}
                    </div>
                    <div style={{ fontSize: "0.78rem", color: "var(--slate-500)" }}>
                      of {formatCurrency(b.amount)} (25% fee {formatCurrency(b.commission)})
                    </div>
                    {refFor === b._id ? (
                      <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.4rem", alignItems: "flex-end" }}>
                        <div style={{ fontSize: "0.78rem", color: "var(--slate-600)", maxWidth: "16rem", textAlign: "right" }}>
                          Destination on file: <strong>{dest}</strong>
                        </div>
                        <input
                          className="form-control"
                          style={{ padding: "0.3rem 0.5rem", fontSize: "0.85rem", width: "11rem" }}
                          placeholder="UPI / bank ref"
                          value={reference}
                          autoFocus
                          onChange={(e) => setReference(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && settle(b, dest)}
                        />
                        <label style={{ display: "flex", gap: "0.35rem", alignItems: "flex-start", fontSize: "0.78rem", color: "var(--slate-700)", maxWidth: "16rem", textAlign: "left", cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={transferConfirmed}
                            onChange={(e) => setTransferConfirmed(e.target.checked)}
                            style={{ marginTop: "0.15rem" }}
                          />
                          <span>I confirm the transfer of {formatCurrency(b.cookPayout)} was completed externally to these details.</span>
                        </label>
                        <div style={{ display: "flex", gap: "0.4rem" }}>
                          <button className="btn btn-outline btn-sm" disabled={saving} onClick={() => { setRefFor(null); setReference(""); setTransferConfirmed(false); }}>
                            Cancel
                          </button>
                          <button className="btn btn-primary btn-sm" disabled={saving || !transferConfirmed || !reference.trim()} onClick={() => settle(b, dest)} title={!transferConfirmed ? "Tick the transfer confirmation first" : "Record payout"}>
                            <CheckCircle2 size={14} /> Confirm paid
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          className="btn btn-primary btn-sm"
                          style={{ marginTop: "0.5rem" }}
                          disabled={blocked}
                          title={blocked ? `Blocked: ${(blockers[0] || "see note")}` : "Record an external transfer as paid"}
                          onClick={() => openSettle(b._id)}
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
      {!isRefunds && !loading && !error && (
        <Pager page={queuePage} totalPages={queuePages} total={queueTotal} onPage={gotoQueuePage} label="pending payouts" />
      )}
      {isRefunds && (
      <>
      {/* Refunds awaiting a decision — approve returns the money, reject declines it */}
      <h3 style={{ margin: "1.75rem 0 0.75rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <Clock3 size={17} style={{ color: "#d97706" }} /> Refunds awaiting decision
      </h3>
      {!pendingRefunds?.length ? (
        <p style={{ color: "var(--slate-500)", fontSize: "0.9rem" }}>Nothing awaiting a decision on this page.</p>
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
                    {b.startTime ? ` · ${formatTimeRange12(b.startTime, b.endTime, "-")}` : ""}
                  </span>
                  <div style={{ fontSize: "0.8rem", color: "var(--slate-500)", marginTop: "0.2rem" }}>
                    Payment id: <code>{b.payment?.razorpayPaymentId || "—"}</code>
                  </div>
                  {b.payment?.refundReason ? (
                    <div style={{ fontSize: "0.82rem", color: "var(--slate-700)", marginTop: "0.25rem" }}>
                      <strong>Reason:</strong> {b.payment.refundReason}
                      {b.payment?.refundCustomerNote ? ` — “${b.payment.refundCustomerNote}”` : ""}
                    </div>
                  ) : null}
                  {b.payment?.refundRequestedAt ? (
                    <div style={{ fontSize: "0.78rem", color: "var(--slate-500)" }}>
                      Requested {new Date(b.payment.refundRequestedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                      {b.payment?.refundRequestedBy ? ` · by ${b.payment.refundRequestedBy}` : ""}
                    </div>
                  ) : null}
                </div>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={saving}
                    onClick={() => setPendingApprove(b)}
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
      {/* Refunds stuck mid-approval — an interrupted approval must stay visible
          and may only be resolved by asking the gateway what exists. */}
      <h3 style={{ margin: "1.75rem 0 0.75rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <AlertCircle size={17} style={{ color: "#b45309" }} /> Refunds stuck mid-approval
      </h3>
      {!processingRefunds?.length ? (
        <p style={{ color: "var(--slate-500)", fontSize: "0.9rem" }}>None — every approval finished cleanly.</p>
      ) : (
        <div className="bookings-list-modern">
          {processingRefunds.map((b) => (
            <article key={b._id} className="booking-item-card">
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
                <div>
                  <strong>{b.customer?.name || "Customer"}</strong>
                  <span style={{ color: "var(--slate-500)", fontSize: "0.85rem" }}>
                    {" "}· {formatCurrency(b.payment?.refundAmount || b.amount)} refund · approval interrupted
                  </span>
                  <div style={{ fontSize: "0.8rem", color: "var(--slate-500)", marginTop: "0.2rem" }}>
                    Payment id: <code>{b.payment?.razorpayPaymentId || "—"}</code>
                  </div>
                  <p style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", color: "#b45309" }}>
                    Verify with the gateway before anything else — recording a manual settlement without
                    checking could refund the customer twice.
                  </p>
                </div>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={saving}
                    onClick={() => reconcileRefund(b._id)}
                  >
                    <RefreshCw size={14} /> Verify with gateway
                  </button>
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
        <p style={{ color: "var(--slate-500)", fontSize: "0.9rem" }}>Nothing pending on this page — all shown refunds processed.</p>
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
      <Pager page={refundsPage} totalPages={refundsPages} total={refundsTotal} onPage={gotoRefundsPage} label="refund rows" />
      </>
      )}
      <ConfirmDialog
        open={!!pendingApprove}
        title="Approve this refund?"
        message={
          pendingApprove?.payout?.status === "settled"
            ? `The cook payout for this booking is already settled — approving this refund is a clawback: ${formatCurrency(pendingApprove?.payment?.refundAmount || pendingApprove?.amount)} will be recovered from the cook. Leave the amount blank for a full refund, or type a smaller whole-rupee amount for a partial refund.`
            : "Leave the amount blank for a full refund, or type a smaller approved amount for a partial refund. The money will be returned to the customer."
        }
        confirmLabel="Approve refund"
        tone="emerald"
        busy={saving}
        input={{
          label: "Approved amount in ₹ (blank = full)",
          placeholder: "e.g. 700",
          singleLine: true,
          inputMode: "numeric",
        }}
        checkbox={
          pendingApprove?.payout?.status === "settled"
            ? { label: "I understand this is a clawback — the cook was already paid, and this amount will be recovered from them." }
            : undefined
        }
        requireCheckbox={pendingApprove?.payout?.status === "settled"}
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
