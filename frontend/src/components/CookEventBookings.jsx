import { Link } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import { formatDate } from "../utils/constants";
import { formatCurrency, EVENT_SERVICE_LABEL, eventStatusLabel } from "../utils/eventConstants";
import { CalendarCheck, MapPin, Users, UtensilsCrossed, Wallet } from "lucide-react";

// Cook (§13): event assignments — upcoming / completed / cancelled with full
// event details + earnings from completed events.
const CookEventBookings = () => {
  const { data, loading } = useFetch("/event-bookings/cook");
  const bookings = Array.isArray(data) ? data : [];

  const upcoming = bookings.filter((b) =>
    ["cook_assigned", "confirmed", "in_progress", "pending"].includes(b.bookingStatus)
  );
  const completed = bookings.filter((b) => b.bookingStatus === "completed");
  const cancelled = bookings.filter((b) => b.bookingStatus === "cancelled");
  const earnings = completed.reduce((sum, b) => sum + Number(b.totalAmount || 0), 0);

  if (loading) return <p className="cook-loading-text">Loading event assignments...</p>;

  if (bookings.length === 0) {
    return (
      <div className="empty-state-card">
        <div className="empty-state-icon">
          <CalendarCheck size={28} />
        </div>
        <h3>No event assignments yet</h3>
        <p style={{ fontSize: "0.95rem", color: "var(--slate-600)" }}>
          When CookMitra assigns you to a birthday, anniversary or family function, it appears here
          with the full event details.
        </p>
      </div>
    );
  }

  const renderCard = (b) => (
    <div key={b._id} className="booking-item-card">
      <div className="booking-item-top">
        <div>
          <h3 style={{ margin: 0 }}>
            {b.eventType} · {formatDate(b.eventDate)}
          </h3>
          <span style={{ fontSize: "0.85rem", color: "var(--slate-500)" }}>
            {b.bookingId} · {b.startTime} · {b.duration} hr · {b.guestCount} guests
          </span>
        </div>
        <span className="badge badge-festive">{eventStatusLabel(b.bookingStatus).toUpperCase()}</span>
      </div>
      <div className="booking-metadata-grid">
        <div className="meta-field">
          <label>
            <UtensilsCrossed size={13} /> Menu ({b.foodType})
          </label>
          <span>{b.menu}</span>
        </div>
        <div className="meta-field">
          <label>
            <MapPin size={13} /> Venue
          </label>
          <span>
            {b.address}, {b.area}
            {b.landmark ? ` (Near ${b.landmark})` : ""}
          </span>
        </div>
        <div className="meta-field">
          <label>Service</label>
          <span>
            {EVENT_SERVICE_LABEL(b.serviceType)}
            {Number(b.additionalCook) > 0 ? ` · +${b.additionalCook} cook` : ""}
          </span>
        </div>
        <div className="meta-field">
          <label>
            <Wallet size={13} /> Booking Amount
          </label>
          <span style={{ color: "var(--primary)", fontWeight: 700 }}>{formatCurrency(b.totalAmount)}</span>
        </div>
        {b.customerNotes && (
          <div className="meta-field">
            <label>Special Instructions</label>
            <span>{b.customerNotes}</span>
          </div>
        )}
        <div className="meta-field">
          <label>
            <Users size={13} /> Customer
          </label>
          <span>
            {b.customerId?.name || "Customer"}
            {b.customerId?.phone || b.customerId?.mobile ? ` · ${b.customerId.phone || b.customerId.mobile}` : ""}
          </span>
        </div>
      </div>
      <div className="booking-actions-row">
        <Link to={`/event-bookings/${b._id}`} className="btn btn-outline btn-sm">
          View Details
        </Link>
      </div>
    </div>
  );

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          flexWrap: "wrap",
          marginBottom: "1rem",
          alignItems: "center",
        }}
      >
        <span className="badge badge-emerald">
          <Wallet size={13} /> Event earnings: {formatCurrency(earnings)}
        </span>
        <span style={{ fontSize: "0.85rem", color: "var(--slate-500)" }}>
          {upcoming.length} upcoming · {completed.length} completed · {cancelled.length} cancelled
        </span>
      </div>
      {upcoming.length > 0 && (
        <>
          <h3 style={{ fontSize: "1.05rem" }}>Upcoming Assignments</h3>
          <div className="bookings-list-modern">{upcoming.map(renderCard)}</div>
        </>
      )}
      {completed.length > 0 && (
        <>
          <h3 style={{ fontSize: "1.05rem", marginTop: "1.25rem" }}>Completed</h3>
          <div className="bookings-list-modern">{completed.map(renderCard)}</div>
        </>
      )}
      {cancelled.length > 0 && (
        <>
          <h3 style={{ fontSize: "1.05rem", marginTop: "1.25rem" }}>Cancelled</h3>
          <div className="bookings-list-modern">{cancelled.map(renderCard)}</div>
        </>
      )}
    </div>
  );
};

export default CookEventBookings;
