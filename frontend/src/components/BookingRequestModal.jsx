import React, { useEffect, useRef, useState } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate, formatTimeRange12 } from "../utils/constants";
import {
  X,
  Check,
  CalendarDays,
  Clock,
  MapPin,
  Users,
  UtensilsCrossed,
  Timer,
  TimerOff,
  AlertCircle,
  CalendarCheck,
} from "lucide-react";

// Cook's/admin's "Respond to Request" dialog for a `requested` booking. Shows
// the job summary and lets the cook (or an admin acting on the cook's behalf)
// accept or decline in place (PATCH /bookings/:id/accept|reject). On success
// it notifies the parent via onAction (list refetch) and closes itself.
// Props: open, onClose, booking, onAction, onBehalf (admin copy variant).
const BookingRequestModal = ({ open, booking, onClose, onAction, onBehalf }) => {
  const showToast = useShowToast();
  const [acting, setActing] = useState(null); // "accept" | "reject" | null
  const [error, setError] = useState("");
  // Focus handling (Phase 17): move keyboard focus into the dialog on open so
  // screen-reader and keyboard users land on the primary action; Escape still
  // closes (wired below) and focus returns naturally on unmount.
  const acceptBtnRef = useRef(null);
  // Live 5-minute countdown, ticked while the dialog is open.
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    if (open) {
      setActing(null);
      setError("");
      setNowMs(Date.now());
      const t = setTimeout(() => acceptBtnRef.current?.focus(), 60);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open, booking?._id]);

  useEffect(() => {
    if (!open) return undefined;
    const iv = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape" && !acting) onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose, acting]);

  const expiresMs = booking?.requestExpiresAt
    ? new Date(booking.requestExpiresAt).getTime()
    : null;
  const remainingMs =
    open && expiresMs != null && Number.isFinite(expiresMs) ? expiresMs - nowMs : null;
  const expired = remainingMs != null && remainingMs <= 0;
  const urgent = remainingMs != null && remainingMs > 0 && remainingMs < 60000;

  // The window lapsed while the dialog sat open: give the parent a beat to
  // show the expired state, then advance (refetch + next queued request).
  // Callbacks ride refs so parent re-renders can't keep resetting the timer.
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open || !expired) return undefined;
    const t = setTimeout(() => {
      actionRef.current?.();
      closeRef.current?.();
    }, 1800);
    return () => clearTimeout(t);
  }, [open, expired]);

  if (!open) return null;

  const handleAction = async (action) => {
    if (acting || !booking?._id) return;
    setActing(action);
    setError("");
    try {
      await API.patch(`/bookings/${booking._id}/${action}`);
      showToast(
        action === "accept"
          ? onBehalf
            ? "Accepted on behalf of the cook — the customer has 5 minutes to pay."
            : "Booking accepted — the customer has 5 minutes to pay."
          : onBehalf
          ? "Request declined on behalf of the cook."
          : "Booking declined.",
        action === "reject" ? "info" : "success"
      );
      onAction?.();
      onClose();
    } catch (err) {
      const msg = err.response?.data?.message || `Failed to ${action} booking`;
      setError(msg);
      showToast(msg, "error");
      // The request died meanwhile (expired / slot taken) — close up and let
      // the parent refetch + advance to the next waiting request instead of
      // stranding a dead dialog.
      if (err.response?.status === 410 || err.response?.status === 409) {
        onAction?.();
        onClose();
      }
    } finally {
      setActing(null);
    }
  };

  const serviceLabel = String(booking?.serviceType || "Home cooking").replace(/_/g, " ");
  const dishes = booking?.selectedItems || [];
  const totalSecs = remainingMs != null ? Math.max(0, Math.ceil(remainingMs / 1000)) : null;
  const clockText =
    totalSecs != null
      ? `${Math.floor(totalSecs / 60)}:${String(totalSecs % 60).padStart(2, "0")}`
      : null;

  const busy = !!acting || expired;

  return (
    <div className="login-modal-overlay" onClick={() => !busy && onClose()}>
      <div
        className="brm-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="booking-request-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="login-modal-close"
          onClick={() => !busy && onClose()}
          aria-label="Close"
          disabled={busy}
        >
          <X size={20} />
        </button>

        <div className="brm-head">
          <span className="brm-icon" aria-hidden="true">
            <CalendarCheck size={22} />
          </span>
          <div className="brm-head-text">
            <h3 id="booking-request-title">{onBehalf ? "New customer request" : "New booking request"}</h3>
            <p>
              {onBehalf
                ? `${booking?.customer?.name || "A customer"} wants to book ${booking?.cook?.name || "a cook"} — accepting books it on the cook's behalf.`
                : `${booking?.customer?.name || "A customer"} wants to book you — respond before the timer runs out or the request expires.`}
            </p>
          </div>
        </div>

        <div className="brm-timer-row">
          {clockText != null ? (
            <span className={`brm-timer${urgent ? " is-urgent" : ""}${expired ? " is-expired" : ""}`} role="timer">
              {expired ? <TimerOff size={14} /> : <Timer size={14} />}
              {expired ? "Expired" : `${clockText} left to respond`}
            </span>
          ) : (
            <span className="brm-timer is-static" role="note">
              <Timer size={14} /> 5-minute response window
            </span>
          )}
        </div>

        <div className="brm-details">
          <p className="brm-row">
            <CalendarDays size={14} /> {booking?.date ? formatDate(booking.date) : "Date TBD"}
            <span className="brm-dot" aria-hidden="true" />
            <Clock size={14} />{" "}
            {booking?.startTime && booking?.endTime
              ? formatTimeRange12(booking.startTime, booking.endTime, "-")
              : "Time TBD"}
          </p>
          <p className="brm-row">
            <MapPin size={14} /> {booking?.address || "Address shared after acceptance"}
          </p>
          <p className="brm-row">
            <Users size={14} /> {serviceLabel}
            {booking?.guests ? ` · ${booking.guests} guests` : ""}
            {booking?.durationHours ? ` · ${booking.durationHours} hr${Number(booking.durationHours) === 1 ? "" : "s"}` : ""}
          </p>
          {dishes.length > 0 && (
            <p className="brm-row">
              <UtensilsCrossed size={14} /> {dishes.join(" · ")}
            </p>
          )}
          {booking?.amount != null && (
            <p className="brm-row brm-amount">
              <strong>{formatCurrency(booking.amount)}</strong>
              {booking?.payment?.status === "paid" ? " · Paid" : " · Payable after acceptance"}
            </p>
          )}
          {booking?.notes && <p className="brm-note">Note: {booking.notes}</p>}
        </div>

        {error && (
          <div className="error-alert-banner" style={{ marginBottom: "0.75rem" }}>
            <AlertCircle size={16} /> {error}
          </div>
        )}

        <div className="brm-actions">
          {expired ? (
            <p className="brm-expired-note">This request expired — finding the next one…</p>
          ) : (
            <>
              <button
                type="button"
                ref={acceptBtnRef}
                className="btn btn-primary"
                disabled={busy}
                onClick={() => handleAction("accept")}
              >
                <Check size={16} /> {acting === "accept" ? "Accepting…" : "Accept"}
              </button>
              <button
                type="button"
                className="btn btn-danger-outline"
                disabled={busy}
                onClick={() => handleAction("reject")}
              >
                <X size={16} /> {acting === "reject" ? "Declining…" : "Decline"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default BookingRequestModal;
