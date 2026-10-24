import React, { useState, useEffect, useCallback, useRef } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate, formatTimeRange12 } from "../utils/constants";
import ConfirmDialog from "./ConfirmDialog";
import "./AdminRefunds.css";
import {
  Banknote,
  CheckCircle2,
  Check,
  Clock3,
  AlertCircle,
  Copy,
  RefreshCw,
  XCircle,
  Wallet,
  SlidersHorizontal,
  ChevronDown,
} from "lucide-react";

const PAGE_LIMIT = 25;

const emptyPage = { rows: [], total: 0, page: 1, totalPages: 1 };

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
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
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

const REFUND_STATUS_OPTIONS = [
  { value: "", label: "Actionable (default)" },
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "failed", label: "Failed" },
  { value: "manual", label: "Manual" },
  { value: "processed", label: "Processed (history)" },
  { value: "rejected", label: "Rejected (history)" },
  { value: "all", label: "All statuses" },
];

// Custom styled replacement for the native status <select> (whose popup
// list is OS-rendered and cannot be styled). Button + popup menu with full
// keyboard support: Enter/Space/ArrowDown opens, arrows move, Enter picks.
const RefundStatusFilter = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const wrapRef = useRef(null);
  const current = REFUND_STATUS_OPTIONS.find((o) => o.value === value) || REFUND_STATUS_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    setFocusIdx(Math.max(0, REFUND_STATUS_OPTIONS.findIndex((o) => o.value === value)));
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, value]);

  const pick = (v) => {
    onChange(v);
    setOpen(false);
  };

  const onBtnKey = (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  };
  const onMenuKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((i) => (i + 1) % REFUND_STATUS_OPTIONS.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((i) => (i - 1 + REFUND_STATUS_OPTIONS.length) % REFUND_STATUS_OPTIONS.length);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(REFUND_STATUS_OPTIONS[focusIdx].value);
    }
  };

  return (
    <div className={`rf-dd${value ? " is-active" : ""}${open ? " is-open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="rf-dd-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Filter refunds by status"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onBtnKey}
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        <span className="rf-dd-label">Status</span>
        <span className="rf-dd-value">{current.label}</span>
        <ChevronDown size={14} aria-hidden="true" className="rf-dd-chev" />
      </button>
      {open && (
        <ul className="rf-dd-menu" role="listbox" aria-label="Refund statuses" onKeyDown={onMenuKey}>
          {REFUND_STATUS_OPTIONS.map((o, i) => (
            <li key={o.value || "default"}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`rf-dd-item${o.value === value ? " is-selected" : ""}${i === focusIdx ? " is-focused" : ""}`}
                onClick={() => pick(o.value)}
                onMouseEnter={() => setFocusIdx(i)}
              >
                <span className="rf-dd-check" aria-hidden="true">
                  {o.value === value && <Check size={13} />}
                </span>
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const AdminPayoutsPanel = ({ view = "payouts" }) => {
  const isRefunds = view === "refunds";
  const showToast = useShowToast();
  const [statusFilter, setStatusFilter] = useState("");
  const { rows: queueRows, total: queueTotal, totalPages: queuePages, page: queuePage, loading, error, gotoPage: gotoQueuePage, refetch } =
    usePagedList(isRefunds ? null : "/payouts/queue");
  const refundsUrl = isRefunds ? `/payouts/refunds${statusFilter ? `?status=${statusFilter}` : ""}` : null;
  const { rows: refundRows, total: refundsTotal, totalPages: refundsPages, page: refundsPage, loading: refundsLoading, error: refundsError, gotoPage: gotoRefundsPage, refetch: refetchRefunds } =
    usePagedList(refundsUrl);
  const [refFor, setRefFor] = useState(null);
  const [reference, setReference] = useState("");
  const [transferConfirmed, setTransferConfirmed] = useState(false);
  const [overrideConfirmed, setOverrideConfirmed] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [pendingApprove, setPendingApprove] = useState(null);
  const [pendingReject, setPendingReject] = useState(null);

  const pendingRefunds = (refundRows || []).filter((b) => b.payment?.refundStatus === "pending");
  const processingRefunds = (refundRows || []).filter((b) => b.payment?.refundStatus === "processing");
  const followupRefunds = (refundRows || []).filter((b) =>
    ["failed", "manual"].includes(b.payment?.refundStatus)
  );

  const openSettle = (bookingId) => {
    setRefFor(bookingId);
    setReference("");
    setTransferConfirmed(false);
    setOverrideConfirmed(false);
    setOverrideReason("");
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
    // Legacy auto-completes carry no OTP trail, so the server blocks them
    // unless the admin explicitly asserts out-of-band verification here.
    const needsOverride = booking.payoutEligible === false && booking.payoutOverrideAllowed === true;
    if (needsOverride && !overrideConfirmed) {
      showToast("Tick the verification override first — it records that you verified this legacy service out-of-band", "error");
      return;
    }
    if (needsOverride && overrideReason.trim().length < 10) {
      showToast("Describe how the service was verified (min 10 characters) — the note is kept on the payout record", "error");
      return;
    }
    setSaving(true);
    try {
      await API.patch(`/payouts/${bookingId}/settle`, {
        reference: reference.trim(),
        ...(needsOverride ? { verificationOverride: true, overrideReason: overrideReason.trim() } : {}),
      });
      showToast(`Payout recorded${detailsLabel ? ` (${detailsLabel})` : ""} — the cook has been notified.`, "success");
      setRefFor(null);
      setReference("");
      setTransferConfirmed(false);
      setOverrideConfirmed(false);
      setOverrideReason("");
      refetch();
    } catch (err) {
      if (err.response?.status === 409) {
        showToast("Already handled — refreshing the queue to show the current state.", "info");
        setRefFor(null);
        setReference("");
        setTransferConfirmed(false);
        setOverrideConfirmed(false);
        setOverrideReason("");
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
    const raw = String(amountInput ?? "").trim();
    if (raw !== "" && !/^\d+$/.test(raw)) {
      showToast("Approved amount must be whole rupees — leave blank for a full refund.", "error");
      return;
    }
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
      <div className={isRefunds ? "rf-head" : undefined} style={isRefunds ? undefined : { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", gap: "0.6rem", flexWrap: "wrap" }}>
        {isRefunds ? (
          <div className="rf-title">
            <span className="rf-title-ico" aria-hidden="true">
              <Wallet size={20} />
            </span>
            <div>
              <h2>Refunds</h2>
              <p className="rf-sub">Review customer refund requests and record manual settlements.</p>
            </div>
          </div>
        ) : (
          <h2 style={{ fontSize: "1.15rem", fontWeight: 800, margin: 0 }}>Cook Payouts</h2>
        )}
        <div className={isRefunds ? "rf-toolbar" : undefined} style={isRefunds ? undefined : { display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
          {isRefunds && (
            <RefundStatusFilter value={statusFilter} onChange={setStatusFilter} />
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
          {refundsLoading && <p className="rf-loading">Loading refund requests…</p>}
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
                        {b.payoutOverrideAllowed === true && " You may still pay after verifying the service out-of-band (override below)."}
                      </p>
                    )}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 800, color: "var(--primary)", fontSize: "1.05rem" }}>
                      {formatCurrency(b.cookPayout)}
                    </div>
                    <div style={{ fontSize: "0.78rem", color: "var(--slate-500)" }}>
                      of {formatCurrency(b.amount)} (15% fee {formatCurrency(b.commission)})
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
                        {b.payoutEligible === false && b.payoutOverrideAllowed === true && (
                          <>
                            <label style={{ display: "flex", gap: "0.35rem", alignItems: "flex-start", fontSize: "0.78rem", color: "var(--slate-700)", maxWidth: "16rem", textAlign: "left", cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                checked={overrideConfirmed}
                                onChange={(e) => setOverrideConfirmed(e.target.checked)}
                                style={{ marginTop: "0.15rem" }}
                              />
                              <span>Verification override: I verified out-of-band that this legacy service was actually delivered (no OTP trail exists).</span>
                            </label>
                            <input
                              className="form-control"
                              style={{ padding: "0.3rem 0.5rem", fontSize: "0.85rem", width: "11rem" }}
                              placeholder="How was it verified? (min 10 chars)"
                              value={overrideReason}
                              onChange={(e) => setOverrideReason(e.target.value)}
                            />
                          </>
                        )}
                        <div style={{ display: "flex", gap: "0.4rem" }}>
                          <button className="btn btn-outline btn-sm" disabled={saving} onClick={() => { setRefFor(null); setReference(""); setTransferConfirmed(false); setOverrideConfirmed(false); setOverrideReason(""); }}>
                            Cancel
                          </button>
                          <button className="btn btn-primary btn-sm" disabled={saving || !transferConfirmed || !reference.trim() || ((b.payoutEligible === false && b.payoutOverrideAllowed === true) && (!overrideConfirmed || overrideReason.trim().length < 10))} onClick={() => settle(b, dest)} title={!transferConfirmed ? "Tick the transfer confirmation first" : "Record payout"}>
                            <CheckCircle2 size={14} /> Confirm paid
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          className="btn btn-primary btn-sm"
                          style={{ marginTop: "0.5rem" }}
                          disabled={blocked && b.payoutOverrideAllowed !== true}
                          title={blocked && b.payoutOverrideAllowed !== true ? `Blocked: ${(blockers[0] || "see note")}` : "Record an external transfer as paid"}
                          onClick={() => openSettle(b._id)}
                        >
                          <Banknote size={14} /> {blocked ? "Verify & mark paid" : "Mark paid"}
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
      <section className="rf-section" aria-label="Refunds awaiting decision">
      <div className="rf-section-head">
        <span className="rf-section-ico" aria-hidden="true"><Clock3 size={16} /></span>
        <h3>Refunds awaiting decision</h3>
        {pendingRefunds?.length > 0 && <span className="rf-count">{pendingRefunds.length}</span>}
      </div>
      {!pendingRefunds?.length ? (
        <p className="rf-empty-note"><CheckCircle2 size={15} /> Nothing awaiting a decision on this page.</p>
      ) : (
        <div className="bookings-list-modern">
          {pendingRefunds.map((b) => (
            <article key={b._id} className="booking-item-card rf-card rf-card--amber">
              <div className="rf-top">
                <span className="rf-avatar" aria-hidden="true">
                  {(b.customer?.name || "C")[0].toUpperCase()}
                </span>
                <div className="rf-id">
                  <div className="rf-name-row">
                    <strong>{b.customer?.name || "Customer"}</strong>
                    <span className="rf-amount">{formatCurrency(b.payment?.refundAmount || b.amount)} refund</span>
                  </div>
                  <p className="rf-meta">
                    {b.status ? String(b.status).replace(/_/g, " ") : "booking"} ·{" "}
                    {b.date ? formatDate(b.date) : ""}
                    {b.startTime ? ` · ${formatTimeRange12(b.startTime, b.endTime, "-")}` : ""}
                  </p>
                </div>
              </div>
              <div className="rf-payline">
                Payment id: <code>{b.payment?.razorpayPaymentId || "—"}</code>
              </div>
              {b.payment?.refundReason ? (
                <div className="rf-note">
                  <strong>Reason:</strong> {b.payment.refundReason}
                  {b.payment?.refundCustomerNote ? ` — “${b.payment.refundCustomerNote}”` : ""}
                </div>
              ) : null}
              {b.payment?.refundRequestedAt ? (
                <div className="rf-requested">
                  Requested {new Date(b.payment.refundRequestedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                  {b.payment?.refundRequestedBy ? ` · by ${b.payment.refundRequestedBy}` : ""}
                </div>
              ) : null}
              <div className="rf-actions">
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
            </article>
          ))}
        </div>
      )}
      </section>
      <section className="rf-section" aria-label="Refunds stuck mid-approval">
      <div className="rf-section-head">
        <span className="rf-section-ico rf-ico-rose" aria-hidden="true"><AlertCircle size={16} /></span>
        <h3>Refunds stuck mid-approval</h3>
        {processingRefunds?.length > 0 && <span className="rf-count">{processingRefunds.length}</span>}
      </div>
      {!processingRefunds?.length ? (
        <p className="rf-empty-note"><CheckCircle2 size={15} /> None — every approval finished cleanly.</p>
      ) : (
        <div className="bookings-list-modern">
          {processingRefunds.map((b) => (
            <article key={b._id} className="booking-item-card rf-card rf-card--rose">
              <div className="rf-top">
                <span className="rf-avatar" aria-hidden="true">
                  {(b.customer?.name || "C")[0].toUpperCase()}
                </span>
                <div className="rf-id">
                  <div className="rf-name-row">
                    <strong>{b.customer?.name || "Customer"}</strong>
                    <span className="rf-amount">{formatCurrency(b.payment?.refundAmount || b.amount)} refund</span>
                  </div>
                  <p className="rf-meta">approval interrupted</p>
                </div>
              </div>
              <div className="rf-payline">
                Payment id: <code>{b.payment?.razorpayPaymentId || "—"}</code>
              </div>
              <p className="rf-warn">
                <AlertCircle size={14} />
                <span>Verify with the gateway before anything else — recording a manual settlement without
                checking could refund the customer twice.</span>
              </p>
              <div className="rf-actions">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={saving}
                  onClick={() => reconcileRefund(b._id)}
                >
                  <RefreshCw size={14} /> Verify with gateway
                </button>
                {refFor === `refund-${b._id}` ? (
                  <div className="rf-settle-inline">
                    <input
                      className="form-control"
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
      </section>
      <section className="rf-section" aria-label="Refunds needing manual action">
      <div className="rf-section-head">
        <span className="rf-section-ico rf-ico-blue" aria-hidden="true"><Banknote size={16} /></span>
        <h3>Refunds needing manual action</h3>
        {followupRefunds?.length > 0 && <span className="rf-count">{followupRefunds.length}</span>}
      </div>
      {!followupRefunds?.length ? (
        <p className="rf-empty-note"><CheckCircle2 size={15} /> Nothing pending on this page — all shown refunds processed.</p>
      ) : (
        <div className="bookings-list-modern">
          {followupRefunds.map((b) => (
            <article key={b._id} className="booking-item-card rf-card rf-card--blue">
              <div className="rf-top">
                <span className="rf-avatar" aria-hidden="true">
                  {(b.customer?.name || "C")[0].toUpperCase()}
                </span>
                <div className="rf-id">
                  <div className="rf-name-row">
                    <strong>{b.customer?.name || "Customer"}</strong>
                    <span className="rf-amount">{formatCurrency(b.payment?.refundAmount || b.amount)} refund</span>
                  </div>
                  <p className="rf-meta">
                    {b.payment?.refundStatus === "failed" ? "gateway refund failed" : "needs manual transfer"}
                  </p>
                </div>
              </div>
              <div className="rf-payline">
                Payment id: <code>{b.payment?.razorpayPaymentId || "—"}</code>
              </div>
              <div className="rf-actions">
                {refFor === `refund-${b._id}` ? (
                  <div className="rf-settle-inline">
                    <input
                      className="form-control"
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
      </section>
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
