import { Link, useNavigate } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import { formatDate } from "../utils/constants";
import { formatCurrency, EVENT_SERVICE_LABEL, eventStatusLabel } from "../utils/eventConstants";
import { CalendarCheck, ShieldCheck, PartyPopper, ChevronRight } from "lucide-react";

const CustomerEventBookings = () => {
  const { data, loading } = useFetch("/event-bookings/my");
  const navigate = useNavigate();
  const bookings = Array.isArray(data) ? data : [];

  const upcoming = bookings.filter((b) =>
    ["pending", "cook_assigned", "confirmed", "in_progress"].includes(b.bookingStatus)
  );
  const past = bookings.filter((b) => ["completed", "cancelled"].includes(b.bookingStatus));

  const openBooking = (e, id) => {
    if (e.target.closest("button, a")) return;
    navigate(`/event-bookings/${id}`);
  };

  const renderCard = (b) => {
    const cook = b.cookId && typeof b.cookId === "object" ? b.cookId : null;
    return (
      <article
        key={b._id}
        className="booking-item-card booking-card-modern"
        onClick={(e) => openBooking(e, b._id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter") navigate(`/event-bookings/${b._id}`);
        }}
        aria-label={`Open ${b.eventType} booking details`}
        style={{ cursor: "pointer" }}
      >
        <div className="booking-item-top">
          <div>
            <h3 style={{ margin: 0 }}>
              {b.eventType} · {formatDate(b.eventDate)}
            </h3>
            <span style={{ fontSize: "0.85rem", color: "var(--slate-500)" }}>
              {b.bookingId} · {EVENT_SERVICE_LABEL(b.serviceType)} · {b.guestCount} guests
              {cook ? ` · Cook: ${cook.name}` : " · Cook: to be assigned"}
            </span>
          </div>
          <span className="badge badge-festive">{eventStatusLabel(b.bookingStatus).toUpperCase()}</span>
        </div>
        <div className="booking-metadata-grid">
          <div className="meta-field">
            <label>Time</label>
            <span>
              {b.startTime} · {b.duration} hr
            </span>
          </div>
          <div className="meta-field">
            <label>Venue</label>
            <span>
              {b.address}, {b.area}
            </span>
          </div>
          <div className="meta-field">
            <label>Total</label>
            <span style={{ color: "var(--primary)", fontWeight: 700 }}>{formatCurrency(b.totalAmount)}</span>
          </div>
        </div>
        <div className="booking-actions-row">
          <span className="service-learn-more">
            View details <ChevronRight size={15} />
          </span>
        </div>
      </article>
    );
  };

  if (loading) {
    return (
      <div className="loading-spinner-wrapper">
        <div className="spinner"></div>
        <p>Loading your event bookings...</p>
      </div>
    );
  }

  return (
    <div className="dashboard-container my-bookings-page">
      <div className="od-hero">
        <div className="od-hero-text">
          <span className="od-eyebrow">
            <PartyPopper size={12} /> CookMitra Events
          </span>
          <h1 className="od-title">My Event Bookings</h1>
          <p className="od-sub">
            <ShieldCheck size={13} />
            <span className="od-sub-text">Birthdays, anniversaries & family functions — you celebrate, we cook</span>
          </p>
        </div>
        <Link to="/events" className="btn btn-primary">
          <CalendarCheck size={16} /> Book an Event
        </Link>
      </div>

      {bookings.length === 0 ? (
        <div className="no-data">
          <p>No event bookings yet — plan your first celebration!</p>
          <Link to="/events" className="btn btn-primary btn-sm">
            Book an Event Cook
          </Link>
        </div>
      ) : (
        <>
          <h2 style={{ fontSize: "1.2rem", margin: "1.25rem 0 0.75rem" }}>Upcoming ({upcoming.length})</h2>
          {upcoming.length > 0 ? (
            <div className="bookings-list-modern">{upcoming.map(renderCard)}</div>
          ) : (
            <p style={{ color: "var(--slate-500)" }}>No upcoming events.</p>
          )}
          {past.length > 0 && (
            <>
              <h2 style={{ fontSize: "1.2rem", margin: "1.5rem 0 0.75rem" }}>
                Completed & Cancelled ({past.length})
              </h2>
              <div className="bookings-list-modern">{past.map(renderCard)}</div>
            </>
          )}
        </>
      )}
    </div>
  );
};

export default CustomerEventBookings;
