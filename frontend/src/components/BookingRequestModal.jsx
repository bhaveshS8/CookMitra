import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate, formatTimeRange12, getLocalDateStr } from "../utils/constants";
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
  // Admin on-behalf accept of a BROADCAST (unassigned) request must name the
  // winning cook — the server never picks one. Loaded from the backend's
  // eligible-cooks feed (server-determined availability for this exact slot,
  // never trusted from the client); falls back to the availability-filtered
  // cooks list if that feed is unreachable.
  const needsCookPick = Boolean(onBehalf && !booking?.cook);
  const [assignCookId, setAssignCookId] = useState("");
  const [assignCooks, setAssignCooks] = useState([]);
  const [assignLoading, setAssignLoading] = useState(false);
  // Real-time takeover: another cook / the admin just won this request (or it
  // expired) while the dialog sat open — disable the buttons and auto-close
  // instead of leaving a stale actionable popup.
  const [takenOver, setTakenOver] = useState(null);

  useEffect(() => {
    if (!open || !needsCookPick) return undefined;
    setAssignCookId("");
    setAssignCooks([]);
    let cancelled = false;
    setAssignLoading(true);
    (async () => {
      try {
        // Backend-determined eligible cooks for THIS booking (excludes
        // ignored/unavailable/out-of-window cooks server-side).
        if (booking?._id) {
          try {
            const elig = await API.get(`/bookings/${booking._id}/eligible-cooks`);
            const eligList = Array.isArray(elig.data?.cooks) ? elig.data.cooks : null;
            if (!cancelled && eligList) {
              setAssignCooks(eligList);
              return;
            }
          } catch {
            // fall through to the availability-filtered list below
          }
        }
        const dayStr = getLocalDateStr(booking?.date);
        const params = dayStr && booking?.startTime && booking?.endTime
          ? { date: dayStr, startTime: booking.startTime, endTime: booking.endTime }
          : {};
        const res = await API.get("/cooks", { params });
        if (cancelled) return;
        const list = Array.isArray(res.data) ? res.data : res.data?.cooks || res.data?.data || [];
        setAssignCooks(list);
      } catch {
        if (!cancelled) setAssignCooks([]);
      } finally {
        if (!cancelled) setAssignLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, needsCookPick, booking?._id, booking?.date, booking?.startTime, booking?.endTime]);

  useEffect(() => {
    if (open) {
      setActing(null);
      setError("");
      setTakenOver(null);
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
  // The same auto-close runs when real-time reports this request was just
  // assigned elsewhere or expired (takenOver below).
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

  // Real-time takeover for the OPEN dialog: someone else won it (or it
  // expired) — freeze the buttons with a truthful note, then advance so the
  // parent refetches and pops the next waiting request. Stale/duplicate taps
  // after this point are blocked by `busy` below and by the server's atomic
  // claim (409 BOOKING_ALREADY_ASSIGNED) if they ever slip through.
  useEffect(() => {
    if (!open || !booking?._id) return undefined;
    const myId = String(booking._id);
    const onAssigned = (e) => {
      const d = e?.detail || {};
      if (d.bookingId && String(d.bookingId) !== myId) return;
      if (!d.bookingId && d.customerId) return;
      setTakenOver({
        kind: "assigned",
        message: "This request was just accepted — closing…",
      });
      showToast("This request was just accepted by another cook.", "info");
      setTimeout(() => {
        actionRef.current?.();
        closeRef.current?.();
      }, 1400);
    };
    const onExpired = (e) => {
      const d = e?.detail || {};
      if (d.bookingId && String(d.bookingId) !== myId) return;
      if (!d.bookingId && d.customerId) return;
      setTakenOver({ kind: "expired", message: "This request expired — closing…" });
      setTimeout(() => {
        actionRef.current?.();
        closeRef.current?.();
      }, 1400);
    };
    window.addEventListener("realtime-booking-assigned", onAssigned);
    window.addEventListener("realtime-booking-expired", onExpired);
    return () => {
      window.removeEventListener("realtime-booking-assigned", onAssigned);
      window.removeEventListener("realtime-booking-expired", onExpired);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, booking?._id]);

  if (!open) return null;

  const handleAction = async (action) => {
    if (acting || takenOver || !booking?._id) return;
    // Admin broadcast accept without a chosen cook is meaningless — the
    // server refuses it (400). Block here with a clear inline error.
    if (action === "accept" && needsCookPick && !assignCookId) {
      setError("Choose the cook to assign this request to, then accept.");
      return;
    }
    setActing(action);
    setError("");
    try {
      const body = action === "accept" && needsCookPick ? { cookId: assignCookId } : undefined;
      await API.patch(`/bookings/${booking._id}/${action}`, body);
      showToast(
        action === "accept"
          ? onBehalf
            ? "Accepted on behalf of the cook — the customer has 5 minutes to pay."
            : "Booking accepted — the customer has 5 minutes to pay."
          : onBehalf
          ? "Request declined on behalf of the cook."
          : "Request ignored — the customer is still waiting for another cook.",
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

  const busy = !!acting || expired || !!takenOver;

  // Portaled to document.body: the dialog must escape .main-content's
  // pageIn animation stacking context, otherwise the sticky navbar paints
  // over it (backdrop and card visibly starting below the navbar).
  return createPortal(
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

        {error && !takenOver && (
          <div className="error-alert-banner" style={{ marginBottom: "0.75rem" }}>
            <AlertCircle size={16} /> {error}
          </div>
        )}
        {takenOver && (
          <div className="error-alert-banner" style={{ marginBottom: "0.75rem" }}>
            <AlertCircle size={16} /> {takenOver.message}
          </div>
        )}

        {needsCookPick && !expired && (
          <div className="form-group" style={{ marginBottom: "0.75rem" }}>
            <label htmlFor="brm-assign-cook">Assign to cook *</label>
            <select
              id="brm-assign-cook"
              className="form-control"
              value={assignCookId}
              onChange={(e) => {
                setAssignCookId(e.target.value);
                if (error) setError("");
              }}
              disabled={busy || assignLoading}
            >
              <option value="">
                {assignLoading ? "Loading free cooks…" : "Choose a cook for this slot…"}
              </option>
              {assignCooks.map((c) => {
                const id = String(c?.user?._id || (typeof c?.user === "string" ? c.user : null) || c?._id || "");
                const name = c?.user?.name || c?.name || "Verified cook";
                return (
                  <option key={id} value={id}>
                    {name}{c?.serviceArea ? ` · ${c.serviceArea}` : ""}
                  </option>
                );
              })}
            </select>
            {!assignLoading && assignCooks.length === 0 && (
              <p className="field-hint">No cooks look free for this slot right now — declining keeps the request live for cooks.</p>
            )}
          </div>
        )}

        <div className="brm-actions">
          {expired || takenOver ? (
            <p className="brm-expired-note">{takenOver ? takenOver.message : "This request expired — finding the next one…"}</p>
          ) : (
            <>
              <button
                type="button"
                ref={acceptBtnRef}
                className="btn btn-primary"
                disabled={busy}
                onClick={() => handleAction("accept")}
              >
                <Check size={16} /> {acting === "accept" ? "Accepting…" : onBehalf ? "Accept & Assign" : "Accept"}
              </button>
              <button
                type="button"
                className="btn btn-danger-outline"
                disabled={busy}
                onClick={() => handleAction("reject")}
              >
                <X size={16} /> {acting === "reject" ? (onBehalf ? "Declining…" : "Ignoring…") : onBehalf ? "Decline" : "Ignore"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default BookingRequestModal;
