import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useSelector } from "react-redux";
import API from "../api/axios";
import { useFetch } from "../hooks/useFetch";
import { formatDate } from "../utils/constants";
import {
  formatCurrency,
  EVENT_SERVICE_LABEL,
  eventStatusLabel,
  EVENT_STATUS_FLOW,
} from "../utils/eventConstants";
import { useShowToast } from "../store/hooks";
import {
  CalendarCheck,
  Clock3,
  Users,
  MapPin,
  UtensilsCrossed,
  ChefHat,
  BadgeIndianRupee,
  CheckCircle2,
  XCircle,
} from "lucide-react";

const EventBookingDetails = () => {
  const { id } = useParams();
  const user = useSelector((s) => s.auth.user);
  const showToast = useShowToast();
  const { data: booking, loading, error, refetch } = useFetch(`/event-bookings/${id}`);
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    if (!window.confirm("Cancel this event booking? This cannot be undone.")) return;
    setCancelling(true);
    try {
      await API.post(`/event-bookings/${id}/cancel`);
      showToast("Event booking cancelled", "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Cancel failed", "error");
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return (
      <div className="loading-spinner-wrapper">
        <div className="spinner"></div>
        <p>Loading event booking...</p>
      </div>
    );
  }

  if (error || !booking) {
    return (
      <div className="dashboard-container">
        <div className="error-alert-banner">{error || "Event booking not found"}</div>
        <p style={{ marginTop: "1rem" }}>
          <Link to="/events">Back to Events</Link>
        </p>
      </div>
    );
  }

  const status = booking.bookingStatus;
  const flowIdx = EVENT_STATUS_FLOW.indexOf(status);
  const cancellable = ["pending", "cook_assigned", "confirmed", "in_progress"].includes(status);
  const canCancel =
    cancellable &&
    (user?.role === "admin" ||
      String(booking.customerId?._id || booking.customerId) === user?.id);
  const cook = booking.cookId && typeof booking.cookId === "object" ? booking.cookId : null;

  const rows = [
    { icon: <CalendarCheck size={15} />, label: "Event", value: `${booking.eventType} · ${formatDate(booking.eventDate)} · ${booking.startTime}` },
    { icon: <Clock3 size={15} />, label: "Duration", value: `${booking.duration} hr${Number(booking.extraHours) > 0 ? ` + ${booking.extraHours} extra hr` : ""}` },
    { icon: <Users size={15} />, label: "Guests", value: `${booking.guestCount}${Number(booking.additionalCook) > 0 ? ` · +${booking.additionalCook} cook` : ""}` },
    { icon: <UtensilsCrossed size={15} />, label: `Menu (${booking.foodType})`, value: booking.menu },
    { icon: <ChefHat size={15} />, label: "Service", value: EVENT_SERVICE_LABEL(booking.serviceType) },
    {
      icon: <MapPin size={15} />,
      label: "Venue",
      value: `${booking.address}, ${booking.area}${booking.landmark ? ` (Near ${booking.landmark})` : ""}`,
    },
  ];

  return (
    <div className="dashboard-container events-page">
      <div className="dashboard-header-row">
        <div>
          <span className="badge badge-festive" style={{ marginBottom: "0.5rem" }}>
            {booking.bookingId || "Event Booking"}
          </span>
          <h1>
            {booking.eventType} — {eventStatusLabel(status)}
          </h1>
          <p style={{ color: "var(--slate-600)", margin: 0 }}>
            {formatDate(booking.eventDate)} · {booking.startTime} · {booking.guestCount} guests
          </p>
        </div>
        <span className="badge badge-festive">{eventStatusLabel(status).toUpperCase()}</span>
      </div>

      {status === "pending" && (
        <div
          style={{
            background: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: "10px",
            padding: "0.85rem 1rem",
            marginBottom: "1.25rem",
            color: "#92400e",
          }}
        >
          Your booking request has been received. CookMitra will assign a suitable cook based on
          availability, location and event requirements.
        </div>
      )}

      {/* Status timeline */}
      <ol className="od-steps-modern" aria-label="Booking status" style={{ marginBottom: "1.5rem" }}>
        {EVENT_STATUS_FLOW.map((s, i) => {
          const state =
            status === "cancelled" ? "" : flowIdx >= 0 && i < flowIdx ? "done" : i === flowIdx ? "active" : "";
          return (
            <li key={s} className={`od-step-item ${state}`}>
              <span className="od-step-num" aria-hidden="true">
                {state === "done" ? "✓" : i + 1}
              </span>
              <span className="od-step-text">
                <span className="od-step-name">{eventStatusLabel(s)}</span>
              </span>
              {i < EVENT_STATUS_FLOW.length - 1 && <span className="od-step-link" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>

      <div className="booking-metadata-grid">
        {rows.map((r) => (
          <div className="meta-field" key={r.label}>
            <label>
              {r.icon} {r.label}
            </label>
            <span>{r.value}</span>
          </div>
        ))}
        <div className="meta-field">
          <label>
            <BadgeIndianRupee size={15} /> Price Breakdown
          </label>
          <span>
            Service {formatCurrency(booking.serviceAmount)}
            {Number(booking.additionalCookAmount) > 0 && ` · +Cook ${formatCurrency(booking.additionalCookAmount)}`}
            {Number(booking.extraHourAmount) > 0 && ` · +Hours ${formatCurrency(booking.extraHourAmount)}`}
            {Number(booking.travelCharge) > 0 ? ` · Travel ${formatCurrency(booking.travelCharge)}` : " · Travel FREE"}
            {" · "}
            <strong>Total {formatCurrency(booking.totalAmount)}</strong>
          </span>
        </div>
        {booking.customerNotes && (
          <div className="meta-field">
            <label>Special Instructions</label>
            <span>{booking.customerNotes}</span>
          </div>
        )}
      </div>

      {/* Assigned cook (§11) */}
      <div className="profile-card-block" style={{ marginTop: "1.25rem" }}>
        <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <ChefHat size={18} style={{ color: "var(--primary)" }} /> Assigned Cook
        </h3>
        {cook ? (
          <div className="event-cook-card" style={{ display: "flex", alignItems: "center", gap: "0.9rem" }}>
            <span
              style={{
                width: 52,
                height: 52,
                borderRadius: "50%",
                background: "var(--primary-gradient)",
                color: "#fff",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 800,
                fontSize: "1.3rem",
                flexShrink: 0,
              }}
            >
              {(cook.name || "C")[0].toUpperCase()}
            </span>
            <div>
              <div style={{ fontWeight: 800, fontSize: "1.05rem" }}>{cook.name}</div>
              <div style={{ fontSize: "0.88rem", color: "var(--slate-500)" }}>
                {[cook.phone || cook.mobile].filter(Boolean).join(" · ") || "Contact shared on confirmation"}
              </div>
            </div>
            <span className="badge badge-emerald" style={{ marginLeft: "auto" }}>
              <CheckCircle2 size={13} /> Verified Cook
            </span>
          </div>
        ) : (
          <p style={{ color: "var(--slate-500)", margin: 0 }}>
            <Clock3 size={14} /> CookMitra is finding a suitable verified cook for your event. You will be
            notified once assigned.
          </p>
        )}
      </div>

      <div className="booking-actions-row" style={{ marginTop: "1.25rem" }}>
        {canCancel && (
          <button className="btn btn-danger-outline btn-sm" onClick={handleCancel} disabled={cancelling}>
            <XCircle size={15} /> {cancelling ? "Cancelling..." : "Cancel Booking"}
          </button>
        )}
        <Link to="/dashboard/event-bookings" className="btn btn-outline btn-sm">
          My Event Bookings
        </Link>
        <Link to="/events" className="btn btn-outline btn-sm">
          Book Another Event
        </Link>
      </div>
    </div>
  );
};

export default EventBookingDetails;
