import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import { formatDate } from "../utils/constants";
import {
  Calendar,
  CalendarCheck,
  CheckCircle2,
  ChevronRight,
  Clock3,
  MessageCircle,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";

const prettyService = (s) =>
  String(s || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

const CustomerDashboard = () => {
  const { data: bookings, loading } = useFetch("/bookings/my");
  const navigate = useNavigate();

  // Only completed meals are shown on this page now.
  const completedBookings =
    bookings?.filter((b) => b.status === "completed") || [];

  // Clicking anywhere on a booking card (except its own buttons/links)
  // opens that booking's details page.
  const openBooking = (e, bookingId) => {
    if (e.target.closest("button, a, input, select, textarea")) return;
    navigate(`/bookings/${bookingId}`);
  };
  const openBookingKey = (e, bookingId) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      navigate(`/bookings/${bookingId}`);
    }
  };

  if (loading) {
    return (
      <div className="loading-spinner-wrapper">
        <div className="spinner"></div>
        <p style={{ color: "var(--slate-500)", fontWeight: 600 }}>
          Loading your completed bookings...
        </p>
      </div>
    );
  }

  return (
    <div className="dashboard-container my-bookings-page">
      <div className="od-hero">
        <div className="od-hero-text">
          <span className="od-eyebrow">
            <CalendarCheck size={12} /> Your sessions
          </span>
          <h1 className="od-title">My Bookings</h1>
          <p className="od-sub">
            <ShieldCheck size={13} />
            <span className="od-sub-text">
              Completed meals and receipts, all in one place
            </span>
          </p>
        </div>
      </div>

      {/* COOKMITRA EVENTS cross-link — event bookings live on their own page. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          background: "linear-gradient(135deg, #fff7ed, #ffedd5)",
          border: "1px solid #fed7aa",
          borderRadius: "12px",
          padding: "0.85rem 1rem",
          marginBottom: "1.25rem",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: "1.3rem" }} aria-hidden="true">
          🎉
        </span>
        <div style={{ flex: 1, minWidth: 200 }}>
          <strong>Celebrating something?</strong>
          <div style={{ fontSize: "0.88rem", color: "var(--slate-600)" }}>
            Birthdays, anniversaries & family functions — you celebrate, we cook.
          </div>
        </div>
        <Link to="/events" className="btn btn-primary btn-sm">
          Book an Event
        </Link>
        <Link to="/dashboard/event-bookings" className="btn btn-outline btn-sm">
          My Events
        </Link>
      </div>

      {completedBookings.length > 0 ? (
        <div className="bookings-list-modern my-bookings-list">
          {completedBookings.map((booking) => {
            const cookName = booking.cook?.name || "Completed Session";
            const initial = (cookName || "C").charAt(0).toUpperCase();
            const ref = booking._id?.substring(18).toUpperCase();
            const dishes = booking.selectedItems || [];
            const extraDishes = dishes.length > 2 ? dishes.length - 2 : 0;
            const waHref = booking.cook?.phone
              ? "https://wa.me/" +
                booking.cook.phone.replace(/[^0-9]/g, "") +
                "?text=" +
                encodeURIComponent(
                  "Completed session with " +
                    (booking.cook?.name || "cook") +
                    " on " +
                    formatDate(booking.date) +
                    ": " +
                    (booking.serviceType || "")
                      .replace(/_/g, " ")
                      .replace(/\s+/g, " ") +
                    " for " +
                    (booking.guests || "-") +
                    " guests. Rate: " +
                    (booking.rating?.average?.toFixed(1) ?? "N/A") +
                    " / 5"
                )
              : null;
            return (
            <article
              key={booking._id}
              className="booking-item-card booking-card-modern my-booking-card"
              data-status="completed"
              onClick={(e) => openBooking(e, booking._id)}
              onKeyDown={(e) => openBookingKey(e, booking._id)}
              role="button"
              tabIndex={0}
              aria-label={`Open details for completed booking with ${booking.cook?.name || "cook"}`}
            >
              <div className="my-booking-main">
                <div className="my-booking-avatar" aria-hidden="true">
                  {booking.cook?.photo ? (
                    <img src={booking.cook.photo} alt="" />
                  ) : (
                    <span className="my-booking-avatar-fallback">{initial}</span>
                  )}
                </div>
                <div className="my-booking-body">
                  <div className="my-booking-title-row">
                    <h3 className="my-booking-cook">{cookName}</h3>
                    <span className="badge badge-emerald my-booking-status">
                      <CheckCircle2 size={11} /> Done
                    </span>
                  </div>
                  <p className="my-booking-sub">
                    <span className="my-booking-service">
                      {prettyService(booking.serviceType) || "Session"}
                    </span>
                    <span className="my-booking-dot" aria-hidden="true" />
                    <span className="my-booking-date">
                      <Calendar size={11} />
                      {formatDate(booking.date)}
                    </span>
                    <span className="my-booking-dot" aria-hidden="true" />
                    <span className="my-booking-time">
                      <Clock3 size={11} />
                      {booking.startTime}-{booking.endTime}
                    </span>
                    {ref && <span className="my-booking-ref">#{ref}</span>}
                  </p>
                  <div className="my-booking-chips">
                    {booking.guests ? (
                      <span className="my-chip">
                        <Users size={11} /> {booking.guests} guests
                      </span>
                    ) : null}
                    {booking.durationHours ? (
                      <span className="my-chip">
                        <Clock3 size={11} /> {booking.durationHours}h
                      </span>
                    ) : null}
                    {dishes.slice(0, 2).map((item, i) => (
                      <span key={i} className="my-chip my-chip-dish">
                        {item}
                      </span>
                    ))}
                    {extraDishes > 0 && (
                      <span className="my-chip my-chip-more">
                        +{extraDishes} more
                      </span>
                    )}
                  </div>
                  {booking.notes && (
                    <p className="my-booking-note" title={booking.notes}>
                      &ldquo;{booking.notes}&rdquo;
                    </p>
                  )}
                </div>
                <div className="my-booking-side">
                  <span className="my-booking-go" aria-hidden="true">
                    <ChevronRight size={18} />
                  </span>
                </div>
              </div>
              {waHref && (
                <div className="my-booking-foot">
                  <span className="my-booking-foot-hint">Enjoyed your meal?</span>
                  <a
                    href={waHref}
                    target="_blank"
                    rel="noreferrer"
                    className="my-booking-review"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MessageCircle size={13} /> Review cook
                  </a>
                </div>
              )}
            </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-state-card">
          <div className="empty-state-icon">
            <CheckCircle2 size={28} />
          </div>
          <h3>No completed sessions yet</h3>
          <p
            style={{
              fontSize: "0.95rem",
              color: "var(--slate-600)",
              marginBottom: "1rem",
            }}
          >
            Your completed sessions and receipts will appear here after your
            first completed session.
          </p>
          <div
            style={{
              display: "flex",
              gap: "0.75rem",
              flexWrap: "wrap",
              marginTop: "1rem",
              justifyContent: "center",
            }}
          >
            <Link to="/cook-on-demand" className="btn btn-primary">
              <Search size={16} /> Book a Cook
            </Link>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomerDashboard;
