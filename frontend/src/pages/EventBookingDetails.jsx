import { useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useSelector } from "react-redux";
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
  EVENT_STATUS_FLOW,
  EVENT_REFUND_LABELS,
} from "../utils/eventConstants";
import { useShowToast } from "../store/hooks";
import CookAvatar from "../components/CookAvatar";
import {
  AlertCircle,
  CalendarCheck,
  Clock3,
  Users,
  MapPin,
  LocateFixed,
  UtensilsCrossed,
  ChefHat,
  BadgeIndianRupee,
  CheckCircle2,
  XCircle,
  UserCheck,
  CreditCard,
  ShieldCheck,
  PartyPopper,
} from "lucide-react";

const EventBookingDetails = () => {
  const { id } = useParams();
  const user = useSelector((s) => s.auth.user);
  const showToast = useShowToast();
  const { data: booking, loading, error, refetch } = useFetch(id ? `/event-bookings/${id}` : null);
  const status = booking?.bookingStatus || null;
  const isAdmin = user?.role === "admin";
  const assignable = isAdmin && ["pending", "cook_assigned"].includes(status);
  const {
    data: cookList,
    loading: cooksLoading,
    error: cooksError,
    refetch: refetchCooks,
  } = useFetch(assignable ? "/cooks" : null);
  const [cancelling, setCancelling] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignCookId, setAssignCookId] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyKm, setVerifyKm] = useState("");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const verifyLock = useRef(false);
  const [refundBusy, setRefundBusy] = useState("");

  const handleCancel = async () => {
    if (cancelling) return;
    const paid = booking?.payment?.status === "paid";
    const message =
      booking?.bookingStatus === "in_progress"
        ? "This event is marked as in progress. Cancel it anyway?"
        : paid
          ? "Cancel this event booking? A full refund request will be sent to CookMitra for approval."
          : "Cancel this event booking? This cannot be undone.";
    if (!window.confirm(message)) return;
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

  // Admin-only reassignment (opened from a booking-request notification).
  // Customers and cooks never render this panel; the backend authorize
  // gate rejects them regardless.
  const verifiedCooks = (Array.isArray(cookList) ? cookList : []).filter(
    (c) => c.approvalStatus === "approved"
  );

  const handleAssign = async () => {
    if (assignBusy) return;
    if (!assignCookId) {
      showToast("Select a verified cook first", "error");
      return;
    }
    const cookEntry = verifiedCooks.find((c) => String(c?.user?._id || "") === String(assignCookId));
    if (
      !window.confirm(
        `Assign ${cookEntry?.user?.name || "this cook"} to booking ${booking?.bookingId || id}?`
      )
    )
      return;
    setAssignBusy(true);
    try {
      await API.post(`/event-bookings/${id}/assign-cook`, { cookId: assignCookId });
      showToast("Cook assigned — customer and cook notified!", "success");
      setAssigning(false);
      setAssignCookId("");
      refetch();
    } catch (err) {
      if (err.response?.status === 409) refetch();
      showToast(err.response?.data?.message || "Assignment failed", "error");
    } finally {
      setAssignBusy(false);
    }
  };

  const openVerifyDistance = () => {
    setVerifyOpen(true);
    setVerifyKm(String(booking?.distanceKm ?? ""));
    setVerifyError("");
  };

  const closeVerifyDistance = () => {
    if (verifyBusy) return;
    setVerifyOpen(false);
    setVerifyKm("");
    setVerifyError("");
  };

  const handleVerifyDistance = async () => {
    if (verifyLock.current) return;
    const raw = String(verifyKm).trim();
    const distance = Number(raw);
    if (!raw || !Number.isFinite(distance) || distance < 0 || distance > 100000) {
      setVerifyError("Enter a valid distance in km (0–100000).");
      return;
    }
    verifyLock.current = true;
    setVerifyBusy(true);
    setVerifyError("");
    try {
      await API.patch(`/event-bookings/${id}/verify-distance`, { distanceKm: distance });
      setVerifyOpen(false);
      setVerifyKm("");
      showToast("Distance verified — travel charge and final amount updated", "success");
      await refetch();
    } catch (err) {
      const message = err.response?.data?.message || "Distance verification failed. Please try again.";
      setVerifyError(message);
      if (err.response?.status === 409) refetch();
    } finally {
      verifyLock.current = false;
      setVerifyBusy(false);
    }
  };

  const handleReconcileRefund = async () => {
    if (refundBusy) return;
    setRefundBusy("reconcile");
    try {
      const res = await API.post(`/event-payments/admin/refunds/${id}/reconcile`);
      if (res.data?.adopted && res.data?.pending) {
        showToast("Gateway refund is still pending confirmation", "info");
      } else if (res.data?.adopted) {
        showToast("Gateway refund confirmed", "success");
      } else {
        showToast("No gateway refund found — returned to the approval queue", "info");
      }
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Gateway reconciliation failed", "error");
      refetch();
    } finally {
      setRefundBusy("");
    }
  };

  const handleRefund = async (action) => {
    if (refundBusy) return;
    const message =
      action === "approve"
        ? `Approve a full refund of ${formatCurrency(booking?.payment?.refundAmount || booking?.payment?.paidAmount || 0)}?`
        : "Decline this refund request?";
    if (!window.confirm(message)) return;
    const reason = action === "reject"
      ? window.prompt("Reason for declining (optional)") || ""
      : window.prompt("Admin note (optional)") || "";
    setRefundBusy(action);
    try {
      await API.post(
        `/event-payments/admin/refunds/${id}/${action}`,
        action === "approve" ? { note: reason } : { reason }
      );
      showToast(action === "approve" ? "Refund approved" : "Refund declined", "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Refund action failed", "error");
      refetch();
    } finally {
      setRefundBusy("");
    }
  };

  if (loading) {
    return (
      <div className="dashboard-container events-page event-detail-page">
        <div className="event-detail-skeleton" aria-hidden="true">
          <span className="event-detail-skeleton-head" />
          <span className="event-detail-skeleton-line" />
          <span className="event-detail-skeleton-line event-detail-skeleton-line--short" />
          <span className="event-detail-skeleton-block" />
        </div>
        <span className="sr-only" role="status">
          Loading event booking
        </span>
      </div>
    );
  }

  if (error || !booking) {
    return (
      <div className="dashboard-container events-page event-detail-page">
        <div className="event-state event-state--error" role="alert">
          <span className="event-state-icon">
            <AlertCircle size={26} />
          </span>
          <h1>We couldn't load this event</h1>
          <p>{error || "Event booking not found"}</p>
          <div className="event-state-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={refetch}>
              Try again
            </button>
            <Link to="/dashboard/event-bookings" className="btn btn-outline btn-sm">
              Back to my events
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const flowIdx = EVENT_STATUS_FLOW.indexOf(status);
  const cancellable = ["pending", "cook_assigned", "confirmed", "in_progress"].includes(status);
  const currentUserId = user?.id || user?._id;
  const isOwner =
    currentUserId && String(booking.customerId?._id || booking.customerId) === String(currentUserId);
  const payment = booking.payment || {};
  const paymentMeta = eventPaymentMeta(booking);
  const isPaid = payment.status === "paid";
  const canCancel =
    cancellable &&
    !(status === "in_progress" && isPaid) &&
    (user?.role === "admin" || isOwner);
  const distanceVerified = booking.distanceVerified === true;
  const canVerifyDistance = isAdmin && canVerifyEventDistance(booking);
  const payEligible =
    Boolean(booking.cookId) &&
    status === "cook_assigned" &&
    distanceVerified &&
    !isPaid &&
    Number(booking.totalAmount) > 0;
  const canPay = isOwner && payEligible;
  const canReviewRefund =
    isAdmin &&
    isPaid &&
    ["pending", "failed"].includes(payment.refundStatus);
  const canReconcileRefund =
    isAdmin &&
    isPaid &&
    payment.refundStatus === "processing" &&
    !payment.testMode;
  const cook = booking.cookId && typeof booking.cookId === "object" ? booking.cookId : null;
  const cookName = String(cook?.name || "").trim();
  const cookPhone = cook?.phone || cook?.mobile || "";
  const showCookContact = isAdmin || ["confirmed", "in_progress", "completed"].includes(status);
  const cookContact = showCookContact ? (isAdmin ? [cookPhone, cook?.email].filter(Boolean).join(" · ") : cookPhone) : "";
  const customer = booking.customerId && typeof booking.customerId === "object" ? booking.customerId : null;

  const venueText = [booking.address, booking.area].filter(Boolean).join(", ") || "—";
  const eventWhen = [formatDate(booking.eventDate), formatTime12(booking.startTime)]
    .filter(Boolean)
    .join(" · ");
  const rows = [
    {
      icon: <CalendarCheck size={15} />,
      label: "Date & time",
      value: eventWhen,
    },
    {
      icon: <Clock3 size={15} />,
      label: "Duration",
      value: `${booking.duration ?? "—"} hr${Number(booking.extraHours) > 0 ? ` + ${booking.extraHours} extra hr` : ""}`,
    },
    { icon: <Users size={15} />, label: "Guests", value: `${booking.guestCount ?? "—"}` },
    {
      icon: <UtensilsCrossed size={15} />,
      label: `Menu (${booking.foodType || "—"})`,
      value: booking.menu || "—",
    },
    { icon: <ChefHat size={15} />, label: "Service", value: EVENT_SERVICE_LABEL(booking.serviceType) || "—" },
    {
      icon: <MapPin size={15} />,
      label: "Venue",
      value: `${venueText}${booking.landmark ? ` (Near ${booking.landmark})` : ""}`,
    },
    {
      icon: <LocateFixed size={15} />,
      label: "Travel distance",
      value: `${booking.distanceKm ?? 0} km · ${distanceVerified ? "verified" : "provisional estimate"}`,
    },
  ];
  if (isAdmin && (customer?.name || customer?.phone || customer?.mobile)) {
    rows.unshift({
      icon: <Users size={15} />,
      label: "Customer",
      value: [customer?.name, customer?.phone || customer?.mobile].filter(Boolean).join(" · "),
    });
  }

  const cookStatusText =
    !cook
      ? ""
      : status === "cook_assigned"
        ? "Assigned — payment and confirmation are the next steps."
        : status === "confirmed"
          ? "Confirmed for your event."
          : status === "in_progress"
            ? "Your event is in progress."
            : status === "completed"
              ? "Event completed."
              : status === "cancelled"
                ? "This assignment was cancelled."
                : "Assigned to your event.";

  const renderPaymentBody = () => {
    if (isPaid) {
      return (
        <div className="event-pay-state event-pay-state--paid">
          <div className="event-pay-icon">
            <CheckCircle2 size={20} />
          </div>
          <div className="event-pay-copy">
            <strong>Payment received</strong>
            <p>
              {formatCurrency(payment.paidAmount)}
              {payment.paidAt ? ` · ${new Date(payment.paidAt).toLocaleString()}` : ""}
            </p>
            {payment.testMode && <p className="event-pay-hint">Test payment — no real money was moved.</p>}
            {payment.refundStatus && payment.refundStatus !== "none" && (
              <p className="event-pay-hint">
                {EVENT_REFUND_LABELS[payment.refundStatus] || payment.refundStatus}
                {Number(payment.refundAmount) > 0 ? ` — ${formatCurrency(payment.refundAmount)}` : ""}
                {payment.refundReason ? ` (${payment.refundReason})` : ""}
              </p>
            )}
            {payment.refundStatus === "failed" && isAdmin && (
              <p className="event-pay-hint event-pay-hint--danger">
                {payment.refundError || "The gateway refund failed. Retry approval when Razorpay is available."}
              </p>
            )}
          </div>
        </div>
      );
    }

    if (payment.status === "failed") {
      return (
        <div className="event-pay-state event-pay-state--failed">
          <div className="event-pay-icon">
            <XCircle size={20} />
          </div>
          <div className="event-pay-copy">
            <strong>Payment failed</strong>
            <p>No payment is recorded as completed for this event. You can retry securely when ready.</p>
            {canPay && (
              <Link to={`/event-bookings/${id}/pay`} className="btn btn-primary btn-sm event-pay-btn">
                <CreditCard size={15} /> Retry payment {formatCurrency(booking.totalAmount)}
              </Link>
            )}
          </div>
        </div>
      );
    }

    if (!booking.cookId) {
      return (
        <div className="event-pay-state">
          <div className="event-pay-icon">
            <ChefHat size={20} />
          </div>
          <div className="event-pay-copy">
            <strong>Awaiting cook assignment</strong>
            <p>Payment is not open yet. CookMitra will assign a verified cook first, then verify the final amount.</p>
          </div>
        </div>
      );
    }

    if (status === "cook_assigned" && !distanceVerified) {
      return (
        <div className="event-pay-state">
          <div className="event-pay-icon">
            <LocateFixed size={20} />
          </div>
          <div className="event-pay-copy">
            <strong>Distance verification pending</strong>
            <p>
              Your cook is assigned. Payment opens after CookMitra verifies the {booking.distanceKm ?? 0} km travel
              estimate and final amount.
            </p>
          </div>
        </div>
      );
    }

    if (payEligible) {
      return (
        <div className="event-pay-state event-pay-state--ready">
          <div className="event-pay-icon">
            <CreditCard size={20} />
          </div>
          <div className="event-pay-copy">
            <strong>{isOwner ? "Payment ready" : "Payment due from customer"}</strong>
            <p>
              {isOwner
                ? "Your cook and final amount are confirmed. Pay the full amount online to confirm this event."
                : `The customer can pay ${formatCurrency(booking.totalAmount)} once they open the booking.`}
            </p>
            {canPay && (
              <Link to={`/event-bookings/${id}/pay`} className="btn btn-primary btn-sm event-pay-btn">
                <CreditCard size={15} /> Pay {formatCurrency(booking.totalAmount)}
              </Link>
            )}
          </div>
        </div>
      );
    }

    if (status === "cancelled") {
      return (
        <div className="event-pay-state">
          <div className="event-pay-icon">
            <XCircle size={20} />
          </div>
          <div className="event-pay-copy">
            <strong>Booking cancelled</strong>
            <p>No further payment can be made for this event.</p>
          </div>
        </div>
      );
    }

    if (["confirmed", "in_progress", "completed"].includes(status)) {
      return (
        <div className="event-pay-state">
          <div className="event-pay-icon">
            <ShieldCheck size={20} />
          </div>
          <div className="event-pay-copy">
            <strong>No online payment recorded</strong>
            <p>This event is {eventStatusLabel(status).toLowerCase()}. There is no captured online payment for it.</p>
          </div>
        </div>
      );
    }

    return (
      <div className="event-pay-state">
        <div className="event-pay-icon">
          <ShieldCheck size={20} />
        </div>
        <div className="event-pay-copy">
          <strong>Payment not open</strong>
          <p>Payment becomes available after a cook is assigned and the final amount is verified.</p>
        </div>
      </div>
    );
  };

  return (
    <div className="dashboard-container events-page event-detail-page">
      <header className="event-detail-hero">
        <div className="event-detail-hero-main">
          <span className="event-detail-eyebrow">
            <PartyPopper size={13} aria-hidden="true" /> CookMitra Events
          </span>
          <span className="badge badge-festive event-ref-badge">{booking.bookingId || "Event Booking"}</span>
          <h1 className="event-detail-title">{eventTypeLabel(booking)}</h1>
          <p className="event-detail-sub">
            {formatDate(booking.eventDate) || "—"} · {formatTime12(booking.startTime) || "—"} ·{" "}
            {booking.guestCount ?? "—"} guests
          </p>
          <div className="event-detail-hero-stats">
            <span><CalendarCheck size={13} aria-hidden="true" /> {formatDate(booking.eventDate) || "Date TBD"}</span>
            <span><Clock3 size={13} aria-hidden="true" /> {formatTime12(booking.startTime) || "Time TBD"}</span>
            <span><Users size={13} aria-hidden="true" /> {booking.guestCount ?? "—"} guests</span>
            <span><ChefHat size={13} aria-hidden="true" /> {EVENT_SERVICE_LABEL(booking.serviceType) || "Event service"}</span>
          </div>
        </div>
        <div className="event-detail-hero-side">
          <div className="event-detail-badges">
            <span className={`event-status-pill event-status-pill--${eventStatusTone(status)}`}>
              {eventStatusLabel(status)}
            </span>
            <span className={`event-pay-badge event-pay-badge--${paymentMeta.tone}`}>{paymentMeta.label}</span>
          </div>
          <div className="event-detail-hero-total">
            <span>{distanceVerified ? "Final event total" : "Estimated event total"}</span>
            <strong>{formatCurrency(booking.totalAmount)}</strong>
            <em>{distanceVerified ? "Verified" : "Travel pending verification"}</em>
          </div>
        </div>
      </header>

      {status === "pending" && (
        <div className="event-context-box event-context-box--pending">
          {isAdmin
            ? "New booking request — assign a verified cook below to move it to Cook Assigned."
            : "Your booking request has been received. CookMitra will assign a suitable cook based on availability, location and event requirements."}
        </div>
      )}
      {status === "cancelled" && (
        <div className="event-context-box event-context-box--cancelled">
          This event was cancelled. Existing refund status is shown in the payment section.
        </div>
      )}

      {/* Status timeline */}
      <ol className="od-steps-modern event-timeline" aria-label="Booking status">
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

      <div className="event-detail-layout">
        <div className="event-detail-primary">
      <section className="event-panel event-panel--price" aria-labelledby="event-price-heading">
        <div className="event-panel-head">
          <h3 id="event-price-heading">
            <BadgeIndianRupee size={18} /> Price summary
          </h3>
          {distanceVerified ? (
            <span className="event-pay-badge event-pay-badge--emerald">
              <CheckCircle2 size={12} /> Travel verified
            </span>
          ) : (
            <span className="event-pay-badge event-pay-badge--amber">Travel provisional</span>
          )}
        </div>
        <ul className="event-price-list">
          <li className="event-price-row">
            <span>Service</span>
            <strong>{formatCurrency(booking.serviceAmount)}</strong>
          </li>
          {Number(booking.additionalCookAmount) > 0 && (
            <li className="event-price-row">
              <span>Additional cook</span>
              <strong>{formatCurrency(booking.additionalCookAmount)}</strong>
            </li>
          )}
          {Number(booking.extraHourAmount) > 0 && (
            <li className="event-price-row">
              <span>Extra hours</span>
              <strong>{formatCurrency(booking.extraHourAmount)}</strong>
            </li>
          )}
          <li className={`event-price-row${Number(booking.travelCharge) > 0 ? "" : " is-free"}`}>
            <span>Travel · {booking.distanceKm ?? 0} km</span>
            <strong>{Number(booking.travelCharge) > 0 ? formatCurrency(booking.travelCharge) : "FREE"}</strong>
          </li>
        </ul>
        <div className="event-total-row">
          <span>
            <BadgeIndianRupee size={17} aria-hidden="true" />{" "}
            {distanceVerified ? "Final total" : "Estimated total"}
          </span>
          <strong>{formatCurrency(booking.totalAmount)}</strong>
        </div>
        {distanceVerified ? (
          <p className="event-verify-note">
            <CheckCircle2 size={14} aria-hidden="true" />
            Travel verified at {booking.distanceKm ?? 0} km — final travel charge and total are confirmed.
          </p>
        ) : (
          <p className="event-estimate-note">
            Travel charge is provisional — an admin verifies the distance ({booking.distanceKm ?? 0} km estimate)
            before final billing.
          </p>
        )}
      </section>

      {canVerifyDistance && (
        <section className="event-panel event-verify-panel" aria-labelledby="event-verify-heading">
          <div className="event-panel-head">
            <h3 id="event-verify-heading">
              <LocateFixed size={18} /> Verify distance &amp; finalize amount
            </h3>
            <span className="event-pay-badge event-pay-badge--amber">
              <Clock3 size={12} /> Pending
            </span>
          </div>

          <div className="event-verify-grid">
            <div className="event-verify-fact event-verify-fact--wide">
              <span>Customer venue</span>
              <strong>
                {venueText}
                {booking.landmark ? ` · Near ${booking.landmark}` : ""}
              </strong>
            </div>
            <div className="event-verify-fact">
              <span>Assigned cook</span>
              <strong>{cookName || "Assigned cook"}</strong>
            </div>
            <div className="event-verify-fact">
              <span>Provisional distance</span>
              <strong>{booking.distanceKm ?? 0} km</strong>
            </div>
            <div className="event-verify-fact">
              <span>Provisional travel charge</span>
              <strong>
                {Number(booking.travelCharge) > 0 ? formatCurrency(booking.travelCharge) : "FREE"}
              </strong>
            </div>
            <div className="event-verify-fact event-verify-fact--total">
              <span>Current estimated total</span>
              <strong>{formatCurrency(booking.totalAmount)}</strong>
            </div>
          </div>

          {verifyOpen ? (
            <div className="event-verify-confirm">
              <div className="form-group event-verify-field">
                <label htmlFor={`verify-distance-${id}`}>Verified distance (km)</label>
                <input
                  id={`verify-distance-${id}`}
                  type="number"
                  min={0}
                  max={100000}
                  step="0.1"
                  className="form-control"
                  value={verifyKm}
                  onChange={(e) => {
                    setVerifyKm(e.target.value);
                    if (verifyError) setVerifyError("");
                  }}
                  disabled={verifyBusy}
                  autoFocus
                />
              </div>
              <p className="event-verify-help">
                Confirm the measured travel distance. The server recalculates the travel charge from the current
                pricing table and derives the final total from the stored price snapshot. Customer payment stays
                locked until this verification succeeds.
              </p>
              {verifyError && (
                <div className="event-inline-note event-inline-note--error" role="alert">
                  <AlertCircle size={15} aria-hidden="true" />
                  <span>{verifyError}</span>
                </div>
              )}
              <div className="event-verify-actions">
                <button
                  type="button"
                  className="btn btn-success btn-sm"
                  disabled={verifyBusy}
                  onClick={handleVerifyDistance}
                >
                  <CheckCircle2 size={15} aria-hidden="true" />{" "}
                  {verifyBusy ? "Verifying…" : "Confirm & finalize amount"}
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  disabled={verifyBusy}
                  onClick={closeVerifyDistance}
                >
                  <XCircle size={15} aria-hidden="true" /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="event-verify-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={openVerifyDistance}>
                <LocateFixed size={15} aria-hidden="true" /> Verify distance &amp; finalize amount
              </button>
            </div>
          )}
        </section>
      )}

      <section className="event-panel" aria-labelledby="event-payment-heading">
        <div className="event-panel-head">
          <h3 id="event-payment-heading">
            <CreditCard size={18} /> Payment
          </h3>
          <span className={`event-pay-badge event-pay-badge--${paymentMeta.tone}`}>{paymentMeta.label}</span>
        </div>
        {renderPaymentBody()}
        {canReviewRefund && (
          <div className="event-pay-actions">
            <button
              type="button"
              className="btn btn-success btn-sm"
              disabled={Boolean(refundBusy)}
              onClick={() => handleRefund("approve")}
            >
              <CheckCircle2 size={15} /> {refundBusy === "approve" ? "Approving..." : "Approve full refund"}
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              disabled={Boolean(refundBusy)}
              onClick={() => handleRefund("reject")}
            >
              <XCircle size={15} /> {refundBusy === "reject" ? "Declining..." : "Decline refund"}
            </button>
          </div>
        )}
        {canReconcileRefund && (
          <div className="event-pay-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={Boolean(refundBusy)}
              onClick={handleReconcileRefund}
            >
              <CheckCircle2 size={15} /> {refundBusy === "reconcile" ? "Checking..." : "Check gateway refund"}
            </button>
          </div>
        )}
      </section>
        </div>

        <aside className="event-detail-secondary">
      <div className="booking-metadata-grid event-meta-grid">
        {rows.map((r) => (
          <div className="meta-field" key={r.label}>
            <label>
              {r.icon} {r.label}
            </label>
            <span>{r.value}</span>
          </div>
        ))}
        {booking.customerNotes && (
          <div className="meta-field meta-field--wide">
            <label>Special instructions</label>
            <span>{booking.customerNotes}</span>
          </div>
        )}
      </div>

      {/* Assigned cook (§11) */}
      <section className="event-panel" aria-labelledby="event-cook-heading">
        <div className="event-panel-head">
          <h3 id="event-cook-heading">
            <ChefHat size={18} /> Assigned cook
          </h3>
          {cook ? (
            <span className="event-pay-badge event-pay-badge--emerald">
              <CheckCircle2 size={12} /> Assigned
            </span>
          ) : (
            <span className="event-pay-badge event-pay-badge--amber">
              <Clock3 size={12} /> Awaiting assignment
            </span>
          )}
        </div>

        {cook ? (
          <div className="event-cook-profile">
            <span className="event-cook-avatar" aria-hidden="true">
              <CookAvatar
                photoUrl={cook.avatar || cook.photoUrl}
                name={cookName}
                alt=""
                fallback={<span>{String(cookName || "C").charAt(0).toUpperCase()}</span>}
              />
            </span>
            <div className="event-cook-info">
              <strong className="event-cook-name">{cookName || "Assigned cook"}</strong>
              {cookContact ? (
                <span className="event-cook-contact">{cookContact}</span>
              ) : (
                <span className="event-cook-contact">
                  {isAdmin ? "Contact details not available" : "Contact details shared after confirmation"}
                </span>
              )}
              <span className="event-cook-status">
                <CheckCircle2 size={13} /> {cookStatusText}
              </span>
            </div>
          </div>
        ) : (
          <div className="event-inline-state">
            <Clock3 size={16} />
            <div>
              <strong>Cook assignment in progress</strong>
              <p>
                {isAdmin
                  ? "No cook is assigned yet — pick a verified cook below."
                  : "CookMitra is finding a suitable verified cook for your event. You will be notified once assigned."}
              </p>
            </div>
          </div>
        )}

        {assignable &&
          (assigning ? (
            <div className="event-assign-panel">
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
                  No verified cooks are available right now. Retry after a cook is approved.
                </p>
              ) : (
                <div className="form-group event-assign-field">
                  <label htmlFor={`assign-cook-${id}`}>Verified cook</label>
                  <select
                    id={`assign-cook-${id}`}
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
              <div className="event-assign-actions">
                <button
                  type="button"
                  className="btn btn-success btn-sm"
                  disabled={assignBusy || cooksLoading || Boolean(cooksError) || verifiedCooks.length === 0}
                  onClick={handleAssign}
                >
                  <CheckCircle2 size={15} aria-hidden="true" /> {assignBusy ? "Assigning…" : "Confirm assign"}
                </button>
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    setAssigning(false);
                    setAssignCookId("");
                  }}
                >
                  <XCircle size={15} aria-hidden="true" /> Close
                </button>
              </div>
            </div>
          ) : (
            <div className="event-assign-cta">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setAssigning(true);
                  setAssignCookId(cook ? String(cook._id) : "");
                }}
              >
                <UserCheck size={15} aria-hidden="true" /> {cook ? "Reassign cook" : "Assign cook"}
              </button>
            </div>
          ))}
      </section>

      <div className="booking-actions-row event-detail-actions">
        {canCancel && (
          <button className="btn btn-danger-outline btn-sm" onClick={handleCancel} disabled={cancelling}>
            <XCircle size={15} /> {cancelling ? "Cancelling..." : "Cancel booking"}
          </button>
        )}
        {isAdmin ? (
          <Link to="/admin" className="btn btn-outline btn-sm">
            Back to admin
          </Link>
        ) : (
          <Link to="/dashboard/event-bookings" className="btn btn-outline btn-sm">
            My event bookings
          </Link>
        )}
        <Link to="/events" className="btn btn-outline btn-sm">
          Book another event
        </Link>
      </div>
        </aside>
      </div>
    </div>
  );
};

export default EventBookingDetails;
