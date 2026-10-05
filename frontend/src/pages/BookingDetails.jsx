import React, { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import API from "../api/axios";
import { useSelector } from "react-redux";
import { useShowToast } from "../store/hooks";
import ReviewForm, { ReviewStars } from "../components/ReviewForm";
import ComplaintForm from "../components/ComplaintForm";
import CookAvatar from "../components/CookAvatar";
import CancelBookingModal, { NoShowModal } from "../components/CancelBookingModal";
import RescheduleModal from "../components/RescheduleModal";
import RefundRequestModal from "../components/RefundRequestModal";
import {
  formatCurrency,
  formatDate,
  mapsNavigateUrl,
  bookingWhatsAppUrl,
  bookingCookJobWhatsAppUrl,
  hoursCompleteWhatsAppUrl,
  sessionEndDate,
  effectiveServiceWindow,
  formatRemaining,
  isReviewable,
  isCancelLocked,
  canRescheduleBooking,
  isRescheduleLocked,
  timeAgo,
  formatTime12,
  formatTimeRange12,
  dayTagLabel,
  SERVICE_DETAILS,
} from "../utils/constants";
import { useLocalDay } from "../hooks/useLocalDay";
import {
  ArrowLeft,
  Calendar,
  CheckCircle2,
  AlertCircle,
  Clock,
  MapPin,
  Navigation,
  Phone,
  MessageCircle,
  XCircle,
  CalendarClock,
  Sparkles,
  BellRing,
  Receipt,
  History,
  User,
  ShieldAlert,
  Star,
  Quote,
} from "lucide-react";

const BookingDetails = () => {
  const { bookingId } = useParams();
  const user = useSelector((s) => s.auth.user);
  // Live local day: keeps the Today/Tomorrow badge correct across midnight
  // even if this page stays open past 12 AM.
  const today = useLocalDay();
  const showToast = useShowToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [noShowOpen, setNoShowOpen] = useState(false);
  // Backend-computed cancellation preview (§15) — the only source for the
  // charge/refund figures shown on this page.
  const [cancelPreview, setCancelPreview] = useState(null);
  const [now, setNow] = useState(Date.now());
  // Cook enters the customer's OTP to start the service clock.
  const [otpInput, setOtpInput] = useState("");
  const [startingService, setStartingService] = useState(false);
  const [otpError, setOtpError] = useState("");
  // Reschedule picker (customer/admin only — see canReschedule below).
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  // Post-service refund request (customer only — the backend decides
  // eligibility; this state only mirrors its answer).
  const [refundInfo, setRefundInfo] = useState(null);
  const [refundOpen, setRefundOpen] = useState(false);
  // Deep link from the dashboard's Action Required card (?action=refund):
  // auto-open the request modal once eligibility confirms it, then drop the
  // query so a refetch can't reopen it.
  const refundAction = new URLSearchParams(location.search).get("action");
  useEffect(() => {
    if (refundAction === "refund" && refundInfo?.eligible && !refundOpen) {
      setRefundOpen(true);
      navigate(`/bookings/${bookingId}`, { replace: true });
    }
  }, [refundAction, refundInfo, refundOpen, bookingId, navigate]);

  const fetchDetails = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await API.get(`/bookings/${bookingId}`);
      setBooking(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Could not load booking details");
    } finally {
      setLoading(false);
    }
  }, [bookingId]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  // Refund eligibility is server-computed (scheduled end + 1h, not completed,
  // paid, no existing request). Fetched only for paid, non-terminal bookings
  // on the customer's own page — cancelled bookings keep the legacy refund
  // line above, cooks never see refund UI.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setRefundInfo(null);
      if (!booking?._id) return;
      if (user?.role !== "customer") return;
      if (booking?.payment?.status !== "paid") return;
      if (["cancelled", "completed", "rejected", "expired"].includes(booking.status)) return;
      try {
        const res = await API.get(`/bookings/${booking._id}/refund-eligibility`);
        if (!cancelled) setRefundInfo(res.data);
      } catch {
        if (!cancelled) setRefundInfo(null);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [booking?._id, booking?.status, booking?.payment?.status, user?.role]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const handleStartService = async () => {
    const code = otpInput.trim();
    if (!/^\d{4}$/.test(code)) {
      setOtpError("Enter the 4-digit code from the customer");
      return;
    }
    setStartingService(true);
    setOtpError("");
    try {
      const res = await API.patch(`/bookings/${bookingId}/start-service`, { otp: code });
      setBooking((prev) => ({ ...prev, ...res.data }));
      setOtpInput("");
      showToast("Service started — the clock is running!", "success");
    } catch (err) {
      const msg = err.response?.data?.message || "Could not start service";
      setOtpError(msg);
      showToast(msg, "error");
    } finally {
      setStartingService(false);
    }
  };

  // The Cancel dialog (CancelBookingModal) performs the API call itself with
  // the chosen reason — this just merges the cancelled booking into state.
  const handleCancelled = (updated) => {
    if (updated && typeof updated === "object") {
      setBooking((prev) => ({ ...prev, ...updated }));
    } else {
      fetchDetails();
    }
    setCancelPreview(null);
  };

  // Cancellation preview for the info card below (customer, active booking
  // only — the modal re-fetches fresh numbers at confirm time).
  useEffect(() => {
    let alive = true;
    const load = async () => {
      setCancelPreview(null);
      if (!booking?._id) return;
      if (user?.role !== "customer") return;
      if (!["requested", "accepted", "confirmed"].includes(booking.status)) return;
      if (booking?.serviceStartedAt) return;
      try {
        const res = await API.get(`/bookings/${booking._id}/cancellation-preview`);
        if (alive) setCancelPreview(res.data);
      } catch {
        if (alive) setCancelPreview(null);
      }
    };
    load();
    return () => {
      alive = false;
    };
  }, [booking?._id, booking?.status, booking?.serviceStartedAt, user?.role]);

  // Once the cook verifies the OTP the service clock starts — Cancel
  // disappears; it can no longer be called off here.
  // (Gated on the actual clock, mirroring the backend — merely reaching the
  // scheduled hour is not a start.)
  // An upcoming booking may be cancelled only until 30 minutes before the
  // scheduled service start (backend enforces the same cutoff — this only
  // hides doomed actions).
  const serviceStarted = Boolean(booking?.serviceStartedAt);
  const cancelLocked = isCancelLocked(booking, now);

  const getStatusBadge = (status) => {
    if (booking?.hoursCompleted && ["accepted", "confirmed", "in_progress"].includes(status)) {
      return <span className="badge badge-amber">Hours Complete ⏰</span>;
    }
    if (booking?.cookArrived && ["accepted", "confirmed", "in_progress"].includes(status)) {
      return <span className="badge badge-emerald">Cook Arrived ✓</span>;
    }
    switch (status) {
      case "requested":
        return <span className="badge badge-amber">Awaiting Cook Acceptance</span>;
      case "accepted":
        return (
          <span className="badge badge-amber">
            Accepted by Cook
          </span>
        );
      case "confirmed":
        return <span className="badge badge-blue">Confirmed & Scheduled</span>;
      case "in_progress":
        return <span className="badge badge-purple">Session In Progress</span>;
      case "completed":
        return <span className="badge badge-emerald">Completed</span>;
      case "rejected":
        return <span className="badge badge-rose">Declined by Cook</span>;
      case "cancelled":
        return <span className="badge badge-slate">Cancelled</span>;
      case "expired":
        return <span className="badge badge-slate">Expired — Cook Didn't Respond</span>;
      default:
        return <span className="badge badge-slate">{status}</span>;
    }
  };

  if (loading) {
    return (
      <div className="bd-loading">
        <div className="loading-spinner-wrapper">
          <div className="spinner"></div>
          <p className="bd-mini-note">Loading booking details...</p>
        </div>
      </div>
    );
  }

  if (error || !booking) {
    return (
      <div className="bd-error">
        <Link
          to={
            user?.role === "cook"
              ? "/dashboard/cook-bookings"
              : user?.role === "admin"
                ? "/admin"
                : "/dashboard/my-bookings"
          }
          className="back-link-bar bd-error-link"
        >
          <ArrowLeft size={16} />{" "}
          {user?.role === "cook"
            ? "Back to Cook Dashboard"
            : user?.role === "admin"
              ? "Back to Admin"
              : "Back to My Bookings"}
        </Link>
        <div className="error-alert-banner">
          <AlertCircle size={18} /> {error || "Booking not found"}
        </div>
      </div>
    );
  }

  const serviceInfo = SERVICE_DETAILS[booking.serviceType] || {
    label: (booking.serviceType || "").replace(/_/g, " "),
  };
  const end = sessionEndDate(booking);
  // Redefined window: after OTP start this is actual start → actual end.
  const serviceWindow = effectiveServiceWindow(booking);
  const remainingLabel = end ? formatRemaining(end, now) : null;
  const isActive = ["requested", "accepted", "confirmed", "in_progress"].includes(booking.status);
  // Cancel mirrors the backend 30-minute cutoff (admins exempt there): hide
  // the button once moves are locked so users aren't offered a doomed action.
  // The backend also refuses self-serve cancel once the session is live
  // (in_progress) for non-admins — hide there too so the button never offers
  // an action the API would reject.
  const canCancel =
    isActive &&
    !serviceStarted &&
    user?.role !== "admin" &&
    booking.status !== "in_progress" &&
    !cancelLocked;
  // OTP service-start state.
  const sessionLive = ["accepted", "confirmed", "in_progress"].includes(booking.status);
  const showOtpForm =
    user?.role === "cook" && sessionLive && !booking.serviceStartedAt;
  // Reschedule (v1: customer own-booking + admin any-booking, instant move).
  // canRescheduleBooking mirrors the backend (status, lock, cap, started
  // flags); the locked-note below explains a doomed action instead of
  // offering it — same pattern as the cancel lock note.
  const canReschedule = canRescheduleBooking(booking, user, now);
  const reschedulableStatus =
    ["requested", "accepted", "confirmed"].includes(booking.status) &&
    !serviceStarted &&
    !booking.cookArrived &&
    !booking.hoursCompleted;
  const showRescheduleLockedNote =
    reschedulableStatus && user?.role === "customer" && !canReschedule;
  const startedAtLabel = booking.serviceStartedAt
    ? new Date(booking.serviceStartedAt).toLocaleString("en-IN", {
        day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
      })
    : "";

  const waToCook = bookingWhatsAppUrl({
    cookPhone: booking.cook?.phone,
    customerName: user?.name,
    customerPhone: user?.phone,
    booking,
  });
  // After payment the cook needs the customer's name, number and location —
  // prefer the server-built job sheet link, fall back to the client builder.
  const isPaid = booking?.payment?.status === "paid";
  const jobSheetWa = isPaid
    ? booking.cookWhatsappUrl ||
      bookingCookJobWhatsAppUrl({
        cookPhone: booking.cook?.phone,
        customerName: user?.name,
        customerPhone: user?.phone,
        booking,
      })
    : null;
  const hoursWa =
    booking.hoursCompleted &&
    (booking.hoursCompleteWhatsappUrl ||
      hoursCompleteWhatsAppUrl({
        toPhone: user?.phone,
        booking,
        cookName: booking.cook?.name,
        cookPhone: booking.cook?.phone,
        customerName: user?.name,
      }));

  // Journey tracker: where is this booking in its life? Note "accepted"
  // means the cook said yes but payment may still be pending.
  const journeySteps = [
    { key: "requested", label: "Requested", hint: "Waiting for cook" },
    {
      key: "confirmed",
      label: "Accepted",
      hint: "Cook accepted",
    },
    { key: "in_progress", label: "In progress", hint: "Cooking now" },
    { key: "completed", label: "Completed", hint: "Done · rate cook" },
  ];
  const journeyIdx =
    { requested: 0, accepted: 1, confirmed: 1, in_progress: 2, completed: 3 }[booking?.status] ?? -1;
  const journeyEndedBad = ["rejected", "cancelled", "expired"].includes(booking?.status);
  const endedLabel =
    booking?.status === "rejected"
      ? "Declined by cook"
      : booking?.status === "cancelled"
        ? "Cancelled"
        : booking?.status === "expired"
          ? "Expired"
          : "";

  // Refund status for a cancelled paid booking — refunds are approved or
  // rejected by an admin (nothing moves automatically). Unpaid bookings
  // show nothing: no money moved.
  const refundLine = (() => {
    // Refund copy is money-information for the customer (and support). On the
    // cook's page a cancelled booking shows ONLY the slot-freed line — there
    // is nothing for the cook to act on here, so never build the string.
    if (user?.role === "cook") return "";
    if (booking?.status !== "cancelled") return "";
    const pay = booking?.payment || {};
    if (pay.status !== "paid") return "";
    const amt = pay.refundAmount || pay.paidAmount || booking?.amount;
    const amtLabel = amt ? ` of ${formatCurrency(amt)}` : "";
    if (pay.refundStatus === "processed") {
      return `Refund${amtLabel} initiated — it reaches your account in 5–7 business days.`;
    }
    if (pay.refundStatus === "manual") {
      return pay.testMode
        ? "Test payment — no real money moved."
        : "Your refund will be settled manually within 5–7 business days.";
    }
    if (pay.refundStatus === "failed") {
      return "The approved refund hit a gateway error — our team is following up.";
    }
    if (pay.refundStatus === "rejected") {
      return "The refund request was declined — please contact support if you need help.";
    }
    if (pay.refundStatus === "pending") {
      return "Refund requested — our team will review it shortly.";
    }
    return "Our team will review your refund shortly.";
  })();

  return (
    <div className="bd-wrap">
      <div className="bd-back">
        <Link
          to={
            user?.role === "cook"
              ? "/dashboard/cook-bookings"
              : user?.role === "admin"
                ? "/admin"
                : "/dashboard/my-bookings"
          }
          className="back-link-bar"
        >
          <ArrowLeft size={16} />{" "}
          {user?.role === "cook"
            ? "Back to Cook Dashboard"
            : user?.role === "admin"
              ? "Back to Admin"
              : "Back to My Bookings"}
        </Link>
      </div>

      {/* Hero */}
      <div className="bd-hero">
        <div className="bd-hero-top">
          <span className="bd-eyebrow">
            <Sparkles size={12} /> Booking details
          </span>
          {getStatusBadge(booking.status)}
        </div>
        <h1 className="bd-title">{serviceInfo.label}</h1>
        <p className="bd-sub">
          Booking #{booking._id?.substring(18)} • Booked {booking.createdAt ? timeAgo(booking.createdAt) : ""}
        </p>
        <div className="bd-hero-cookline">
          <span className="bd-hero-cook-avatar" aria-hidden="true">
            <CookAvatar photoUrl={booking.cook?.photoUrl} name={booking.cook?.name} alt="" />
          </span>
          <span>Hosted by <strong>{booking.cook?.name || "your assigned cook"}</strong></span>
        </div>
        <div className="bd-hero-facts">
          <span className="bd-fact-chip"><Calendar size={13} /> {formatDate(booking.date)}</span>
          {user?.role === "cook" && (() => {
            const tag = dayTagLabel(booking, today);
            return tag ? (
              <span
                className={`bd-fact-chip cook-day-tag ${tag === "Today" ? "is-today" : "is-tomorrow"}`}
                aria-label={`This booking is for ${tag.toLowerCase()}`}
              >
                {tag}
              </span>
            ) : null;
          })()}
          <span className="bd-fact-chip"><Clock size={13} /> {formatTimeRange12(serviceWindow.startTime, serviceWindow.endTime)}{booking.serviceStartedAt ? " (actual)" : ""}</span>
          {booking.durationHours && (
            <span className="bd-fact-chip">{booking.durationHours} hr{Number(booking.durationHours) === 1 ? "" : "s"}</span>
          )}
          {booking.guests && (
            <span className="bd-fact-chip"><User size={13} /> {booking.guests} guest{Number(booking.guests) === 1 ? "" : "s"}</span>
          )}
          {!booking.hoursCompleted && isActive && remainingLabel && (
            <span className="bd-fact-chip live"><Clock size={13} /> {remainingLabel}</span>
          )}
        </div>
      </div>

      {/* Journey tracker */}
      {!journeyEndedBad && journeyIdx >= 0 && (
        <ol className="bd-journey" aria-label="Booking progress">
          {journeySteps.map((s, i) => (
            <li
              key={s.key}
              className={`bd-journey-step ${i < journeyIdx || booking.status === "completed" ? "done" : i === journeyIdx ? "current" : ""}`}
              aria-current={i === journeyIdx ? "step" : undefined}
            >
              <span className="bd-journey-dot" aria-hidden="true">
                {i < journeyIdx || booking.status === "completed" ? <CheckCircle2 size={14} /> : i + 1}
              </span>
              <span className="bd-journey-text">
                <span className="bd-journey-name">{s.label}</span>
                <span className="bd-journey-hint">{s.hint}</span>
              </span>
              {i < journeySteps.length - 1 && (
                <span className={`bd-journey-link ${i < journeyIdx ? "done" : ""}`} aria-hidden="true" />
              )}
            </li>
          ))}
        </ol>
      )}
      {journeyEndedBad && (
        <div className="bd-banner bad">
          <XCircle size={18} />
          <span>
            This booking {endedLabel.toLowerCase()}
            {booking.status === "rejected" ? " — try another cook or time." : " — the slot is free again."}
            {booking.status === "cancelled" && refundLine && (
              <>
                <br />
                {refundLine}
              </>
            )}
          </span>
        </div>
      )}

      {/* NOTE: no standalone arrival banner here by design — arrival is only
          recorded via the OTP-verified service start (manual arrival taps
          are disabled), which already shows its own started banner below. */}
      {booking.hoursCompleted && !booking.review && (
        <div className="bd-banner warn">
          <BellRing size={18} />
          <span>Your cooking hours are complete! Please review your session below.</span>
          {hoursWa && (
            <a href={hoursWa} target="_blank" rel="noreferrer" className="btn btn-success btn-sm">
              <MessageCircle size={15} /> Hours Done on WhatsApp
            </a>
          )}
        </div>
      )}

      {booking.serviceStartedAt && sessionLive && !booking.hoursCompleted && (() => {
        const remaining = end ? formatRemaining(end, now) : null;
        const overdue = !!(end && end.getTime() < now);
        return (
          <div className={`bd-clock${overdue ? " is-overdue" : " is-live"}`} role="status">
            <div className="bd-clock-head">
              <span className="bd-clock-dot" aria-hidden="true" />
              <strong>{overdue ? "Running over time" : "Service in progress"}</strong>
              {remaining && <span className="bd-clock-remaining">{remaining}</span>}
            </div>
            <div className="bd-clock-meta">
              <span>Started {startedAtLabel}</span>
              {serviceWindow.endTime && <span>Ends {formatTime12(serviceWindow.endTime)}</span>}
            </div>
            <p className="bd-clock-sub">
              {overdue
                ? "The booked hours have ended — please wrap up the session."
                : "Hours are being counted."}
            </p>
          </div>
        );
      })()}

      {/* Service timings: actual OTP clock when the service started, else
          the scheduled slot (covers old bookings from before the OTP clock).
          Hidden for requests that never became a service. */}
      {(booking.serviceStartedAt ||
        ["in_progress", "completed"].includes(booking.status) ||
        booking.hoursCompleted) && (() => {
        const started = !!booking.serviceStartedAt;
        const startLabel = started
          ? startedAtLabel
          : `${formatDate(booking.date)} • ${formatTime12(booking.startTime)}`;
        const endLabel = started && booking.serviceEndsAt
          ? new Date(booking.serviceEndsAt).toLocaleString("en-IN", {
              day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
            })
          : `${formatDate(booking.date)} • ${formatTime12(booking.endTime)}`;
        return (
          <div className="bd-card bd-timings-card">
            <h3 className="bd-card-head">
              <Clock size={18} /> Service Timings
            </h3>
            <div className="bd-facts">
              <div className="bd-fact">
                <span className="bd-fact-icon"><Clock size={16} /></span>
                <div className="bd-fact-body"><label>Service {started ? "started" : "scheduled"}</label><span>{startLabel || "—"}</span></div>
              </div>
              <div className="bd-fact">
                <span className="bd-fact-icon"><CheckCircle2 size={16} /></span>
                <div className="bd-fact-body"><label>Service {started ? "ended" : "ends"}</label><span>{endLabel || "—"}</span></div>
              </div>
            </div>
            <p className="bd-mini-note">
              {started
                ? "Actual clock from OTP verification — not the slot estimate."
                : "Scheduled slot — actual times appear once the cook verifies your OTP."}
            </p>
          </div>
        );
      })()}

      {showOtpForm && (
        <div className="bd-card bd-cook-card">
          <h3 className="bd-card-head">
            <Clock size={18} /> Start service with customer OTP
          </h3>
          <p className="bd-otp-desc">
            Ask {booking.customer?.name || "the customer"} for the 4-digit code on their booking —
            entering it marks your arrival and starts the {booking.durationHours}-hour clock.
          </p>
          <div className="bd-otp-row">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              className="form-control bd-otp-input"
              placeholder="••••"
              value={otpInput}
              onChange={(e) => {
                setOtpInput(e.target.value.replace(/\D/g, "").slice(0, 4));
                setOtpError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleStartService();
                }
              }}
              aria-label="4-digit service start code"
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={startingService || otpInput.trim().length !== 4}
              onClick={handleStartService}
            >
              <CheckCircle2 size={16} /> {startingService ? "Starting…" : "Start Service"}
            </button>
          </div>
          {otpError && (
            <div className="error-alert-banner" style={{ marginTop: "0.75rem" }}>
              <AlertCircle size={16} /> {otpError}
            </div>
          )}
        </div>
      )}

      {/* Booking summary: cook + order in one card
          (session facts live in the hero chips above).
          Cook viewers never see the cook block (their own number, Call and
          WhatsApp buttons) — they get the Customer card + Venue below
          instead. The order (dishes/notes) still shows: it's the job sheet. */}
      <div className="bd-card">
        <h3 className="bd-card-head">
          <Receipt size={18} /> Booking Summary
        </h3>

        {user?.role !== "cook" && (
          <>
            {/* Cook */}
            <div className="bd-cook">
              <div className="bd-cook-avatar" aria-hidden="true">
                <CookAvatar photoUrl={booking.cook?.photoUrl} name={booking.cook?.name} alt="" />
              </div>
              <div>
                <div className="bd-cook-name">{booking.cook?.name || "Assigned Cook"}</div>
                <div className="bd-cook-sub">
                  {booking.cookServiceArea || "Verified cook"}
                </div>
                {booking.cook?.phone && (
                  <div className="bd-cook-phone">
                    <Phone size={13} /> {booking.cook.phone}
                  </div>
                )}
              </div>
            </div>
            {(booking.cook?.phone || jobSheetWa || waToCook) && (
              <div className="bd-row-actions">
                {booking.cook?.phone && (
                  <a href={`tel:${booking.cook.phone}`} className="btn btn-outline btn-sm">
                    <Phone size={15} /> Call
                  </a>
                )}
                {(jobSheetWa || waToCook) && (
                  <a href={jobSheetWa || waToCook} target="_blank" rel="noreferrer" className="btn btn-success btn-sm">
                    <MessageCircle size={15} /> {jobSheetWa ? "Send details to cook" : "WhatsApp Cook"}
                  </a>
                )}
              </div>
            )}
          </>
        )}

        {/* Order (only when there is something in it) */}
        {(booking.selectedItems?.length > 0 || booking.notes) && (
          <>
            <hr className="bd-sec-div" />
            <h4 className="bd-sec-head">
              <User size={15} /> Your Order
            </h4>
            {booking.selectedItems?.length > 0 && (
              <div className="bd-dishes">
                {booking.selectedItems.map((item, i) => (
                  <span key={i} className="badge badge-amber">{item}</span>
                ))}
              </div>
            )}
            {booking.notes && (
              <p className="bd-note">
                <strong>Notes:</strong> {booking.notes}
              </p>
            )}
          </>
        )}
      </div>

      {/* Customer contact — cook only. The backend shares the customer's
          phone once the booking is accepted (it stays hidden while
          "requested"); the tel: link opens the device dialer. Reuses the
          bd-cook card styles so no new CSS is needed. */}
      {user?.role === "cook" && (
        <div className="bd-card">
          <h3 className="bd-card-head">
            <User size={18} /> Customer
          </h3>
          <div className="bd-cook">
            <div className="bd-cook-avatar" aria-hidden="true">
              {booking.customer?.name?.[0]?.toUpperCase() || "C"}
            </div>
            <div>
              <div className="bd-cook-name">{booking.customer?.name || "Customer"}</div>
              {booking.customer?.phone ? (
                <div className="bd-cook-phone">
                  <Phone size={13} /> {booking.customer.phone}
                </div>
              ) : (
                <div className="bd-cook-sub">
                  Number is shared once you accept this booking.
                </div>
              )}
            </div>
          </div>
          {booking.customer?.phone && (
            <div className="bd-row-actions">
              <a href={`tel:${booking.customer.phone}`} className="btn btn-primary btn-sm">
                <Phone size={15} /> Call Customer
              </a>
            </div>
          )}
        </div>
      )}

      {/* Venue card — hidden for customers ("user"): they already know their
          own address. Cooks (and admins) still see it to navigate to the
          customer's location. */}
      {user?.role !== "customer" && (
        <div className="bd-card bd-summary-card">
          <h3 className="bd-card-head">
            <MapPin size={18} /> Venue
          </h3>
          <p className="bd-venue-addr">{booking.address}</p>
          {mapsNavigateUrl(booking) && (
            <div className="bd-row-actions">
              <a href={mapsNavigateUrl(booking)} target="_blank" rel="noreferrer" className="btn btn-primary">
                <Navigation size={17} /> {user?.role === "cook" ? "Go to Customer Location" : "Open in Google Maps"}
              </a>
            </div>
          )}
        </div>
      )}

      {/* Timeline (admin only — hidden on customer/cook logins) */}
      {booking.statusHistory?.length > 0 && user?.role === "admin" && (
        <div className="bd-card bd-venue-card">
          <h3 className="bd-card-head">
            <History size={18} /> Status Timeline
          </h3>
          <div className="bd-tl-list">
            {booking.statusHistory.map((h, i) => (
              <div key={i} className="bd-tl-row">
                <span className="badge badge-slate">{String(h.status).replace(/_/g, " ").toUpperCase()}</span>
                <span className="bd-tl-meta">
                  {h.timestamp ? new Date(h.timestamp).toLocaleString() : ""}
                  {h.note ? ` • ${h.note}` : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reschedule history — every move with its reason + cook change.
          Customer-safe: only slot/cook/reason/by display, never internals. */}
      {Array.isArray(booking.reschedules) && booking.reschedules.length > 0 && (
        <div className="bd-card bd-venue-card">
          <h3 className="bd-card-head">
            <CalendarClock size={18} /> Reschedule History
          </h3>
          <div className="bd-tl-list">
            {booking.reschedules.map((r, i) => {
              const cookChanged =
                r.fromCook && r.toCook && String(r.fromCook) !== String(r.toCook);
              return (
                <div key={i} className="bd-tl-row">
                  <span className="badge badge-blue">
                    {r.at ? new Date(r.at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "Moved"}
                  </span>
                  <span className="bd-tl-meta">
                    Previous: {r.fromDate ? formatDate(r.fromDate) : "—"}
                    {r.fromStartTime ? ` • ${formatTime12(r.fromStartTime)}${r.fromEndTime ? ` – ${formatTime12(r.fromEndTime)}` : ""}` : ""}
                    {r.fromCookName ? ` • Cook: ${r.fromCookName}` : ""}
                    <br />
                    Changed to: {r.toDate ? formatDate(r.toDate) : "—"}
                    {r.toStartTime ? ` • ${formatTime12(r.toStartTime)}${r.toEndTime ? ` – ${formatTime12(r.toEndTime)}` : ""}` : ""}
                    {r.toCookName ? ` • Cook: ${r.toCookName}` : cookChanged ? " • Cook reassigned" : ""}
                    {r.reason ? (
                      <>
                        <br />
                        Reason: {r.reason}
                      </>
                    ) : null}
                    {r.by ? (
                      <>
                        <br />
                        Changed by: {String(r.by).charAt(0).toUpperCase() + String(r.by).slice(1)}
                      </>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Post-service refund (customer only). The button appears only when
          the backend reports the booking eligible (end + 1h, not completed,
          paid, no existing request); every other state shows status copy. */}
      {user?.role === "customer" && refundInfo && (() => {
        const rs = refundInfo.refundStatus || booking?.payment?.refundStatus || "none";
        const amt = refundInfo.refundAmount || refundInfo.paidAmount || booking?.payment?.paidAmount || booking?.amount;
        if (refundInfo.eligible) {
          return (
            <div className="bd-card bd-refund-card" role="region" aria-label="Refund available">
              <h3 className="bd-card-head">
                <AlertCircle size={18} /> Service not completed
              </h3>
              <p className="bd-note-hint">
                {refundInfo.scheduledEnd
                  ? `Scheduled end: ${new Date(refundInfo.scheduledEnd).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}. `
                  : ""}
                Refund request available because the service was not marked completed.
              </p>
              <div className="bd-row-actions">
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setRefundOpen(true)}>
                  <Receipt size={16} /> Request refund
                </button>
              </div>
            </div>
          );
        }
        if (rs === "pending" || rs === "processing") {
          return (
            <div className="bd-card bd-refund-card" role="status">
              <h3 className="bd-card-head">
                <Clock size={18} /> Refund request under review
              </h3>
              <p className="bd-note-hint">
                Requested{amt ? `: ${formatCurrency(amt)}` : ""}
                {refundInfo.refundRequestedAt
                  ? ` · Submitted ${new Date(refundInfo.refundRequestedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`
                  : ""}. Our admin team will review it shortly.
              </p>
            </div>
          );
        }
        if (rs === "failed" || rs === "manual") {
          return (
            <div className="bd-card bd-refund-card" role="status">
              <h3 className="bd-card-head">
                <Clock size={18} /> Refund processing
              </h3>
              <p className="bd-note-hint">
                {amt ? `${formatCurrency(amt)} · ` : ""}Our team is completing your refund — we will notify you.
              </p>
            </div>
          );
        }
        if (rs === "processed") {
          const paid = Number(refundInfo.paidAmount || booking?.payment?.paidAmount || booking?.amount || 0);
          const refunded = Number(refundInfo.refundAmount || 0);
          const isPartial = paid > 0 && refunded > 0 && refunded < paid;
          const remaining = isPartial ? paid - refunded : 0;
          return (
            <div className="bd-card bd-refund-card is-done" role="status">
              <h3 className="bd-card-head">
                <CheckCircle2 size={18} /> {isPartial ? "Partial refund completed" : "Refund completed"}
              </h3>
              <p className="bd-note-hint">
                {isPartial
                  ? `Refund of ${formatCurrency(refunded)} processed (from ${formatCurrency(paid)} paid). Remaining unrefunded: ${formatCurrency(remaining)}.`
                  : `Refunded${amt ? `: ${formatCurrency(amt)}` : ""} — it reaches your account in 5–7 business days.`}
                {refundInfo.refundAdminNote ? ` Note: ${refundInfo.refundAdminNote}` : ""}
              </p>
            </div>
          );
        }
        if (rs === "rejected") {
          return (
            <div className="bd-card bd-refund-card" role="status">
              <h3 className="bd-card-head">
                <XCircle size={18} /> Refund request rejected
              </h3>
              <p className="bd-note-hint">
                Reason: {refundInfo.refundAdminNote || "Reviewed by our team — please contact support if you need help."}
              </p>
            </div>
          );
        }
        return null;
      })()}

      {/* Cancellation — backend-computed eligibility + estimate (§23).
          Active bookings show the live preview; cancelled ones show the
          immutable snapshot recorded at cancellation time. */}
      {user?.role === "customer" && cancelPreview?.canCancel && (
        <div className="bd-card bd-cancel-card" role="status">
          <h3 className="bd-card-head">
            <XCircle size={18} /> Cancellation
          </h3>
          <p className="bd-note-hint">You can cancel this booking.</p>
          <dl className="cancel-breakdown">
            <div><dt>Cancellation charge ({cancelPreview.cancellationChargePercent}%)</dt><dd>{formatCurrency(cancelPreview.bookingAmount - cancelPreview.grossRefund)}</dd></div>
            <div className="cancel-total"><dt>Estimated refund</dt><dd>{formatCurrency(cancelPreview.finalRefund)}</dd></div>
          </dl>
          <p className="bd-mini-note">
            Non-refundable payment charges may apply.{" "}
            <Link to="/customer-cancellation-refund-policy">Cancellation & Refund Policy</Link>
          </p>
        </div>
      )}
      {user?.role === "customer" && cancelPreview && !cancelPreview.canCancel && ["requested", "accepted", "confirmed"].includes(booking.status) && (
        <div className="bd-card bd-cancel-card" role="status">
          <h3 className="bd-card-head">
            <XCircle size={18} /> Cancellation unavailable
          </h3>
          <p className="bd-note-hint">{cancelPreview.message || "The service has already started."}</p>
        </div>
      )}
      {booking.status === "cancelled" && booking.cancellationInfo?.cancelledAt && (
        <div className="bd-card bd-cancel-card" role="status">
          <h3 className="bd-card-head">
            <XCircle size={18} /> Cancellation details
          </h3>
          <dl className="cancel-breakdown">
            <div><dt>Booking amount</dt><dd>{formatCurrency(booking.cancellationInfo.bookingAmount)}</dd></div>
            <div><dt>Cancellation charge ({booking.cancellationInfo.cancellationChargePercentage}%)</dt><dd>{formatCurrency(booking.cancellationInfo.bookingAmount - booking.cancellationInfo.grossRefundAmount)}</dd></div>
            <div className="cancel-total"><dt>Refund</dt><dd>{formatCurrency(booking.cancellationInfo.finalRefundAmount)}</dd></div>
            <div><dt>Refund status</dt><dd>{String(booking.cancellationInfo.refundStatus || "").replace(/_/g, " ")}</dd></div>
            {booking.cancellationInfo.refundReference && (
              <div><dt>Refund reference</dt><dd>{booking.cancellationInfo.refundReference}</dd></div>
            )}
          </dl>
          <p className="bd-mini-note">
            <Link to="/customer-cancellation-refund-policy">Cancellation & Refund Policy</Link>
          </p>
        </div>
      )}

      {/* Actions — reschedule + cancel. Rendered only when it applies, so
          completed/cancelled/expired bookings never show an empty bar.
          Inside 30 minutes of the start (or past the 2-move cap) the move
          locks — a note says so instead of offering a doomed button. */}
      {(canCancel ||
        canReschedule ||
        showRescheduleLockedNote ||
        (isActive && !serviceStarted && user?.role !== "admin" && cancelLocked)) && (
        <div className="bd-actionbar">
          {canReschedule && (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => setRescheduleOpen(true)}
            >
              <CalendarClock size={16} /> Reschedule
            </button>
          )}
          {canCancel && (
            <button className="btn btn-danger-outline btn-sm" onClick={() => setConfirmCancel(true)}>
              <XCircle size={16} />{" "}
              {booking.status === "requested"
                ? "Cancel Request"
                : "Cancel Booking"}
            </button>
          )}
          {user?.role === "cook" && String(booking.cook?._id || booking.cook) === String(user?._id || user?.id) && ["accepted", "confirmed", "in_progress"].includes(booking.status) && !serviceStarted && (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setNoShowOpen(true)}>
              <AlertCircle size={16} /> Mark customer no-show
            </button>
          )}
          {!canCancel && cancelLocked && (
            <p className="bd-mini-note" style={{ margin: 0 }}>
              Cancellation closes 30 minutes before the start time — please contact
              support for help with this booking.
            </p>
          )}
          {showRescheduleLockedNote && !canReschedule && (
            <p className="bd-mini-note" style={{ margin: 0 }}>
              {isRescheduleLocked(booking, now)
                ? "Rescheduling closes 30 minutes before the start time — please contact support for help with this booking."
                : "This booking has already been rescheduled twice — please contact support if you need another change."}
            </p>
          )}
        </div>
      )}
      {(isReviewable(booking) || booking.review) && user?.role === "customer" && (
        <div className="bd-card bd-timeline-card">
          <h3 className="bd-card-head">
            <Star size={18} /> {booking.review ? "Your review" : "Rate your cook"}
          </h3>
          <ReviewForm
            bookingId={booking._id}
            existingReview={booking.review}
            onSubmitted={fetchDetails}
            variant="bare"
          />
        </div>
      )}
      {/* Cook-only: report an issue about this customer to the admin. */}
      {user?.role === "cook" && booking.customer && (
        <div className="bd-card bd-review-card">
          <h3 className="bd-card-head">
            <ShieldAlert size={18} /> Report an issue
          </h3>
          <p className="bd-note-hint">
            Faced a problem with {booking.customer?.name || "this customer"}? Tell our team — we review every complaint.
          </p>
          <ComplaintForm
            bookingId={booking._id}
            filedBy="cook"
            counterpartyName={booking.customer?.name}
          />
        </div>
      )}
      {/* Customer: report an issue about this cook / session to the admin. */}
      {user?.role === "customer" && booking.cook && (
        <div className="bd-card bd-review-card">
          <h3 className="bd-card-head">
            <ShieldAlert size={18} /> Report an issue
          </h3>
          <p className="bd-note-hint">
            Faced a problem with {booking.cook?.name || "your cook"} or this session? Tell our team — we review every complaint.
          </p>
          <ComplaintForm
            bookingId={booking._id}
            filedBy="customer"
            counterpartyName={booking.cook?.name}
          />
        </div>
      )}
      {booking.status === "completed" && booking.review && user?.role !== "customer" && (
        <div className="review-card review-card--cook">
          <div className="review-card-head">
            <span className="review-card-badge">
              <Star size={16} />
            </span>
            <div className="review-card-headtext">
              <strong>Customer rating</strong>
              {booking.review.createdAt && (
                <span className="review-card-date">{formatDate(booking.review.createdAt)}</span>
              )}
            </div>
          </div>
          <div className="review-card-score">
            <ReviewStars value={booking.review.rating} size={20} />
            <span className="review-card-num">{booking.review.rating}/5</span>
          </div>
          {booking.review.comment && (
            <div className="review-card-comment">
              <Quote size={14} />
              <p>“{booking.review.comment}”</p>
            </div>
          )}
        </div>
      )}
      {confirmCancel && (
        <CancelBookingModal
          bookingId={booking._id}
          onClose={() => setConfirmCancel(false)}
          onCancelled={handleCancelled}
        />
      )}
      {noShowOpen && (
        <NoShowModal
          bookingId={booking._id}
          onClose={() => setNoShowOpen(false)}
          onMarked={(updated) => {
            if (updated && typeof updated === "object") setBooking((prev) => ({ ...prev, ...updated }));
            else fetchDetails();
          }}
        />
      )}
      {rescheduleOpen && (
        <RescheduleModal
          booking={booking}
          onClose={() => setRescheduleOpen(false)}
          onRescheduled={(updated) => {
            // The move keeps the cook, duration and price — merge the fresh
            // slot/count/history over local state; the modal already toasts.
            if (updated && typeof updated === "object") {
              setBooking((prev) => ({ ...prev, ...updated }));
            } else {
              fetchDetails();
            }
          }}
        />
      )}
      {refundOpen && (
        <RefundRequestModal
          booking={booking}
          eligibility={refundInfo}
          onClose={() => setRefundOpen(false)}
          onRequested={() => {
            // The request only queues for admin review — refresh both the
            // booking (payment.refundStatus) and the eligibility card.
            fetchDetails();
            API.get(`/bookings/${booking._id}/refund-eligibility`)
              .then((res) => setRefundInfo(res.data))
              .catch(() => setRefundInfo(null));
          }}
        />
      )}
    </div>
  );
};

export default BookingDetails;
