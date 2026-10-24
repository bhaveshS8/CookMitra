import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import { formatTime12 } from "../utils/constants";
import {
  formatCurrency,
  EVENT_SERVICE_LABEL,
  eventPaymentMeta,
  eventStatusLabel,
  eventStatusTone,
  eventTypeLabel,
} from "../utils/eventConstants";
import {
  AlertCircle,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  ChefHat,
  ChevronRight,
  Clock3,
  MapPin,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Users,
  UtensilsCrossed,
  Wallet,
  XCircle,
} from "lucide-react";

const TERMINAL = ["completed", "cancelled"];

const STATUS_META = {
  pending: { icon: Clock3 },
  cook_assigned: { icon: ChefHat },
  confirmed: { icon: CheckCircle2 },
  in_progress: { icon: Sparkles },
  completed: { icon: CheckCircle2 },
  cancelled: { icon: XCircle },
};

const paymentIcon = (meta) => {
  if (meta.isRefund) return RotateCcw;
  if (meta.tone === "emerald") return CheckCircle2;
  if (meta.tone === "rose") return AlertCircle;
  return Clock3;
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

const dateParts = (value) => {
  const date = parseDate(value);
  if (!date) return null;
  return {
    day: date.getDate(),
    month: date.toLocaleDateString("en-IN", { month: "short" }),
    weekday: date.toLocaleDateString("en-IN", { weekday: "short" }),
    full: date.toLocaleDateString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
  };
};

const sortUpcoming = (a, b) => {
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
  new Date(b.updatedAt || b.createdAt || 0).getTime() -
    new Date(a.updatedAt || a.createdAt || 0).getTime();

const venueLabel = (booking) => {
  const address = [booking.address, booking.area]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(", ");
  const landmark = String(booking.landmark || "").trim();
  const landmarkText = landmark
    ? /^near\b/i.test(landmark)
      ? landmark
      : `Near ${landmark}`
    : "";
  return [address, landmarkText].filter(Boolean).join(" · ");
};

const EMPTY_BOOKINGS = [];

const CookEventBookings = () => {
  const { data, loading, refreshing, error, refetch } = useFetch("/event-bookings/cook");
  const [filter, setFilter] = useState("all");
  const bookings = Array.isArray(data) ? data : EMPTY_BOOKINGS;

  const groups = useMemo(() => {
    const upcoming = bookings
      .filter((booking) => !TERMINAL.includes(booking.bookingStatus))
      .sort(sortUpcoming);
    const completed = bookings
      .filter((booking) => booking.bookingStatus === "completed")
      .sort(sortRecent);
    const cancelled = bookings
      .filter((booking) => booking.bookingStatus === "cancelled")
      .sort(sortRecent);
    return { upcoming, completed, cancelled };
  }, [bookings]);

  const counts = {
    all: bookings.length,
    upcoming: groups.upcoming.length,
    completed: groups.completed.length,
    cancelled: groups.cancelled.length,
  };
  const nextUpId = groups.upcoming.find(
    (booking) => booking.bookingStatus !== "in_progress"
  )?._id;

  const earnings = useMemo(
    () =>
      groups.completed.reduce(
        (sum, booking) => sum + Number(booking.totalAmount || 0),
        0
      ),
    [groups.completed]
  );

  if (loading) {
    return (
      <div className="cev" aria-busy="true">
        <div className="cev-stats cev-stats--skeleton" aria-hidden="true">
          {[0, 1, 2, 3].map((key) => (
            <div className="cev-stat cev-skeleton-block" key={key}>
              <span className="cev-skeleton-icon" />
              <span className="cev-skeleton-copy">
                <span className="cev-skeleton-line cev-skeleton-line--value" />
                <span className="cev-skeleton-line cev-skeleton-line--label" />
              </span>
            </div>
          ))}
        </div>
        <div className="cev-skeleton-list" aria-hidden="true">
          {[0, 1, 2].map((key) => (
            <div className="cev-skeleton-card" key={key}>
              <span className="cev-skeleton-date" />
              <span className="cev-skeleton-body">
                <span className="cev-skeleton-line cev-skeleton-line--title" />
                <span className="cev-skeleton-line cev-skeleton-line--sub" />
                <span className="cev-skeleton-line cev-skeleton-line--chips" />
              </span>
            </div>
          ))}
        </div>
        <span className="sr-only" role="status">
          Loading event assignments
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="cev-state cev-state--error" role="alert">
        <span className="cev-state-icon">
          <AlertCircle size={26} />
        </span>
        <h3>Could not load event assignments</h3>
        <p>{error}</p>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => refetch()}>
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    );
  }

  if (bookings.length === 0) {
    return (
      <div className="cev-state cev-state--empty">
        <span className="cev-state-icon">
          <CalendarCheck size={28} />
        </span>
        <h3>No event assignments yet</h3>
        <p>
          When CookMitra assigns you to a birthday, anniversary or family function,
          the full event details will appear here.
        </p>
      </div>
    );
  }

  const renderCard = (booking, isNext = false) => {
    const status = booking.bookingStatus;
    const meta = STATUS_META[status] || { icon: Clock3 };
    const StatusIcon = meta.icon;
    const payment = eventPaymentMeta(booking);
    const PaymentIcon = paymentIcon(payment);
    const distanceVerified = booking.distanceVerified === true;
    const date = dateParts(booking.eventDate);
    const relative = relativeDay(booking.eventDate);
    const time = formatTime12(booking.startTime);
    const duration = Number(booking.duration);
    const extras = Number(booking.extraHours);
    const guests = Number(booking.guestCount);
    const service = EVENT_SERVICE_LABEL(booking.serviceType);
    const extraCooks = Number(booking.additionalCook);
    const venue = venueLabel(booking);
    const customer =
      booking.customerId && typeof booking.customerId === "object"
        ? booking.customerId
        : null;
    const customerPhone = customer?.phone || customer?.mobile || "";
    const customerName = String(customer?.name || "").trim();
    const amount = Number(booking.totalAmount);
    const hasCook = Boolean(booking.cookId);

    const serviceText = [service, extraCooks > 0 ? `+${extraCooks} cook` : ""]
      .filter(Boolean)
      .join(" · ");
    const durationText =
      duration > 0
        ? `${duration} hr${extras > 0 ? ` + ${extras} extra` : ""}`
        : "";

    return (
      <article
        key={booking._id}
        className={`cev-card${isNext ? " is-next" : ""}`}
        data-status={status}
      >
        <div className="cev-card-top">
          <div className="cev-date" aria-hidden="true">
            {date ? (
              <>
                <span className="cev-date-day">{date.day}</span>
                <span className="cev-date-month">{date.month}</span>
                <span className="cev-date-weekday">{date.weekday}</span>
              </>
            ) : (
              <CalendarDays size={20} />
            )}
          </div>

          <div className="cev-main">
            <div className="cev-title-row">
              <div className="cev-title-wrap">
                {isNext && <span className="cev-next">Next up</span>}
                <h3 className="cev-title">{eventTypeLabel(booking)}</h3>
              </div>
              <div className="cev-badges">
                <span className={`badge badge-${eventStatusTone(status)} cev-status`}>
                  <StatusIcon size={12} aria-hidden="true" />
                  {eventStatusLabel(status)}
                </span>
                <span className={`badge badge-${payment.tone} cev-pay`}>
                  <PaymentIcon size={12} aria-hidden="true" />
                  {payment.label}
                </span>
              </div>
            </div>

            <div className="cev-ref-row">
              <span className="cev-ref">{booking.bookingId || "Event booking"}</span>
              {serviceText && (
                <>
                  <span className="cev-sep" aria-hidden="true" />
                  <span className="cev-ref-service">{serviceText}</span>
                </>
              )}
              {guests > 0 && (
                <>
                  <span className="cev-sep" aria-hidden="true" />
                  <span>
                    {guests} {guests === 1 ? "guest" : "guests"}
                  </span>
                </>
              )}
            </div>

            <div className="cev-when">
              <span>
                <CalendarDays size={13} aria-hidden="true" />
                {date?.full || "Date to be confirmed"}
                {relative ? <em className="cev-relative">{relative}</em> : null}
              </span>
              {time && (
                <span>
                  <Clock3 size={13} aria-hidden="true" />
                  {time}
                  {durationText ? ` · ${durationText}` : ""}
                </span>
              )}
            </div>

            {venue && (
              <div className="cev-venue">
                <MapPin size={13} aria-hidden="true" />
                <span>{venue}</span>
              </div>
            )}

            <div className="cev-facts">
              {(customerName || customerPhone) && (
                <div className="cev-fact">
                  <span className="cev-fact-label">
                    <Users size={12} aria-hidden="true" /> Customer
                  </span>
                  <span className="cev-fact-value">
                    {customerName || "Customer"}
                    {customerPhone ? <small>{customerPhone}</small> : null}
                  </span>
                </div>
              )}
              {amount > 0 && (
                <div className="cev-fact cev-fact--amount">
                  <span className="cev-fact-label">
                    <Wallet size={12} aria-hidden="true" /> Event value
                  </span>
                  <span className="cev-fact-value cev-fact-value--amount">
                    {formatCurrency(amount)}
                  </span>
                </div>
              )}
              {booking.menu && (
                <div className="cev-fact cev-fact--wide">
                  <span className="cev-fact-label">
                    <UtensilsCrossed size={12} aria-hidden="true" /> Menu
                    {booking.foodType ? ` · ${booking.foodType}` : ""}
                  </span>
                  <span className="cev-fact-value cev-fact-value--wrap">{booking.menu}</span>
                </div>
              )}
            </div>

            {!distanceVerified && (
              <div className="cev-note cev-note--warning">
                <span className="cev-note-label">Travel charge provisional</span>
                <p>
                  CookMitra is verifying the {booking.distanceKm ?? 0} km travel estimate. The event value may
                  be adjusted before payment.
                </p>
              </div>
            )}

            {booking.customerNotes && (
              <div className="cev-note">
                <span className="cev-note-label">Special instructions</span>
                <p>{booking.customerNotes}</p>
              </div>
            )}
          </div>
        </div>

        <div className="cev-card-foot">
          <span className="cev-assigned">
            <ChefHat size={14} aria-hidden="true" />
            {hasCook ? "Assigned to you" : "Cook assignment pending"}
          </span>
          <Link
            to={`/event-bookings/${booking._id}`}
            className="btn btn-outline btn-sm cev-view"
          >
            View details
            <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </article>
    );
  };

  const renderGroup = (title, items) => {
    if (items.length === 0) return null;
    return (
      <section className="cev-section" aria-label={title}>
        <div className="cev-section-head">
          <h3>{title}</h3>
          <span className="cev-section-count">{items.length}</span>
        </div>
        <div className="cev-list">
          {items.map((booking) => renderCard(booking, booking._id === nextUpId))}
        </div>
      </section>
    );
  };

  const visible = (() => {
    if (filter === "upcoming") return groups.upcoming;
    if (filter === "completed") return groups.completed;
    if (filter === "cancelled") return groups.cancelled;
    return [];
  })();

  const filteredTitle = FILTERS.find((item) => item.id === filter)?.label || "Assignments";
  const emptyFilterCopy =
    filter === "upcoming"
      ? "You have no upcoming event assignments right now."
      : filter === "completed"
        ? "Completed events will appear here once an assignment wraps up."
        : "You have no cancelled event assignments.";

  return (
    <div className="cev">
      <div className="cev-stats" aria-label="Assignment summary">
        <div className="cev-stat cev-stat--upcoming">
          <span className="cev-stat-icon" aria-hidden="true">
            <CalendarDays size={18} />
          </span>
          <span className="cev-stat-copy">
            <strong>{groups.upcoming.length}</strong>
            <span>Upcoming</span>
          </span>
        </div>
        <div className="cev-stat cev-stat--completed">
          <span className="cev-stat-icon" aria-hidden="true">
            <CheckCircle2 size={18} />
          </span>
          <span className="cev-stat-copy">
            <strong>{groups.completed.length}</strong>
            <span>Completed</span>
          </span>
        </div>
        <div className="cev-stat cev-stat--cancelled">
          <span className="cev-stat-icon" aria-hidden="true">
            <XCircle size={18} />
          </span>
          <span className="cev-stat-copy">
            <strong>{groups.cancelled.length}</strong>
            <span>Cancelled</span>
          </span>
        </div>
        <div className="cev-stat cev-stat--earnings">
          <span className="cev-stat-icon" aria-hidden="true">
            <Wallet size={18} />
          </span>
          <span className="cev-stat-copy">
            <strong>{formatCurrency(earnings)}</strong>
            <span>Completed event value</span>
          </span>
        </div>
      </div>

      <div className="cev-toolbar">
        <div className="cev-filters" role="group" aria-label="Filter event assignments">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`cev-filter${filter === item.id ? " is-active" : ""}`}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
              <span className="cev-filter-count">{counts[item.id]}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="cev-refresh"
          onClick={() => refetch()}
          disabled={refreshing}
          aria-label="Refresh event assignments"
        >
          <RefreshCw
            size={14}
            className={refreshing ? "is-spinning" : ""}
            aria-hidden="true"
          />
          <span>{refreshing ? "Updating" : "Refresh"}</span>
        </button>
      </div>

      {filter === "all" ? (
        <>
          {renderGroup("Upcoming", groups.upcoming)}
          {renderGroup("Completed", groups.completed)}
          {renderGroup("Cancelled", groups.cancelled)}
        </>
      ) : visible.length > 0 ? (
        <section className="cev-section" aria-label={filteredTitle}>
          <div className="cev-list">
            {visible.map((booking) => renderCard(booking, booking._id === nextUpId))}
          </div>
        </section>
      ) : (
        <div className="cev-state cev-state--empty cev-state--filtered">
          <span className="cev-state-icon">
            <CalendarCheck size={26} />
          </span>
          <h3>No {filteredTitle.toLowerCase()} assignments</h3>
          <p>{emptyFilterCopy}</p>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setFilter("all")}>
            Show all assignments
          </button>
        </div>
      )}

      <p className="cev-footnote">
        <CalendarCheck size={13} aria-hidden="true" />
        Your assignment status updates automatically. Open a booking for the full event details.
      </p>
    </div>
  );
};

export default CookEventBookings;
