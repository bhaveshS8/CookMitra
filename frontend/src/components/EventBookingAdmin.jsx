import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { useFetch } from "../hooks/useFetch";
import { formatDate, formatTime12 } from "../utils/constants";
import {
  formatCurrency,
  EVENT_SERVICE_LABEL,
  canVerifyEventDistance,
  eventPaymentMeta,
  eventStatusLabel,
  eventStatusTone,
  eventTypeLabel,
  EVENT_REFUND_LABELS,
} from "../utils/eventConstants";
import { useShowToast } from "../store/hooks";
import {
  AlertCircle,
  CalendarCheck,
  Check,
  ChefHat,
  Clock3,
  LocateFixed,
  MapPin,
  RefreshCw,
  RotateCcw,
  UserCheck,
  X,
} from "lucide-react";

// Admin: event booking queue — assign verified cooks + move §15 lifecycle.
const EventBookingAdmin = () => {
  const { data, loading, error, refetch } = useFetch("/event-bookings");
  const { data: refunds, refetch: refetchRefunds } = useFetch("/event-payments/admin/refunds");
  const {
    data: cooks,
    loading: cooksLoading,
    error: cooksError,
    refetch: refetchCooks,
  } = useFetch("/cooks");
  const showToast = useShowToast();
  const [filter, setFilter] = useState("all");
  const [assignFor, setAssignFor] = useState(null);
  const [assignCookId, setAssignCookId] = useState("");
  const [busy, setBusy] = useState(null);
  const [refundBusy, setRefundBusy] = useState("");
  const [verifyFor, setVerifyFor] = useState(null);
  const [verifyKm, setVerifyKm] = useState("");
  const verifyLock = useRef(false);

  const bookings = Array.isArray(data) ? data : [];
  const refundRows = Array.isArray(refunds) ? refunds : [];
  const verifiedCooks = (Array.isArray(cooks) ? cooks : []).filter((c) => c.approvalStatus === "approved");

  const visible = bookings.filter((b) => {
    if (filter === "pending") return b.bookingStatus === "pending";
    if (filter === "live") return ["cook_assigned", "confirmed", "in_progress"].includes(b.bookingStatus);
    if (filter === "past") return ["completed", "cancelled"].includes(b.bookingStatus);
    return true;
  });

  const conflictMessage = (err, fallback) => {
    if (err.response?.status === 409) {
      refetch();
      return err.response?.data?.message || "Conflict — another admin just updated this booking. List refreshed.";
    }
    return err.response?.data?.message || fallback;
  };

  const handleAssign = async (booking) => {
    if (busy) return;
    if (!assignCookId) {
      showToast("Select a verified cook first", "error");
      return;
    }
    const cookEntry = verifiedCooks.find((c) => String(c?.user?._id || "") === String(assignCookId));
    if (
      !window.confirm(
        `Assign ${cookEntry?.user?.name || "this cook"} to booking ${booking.bookingId || booking._id.slice(-6).toUpperCase()}?`
      )
    )
      return;
    setBusy(booking._id);
    try {
      await API.post(`/event-bookings/${booking._id}/assign-cook`, { cookId: assignCookId });
      showToast("Cook assigned — customer and cook notified!", "success");
      setAssignFor(null);
      setAssignCookId("");
      refetch();
    } catch (err) {
      showToast(conflictMessage(err, "Assignment failed"), "error");
    } finally {
      setBusy(null);
    }
  };

  const handleStatus = async (bookingId, status) => {
    if (busy) return;
    if (!window.confirm(`Move booking to ${eventStatusLabel(status)}?`)) return;
    setBusy(bookingId);
    try {
      await API.patch(`/event-bookings/${bookingId}/status`, { status });
      showToast(`Booking marked ${eventStatusLabel(status)}`, "success");
      refetch();
    } catch (err) {
      showToast(conflictMessage(err, "Status update failed"), "error");
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = async (bookingId) => {
    if (busy) return;
    if (!window.confirm("Cancel this event booking as admin?")) return;
    setBusy(bookingId);
    try {
      await API.post(`/event-bookings/${bookingId}/cancel`);
      showToast("Booking cancelled", "success");
      refetch();
    } catch (err) {
      showToast(conflictMessage(err, "Cancel failed"), "error");
    } finally {
      setBusy(null);
    }
  };

  const handleVerifyDistance = async (booking) => {
    if (busy || verifyLock.current) return;
    const raw = String(verifyKm).trim();
    const dist = Number(raw);
    if (!raw || !Number.isFinite(dist) || dist < 0 || dist > 100000) {
      showToast("Enter a valid distance in km (0–100000)", "error");
      return;
    }
    if (!canVerifyEventDistance(booking)) {
      showToast("This booking is no longer eligible for distance verification", "error");
      refetch();
      return;
    }
    verifyLock.current = true;
    setBusy(booking._id);
    try {
      await API.patch(`/event-bookings/${booking._id}/verify-distance`, { distanceKm: dist });
      showToast("Distance verified — travel charge recalculated server-side", "success");
      setVerifyFor(null);
      setVerifyKm("");
      refetch();
    } catch (err) {
      showToast(conflictMessage(err, "Verification failed"), "error");
    } finally {
      verifyLock.current = false;
      setBusy(null);
    }
  };

  const handleRefund = async (booking, action) => {
    if (refundBusy) return;
    const amount = formatCurrency(booking.payment?.refundAmount || booking.payment?.paidAmount || 0);
    if (!window.confirm(action === "approve" ? `Approve the full refund of ${amount}?` : "Decline this refund request?")) {
      return;
    }
    const reason =
      action === "approve"
        ? window.prompt("Admin note (optional)") || ""
        : window.prompt("Reason for declining (optional)") || "";
    setRefundBusy(booking._id);
    try {
      await API.post(
        `/event-payments/admin/refunds/${booking._id}/${action}`,
        action === "approve" ? { note: reason } : { reason }
      );
      showToast(action === "approve" ? "Full refund approved" : "Refund declined", "success");
      refetchRefunds();
      refetch();
    } catch (err) {
      showToast(conflictMessage(err, "Refund action failed"), "error");
      refetchRefunds();
    } finally {
      setRefundBusy("");
    }
  };

  const handleReconcileRefund = async (booking) => {
    if (refundBusy) return;
    setRefundBusy(booking._id);
    try {
      const res = await API.post(`/event-payments/admin/refunds/${booking._id}/reconcile`);
      if (res.data?.adopted && res.data?.pending) {
        showToast("Gateway refund is still pending confirmation", "info");
      } else if (res.data?.adopted) {
        showToast("Gateway refund confirmed", "success");
      } else {
        showToast("No gateway refund found — returned to the approval queue", "info");
      }
      refetchRefunds();
      refetch();
    } catch (err) {
      showToast(conflictMessage(err, "Gateway reconciliation failed"), "error");
      refetchRefunds();
    } finally {
      setRefundBusy("");
    }
  };

  const nextActions = (b) => {
    switch (b.bookingStatus) {
      case "cook_assigned":
        return [{ status: "confirmed", label: "Confirm Booking" }];
      case "confirmed":
        return [{ status: "in_progress", label: "Start (In Progress)" }];
      case "in_progress":
        return [{ status: "completed", label: "Mark Completed" }];
      default:
        return [];
    }
  };

  return (
    <div className="event-admin">
      <div className="dashboard-header-row event-admin-head">
        <div>
          <h2>Event Bookings</h2>
          <p className="event-admin-sub">Assign verified cooks, verify travel and manage the event lifecycle.</p>
        </div>
        <div className="event-filter-row" role="group" aria-label="Filter event bookings">
          {[
            { id: "all", label: `All (${bookings.length})` },
            { id: "pending", label: `Pending (${bookings.filter((b) => b.bookingStatus === "pending").length})` },
            { id: "live", label: "Live" },
            { id: "past", label: "Past" },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              className={`btn btn-sm ${filter === f.id ? "btn-primary" : "btn-outline"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {refundRows.length > 0 && (
        <section className="event-refund-panel" aria-labelledby="event-refunds-heading">
          <div className="event-panel-head">
            <h3 id="event-refunds-heading">
              <RotateCcw size={18} /> Event refund approvals ({refundRows.length})
            </h3>
          </div>
          <div className="event-refund-list">
            {refundRows.map((r) => {
              const customer = r.customerId && typeof r.customerId === "object" ? r.customerId : null;
              return (
                <article key={r._id} className="event-refund-card">
                  <div className="event-refund-info">
                    <div className="event-refund-title">
                      <strong>{r.bookingId}</strong>
                      <span className={`event-pay-badge event-pay-badge--${r.payment?.refundStatus === "failed" ? "rose" : "amber"}`}>
                        {EVENT_REFUND_LABELS[r.payment?.refundStatus] || "Awaiting approval"}
                      </span>
                    </div>
                    <p>
                      {customer?.name || "Customer"} · {eventTypeLabel(r)} ·{" "}
                      <strong>{formatCurrency(r.payment?.refundAmount || r.payment?.paidAmount || 0)}</strong>
                    </p>
                    <p className="event-refund-reason">
                      {r.payment?.refundStatus === "failed"
                        ? r.payment?.refundError || "Gateway retry available"
                        : r.payment?.refundStatus === "processing"
                          ? "Refund initiated — check the gateway to confirm whether it completed."
                          : r.payment?.refundReason || "Event cancelled before service start"}
                    </p>
                  </div>
                  <div className="event-refund-actions">
                    {r.payment?.refundStatus === "processing" ? (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={refundBusy === r._id}
                        onClick={() => handleReconcileRefund(r)}
                      >
                        <RefreshCw size={15} /> {refundBusy === r._id ? "Checking..." : "Check gateway"}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-success btn-sm"
                          disabled={refundBusy === r._id}
                          onClick={() => handleRefund(r, "approve")}
                        >
                          <Check size={15} /> {refundBusy === r._id ? "Working..." : "Approve full refund"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          disabled={refundBusy === r._id}
                          onClick={() => handleRefund(r, "reject")}
                        >
                          <X size={15} /> Decline
                        </button>
                      </>
                    )}
                    <Link to={`/event-bookings/${r._id}`} className="btn btn-outline btn-sm">
                      View
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {loading ? (
        <div className="loading-spinner-wrapper">
          <div className="spinner"></div>
          <p>Loading event bookings...</p>
        </div>
      ) : error ? (
        <div className="event-state event-state--error" role="alert">
          <span className="event-state-icon">
            <AlertCircle size={24} />
          </span>
          <h3>Couldn't load event bookings</h3>
          <p>{error}</p>
          <button type="button" className="btn btn-outline btn-sm" onClick={refetch}>
            Retry
          </button>
        </div>
      ) : visible.length > 0 ? (
        <div className="event-admin-list">
          {visible.map((b) => {
            const cook = b.cookId && typeof b.cookId === "object" ? b.cookId : null;
            const customer = b.customerId && typeof b.customerId === "object" ? b.customerId : null;
            const payMeta = eventPaymentMeta(b);
            const distanceVerified = b.distanceVerified === true;
            const isBusy = busy === b._id;
            return (
              <article key={b._id} className="event-admin-card">
                <header className="event-admin-card-head">
                  <div className="event-admin-heading">
                    <span className="event-admin-ref">{b.bookingId}</span>
                    <h3>{eventTypeLabel(b)}</h3>
                    <p>
                      {customer?.name || "Customer"}
                      {customer?.phone ? ` · ${customer.phone}` : ""} ·{" "}
                      {EVENT_SERVICE_LABEL(b.serviceType)} · {b.guestCount} guests
                    </p>
                  </div>
                  <div className="event-admin-badges">
                    <span className={`event-status-pill event-status-pill--${eventStatusTone(b.bookingStatus)}`}>
                      {eventStatusLabel(b.bookingStatus)}
                    </span>
                    <span className={`event-pay-badge event-pay-badge--${payMeta.tone}`}>{payMeta.label}</span>
                  </div>
                </header>

                <div className="event-admin-facts">
                  <span>
                    <CalendarCheck size={14} /> {formatDate(b.eventDate) || "—"} · {formatTime12(b.startTime) || "—"}
                  </span>
                  <span>
                    <Clock3 size={14} /> {b.duration} hr
                  </span>
                  <span>
                    <MapPin size={14} /> {[b.address, b.area].filter(Boolean).join(", ") || "—"}
                  </span>
                  <span className={distanceVerified ? "" : "is-warning"}>
                    <LocateFixed size={14} /> {b.distanceKm ?? 0} km ·{" "}
                    {distanceVerified ? "verified" : "provisional"}
                  </span>
                  <span>
                    <ChefHat size={14} /> {cook?.name || "No cook assigned"}
                  </span>
                </div>

                <div className="event-admin-cost">
                  <div>
                    <span>Total</span>
                    <strong>{formatCurrency(b.totalAmount)}</strong>
                  </div>
                  <div className="event-admin-cost-parts">
                    <span>Service {formatCurrency(b.serviceAmount)}</span>
                    <span>Travel {Number(b.travelCharge) > 0 ? formatCurrency(b.travelCharge) : "FREE"}</span>
                    {Number(b.extraHourAmount) > 0 && <span>Extra hours {formatCurrency(b.extraHourAmount)}</span>}
                    {Number(b.additionalCookAmount) > 0 && (
                      <span>Additional cook {formatCurrency(b.additionalCookAmount)}</span>
                    )}
                  </div>
                </div>

                {assignFor === b._id ? (
                  <div className="event-admin-inline-panel">
                    {cooksLoading ? (
                      <p className="event-inline-note">
                        <span className="event-spinner" aria-hidden="true" /> Loading verified cooks…
                      </p>
                    ) : cooksError ? (
                      <div className="event-inline-note event-inline-note--error" role="alert">
                        <span>{cooksError}</span>
                        <button type="button" className="btn btn-outline btn-sm" onClick={refetchCooks}>
                          Retry
                        </button>
                      </div>
                    ) : verifiedCooks.length === 0 ? (
                      <p className="event-inline-note">
                        No verified cooks available right now. Assign after a cook is approved.
                      </p>
                    ) : (
                      <div className="form-group event-admin-field">
                        <label htmlFor={`assign-cook-${b._id}`}>Verified cook</label>
                        <select
                          id={`assign-cook-${b._id}`}
                          className="form-control"
                          value={assignCookId}
                          onChange={(e) => setAssignCookId(e.target.value)}
                        >
                          <option value="">Select a verified cook…</option>
                          {verifiedCooks.map((c) => (
                            <option key={c._id} value={c?.user?._id}>
                              {c?.user?.name} · {c.experienceYears}y · {c.serviceArea || "—"}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="event-admin-inline-actions">
                      <button
                        type="button"
                        className="btn btn-success btn-sm"
                        disabled={isBusy || cooksLoading || Boolean(cooksError) || verifiedCooks.length === 0}
                        onClick={() => handleAssign(b)}
                      >
                        <Check size={15} aria-hidden="true" /> {isBusy ? "Assigning…" : "Confirm assign"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => {
                          setAssignFor(null);
                          setAssignCookId("");
                        }}
                      >
                        <X size={15} aria-hidden="true" /> Close
                      </button>
                    </div>
                  </div>
                ) : verifyFor === b._id ? (
                  <div className="event-admin-inline-panel">
                    <div className="form-group event-admin-field">
                      <label htmlFor={`verify-km-${b._id}`}>Verified distance (km)</label>
                      <input
                        id={`verify-km-${b._id}`}
                        type="number"
                        min={0}
                        max={100000}
                        step="0.1"
                        className="form-control"
                        value={verifyKm}
                        onChange={(e) => setVerifyKm(e.target.value)}
                        placeholder={String(b.distanceKm ?? 0)}
                      />
                    </div>
                    <div className="event-admin-inline-actions">
                      <button
                        type="button"
                        className="btn btn-success btn-sm"
                        disabled={isBusy}
                        onClick={() => handleVerifyDistance(b)}
                      >
                        <Check size={15} aria-hidden="true" /> {isBusy ? "Verifying…" : "Confirm distance"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        disabled={isBusy}
                        onClick={() => {
                          setVerifyFor(null);
                          setVerifyKm("");
                        }}
                      >
                        <X size={15} aria-hidden="true" /> Close
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="event-admin-actions">
                    {["pending", "cook_assigned"].includes(b.bookingStatus) && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={isBusy}
                        onClick={() => {
                          setAssignFor(b._id);
                          setAssignCookId(cook?._id ? String(cook._id) : "");
                        }}
                      >
                        <UserCheck size={15} aria-hidden="true" /> {cook ? "Reassign cook" : "Assign cook"}
                      </button>
                    )}
                    {canVerifyEventDistance(b) && (
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        disabled={isBusy}
                        onClick={() => {
                          setVerifyFor(b._id);
                          setVerifyKm(String(b.distanceKm ?? 0));
                        }}
                      >
                        <LocateFixed size={15} aria-hidden="true" /> Verify distance ({b.distanceKm ?? 0} km)
                      </button>
                    )}
                    {nextActions(b).map((a) => (
                      <button
                        key={a.status}
                        type="button"
                        className="btn btn-success btn-sm"
                        disabled={isBusy}
                        onClick={() => handleStatus(b._id, a.status)}
                      >
                        <Check size={15} aria-hidden="true" /> {isBusy ? "Working…" : a.label}
                      </button>
                    ))}
                    {!["completed", "cancelled"].includes(b.bookingStatus) && (
                      <button
                        type="button"
                        className="btn btn-danger-outline btn-sm"
                        disabled={isBusy}
                        onClick={() => handleCancel(b._id)}
                      >
                        <X size={15} aria-hidden="true" /> {isBusy ? "Working…" : "Cancel"}
                      </button>
                    )}
                    <Link to={`/event-bookings/${b._id}`} className="btn btn-outline btn-sm">
                      View details
                    </Link>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="event-state">
          <span className="event-state-icon">
            <CalendarCheck size={24} />
          </span>
          <h3>No event bookings here</h3>
          <p>No event bookings match this filter yet.</p>
        </div>
      )}
    </div>
  );
};

export default EventBookingAdmin;
