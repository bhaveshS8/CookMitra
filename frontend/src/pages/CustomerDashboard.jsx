import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import { formatDate, formatTimeRange12, formatCurrency } from "../utils/constants";
import { buildRetryState } from "../utils/bookingRetry";
import CookAvatar from "../components/CookAvatar";
import {
  Calendar,
  CalendarCheck,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  IndianRupee,
  KeyRound,
  MessageCircle,
  Phone,
  Search,
  ShieldCheck,
  Star,
  Users,
  UtensilsCrossed,
  Wallet,
  XCircle,
} from "lucide-react";

const prettyService = (s) =>
  String(s || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

// Bookings that still need the customer's attention or are coming up — the
// ones that were previously invisible (a "pay within 5 minutes" booking used
// to have no home in the app, so it silently expired).
const ACTIVE_STATUSES = ["requested", "accepted", "confirmed", "in_progress"];
const UNATTENDED_STATUSES = ["unattended"];
// Action line under the status badge. `confirmed` is deliberately absent: the
// emerald "Confirmed" badge already states it, so "Confirmed — paid" was
// redundant noise on the customer's own card.
const ACTION_FOR = {
  requested: { label: "Waiting for the cook to respond" },
  accepted: { label: "Accepted — payment needed" },
  in_progress: { label: "Session live" },
};

const CustomerDashboard = () => {
  // F-07: surface fetch failures as an error state with retry — a failed
  // /bookings/my must never render as a misleading "no bookings" empty page.
  const { data: bookings, loading, error, refetch } = useFetch("/bookings/my");
  const navigate = useNavigate();

  // Only completed meals live in the main list — newer bookings first.
  const byNewest = (a, b) =>
    new Date(b?.createdAt).getTime() - new Date(a?.createdAt).getTime() ||
    String(b._id || "").localeCompare(String(a._id || ""));
  const completedBookings = (bookings?.filter((b) => b.status === "completed") || []).sort(byNewest);
  // Active & upcoming first (soonest service date on top) — this is where a
  // customer finds a booking that is waiting on payment or confirmation.
  const bySoonest = (a, b) =>
    new Date(a?.date).getTime() - new Date(b?.date).getTime() ||
    String(a.startTime || "").localeCompare(String(b.startTime || ""));
  const activeBookings = (bookings?.filter((b) => ACTIVE_STATUSES.includes(b.status)) || []).sort(bySoonest);
  // Requests that expired within the last 10 minutes (cook didn't respond) —
  // kept visible so the customer can find another cook on the same slot
  // instead of losing the flow. The server drops them once the grace passes.
  const expiredBookings = (bookings?.filter((b) => b.status === "expired") || []).sort(byNewest);
  // Cancelled bookings stay visible with their tag so the customer keeps the
  // history (what was called off, and whether a refund followed).
  const cancelledBookings = (bookings?.filter((b) => b.status === "cancelled") || []).sort(byNewest);
  // Rejected bookings must NOT disappear (P1-10): the cook declined, so the
  // customer keeps the record, the reason where permitted, and a retry path.
  const rejectedBookings = (bookings?.filter((b) => b.status === "rejected") || []).sort(byNewest);
  // Unattended: cook never showed up after service hours passed
  const unattendedBookings = (bookings?.filter((b) => UNATTENDED_STATUSES.includes(b.status)) || []).sort(byNewest);

  // "Find another cook" from an expired card: carry the same plan + slot,
  // minus the cook who didn't respond (same snapshot the waiting screen uses).
  const retryAnotherCook = (booking) =>
    navigate("/cook-on-demand", {
      state: { retryFromBooking: buildRetryState(booking) },
    });

  // "Copied" feedback for the tap-to-copy OTP pill (one at a time).
  const [copiedOtpId, setCopiedOtpId] = useState(null);
  const copyOtp = async (booking) => {
    const code = String(booking.serviceOtp || "");
    if (!code) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const ta = document.createElement("textarea");
        ta.value = code;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopiedOtpId(booking._id);
      setTimeout(() => {
        setCopiedOtpId((id) => (id === booking._id ? null : id));
      }, 1600);
    } catch {
      // Clipboard unavailable — the code itself stays visible on the card.
    }
  };

  // Short dish summary for the compact active cards.
  const dishLabel = (dishes) =>
    dishes.length <= 3
      ? dishes.join(" · ")
      : `${dishes.slice(0, 3).join(" · ")} +${dishes.length - 3} more`;

  // Quick-info strip on every booking card: service-start OTP (only while it
  // is still usable — mirrors the details page), tap-to-call the cook, and
  // the ordered dishes. Renders nothing when there is nothing to show.
  // Unified active cards already render dishes as chips, so they pass
  // hideDishes to avoid showing them twice.
  const quickRow = (booking, hideDishes = false) => {
    const dishes = booking.selectedItems || [];
    const showOtp =
      ["accepted", "confirmed", "in_progress"].includes(booking.status) &&
      booking.serviceOtp &&
      !booking.serviceStartedAt;
    const phone = booking.cook?.phone;
    const showDishes = !hideDishes && dishes.length > 0;
    if (!showOtp && !phone && !showDishes) return null;
    return (
      <span className="my-quick">
        {showOtp && (
          <button
            type="button"
            className="my-qpill my-qotp"
            onClick={(e) => {
              e.stopPropagation();
              copyOtp(booking);
            }}
            title="Tap to copy your service-start code"
            aria-label={`Copy service start code ${booking.serviceOtp}`}
          >
            <KeyRound size={12} />
            <span className="my-qotp-label">OTP</span>
            <code>{booking.serviceOtp}</code>
            {copiedOtpId === booking._id ? <Check size={12} /> : <Copy size={12} />}
          </button>
        )}
        {phone && (
          <a
            href={`tel:${phone}`}
            className="my-qpill my-qcall"
            onClick={(e) => e.stopPropagation()}
            aria-label={`Call ${booking.cook?.name || "cook"}`}
          >
            <Phone size={12} /> Call cook
          </a>
        )}
        {dishes.length > 0 && !hideDishes && (
          <span className="my-qpill my-qdish" title={dishes.join(", ")}>
            <UtensilsCrossed size={12} /> {dishLabel(dishes)}
          </span>
        )}
      </span>
    );
  };

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

  // Status pill language for the unified cards (completed uses Done).
  const STATUS_PILL = {
    requested: "badge-amber",
    accepted: "badge-blue",
    confirmed: "badge-emerald",
    in_progress: "badge-purple",
    expired: "badge-slate",
    cancelled: "badge-rose",
    rejected: "badge-rose",
    unattended: "badge-rose",
  };
  const STATUS_LABEL = {
    requested: "Requested",
    accepted: "Accepted",
    confirmed: "Confirmed",
    in_progress: "Live",
    expired: "Expired",
    cancelled: "Cancelled",
    rejected: "Declined",
    unattended: "Unattended",
  };

  // Unified booking card: the exact completed-session skeleton (cook avatar +
  // name, status pill, service/date/time/ref row, info + dish chips, notes,
  // OTP/call strip, chevron, action footer) for Active/Expired/Unattended/
  // Cancelled/Declined rows — keeping each row's own action line and CTA.
  const renderActiveCard = (booking, { actionIcon: ActionIcon, actionTitle, footHint, cta }) => {
    const cookName = booking.cook?.name || "Your cook";
    const initial = (cookName || "C").charAt(0).toUpperCase();
    const ref = booking._id?.substring(18).toUpperCase();
    const dishes = booking.selectedItems || [];
    const amount = booking.payment?.paidAmount || booking.amount;
    return (
      <article
        key={booking._id}
        className="booking-item-card booking-card-modern my-booking-card"
        data-status={booking.status}
        onClick={(e) => openBooking(e, booking._id)}
        onKeyDown={(e) => openBookingKey(e, booking._id)}
        role="button"
        tabIndex={0}
        aria-label={`${actionTitle || STATUS_LABEL[booking.status] || booking.status}: ${prettyService(booking.serviceType)} on ${formatDate(booking.date)}`}
      >
        <div className="my-booking-main">
          <div className="my-booking-avatar" aria-hidden="true">
            <CookAvatar
              photoUrl={booking.cook?.photoUrl}
              name={cookName}
              alt=""
              fallback={<span className="my-booking-avatar-fallback">{initial}</span>}
            />
          </div>
          <div className="my-booking-body">
            <div className="my-booking-title-row">
              <h3 className="my-booking-cook">{cookName}</h3>
              <span className={`badge ${STATUS_PILL[booking.status] || "badge-slate"} my-booking-status`}>
                {STATUS_LABEL[booking.status] || booking.status}
              </span>
            </div>
            {actionTitle ? (
              <p className="my-booking-action">
                <ActionIcon size={14} /> {actionTitle}
              </p>
            ) : null}
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
                {formatTimeRange12(booking.startTime, booking.endTime, "-")}
              </span>
              {ref && <span className="my-booking-ref">#{ref}</span>}
            </p>
            <div className="my-booking-chips">
              {amount ? (
                <span className="my-chip my-chip-price">
                  <IndianRupee size={11} /> {formatCurrency(amount)}
                </span>
              ) : null}
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
              {dishes.map((item, i) => (
                <span key={i} className="my-chip my-chip-dish">
                  {item}
                </span>
              ))}
            </div>
            {booking.rejectionReason && (
              <p className="my-booking-note">Cook&apos;s reason: {booking.rejectionReason}</p>
            )}
            {booking.notes && (
              <p className="my-booking-note" title={booking.notes}>
                &ldquo;{booking.notes}&rdquo;
              </p>
            )}
            {quickRow(booking, true)}
          </div>
          <div className="my-booking-side">
            <span className="my-booking-go" aria-hidden="true">
              <ChevronRight size={18} />
            </span>
          </div>
        </div>
        {(footHint || cta) && (
          <div className="my-booking-foot">
            {footHint && <span className="my-booking-foot-hint">{footHint}</span>}
            {cta}
          </div>
        )}
      </article>
    );
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

  if (error) {
    return (
      <div className="dashboard-container my-bookings-page">
        <div className="od-hero">
          <div className="od-hero-text">
            <h1 className="od-title">My Bookings</h1>
          </div>
        </div>
        <div className="error-alert-banner" role="alert">
          {error}
        </div>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => refetch()}
          style={{ marginTop: "0.75rem" }}
        >
          Try again
        </button>
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

      {activeBookings.length > 0 && (
        <section className="my-active-section" aria-label="Active and upcoming bookings">
          <h2 className="my-section-title">
            <Clock3 size={17} /> Active &amp; upcoming
            <span className="my-section-count">{activeBookings.length}</span>
          </h2>
          <div className="bookings-list-modern my-bookings-list my-active-list">
            {activeBookings.map((booking) => {
              // No entry (e.g. confirmed) => no action line at all.
              const action = ACTION_FOR[booking.status] || {};
              const needsPayment = booking.status === "accepted";
              return renderActiveCard(booking, {
                actionIcon: needsPayment ? Wallet : booking.status === "requested" ? Clock3 : Calendar,
                actionTitle: needsPayment ? "Complete your payment" : action.label,
                footHint: needsPayment ? "Complete payment to confirm your slot." : null,
                cta: needsPayment ? (
                  <Link
                    to={`/bookings/${booking._id}/pay`}
                    className="btn btn-primary btn-sm my-active-cta"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Wallet size={14} /> Pay now
                  </Link>
                ) : null,
              });
            })}
          </div>
        </section>
      )}

      {expiredBookings.length > 0 && (
        <section className="my-active-section" aria-label="Expired requests — find another cook">
          <h2 className="my-section-title">
            <XCircle size={17} /> Time&apos;s up — find another cook
            <span className="my-section-count">{expiredBookings.length}</span>
          </h2>
          <div className="bookings-list-modern my-bookings-list my-active-list">
            {expiredBookings.map((booking) =>
              renderActiveCard(booking, {
                actionIcon: XCircle,
                actionTitle: "No response from cook",
                footHint: "The cook didn't respond in time.",
                cta: (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm my-active-cta"
                    onClick={(e) => {
                      e.stopPropagation();
                      retryAnotherCook(booking);
                    }}
                  >
                    <Search size={14} /> Find another cook
                  </button>
                ),
              })
            )}
          </div>
        </section>
      )}

      {unattendedBookings.length > 0 && (
        <section className="my-active-section" aria-label="Unattended bookings">
          <h2 className="my-section-title">
            <XCircle size={17} /> Unattended
            <span className="my-section-count">{unattendedBookings.length}</span>
          </h2>
          <div className="bookings-list-modern my-bookings-list my-active-list">
            {unattendedBookings.map((booking) =>
              renderActiveCard(booking, {
                actionIcon: XCircle,
                actionTitle: "Cook did not attend",
                footHint: null,
                cta: null,
              })
            )}
          </div>
        </section>
      )}

      {cancelledBookings.length > 0 && (
        <section className="my-active-section" aria-label="Cancelled bookings">
          <h2 className="my-section-title">
            <XCircle size={17} /> Cancelled
            <span className="my-section-count">{cancelledBookings.length}</span>
          </h2>
          <div className="bookings-list-modern my-bookings-list my-active-list">
            {cancelledBookings.map((booking) =>
              // The status badge already says "Cancelled" — no second
              // cancelled line on the card.
              renderActiveCard(booking, {
                actionIcon: XCircle,
                actionTitle: null,
                footHint: null,
                cta: null,
              })
            )}
          </div>
        </section>
      )}

      {rejectedBookings.length > 0 && (
        <section className="my-active-section" aria-label="Declined bookings">
          <h2 className="my-section-title">
            <XCircle size={17} /> Declined by cook
            <span className="my-section-count">{rejectedBookings.length}</span>
          </h2>
          <div className="bookings-list-modern my-bookings-list my-active-list">
            {rejectedBookings.map((booking) =>
              renderActiveCard(booking, {
                actionIcon: XCircle,
                actionTitle: `Declined by ${booking.cook?.name || "cook"}`,
                footHint: "Try another cook for the same slot.",
                cta: (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm my-active-cta"
                    onClick={(e) => {
                      e.stopPropagation();
                      retryAnotherCook(booking);
                    }}
                  >
                    <Search size={14} /> Find another cook
                  </button>
                ),
              })
            )}
          </div>
        </section>
      )}

      {completedBookings.length > 0 ? (
        <section className="my-active-section" aria-label="Completed sessions">
          <h2 className="my-section-title">
            <CheckCircle2 size={17} /> Completed sessions
            <span className="my-section-count">{completedBookings.length}</span>
          </h2>
          <div className="bookings-list-modern my-bookings-list">
          {completedBookings.map((booking) => {
            const cookName = booking.cook?.name || "Completed Session";
            const initial = (cookName || "C").charAt(0).toUpperCase();
            const ref = booking._id?.substring(18).toUpperCase();
            const dishes = booking.selectedItems || [];
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
                  <CookAvatar
                    photoUrl={booking.cook?.photoUrl}
                    name={cookName}
                    alt=""
                    fallback={<span className="my-booking-avatar-fallback">{initial}</span>}
                  />
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
                      {formatTimeRange12(booking.startTime, booking.endTime, "-")}
                    </span>
                    {ref && <span className="my-booking-ref">#{ref}</span>}
                  </p>
                  <div className="my-booking-chips">
                    {booking.payment?.status === "paid" && (booking.payment.paidAmount || booking.amount) ? (
                      <span className="my-chip my-chip-price">
                        <IndianRupee size={11} /> {formatCurrency(booking.payment.paidAmount || booking.amount)}
                      </span>
                    ) : null}
                    {booking.review?.rating ? (
                      <span className="my-chip my-chip-rating">
                        <Star size={11} /> {Number(booking.review.rating).toFixed(1)}
                      </span>
                    ) : null}
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
                    {dishes.map((item, i) => (
                      <span key={i} className="my-chip my-chip-dish">
                        {item}
                      </span>
                    ))}
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
                  <span className="my-booking-foot-hint">
                    {booking.review?.rating ? (
                      <>
                        <Star size={13} style={{ display: "inline", verticalAlign: "-2px" }} /> You rated this
                        session {Number(booking.review.rating).toFixed(1)}/5 — thank you!
                      </>
                    ) : (
                      "Enjoyed your meal?"
                    )}
                  </span>
                  {!booking.review?.rating && (
                    <a
                      href={waHref}
                      target="_blank"
                      rel="noreferrer"
                      className="my-booking-review"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MessageCircle size={13} /> Review cook
                    </a>
                  )}
                  {booking.cook?.phone && (
                    <a
                      href={`tel:${booking.cook.phone}`}
                      className="my-booking-call"
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Call ${booking.cook?.name || "cook"}`}
                    >
                      <Phone size={13} /> Call cook
                    </a>
                  )}
                </div>
              )}
            </article>
            );
          })}
          </div>
        </section>
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
