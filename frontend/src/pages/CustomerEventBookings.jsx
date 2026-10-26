import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import { useAutoRefresh } from "../hooks/useAutoRefresh";
import { useShowToast } from "../store/hooks";
import API from "../api/axios";
import CookAvatar from "../components/CookAvatar";
import { formatDate, formatTime12 } from "../utils/constants";
import {
  formatCurrency,
  EVENT_SERVICE_LABEL,
  eventPaymentMeta,
  eventStatusLabel,
  eventTypeLabel,
} from "../utils/eventConstants";
import {
  CalendarCheck,
  CalendarDays,
  ChefHat,
  CheckCircle2,
  ChevronRight,
  Clock3,
  CreditCard,
  MapPin,
  PartyPopper,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UtensilsCrossed,
  XCircle,
} from "lucide-react";

const TERMINAL = ["completed", "cancelled"];
const CANCELLABLE = ["pending", "cook_assigned", "confirmed", "in_progress"];

const STATUS_META = {
  pending: { tone: "amber", icon: Clock3, hint: "We're matching a verified cook for your event." },
  cook_assigned: { tone: "blue", icon: ChefHat, hint: "Your cook is assigned - review the details below." },
  confirmed: { tone: "emerald", icon: CheckCircle2, hint: "Your cook is confirmed and your event is locked in." },
  in_progress: { tone: "purple", icon: Sparkles, hint: "Your event is happening now." },
  completed: { tone: "emerald", icon: CheckCircle2, hint: "We hope your celebration was a hit." },
  cancelled: { tone: "rose", icon: XCircle, hint: "This event booking was cancelled." },
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "upcoming", label: "Upcoming" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
];

const parseDate = (value) => {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
};

const daysFromToday = (value) => {
  const date = parseDate(value);
  if (!date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((date.getTime() - today.getTime()) / 86400000);
};

const relativeDay = (value) => {
  const diff = daysFromToday(value);
  if (diff === null) return "";
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff <= 45) return `In ${diff} days`;
  if (diff < -1 && diff >= -45) return `${Math.abs(diff)} days ago`;
  return "";
};

const dateBadge = (value) => {
  const date = parseDate(value);
  if (!date) return { day: "--", month: "---", weekday: "" };
  return {
    day: date.getDate(),
    month: date.toLocaleDateString("en-IN", { month: "short" }),
    weekday: date.toLocaleDateString("en-IN", { weekday: "short" }),
  };
};

const sortUpcoming = (a, b) => {
  const daysA = daysFromToday(a.eventDate);
  const daysB = daysFromToday(b.eventDate);
  const pastA = daysA !== null && daysA < 0;
  const pastB = daysB !== null && daysB < 0;
  if (pastA !== pastB) return pastA ? 1 : -1;
  const dateA = parseDate(a.eventDate)?.getTime() ?? 0;
  const dateB = parseDate(b.eventDate)?.getTime() ?? 0;
  return (
    dateA - dateB ||
    String(a.startTime || "").localeCompare(String(b.startTime || "")) ||
    String(a._id || "").localeCompare(String(b._id || ""))
  );
};

const sortRecent = (a, b) =>
  sortUpcoming(b, a) ||
  new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime();

