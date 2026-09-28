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
  const { data, loading, refetch } = useFetch("/event-bookings");
  const { data: cooks } = useFetch("/cooks");
  const showToast = useShowToast();
  const [filter, setFilter] = useState("all");
  const [assignFor, setAssignFor] = useState(null);
  const [assignCookId, setAssignCookId] = useState("");
  const [busy, setBusy] = useState(null);

  const bookings = Array.isArray(data) ? data : [];
  const verifiedCooks = (Array.isArray(cooks) ? cooks : []).filter((c) => c.approvalStatus === "approved");

  const visible = bookings.filter((b) => {
    if (filter === "pending") return b.bookingStatus === "pending";
    if (filter === "live") return ["cook_assigned", "confirmed", "in_progress"].includes(b.bookingStatus);
    if (filter === "past") return ["completed", "cancelled"].includes(b.bookingStatus);
    return true;
  });

  const handleAssign = async (bookingId) => {
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
      showToast(err.response?.data?.message || "Assignment failed", "error");
    } finally {
      setBusy(null);
    }
  };

  const handleStatus = async (bookingId, status) => {
    if (!window.confirm(`Move booking to ${eventStatusLabel(status)}?`)) return;
    setBusy(bookingId);
    try {
      await API.patch(`/event-bookings/${bookingId}/status`, { status });
      showToast(`Booking marked ${eventStatusLabel(status)}`, "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Status update failed", "error");
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = async (bookingId) => {
    if (!window.confirm("Cancel this event booking as admin?")) return;
    setBusy(bookingId);
    try {
      await API.post(`/event-bookings/${bookingId}/cancel`);
      showToast("Booking cancelled", "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Cancel failed", "error");
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem", flexWrap: "wrap", gap: "0.75rem" }}>
        <h2 style={{ fontSize: "1.4rem", margin: 0 }}>Event Bookings</h2>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {[
            { id: "all", label: `All (${bookings.length})` },
            { id: "pending", label: `Pending (${bookings.filter((b) => b.bookingStatus === "pending").length})` },
            { id: "live", label: "Live" },
            { id: "past", label: "Past" },
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`btn btn-sm ${filter === f.id ? "btn-primary" : "btn-secondary"}`}
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
                    <label>Total</label>
                    <span style={{ color: "var(--primary)", fontWeight: 700 }}>
                      {formatCurrency(b.totalAmount)}
                    </span>
                  </div>
                </div>

                {assignFor === b._id ? (
                  <div className="event-assign-row" style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem", flexWrap: "wrap" }}>
                    <select
                      className="form-control"
                      style={{ maxWidth: 320 }}
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
                    <button
                      className="btn btn-success btn-sm"
                      disabled={busy === b._id}
                      onClick={() => handleAssign(b._id)}
                    >
                      <Check size={15} /> Confirm Assign
                    </button>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => {
                        setAssignFor(null);
                        setAssignCookId("");
                      }}
                    >
                      <X size={15} /> Close
                    </button>
                  </div>
                ) : (
                  <div className="booking-actions-row">
                    {["pending", "cook_assigned"].includes(b.bookingStatus) && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => {
                          setAssignFor(b._id);
                          setAssignCookId(cook?._id ? String(cook._id) : "");
                        }}
                      >
                        <UserCheck size={15} /> {cook ? "Reassign Cook" : "Assign Cook"}
                      </button>
                    )}
                    {nextActions(b).map((a) => (
                      <button
                        key={a.status}
                        className="btn btn-success btn-sm"
                        disabled={busy === b._id}
                        onClick={() => handleStatus(b._id, a.status)}
                      >
                        <Check size={15} /> {a.label}
                      </button>
                    ))}
                    {!["completed", "cancelled"].includes(b.bookingStatus) && (
                      <button
                        className="btn btn-danger-outline btn-sm"
                        disabled={busy === b._id}
                        onClick={() => handleCancel(b._id)}
                      >
                        <X size={15} /> Cancel
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
