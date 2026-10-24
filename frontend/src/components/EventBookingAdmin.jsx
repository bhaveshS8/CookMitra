import { useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { useFetch } from "../hooks/useFetch";
import { formatDate } from "../utils/constants";
import { formatCurrency, EVENT_SERVICE_LABEL, eventStatusLabel } from "../utils/eventConstants";
import { useShowToast } from "../store/hooks";
import { Check, X, UserCheck } from "lucide-react";

// Admin: event booking queue — assign verified cooks + move §15 lifecycle.
const EventBookingAdmin = () => {
  const { data, loading, error, refetch } = useFetch("/event-bookings");
  const { data: cooks } = useFetch("/cooks");
  const showToast = useShowToast();
  const [filter, setFilter] = useState("all");
  const [assignFor, setAssignFor] = useState(null);
  const [assignCookId, setAssignCookId] = useState("");
  const [busy, setBusy] = useState(null);
  const [verifyFor, setVerifyFor] = useState(null);
  const [verifyKm, setVerifyKm] = useState("");

  const bookings = Array.isArray(data) ? data : [];
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

  const handleAssign = async (bookingId) => {
    if (busy) return;
    if (!assignCookId) {
      showToast("Select a verified cook first", "error");
      return;
    }
    const cookEntry = verifiedCooks.find((c) => String(c?.user?._id || "") === String(assignCookId));
    if (
      !window.confirm(
        `Assign ${cookEntry?.user?.name || "this cook"} to booking ${bookingId.slice(-6).toUpperCase()}?`
      )
    )
      return;
    setBusy(bookingId);
    try {
      await API.post(`/event-bookings/${bookingId}/assign-cook`, { cookId: assignCookId });
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
    if (busy) return;
    const dist = Number(verifyKm);
    if (!Number.isFinite(dist) || dist < 0 || dist > 100000) {
      showToast("Enter a valid distance in km (0–100000)", "error");
      return;
    }
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
      setBusy(null);
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
      <div className="dashboard-header-row">
        <h2 style={{ fontSize: "1.4rem", margin: 0 }}>Event Bookings</h2>
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

      {loading ? (
        <div className="loading-spinner-wrapper">
          <div className="spinner"></div>
          <p>Loading event bookings...</p>
        </div>
      ) : error ? (
        <div>
          <div className="error-alert-banner">{error}</div>
          <button type="button" className="btn btn-outline btn-sm" style={{ marginTop: "0.75rem" }} onClick={refetch}>
            Retry
          </button>
        </div>
      ) : visible.length > 0 ? (
        <div className="bookings-list-modern">
          {visible.map((b) => {
            const cook = b.cookId && typeof b.cookId === "object" ? b.cookId : null;
            const customer = b.customerId && typeof b.customerId === "object" ? b.customerId : null;
            return (
              <div key={b._id} className="booking-item-card">
                <div className="booking-item-top">
                  <div>
                    <h3 style={{ margin: 0 }}>
                      {b.eventType} · {customer?.name || "Customer"}
                    </h3>
                    <span style={{ fontSize: "0.85rem", color: "var(--slate-500)" }}>
                      {b.bookingId} · {EVENT_SERVICE_LABEL(b.serviceType)} · {b.guestCount} guests
                      {cook ? ` · Cook: ${cook.name}` : " · No cook yet"}
                    </span>
                  </div>
                  <span className="badge badge-festive">{eventStatusLabel(b.bookingStatus).toUpperCase()}</span>
                </div>
                <div className="booking-metadata-grid">
                  <div className="meta-field">
                    <label>Date / Time</label>
                    <span>
                      {formatDate(b.eventDate)} · {b.startTime} · {b.duration} hr
                    </span>
                  </div>
                  <div className="meta-field">
                    <label>Venue</label>
                    <span>
                      {b.address}, {b.area}
                    </span>
                  </div>
                  <div className="meta-field">
                    <label>Menu ({b.foodType})</label>
                    <span>{b.menu}</span>
                  </div>
                  <div className="meta-field">
                    <label>Total{b.distanceVerified !== true ? " (travel provisional)" : ""}</label>
                    <span style={{ color: "var(--primary)", fontWeight: 700 }}>
                      {formatCurrency(b.totalAmount)}
                    </span>
                    {b.distanceVerified !== true && (
                      <small style={{ color: "var(--slate-500)", display: "block" }}>
                        Distance {b.distanceKm ?? 0} km unverified — verify below.
                      </small>
                    )}
                  </div>
                </div>

                {assignFor === b._id ? (
                  <div className="event-assign-row" style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                    <div className="form-group" style={{ flex: "1 1 220px", minWidth: 0 }}>
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
                    <button
                      type="button"
                      className="btn btn-success btn-sm"
                      disabled={busy === b._id}
                      onClick={() => handleAssign(b._id)}
                    >
                      <Check size={15} aria-hidden="true" /> {busy === b._id ? "Assigning…" : "Confirm Assign"}
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
                ) : verifyFor === b._id ? (
                  <div className="event-assign-row" style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap", alignItems: "flex-end" }}>
                    <div className="form-group" style={{ flex: "1 1 200px", minWidth: 0 }}>
                      <label htmlFor={`verify-km-${b._id}`}>Verified distance (km)</label>
                      <input
                        id={`verify-km-${b._id}`}
                        type="number"
                        min={0}
                        max={100000}
                        className="form-control"
                        value={verifyKm}
                        onChange={(e) => setVerifyKm(e.target.value)}
                        placeholder={String(b.distanceKm ?? 0)}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn-success btn-sm"
                      disabled={busy === b._id}
                      onClick={() => handleVerifyDistance(b)}
                    >
                      <Check size={15} aria-hidden="true" /> {busy === b._id ? "Verifying…" : "Confirm Distance"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => {
                        setVerifyFor(null);
                        setVerifyKm("");
                      }}
                    >
                      <X size={15} aria-hidden="true" /> Close
                    </button>
                  </div>
                ) : (
                  <div className="booking-actions-row">
                    {["pending", "cook_assigned"].includes(b.bookingStatus) && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy === b._id}
                        onClick={() => {
                          setAssignFor(b._id);
                          setAssignCookId(cook?._id ? String(cook._id) : "");
                        }}
                      >
                        <UserCheck size={15} aria-hidden="true" /> {cook ? "Reassign Cook" : "Assign Cook"}
                      </button>
                    )}
                    {b.distanceVerified !== true && !["completed", "cancelled"].includes(b.bookingStatus) && (
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        disabled={busy === b._id}
                        onClick={() => {
                          setVerifyFor(b._id);
                          setVerifyKm(String(b.distanceKm ?? 0));
                        }}
                      >
                        Verify Travel ({b.distanceKm ?? 0} km)
                      </button>
                    )}
                    {nextActions(b).map((a) => (
                      <button
                        key={a.status}
                        type="button"
                        className="btn btn-success btn-sm"
                        disabled={busy === b._id}
                        onClick={() => handleStatus(b._id, a.status)}
                      >
                        <Check size={15} aria-hidden="true" /> {busy === b._id ? "Working…" : a.label}
                      </button>
                    ))}
                    {!["completed", "cancelled"].includes(b.bookingStatus) && (
                      <button
                        type="button"
                        className="btn btn-danger-outline btn-sm"
                        disabled={busy === b._id}
                        onClick={() => handleCancel(b._id)}
                      >
                        <X size={15} aria-hidden="true" /> {busy === b._id ? "Working…" : "Cancel"}
                      </button>
                    )}
                    <Link to={`/event-bookings/${b._id}`} className="btn btn-outline btn-sm">
                      View Details
                    </Link>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p style={{ color: "var(--slate-500)" }}>No event bookings match this filter.</p>
      )}
    </div>
  );
};

export default EventBookingAdmin;