const CustomerEventBookings = () => {
  const { data, loading, refreshing, error, refetch } = useFetch("/event-bookings/my");
  const [filter, setFilter] = useState("all");
  const [cancellingId, setCancellingId] = useState(null);
  const showToast = useShowToast();
  useAutoRefresh(refetch, { intervalMs: 30000 });

  const bookings = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  const groups = useMemo(() => {
    const upcoming = bookings.filter((b) => !TERMINAL.includes(b.bookingStatus)).sort(sortUpcoming);
    const completed = bookings.filter((b) => b.bookingStatus === "completed").sort(sortRecent);
    const cancelled = bookings.filter((b) => b.bookingStatus === "cancelled").sort(sortRecent);
    return { upcoming, completed, cancelled };
  }, [bookings]);

  const counts = {
    all: bookings.length,
    upcoming: groups.upcoming.length,
    completed: groups.completed.length,
    cancelled: groups.cancelled.length,
  };

  const visible = useMemo(() => {
    if (filter === "upcoming") return groups.upcoming;
    if (filter === "completed") return groups.completed;
    if (filter === "cancelled") return groups.cancelled;
    return [...groups.upcoming, ...groups.completed, ...groups.cancelled];
  }, [filter, groups]);

  const nextUpId = groups.upcoming.find(
    (booking) =>
      booking.bookingStatus !== "in_progress" &&
      (daysFromToday(booking.eventDate) ?? 0) >= 0
  )?._id;

  const handleCancel = async (booking) => {
    if (cancellingId) return;
    const paid = booking.payment?.status === "paid";
    const message =
      booking.bookingStatus === "in_progress"
        ? "This event is marked as in progress. Cancel it anyway?"
        : paid
          ? "Cancel this event booking? A full refund request will be sent to CookMitra for approval."
          : "Cancel this event booking? This cannot be undone.";
    if (!window.confirm(message)) return;
    setCancellingId(booking._id);
    try {
      await API.post(`/event-bookings/${booking._id}/cancel`);
      showToast("Event booking cancelled", "success");
      await refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Could not cancel this booking", "error");
    } finally {
      setCancellingId(null);
    }
  };

  const renderCard = (booking, isNext) => {
    const status = booking.bookingStatus;
    const meta = STATUS_META[status] || STATUS_META.pending;
    const StatusIcon = meta.icon;
    const cook = booking.cookId && typeof booking.cookId === "object" ? booking.cookId : null;
    const payment = booking.payment || {};
    const isPaid = payment.status === "paid";
    const canPay =
      booking.distanceVerified === true &&
      status === "cook_assigned" &&
      !isPaid &&
      Number(booking.totalAmount) > 0;
    const daysAway = daysFromToday(booking.eventDate);
    const canCancel =
      CANCELLABLE.includes(status) &&
      !(status === "in_progress" && isPaid) &&
      (daysAway === null || daysAway >= 0);
    const payMeta = eventPaymentMeta(booking);
    const refundLabel = payMeta.isRefund ? payMeta.label : "";
    const date = dateBadge(booking.eventDate);
    const relative = relativeDay(booking.eventDate);
    const location = booking.address || booking.area || "Venue shared in details";
    const amountLabel = isPaid
      ? "Paid"
      : booking.distanceVerified !== true
        ? "Estimated total"
        : canPay
          ? "Amount due"
          : "Total";
    const amount = isPaid ? payment.paidAmount || booking.totalAmount : booking.totalAmount;
    const pastUnfinished =
      daysAway !== null && daysAway < 0 && !TERMINAL.includes(status);
    const hint =
      pastUnfinished
        ? "This event date has passed. If it wasn't marked complete, please contact support."
        : status === "pending"
        ? "Awaiting cook assignment — no payment is needed yet."
        : status === "cook_assigned" && !cook
          ? "Cook assignment is being finalised."
          : status === "cook_assigned" && !booking.distanceVerified
            ? "Cook assigned. We're verifying the final travel and amount."
            : status === "cook_assigned" && canPay
              ? payment.status === "failed"
                ? "Your last payment failed — retry securely from the booking."
                : "Complete payment to confirm your event."
              : meta.hint;
    const costItems = [
      Number(booking.serviceAmount) > 0 && { label: "Service", value: formatCurrency(booking.serviceAmount) },
      Number(booking.additionalCookAmount) > 0 && { label: "Additional cook", value: formatCurrency(booking.additionalCookAmount) },
      Number(booking.extraHourAmount) > 0 && { label: "Extra hours", value: formatCurrency(booking.extraHourAmount) },
      { label: "Travel", value: Number(booking.travelCharge) > 0 ? formatCurrency(booking.travelCharge) : "Free" },
    ].filter(Boolean);

    return (
      <article
        key={booking._id}
        className={`meb-card${isNext ? " is-next" : ""}`}
        data-status={status}
      >
        <Link
          to={`/event-bookings/${booking._id}`}
          className="meb-card-body"
          aria-label={`Open ${eventTypeLabel(booking)} booking on ${formatDate(booking.eventDate)}`}
        >
          <span className="meb-date" aria-hidden="true">
            <span className="meb-date-day">{date.day}</span>
            <span className="meb-date-month">{date.month}</span>
            <span className="meb-date-weekday">{date.weekday}</span>
          </span>

          <div className="meb-main">
            <div className="meb-title-row">
              <div className="meb-title-wrap">
                {isNext && <span className="meb-next">Next up</span>}
                <h3 className="meb-title">{eventTypeLabel(booking)}</h3>
              </div>
              <div className="meb-badges">
                <span className={`meb-status meb-status--${meta.tone}`}>
                  <StatusIcon size={12} aria-hidden="true" />
                  {eventStatusLabel(status)}
                </span>
                <span className={`meb-pay-chip meb-pay-chip--${payMeta.tone}`}>
                  {payMeta.label}
                </span>
              </div>
            </div>

            <span className="meb-ref-row">
              <span className="meb-ref">{booking.bookingId || "Event booking"}</span>
              <span className="meb-sep" aria-hidden="true" />
              <span>{EVENT_SERVICE_LABEL(booking.serviceType) || "Event service"}</span>
              {booking.guestCount ? (
                <>
                  <span className="meb-sep" aria-hidden="true" />
                  <span>
                    {booking.guestCount} {booking.guestCount === 1 ? "guest" : "guests"}
                  </span>
                </>
              ) : null}
            </span>

            <span className="meb-hint">
              <StatusIcon size={13} aria-hidden="true" />
              {hint}
            </span>

            <span className="meb-chips">
              <span className="meb-chip">
                <CalendarDays size={12} aria-hidden="true" />
                {formatDate(booking.eventDate)}
                {relative ? <em className="meb-chip-note">{relative}</em> : null}
              </span>
              <span className="meb-chip">
                <Clock3 size={12} aria-hidden="true" />
                {formatTime12(booking.startTime) || "Time TBD"}
                {Number(booking.duration) > 0
                  ? ` - ${booking.duration} hr${Number(booking.extraHours) > 0 ? ` + ${booking.extraHours} extra` : ""}`
                  : ""}
              </span>
              <span className="meb-chip meb-chip--venue" title={[booking.address, booking.area].filter(Boolean).join(", ")}>
                <MapPin size={12} aria-hidden="true" />
                <span className="meb-chip-text">{location}</span>
              </span>
              {booking.foodType ? (
                <span className="meb-chip">
                  <UtensilsCrossed size={12} aria-hidden="true" />
                  {booking.foodType}
                </span>
              ) : null}
            </span>

            <span className="meb-costs" aria-label="Price breakdown">
              {costItems.map((item) => (
                <span className="meb-cost" key={item.label}>
                  <span className="meb-cost-label">{item.label}</span>
                  <strong>{item.value}</strong>
                </span>
              ))}
            </span>

            <span className="meb-cook">
              <span className="meb-cook-avatar" aria-hidden="true">
                {cook ? (
                  <CookAvatar
                    photoUrl={cook.photoUrl || cook.avatar}
                    name={cook.name}
                    alt=""
                    fallback={<span>{String(cook.name || "C").charAt(0).toUpperCase()}</span>}
                  />
                ) : (
                  <ChefHat size={15} />
                )}
              </span>
              <span className="meb-cook-text">
                {cook ? (
                  <>
                    <strong>{cook.name}</strong>
                    <span className="meb-cook-tag">
                      <CheckCircle2 size={11} aria-hidden="true" /> Verified cook
                    </span>
                  </>
                ) : status === "pending" ? (
                  <strong>Matching a verified cook...</strong>
                ) : (
                  <strong>No cook assigned</strong>
                )}
              </span>
            </span>
          </div>

          <span className="meb-go" aria-hidden="true">
            <ChevronRight size={18} />
          </span>
        </Link>

        <div className="meb-foot">
          <div className="meb-amount">
            <span className="meb-amount-label">{amountLabel}</span>
            <strong>{formatCurrency(amount)}</strong>
            {isPaid && refundLabel ? (
              <span className="meb-pay-note meb-pay-note--refund">{refundLabel}</span>
            ) : isPaid ? (
              <span className="meb-pay-note meb-pay-note--paid">
                <CheckCircle2 size={11} aria-hidden="true" /> Payment received
              </span>
            ) : payment.status === "failed" ? (
              <span className="meb-pay-note meb-pay-note--failed">
                <XCircle size={11} aria-hidden="true" /> Payment failed — retry from details
              </span>
            ) : booking.distanceVerified !== true && status !== "cancelled" ? (
              <span className="meb-pay-note">Travel charge provisional</span>
            ) : null}
          </div>

          <div className="meb-actions">
            {canPay && (
              <Link
                to={`/event-bookings/${booking._id}/pay`}
                className="btn btn-primary btn-sm meb-action"
              >
                <CreditCard size={14} aria-hidden="true" />
                Pay {formatCurrency(booking.totalAmount)}
              </Link>
            )}
            {status === "completed" && (
              <Link to="/events" className="btn btn-outline btn-sm meb-action">
                <PartyPopper size={14} aria-hidden="true" />
                Book again
              </Link>
            )}
            <Link to={`/event-bookings/${booking._id}`} className="btn btn-outline btn-sm meb-action">
              View details
              <ChevronRight size={14} aria-hidden="true" />
            </Link>
            {canCancel && (
              <button
                type="button"
                className="meb-cancel"
                disabled={cancellingId === booking._id}
                onClick={() => handleCancel(booking)}
              >
                <XCircle size={14} aria-hidden="true" />
                {cancellingId === booking._id ? "Cancelling..." : "Cancel"}
              </button>
            )}
          </div>
        </div>
      </article>
    );
  };

  if (loading) {
    return (
      <div className="dashboard-container my-events-page">
        <div className="od-hero">
          <div className="od-hero-text">
            <span className="od-eyebrow">
              <PartyPopper size={12} /> CookMitra Events
            </span>
            <h1 className="od-title">My Event Bookings</h1>
            <p className="od-sub">
              <ShieldCheck size={13} />
              <span className="od-sub-text">Plan, track and manage your celebrations in one place</span>
            </p>
          </div>
        </div>
        <div className="meb-skeleton-list" aria-hidden="true">
          {[0, 1, 2].map((key) => (
            <div className="meb-skeleton-card" key={key}>
              <span className="meb-skeleton-date" />
              <span className="meb-skeleton-body">
                <span className="meb-skeleton-line meb-skeleton-line--title" />
                <span className="meb-skeleton-line meb-skeleton-line--sub" />
                <span className="meb-skeleton-line meb-skeleton-line--chips" />
              </span>
            </div>
          ))}
        </div>
        <span className="sr-only" role="status">
          Loading your event bookings
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-container my-events-page">
        <div className="od-hero">
          <div className="od-hero-text">
            <span className="od-eyebrow">
              <PartyPopper size={12} /> CookMitra Events
            </span>
            <h1 className="od-title">My Event Bookings</h1>
          </div>
        </div>
        <div className="error-alert-banner" role="alert">
          {error}
        </div>
        <div className="meb-error-actions">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => refetch()}>
            <RefreshCw size={14} /> Try again
          </button>
          <Link to="/events" className="btn btn-outline btn-sm">
            Browse event cooks
          </Link>
        </div>
      </div>
    );
  }

  const emptyCopy =
    bookings.length === 0
      ? {
          title: "Your first celebration starts here",
          text: "Birthdays, anniversaries and family functions - you celebrate, we cook.",
        }
      : filter === "upcoming"
        ? { title: "No upcoming events", text: "Your past celebrations are still available below." }
        : filter === "completed"
          ? { title: "No completed events yet", text: "Completed celebrations will appear here with their details." }
          : filter === "cancelled"
            ? { title: "No cancelled events", text: "You have no cancelled event bookings." }
            : { title: "No event bookings yet", text: "Plan your first celebration with a verified CookMitra cook." };

  return (
    <div className="dashboard-container my-events-page">
      <div className="od-hero">
        <div className="od-hero-text">
          <span className="od-eyebrow">
            <PartyPopper size={12} /> CookMitra Events
          </span>
          <h1 className="od-title">My Event Bookings</h1>
          <p className="od-sub">
            <ShieldCheck size={13} />
            <span className="od-sub-text">
              Plan, track and manage your celebrations - you celebrate, we cook
            </span>
          </p>
          {bookings.length > 0 && (
            <span className="meb-hero-meta">
              <span className="meb-hero-pill">
                <CalendarCheck size={12} aria-hidden="true" />
                {counts.upcoming} upcoming
              </span>
              {counts.completed > 0 && (
                <span className="meb-hero-pill">
                  <CheckCircle2 size={12} aria-hidden="true" />
                  {counts.completed} completed
                </span>
              )}
            </span>
          )}
        </div>
        <Link to="/events" className="btn btn-primary meb-book-btn">
          <CalendarCheck size={16} aria-hidden="true" />
          Book an Event
        </Link>
      </div>

      {bookings.length > 0 && (
        <div className="meb-summary" aria-label="Event booking summary">
          <div className="meb-summary-tile meb-summary-tile--upcoming">
            <span className="meb-summary-icon" aria-hidden="true"><CalendarDays size={17} /></span>
            <span className="meb-summary-copy">
              <strong>{counts.upcoming}</strong>
              <span>Upcoming</span>
            </span>
          </div>
          <div className="meb-summary-tile meb-summary-tile--completed">
            <span className="meb-summary-icon" aria-hidden="true"><CheckCircle2 size={17} /></span>
            <span className="meb-summary-copy">
              <strong>{counts.completed}</strong>
              <span>Completed</span>
            </span>
          </div>
          <div className="meb-summary-tile meb-summary-tile--cancelled">
            <span className="meb-summary-icon" aria-hidden="true"><XCircle size={17} /></span>
            <span className="meb-summary-copy">
              <strong>{counts.cancelled}</strong>
              <span>Cancelled</span>
            </span>
          </div>
          <div className="meb-summary-tile meb-summary-tile--total">
            <span className="meb-summary-icon" aria-hidden="true"><PartyPopper size={17} /></span>
            <span className="meb-summary-copy">
              <strong>{counts.all}</strong>
              <span>Total events</span>
            </span>
          </div>
        </div>
      )}

      {bookings.length === 0 ? (
        <div className="empty-state-card meb-empty">
          <div className="empty-state-icon">
            <PartyPopper size={32} aria-hidden="true" />
          </div>
          <div>
            <h3>{emptyCopy.title}</h3>
            <p>{emptyCopy.text}</p>
          </div>
          <Link to="/events" className="btn btn-primary">
            Explore event cooks
          </Link>
          <p className="meb-empty-note">
            <ShieldCheck size={13} aria-hidden="true" />
            Free to request. Pay only after a cook is assigned and your final amount is verified.
          </p>
        </div>
      ) : (
        <>
          <div className="meb-toolbar">
            <div className="meb-filters" role="group" aria-label="Filter event bookings">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`meb-filter${filter === item.id ? " is-active" : ""}`}
                  aria-pressed={filter === item.id}
                  onClick={() => setFilter(item.id)}
                >
                  {item.label}
                  <span className="meb-filter-count">{counts[item.id]}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="meb-refresh"
              onClick={() => refetch()}
              disabled={refreshing}
              aria-label="Refresh event bookings"
            >
              <RefreshCw size={14} className={refreshing ? "is-spinning" : ""} aria-hidden="true" />
              <span>{refreshing ? "Updating" : "Refresh"}</span>
            </button>
          </div>

          {visible.length === 0 ? (
            <div className="empty-state-card meb-empty meb-empty--filtered">
              <div className="empty-state-icon">
                <CalendarCheck size={28} aria-hidden="true" />
              </div>
              <div>
                <h3>{emptyCopy.title}</h3>
                <p>{emptyCopy.text}</p>
              </div>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setFilter("all")}>
                Show all bookings
              </button>
            </div>
          ) : (
            <div className="meb-list">
              {visible.map((booking) =>
                renderCard(booking, booking._id === nextUpId)
              )}
            </div>
          )}

          <p className="meb-footnote">
            <ShieldCheck size={13} aria-hidden="true" />
            Your booking status updates automatically. Need to make a change? Open a booking to see
            available actions.
          </p>
        </>
      )}
    </div>
  );
};

export default CustomerEventBookings;
