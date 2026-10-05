import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import CustomCalendar from "./CustomCalendar";
import CookAvatar from "./CookAvatar";
import {
  formatDate,
  formatTime12,
  getLocalDateStr,
  localTodayStr,
  MAX_RESCHEDULES,
} from "../utils/constants";
import {
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import { AnalyticsEvents, track } from "../utils/analytics";

// Mirror of MAX_BOOKING_HORIZON_DAYS on the server — the calendar simply
// doesn't offer days the API would refuse.
const MAX_HORIZON_DAYS = 180;
// Mirror of RESCHEDULE_REASONS on the server (bookingController) — the value
// sent is the label itself, stored on the reschedules[] audit entry.
const REASONS = [
  "Change of plans",
  "Personal reason",
  "Wrong date/time selected",
  "Cook unavailable",
  "Family/event schedule changed",
  "Other",
];

const addDaysStr = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const prettyService = (s) =>
  String(s || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

const friendlyError = (err, fallback) => {
  const msg = err?.response?.data?.message;
  if (typeof msg === "string" && msg.trim()) return msg;
  return fallback;
};

// RescheduleModal — move a booking to a new date/time, optionally with a new
// cook when the current cook cannot cover the new slot.
// Date feed: GET /bookings/:id/reschedule-options?date
// Slot+cook feed: GET /bookings/:id/reschedule-options?date=&startTime=
// Move: PATCH /bookings/:id/reschedule { date, startTime, reason?, cookId? }
// Duration and price never change — the copy says so, the backend enforces it.
const RescheduleModal = ({ booking, onClose, onRescheduled }) => {
  const showToast = useShowToast();
  const navigate = useNavigate();
  const [date, setDate] = useState(() => {
    // Default to the booking's own day when it is still today or later.
    const own = getLocalDateStr(booking?.date);
    return own && own >= localTodayStr() ? own : localTodayStr();
  });
  const [slots, setSlots] = useState([]);
  const [currentSlot, setCurrentSlot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState("");
  // Cook availability for the picked slot: null until a time is chosen.
  const [cookInfo, setCookInfo] = useState(null);
  const [cookLoading, setCookLoading] = useState(false);
  const [replacementCooks, setReplacementCooks] = useState([]);
  const [selectedCook, setSelectedCook] = useState(null);
  const [reason, setReason] = useState("");
  const [otherReason, setOtherReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [success, setSuccess] = useState(null);

  const durationHours = Number(booking?.durationHours || 0);
  const usedMoves = Number(booking?.rescheduleCount || 0);
  const remaining = Math.max(0, MAX_RESCHEDULES - usedMoves);
  const isPaid = booking?.payment?.status === "paid";
  const amount = booking?.payment?.paidAmount || booking?.amount;

  const fetchSlots = useCallback(
    async (day) => {
      setLoading(true);
      setLoadError("");
      setSelected("");
      setCookInfo(null);
      setReplacementCooks([]);
      setSelectedCook(null);
      setConfirming(false);
      try {
        const res = await API.get(`/bookings/${booking._id}/reschedule-options`, {
          params: { date: day },
        });
        setSlots(Array.isArray(res.data?.slots) ? res.data.slots : []);
        setCurrentSlot(res.data?.currentSlot || null);
      } catch (err) {
        setSlots([]);
        setCurrentSlot(null);
        setLoadError(friendlyError(err, "Could not load free slots — please try again."));
      } finally {
        setLoading(false);
      }
    },
    [booking?._id]
  );

  useEffect(() => {
    fetchSlots(date);
  }, [date, fetchSlots]);

  // Cook availability for the picked time — current cook first, replacements
  // when the current cook cannot cover the slot.
  const fetchCookAvailability = useCallback(
    async (day, startTime) => {
      setCookLoading(true);
      setCookInfo(null);
      setReplacementCooks([]);
      setSelectedCook(null);
      setConfirming(false);
      try {
        const res = await API.get(`/bookings/${booking._id}/reschedule-options`, {
          params: { date: day, startTime },
        });
        const available = res.data?.currentCookAvailable !== false;
        setCookInfo({ available });
        setReplacementCooks(Array.isArray(res.data?.availableCooks) ? res.data.availableCooks : []);
        if (!available && Array.isArray(res.data?.availableCooks) && res.data.availableCooks.length === 0) {
          setCookInfo({
            available: false,
            empty: true,
          });
        }
      } catch (err) {
        // A 400 here is usually outside-working-hours or lead-time: surface
        // the server's own user-friendly message.
        setCookInfo({ available: false, error: friendlyError(err, "Could not check cook availability — please try again.") });
        setReplacementCooks([]);
      } finally {
        setCookLoading(false);
      }
    },
    [booking?._id]
  );

  // Close on Escape (unless a move is in flight) and lock the page scroll.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape" && !submitting) onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, submitting]);

  // The booking's own start time only counts as "current" on its own day.
  const currentKey = useMemo(() => {
    if (!currentSlot || currentSlot.date !== date) return "";
    return String(currentSlot.startTime || "");
  }, [currentSlot, date]);

  const selectedEnd = useMemo(() => {
    const s = slots.find((x) => x.startTime === selected);
    return s?.endTime || "";
  }, [slots, selected]);

  const pickTime = (startTime) => {
    if (submitting) return;
    setSelected(startTime);
    setSubmitError("");
    fetchCookAvailability(date, startTime);
  };

  const effectiveReason = useMemo(() => {
    if (reason === "Other") return otherReason.trim().slice(0, 200);
    return reason;
  }, [reason, otherReason]);

  const cookStepOk = cookInfo && !cookInfo.error && (cookInfo.available || selectedCook);
  const canReview = selected && selectedEnd && cookStepOk && !submitting && !cookLoading;
  const canConfirm =
    canReview && confirming && (!cookInfo || cookInfo.available || selectedCook) && !submitting;

  const submit = async () => {
    if (!canConfirm || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const payload = { date, startTime: selected };
      if (effectiveReason) payload.reason = effectiveReason;
      if (selectedCook?.cookId) payload.cookId = selectedCook.cookId;
      const res = await API.patch(`/bookings/${booking._id}/reschedule`, payload);
      track(AnalyticsEvents.BOOKING_RESCHEDULED, {
        booking_id: String(booking?._id || ""),
        from_date: currentSlot?.date || "",
        from_start: currentSlot?.startTime || "",
        to_date: date,
        to_start: selected,
        cook_changed: Boolean(selectedCook?.cookId),
      });
      const moved = res.data || {};
      setSuccess({
        unchanged: Boolean(moved.unchanged),
        date,
        startTime: selected,
        endTime: selectedEnd,
        cookName: selectedCook?.name || booking?.cook?.name || "Your cook",
        cookChanged: Boolean(selectedCook?.cookId),
        reason: effectiveReason,
      });
      showToast(
        moved.unchanged
          ? "Already on this slot — nothing changed."
          : selectedCook?.cookId
            ? `Booking moved and ${selectedCook.name} assigned!`
            : `Booking moved to ${formatDate(`${date}T00:00:00`)} · ${formatTime12(selected)}`,
        "success"
      );
      onRescheduled?.(moved);
    } catch (err) {
      const status = err?.response?.status;
      const msg = friendlyError(err, "We couldn't complete the reschedule. Please try again.");
      setSubmitError(msg);
      showToast(msg, "error");
      // Slot or cook changed under us — reload the feeds.
      if (status === 409) {
        fetchSlots(date);
      }
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    if (!submitting) onClose?.();
  };

  const viewBooking = () => {
    onClose?.();
    navigate(`/bookings/${booking._id}`);
  };

  // Portaled to document.body: escapes .main-content's pageIn stacking
  // context so the sticky navbar can never paint over the dialog.
  return createPortal(
    <div className="login-modal-overlay" onClick={close}>
      <div
        className="rs-card rs-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reschedule-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="login-modal-close"
          onClick={close}
          aria-label="Close"
          disabled={submitting}
        >
          <X size={20} />
        </button>

        <div className="rs-head">
          <span className="rs-icon" aria-hidden="true">
            <CalendarClock size={22} />
          </span>
          <div>
            <h3 id="reschedule-title">Reschedule booking</h3>
            <p className="rs-sub">
              {booking?.cook?.name ? `With ${booking.cook.name}` : "Same cook"}
              {durationHours ? ` · ${durationHours}h session` : ""} · price unchanged
            </p>
          </div>
        </div>

        {success ? (
          <div className="rs-body" role="status" aria-live="polite">
            <div className="rs-success">
              <CheckCircle2 size={40} aria-hidden="true" />
              <h4>{success.unchanged ? "Already on this slot" : "Booking rescheduled successfully"}</h4>
              <p className="rs-success-slot">
                {formatDate(`${success.date}T00:00:00`)} · {formatTime12(success.startTime)}
                {success.endTime ? ` – ${formatTime12(success.endTime)}` : ""}
              </p>
              <p className="rs-success-cook">👨‍🍳 {success.cookName}</p>
              {success.cookChanged && <p className="rs-success-note">Your new cook has been assigned successfully.</p>}
              {success.reason && <p className="rs-success-note">Reason: {success.reason}</p>}
              {isPaid && amount ? (
                <p className="rs-success-note">₹{Number(amount).toLocaleString("en-IN")} · Already paid — no additional charge.</p>
              ) : null}
            </div>
            <div className="rs-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={viewBooking}>
                View booking
              </button>
            </div>
          </div>
        ) : (
          <div className="rs-body">
            {/* Step 1 — current booking */}
            <section className="rs-current" aria-label="Current booking">
              <h4 className="rs-section-title">Current booking</h4>
              <dl className="rs-current-grid">
                <div>
                  <dt>Date</dt>
                  <dd>📅 {formatDate(booking?.date)}</dd>
                </div>
                <div>
                  <dt>Time</dt>
                  <dd>
                    🕐 {formatTime12(booking?.startTime)}
                    {booking?.endTime ? ` – ${formatTime12(booking.endTime)}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Cook</dt>
                  <dd>👨‍🍳 {booking?.cook?.name || "Your cook"}</dd>
                </div>
                <div>
                  <dt>Service</dt>
                  <dd>🍲 {prettyService(booking?.serviceType)}</dd>
                </div>
                <div>
                  <dt>Amount</dt>
                  <dd>💰 {amount ? `₹${Number(amount).toLocaleString("en-IN")}` : "—"}</dd>
                </div>
                <div>
                  <dt>Payment</dt>
                  <dd>{isPaid ? "✓ Payment confirmed" : `Payment ${booking?.payment?.status || "pending"}`}</dd>
                </div>
              </dl>
              <p className={`rs-count ${remaining === 0 ? "is-empty" : ""}`} aria-live="polite">
                {remaining > 0
                  ? `Reschedules remaining: ${remaining} of ${MAX_RESCHEDULES}`
                  : "You have used all available reschedules."}
              </p>
            </section>

            <label className="rs-label" htmlFor="rs-date">
              New date
            </label>
            <CustomCalendar
              id="rs-date"
              value={date}
              min={localTodayStr()}
              max={addDaysStr(MAX_HORIZON_DAYS)}
              onChange={setDate}
            />

            <div className="rs-slot-head">
              <span className="rs-label" id="rs-times-label">Free start times</span>
              {durationHours ? <span className="rs-hint">{durationHours}h slots</span> : null}
            </div>

            {loading ? (
              <p className="rs-empty" role="status">
                <Loader2 size={16} className="rs-spin" /> Loading free slots…
              </p>
            ) : loadError ? (
              <p className="rs-error" role="alert">{loadError}</p>
            ) : slots.length === 0 ? (
              <p className="rs-empty">No free slots on this day — please pick another date.</p>
            ) : (
              <div className="rs-grid" role="listbox" aria-labelledby="rs-times-label">
                {slots.map((s) => {
                  const isCurrent = s.startTime === currentKey;
                  const isSelected = s.startTime === selected;
                  return (
                    <button
                      key={`${s.startTime}-${s.endTime}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={`rs-chip${isSelected ? " is-selected" : ""}`}
                      disabled={isCurrent || submitting}
                      onClick={() => pickTime(s.startTime)}
                      title={isCurrent ? "This is your current time" : `Move to ${formatTime12(s.startTime)}`}
                    >
                      <span className="rs-chip-main">{formatTime12(s.startTime)}</span>
                      <span className="rs-chip-end">to {formatTime12(s.endTime)}</span>
                      {isCurrent ? <span className="rs-chip-tag">Current</span> : null}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Cook availability for the picked slot */}
            {selected ? (
              <section className="rs-cook" aria-label="Cook availability" aria-live="polite">
                {cookLoading ? (
                  <p className="rs-empty" role="status">
                    <Loader2 size={16} className="rs-spin" /> Checking cook availability…
                  </p>
                ) : cookInfo?.error ? (
                  <p className="rs-error" role="alert">{cookInfo.error}</p>
                ) : cookInfo?.available ? (
                  <p className="rs-cook-ok">
                    <BadgeCheck size={16} aria-hidden="true" /> Your current cook is available for this slot.
                  </p>
                ) : (
                  <>
                    <p className="rs-cook-bad" role="alert">
                      Your current cook is unavailable for this time.
                    </p>
                    {cookInfo?.empty ? (
                      <p className="rs-empty">
                        Your current cook is unavailable and no other cook is available for this time. Please choose another time.
                      </p>
                    ) : (
                      <>
                        <h4 className="rs-section-title">Find another available cook</h4>
                        {replacementCooks.length === 0 ? (
                          <p className="rs-empty">Looking for available cooks…</p>
                        ) : (
                          <ul className="rs-cooks">
                            {replacementCooks.map((c) => {
                              const isSel = selectedCook?.cookId === c.cookId;
                              return (
                                <li key={c.cookId} className={`rs-cook-card${isSel ? " is-selected" : ""}`}>
                                  <CookAvatar photoUrl={c.photoUrl} name={c.name} alt="" />
                                  <div className="rs-cook-main">
                                    <strong>👩‍🍳 {c.name}</strong>
                                    <span className="rs-cook-meta">
                                      {c.rating > 0 ? (
                                        <span>
                                          <Star size={12} aria-hidden="true" /> {Number(c.rating).toFixed(1)}
                                          {c.ratingCount ? ` (${c.ratingCount})` : ""}
                                        </span>
                                      ) : (
                                        <span>New cook</span>
                                      )}
                                      <span className="rs-cook-verified">
                                        <ShieldCheck size={12} aria-hidden="true" /> Verified cook
                                      </span>
                                    </span>
                                    <span className="rs-cook-slot">
                                      Available · {formatDate(`${date}T00:00:00`)} · {formatTime12(selected)}
                                      {selectedEnd ? ` – ${formatTime12(selectedEnd)}` : ""}
                                    </span>
                                    <span className="rs-cook-price">Same booking price</span>
                                  </div>
                                  <button
                                    type="button"
                                    className={`btn btn-sm ${isSel ? "btn-primary" : "btn-outline"}`}
                                    disabled={submitting}
                                    onClick={() => {
                                      setSelectedCook(isSel ? null : c);
                                      setConfirming(false);
                                      setSubmitError("");
                                    }}
                                    aria-pressed={isSel}
                                  >
                                    {isSel ? "Selected" : "Select cook"}
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                        {selectedCook ? (
                          <p className="rs-cook-ok">
                            <BadgeCheck size={16} aria-hidden="true" /> New cook selected: {selectedCook.name}
                          </p>
                        ) : null}
                      </>
                    )}
                  </>
                )}
              </section>
            ) : null}

            {/* Reason */}
            <label className="rs-label" htmlFor="rs-reason">
              Reason <span className="rs-optional">(optional)</span>
            </label>
            <select
              id="rs-reason"
              className="rs-select"
              value={reason}
              disabled={submitting}
              onChange={(e) => {
                setReason(e.target.value);
                setConfirming(false);
                setSubmitError("");
              }}
            >
              <option value="">Select a reason…</option>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {reason === "Other" ? (
              <input
                type="text"
                className="rs-input"
                value={otherReason}
                maxLength={200}
                disabled={submitting}
                onChange={(e) => setOtherReason(e.target.value)}
                placeholder="Tell us briefly (max 200 characters)"
                aria-label="Other reason"
              />
            ) : null}

            {submitError ? <p className="rs-error" role="alert">{submitError}</p> : null}

            {/* Confirmation summary */}
            {confirming && selected ? (
              <section className="rs-confirm" aria-label="Confirm reschedule" aria-live="polite">
                <h4 className="rs-section-title">Confirm reschedule</h4>
                <div className="rs-confirm-grid">
                  <div>
                    <h5>Current booking</h5>
                    <p>
                      📅 {formatDate(booking?.date)}
                      <br />
                      🕐 {formatTime12(booking?.startTime)}
                      {booking?.endTime ? ` – ${formatTime12(booking.endTime)}` : ""}
                      <br />👩‍🍳 {booking?.cook?.name || "Your cook"}
                    </p>
                  </div>
                  <div>
                    <h5>New booking</h5>
                    <p>
                      📅 {formatDate(`${date}T00:00:00`)}
                      <br />
                      🕐 {formatTime12(selected)}
                      {selectedEnd ? ` – ${formatTime12(selectedEnd)}` : ""}
                      <br />
                      👩‍🍳 {selectedCook?.name || booking?.cook?.name || "Your cook"}
                    </p>
                  </div>
                </div>
                <div className="rs-confirm-pay">
                  <h5>Payment</h5>
                  <p>
                    {amount ? `₹${Number(amount).toLocaleString("en-IN")}` : "—"}
                    <br />✓ Already paid
                    <br />✓ No additional payment required
                  </p>
                </div>
                {effectiveReason ? (
                  <p className="rs-confirm-reason">Reason: {effectiveReason}</p>
                ) : null}
              </section>
            ) : null}

            <ul className="rs-notes">
              <li>The session length stays the same — the price does not change.</li>
              <li>The other side is notified the moment you confirm.</li>
              <li>Moves close 30 minutes before the start time.</li>
              <li>
                Can&apos;t find a suitable time? You can cancel under our{" "}
                <a href="/customer-cancellation-refund-policy" target="_blank" rel="noreferrer">Cancellation & Refund Policy</a>{" "}
                and book afresh.
              </li>
              {usedMoves > 0 ? (
                <li>
                  This booking has already been moved {usedMoves} of {MAX_RESCHEDULES} times.
                </li>
              ) : null}
            </ul>
          </div>
        )}

        {!success ? (
          <div className="rs-actions">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => (confirming ? setConfirming(false) : close())}
              disabled={submitting}
            >
              {confirming ? "Back" : "Keep current time"}
            </button>
            {!confirming ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!canReview}
                onClick={() => setConfirming(true)}
              >
                Review &amp; confirm
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={submit}
                disabled={!canConfirm}
              >
                {submitting ? (
                  <>
                    <Loader2 size={15} className="rs-spin" /> Moving…
                  </>
                ) : (
                  "Confirm reschedule"
                )}
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>,
    document.body
  );
};

export default RescheduleModal;
