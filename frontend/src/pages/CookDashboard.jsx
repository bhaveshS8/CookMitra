import React, { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import API from "../api/axios";
import { useSelector } from "react-redux";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate, playAlarmSound, localTomorrowStr, mapsNavigateUrl, formatTimeRange12, dayTagLabel, getLocalDateStr, isCancelLocked } from "../utils/constants";
import { useLocalDay } from "../hooks/useLocalDay";
import CookProfileForm from "../components/CookProfileForm";
import CookAvailabilityToggle from "../components/CookAvailabilityToggle";
import { resolveFileUrl } from "../components/CookDocUploads";
import BookingRequestModal from "../components/BookingRequestModal";
import ConfirmDialog from "../components/ConfirmDialog";
import CookScheduleEditor from "../components/CookScheduleEditor";
import CookPayoutPanel from "../components/CookPayoutPanel";
import { Check, XCircle, BellRing, ArrowRight, Star, MapPin, Navigation, CalendarDays, CalendarCheck, CalendarClock, Inbox, History, UserRound, Users, Soup, Wallet, ChefHat, AlertCircle, ShieldCheck } from "lucide-react";

// Customer location summary for a cook's booking card: prefer the structured
// addressDetails (flat/society, landmark, city); fall back to the free-text
// address for older bookings. Pairs with the maps link below it.
const customerLocationLabel = (booking) => {
  const d = booking?.addressDetails || {};
  const primary =
    [d.flatNo, d.society].filter(Boolean).join(", ") || booking?.address || "";
  return [primary, d.landmark ? `Near ${d.landmark}` : "", d.city]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(" · ");
};

const CookDashboard = () => {
  const { data: bookings, loading: loadingBookings, error: bookingError, refetch: refetchBookings } = useFetch("/bookings/cook");
  const { data: cookProfile, loading: loadingProfile, refetch: refetchCookProfile } = useFetch("/cooks/me");
  const { data: myReviews, loading: loadingReviews } = useFetch("/reviews/cook-me");
  const { data: myComplaints } = useFetch("/complaints/my");
  const showToast = useShowToast();
  const user = useSelector((s) => s.auth.user);
  const navigate = useNavigate();
  // Live local day: keeps the Today/Tomorrow badges correct across midnight
  // even when the dashboard tab stays open (polling pauses in hidden tabs).
  const today = useLocalDay();
  // Cooks land on the Today tab — today's jobs are what matter on open.
  const [view, setView] = useState("today");
  const [cancellingId, setCancellingId] = useState(null);
  const [pendingCancelId, setPendingCancelId] = useState(null);
  // Booking id currently being accepted/ignored straight from its card.
  const [actingOn, setActingOn] = useState(null);
  const [requestModalBooking, setRequestModalBooking] = useState(null);
  // Hero photo health: a stored photoUrl can go stale (e.g. server uploads
  // wiped by a redeploy without a persistent volume) — fall back to the
  // initial instead of showing a broken-image icon.
  const [photoOk, setPhotoOk] = useState(true);
  useEffect(() => setPhotoOk(true), [cookProfile?.photoUrl]);
  const seenHoursDone = useRef(new Set());
  const firstLoadDone = useRef(false);
  // Auto-popup bookkeeping: ids of `requested` bookings already surfaced, so
  // each new request pops the Accept/Decline dialog exactly once.
  const seenRequestIds = useRef(new Set());
  const requestsInit = useRef(false);

  // Cooks miss the 5-minute window without OS-level pings — ask once for
  // browser-notification permission so new requests can alert even loudly.
  useEffect(() => {
    try {
      if ("Notification" in window && Notification.permission === "default") {
        const p = Notification.requestPermission();
        if (p && typeof p.catch === "function") p.catch(() => {});
      }
    } catch {
      // optional
    }
  }, []);

  // Poll bookings so new requests pop up without refresh.
  // 15s + hidden-tab pause: fast enough for the 5-minute accept window, but
  // a dashboard left open in a background tab stops hitting the API entirely.
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) refetchBookings();
    };
    const id = setInterval(tick, 15000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refetchBookings]);

  // Alarm once per booking when hours complete (skip state that already
  // existed on first load to avoid noise).
  useEffect(() => {
    if (!bookings?.length) return;
    if (!firstLoadDone.current) {
      bookings.forEach((b) => {
        if (b.hoursCompleted) seenHoursDone.current.add(b._id);
      });
      firstLoadDone.current = true;
      return;
    }
    bookings.forEach((b) => {
      if (b.hoursCompleted && !seenHoursDone.current.has(b._id)) {
        seenHoursDone.current.add(b._id);
        showToast(
          `Cooking hours complete for ${b.customer?.name || "your booking"} — please wrap up.`,
          "warning",
          8000
        );
        playAlarmSound();
        try {
          if ("Notification" in window && Notification.permission === "granted") {
            new Notification("Cooking hours complete!", {
              body: "Your booked cooking hours are complete. Please wrap up the session.",
            });
          }
        } catch {
          // optional
        }
      }
    });
  }, [bookings, showToast]);

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

  const handleCancel = async () => {
    const bookingId = pendingCancelId;
    if (cancellingId || !bookingId) return;
    setPendingCancelId(null);
    setCancellingId(bookingId);
    try {
      await API.patch(`/bookings/${bookingId}/cancel`);
      showToast("Booking cancelled successfully", "info");
      refetchBookings();
    } catch (err) {
      showToast(err.response?.data?.message || "Failed to cancel booking", "error");
    } finally {
      setCancellingId(null);
    }
  };

  // Direct Accept / Ignore from the booking card itself (same endpoints
  // as the request modal). Closes the modal when it shows this booking and
  // queues the next waiting request, so stacked arrivals are each answered.
  const handleRequestAction = async (booking, action) => {
    if (actingOn || !booking?._id) return;
    setActingOn(booking._id);
    try {
      await API.patch(`/bookings/${booking._id}/${action}`);
      showToast(
        action === "accept"
          ? "Booking accepted — the customer has 5 minutes to pay."
          : "Booking request ignored.",
        action === "reject" ? "info" : "success"
      );
      if (String(requestModalBooking?._id) === String(booking._id)) {
        setRequestModalBooking(null);
      }
      refetchBookings();
      popNextPendingRequest(booking._id);
    } catch (err) {
      const gone = err.response?.status === 410 || err.response?.status === 409;
      showToast(err.response?.data?.message || `Failed to ${action} booking`, "error");
      if (gone) {
        // The request died meanwhile (expired / slot taken) — drop the dead
        // row and move on instead of stranding it as actionable.
        if (String(requestModalBooking?._id) === String(booking._id)) {
          setRequestModalBooking(null);
        }
        refetchBookings();
        popNextPendingRequest(booking._id);
      }
    } finally {
      setActingOn(null);
    }
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case "requested":
        return <span className="badge badge-amber">Action Needed</span>;
      case "accepted":
      case "confirmed":
        return <span className="badge badge-blue">Scheduled</span>;
      case "in_progress":
        return <span className="badge badge-purple">In Progress</span>;
      case "completed":
        return <span className="badge badge-emerald">Completed</span>;
      case "unattended":
        return <span className="badge badge-rose">Unattended</span>;
      case "rejected":
        return <span className="badge badge-rose">Declined</span>;
      case "expired":
        return <span className="badge badge-slate">Expired — No Response</span>;
      case "cancelled":
        return <span className="badge badge-slate">Cancelled</span>;
      default:
        return <span className="badge badge-slate">{status}</span>;
    }
  };

  // Counts for the greeting + tabs. Per-booking payment badges show earnings
  // where they matter (on each card).
  const pendingRequests = bookings?.filter((b) => b.status === "requested")?.length || 0;

  // Views: needs-action (new requests) vs today/tomorrow (that date, minus
  // cancelled) vs upcoming (all live) vs previous (settled history).
  // Expired holds never reach this list (the API hides them), so history is
  // completed / cancelled / rejected only.
  // Every tab shows newer bookings first (creation time, newest → oldest).
  const isPrevious = (b) => ["completed", "cancelled", "rejected"].includes(b.status);
  // "Tomorrow" is always derived from the same live `today` string (rather
  // than a second Date() call) so the tabs and the card badges use one
  // midnight-aware source of truth.
  const tomorrowStr = (() => {
    const m = String(today || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return localTomorrowStr();
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    d.setDate(d.getDate() + 1);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const isTodayBooking = (b) => getLocalDateStr(b?.date) === today;
  const isTomorrowBooking = (b) => getLocalDateStr(b?.date) === tomorrowStr;
  const isNotCancelled = (b) => b?.status !== 'cancelled';
  // Newest bookings first in every tab. createdAt is the source of truth;
  // ObjectId order is the tiebreak (also creation-ordered).
  const createdMs = (b) => {
    const t = new Date(b?.createdAt).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const byNewest = (a, b) =>
    createdMs(b) - createdMs(a) ||
    String(b._id || "").localeCompare(String(a._id || ""));
  const visibleBookings = [...(bookings || [])]
    .filter((b) => {
      if (view === 'today') return isTodayBooking(b) && isNotCancelled(b);
      if (view === 'tomorrow') return isTomorrowBooking(b) && isNotCancelled(b);
      if (view === 'needs-action') return b.status === 'requested';
      if (view === 'upcoming') return !isPrevious(b);
      if (view === 'previous') return isPrevious(b);
      // 'all' (and any future view) shows every booking.
      return true;
    })
    .sort(byNewest);
  const previousCount = (bookings || []).filter(isPrevious).length;
  const todayCount = (bookings || []).filter((b) => isTodayBooking(b) && isNotCancelled(b)).length;
  const tomorrowCount = (bookings || []).filter((b) => isTomorrowBooking(b) && isNotCancelled(b)).length;
  const upcomingCount = (bookings || []).filter((b) => !isPrevious(b)).length;
  const completedCount = bookings?.filter((b) => b.status === "completed")?.length || 0;
  // Paid-out earnings (real gateway payments only — mirrors the server rule).
  // Cancelled bookings are refunded to the customer, so their paid amounts
  // are not earnings even though payment.status stays "paid".
  const totalEarned = (bookings || []).reduce(
    (s, b) =>
      b?.status !== "cancelled" && b.payment?.status === "paid" && b.payment?.razorpayPaymentId
        ? s + Number(b.payment?.paidAmount || 0)
        : s,
    0
  );
  const ratingCount = cookProfile?.rating?.count ?? myReviews?.length ?? 0;
  const avgRating =
    cookProfile?.rating?.average ||
    (myReviews?.length
      ? (myReviews.reduce((s, r) => s + Number(r.rating || 0), 0) / myReviews.length).toFixed(1)
      : null);
  const firstName = user?.name?.split(" ")[0] || "Chef";
  const approval = cookProfile?.approvalStatus;

  // Loud alert for a (new) booking request: toast + alarm sound + OS
  // notification. Shared by the first-load pop and every later arrival.
  const alertNewRequest = (booking, extra = "") => {
    showToast(
      `New booking request from ${booking?.customer?.name || "a customer"} — accept or decline!${extra}`,
      "warning",
      8000
    );
    playAlarmSound();
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("New booking request!", {
          body: `${booking?.customer?.name || "A customer"} wants to book you — open the dashboard to accept or decline.${extra}`,
        });
      }
    } catch {
      // optional
    }
  };

  // Auto-popup: whenever a new `requested` booking appears in the polled
  // list, open it in the Accept/Decline dialog automatically so the cook
  // never misses the 5-minute window. While a dialog is already open the
  // newcomer only rings (no yanking the cook mid-decision) and is queued —
  // closing the dialog pops the next waiting request.
  useEffect(() => {
    if (!bookings) return;
    const requested = [...bookings]
      .filter((b) => b?.status === "requested")
      .sort(byNewest);
    if (!requestsInit.current) {
      requestsInit.current = true;
      if (!requested.length) return;
      // Seed everything except the newest as seen, then pop the newest so an
      // already-waiting request greets the cook on login too.
      requested.slice(1).forEach((b) => seenRequestIds.current.add(String(b._id)));
      const newest = requested[0];
      seenRequestIds.current.add(String(newest._id));
      if (!requestModalBooking) {
        setRequestModalBooking(newest);
        alertNewRequest(newest);
      }
      return;
    }
    const fresh = requested.filter((b) => !seenRequestIds.current.has(String(b._id)));
    if (!fresh.length) return;
    fresh.forEach((b) => seenRequestIds.current.add(String(b._id)));
    if (!requestModalBooking) {
      const newest = [...fresh].sort(byNewest)[0];
      setRequestModalBooking(newest);
      alertNewRequest(newest, fresh.length > 1 ? ` (+${fresh.length - 1} more waiting)` : "");
    } else {
      // Dialog busy — ring so the queued request isn't missed.
      showToast(
        `${fresh.length} new booking request${fresh.length === 1 ? "" : "s"} waiting — finish this one first.`,
        "warning",
        8000
      );
      playAlarmSound();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings]);

  // After a dialog closes (accept / decline / dismiss), pop the next still-
  // pending request so stacked arrivals are each answered in turn.
  const popNextPendingRequest = (excludeId) => {
    const next = [...(bookings || [])]
      .filter((b) => b?.status === "requested" && String(b._id) !== String(excludeId || ""))
      .sort(byNewest)[0];
    if (next) {
      seenRequestIds.current.add(String(next._id));
      // Defer a tick so the current dialog's close animation/state settles.
      setTimeout(() => {
        setRequestModalBooking(next);
        alertNewRequest(next);
      }, 350);
    }
  };

  return (
    <div className="dashboard-container cook-dash">
      {/* Hero — greeting, verification, rating, availability */}
      <div className="cook-modern-hero cook-hero">
        <div className="cook-modern-hero-inner">
          <Link
            to="/dashboard/cook-profile"
            className="cook-modern-avatar-wrap cook-modern-avatar-link"
            title="Go to your profile"
            aria-label="Go to your profile"
          >
            {cookProfile?.photoUrl && photoOk ? (
              <img
                src={resolveFileUrl(cookProfile.photoUrl)}
                alt={user?.name || "Cook"}
                className="cook-modern-avatar"
                onError={() => setPhotoOk(false)}
              />
            ) : (
              <span className="cook-modern-avatar-fallback">
                {firstName?.[0]?.toUpperCase() || <ChefHat size={32} />}
              </span>
            )}
            {approval === "approved" && (
              <span className="verified-dot" title="Verified cook">✓</span>
            )}
          </Link>
          <div className="cook-modern-hero-copy">
            <h1 className="cook-hero-title">Hello, {firstName}</h1>
            <p className="cook-hero-sub">
              {pendingRequests > 0
                ? `${pendingRequests} new request${pendingRequests === 1 ? "" : "s"} waiting for you`
                : "You're all caught up — relax!"}
            </p>
            <div className="cook-hero-badges">
              {approval === "approved" ? (
                <span className="hero-pill ok">Verified cook</span>
              ) : approval === "rejected" ? (
                <span className="hero-pill bad">Needs attention</span>
              ) : (
                <span className="hero-pill warn">{cookProfile ? "Under review" : "No profile yet"}</span>
              )}
              {avgRating ? (
                <span className="hero-pill"><Star size={12} /> {avgRating} ({ratingCount})</span>
              ) : (
                <span className="hero-pill">New chef</span>
              )}
              {cookProfile?.serviceArea && (
                <span className="hero-pill"><MapPin size={12} /> {cookProfile.serviceArea}</span>
              )}
            </div>
          </div>
          <div className="cook-modern-hero-actions">
            <CookAvailabilityToggle
              availabilityStatus={cookProfile?.availabilityStatus}
              onChanged={() => refetchCookProfile()}
            />
            <button type="button" className="cook-glass-btn" onClick={() => setView("profile")}>
              <UserRound size={15} /> Profile
            </button>
            <Link className="cook-glass-btn" to="/dashboard/cook-reviews">
              <Star size={15} /> Reviews
            </Link>
          </div>
        </div>
      </div>

      {/* Stat shortcuts */}
      <div className="cook-stats-grid">
        <button type="button" className="cook-stat-card" onClick={() => setView("needs-action")}>
          <div className="cook-stat-icon amber">
            <Inbox size={24} />
          </div>
          <div>
            <div className="cook-stat-num">{pendingRequests}</div>
            <div className="cook-stat-label">New requests</div>
          </div>
        </button>
        <button type="button" className="cook-stat-card" onClick={() => setView("upcoming")}>
          <div className="cook-stat-icon blue">
            <CalendarDays size={24} />
          </div>
          <div>
            <div className="cook-stat-num">{upcomingCount}</div>
            <div className="cook-stat-label">Upcoming</div>
          </div>
        </button>
        <button type="button" className="cook-stat-card" onClick={() => setView("previous")}>
          <div className="cook-stat-icon emerald">
            <Wallet size={24} />
          </div>
          <div>
            <div className="cook-stat-num small-amount">{formatCurrency(totalEarned)}</div>
            <div className="cook-stat-label">Earned · {completedCount} done</div>
          </div>
        </button>
        <Link className="cook-stat-card" to="/dashboard/cook-reviews">
          <div className="cook-stat-icon brand">
            <Star size={24} />
          </div>
          <div>
            <div className="cook-stat-num">{avgRating || "—"}</div>
            <div className="cook-stat-label">{ratingCount ? `${ratingCount} review${ratingCount === 1 ? "" : "s"}` : "No reviews yet"}</div>
          </div>
        </Link>
      </div>

      {!loadingProfile && (!cookProfile || approval !== "approved") && (
        <div className="cook-notice cook-notice-amber">
          <AlertCircle size={16} />
          <span>
            {!cookProfile
              ? "Create your profile to start receiving bookings."
              : approval === "rejected"
              ? "Your application needs attention — please update your profile."
              : "Your profile is under review — you'll be bookable once approved."}
          </span>
          <button onClick={() => setView("profile")} className="cook-link-btn">
            {cookProfile ? "Review profile →" : "Create profile →"}
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="cook-tabs">
        <button
          className={`cook-tab ${view === "needs-action" ? "active" : ""}`}
          onClick={() => setView("needs-action")}
        >
          <Inbox size={15} /> New requests <span className="cook-tab-count">{pendingRequests}</span>
        </button>
        <button
          className={`cook-tab ${view === "today" ? "active" : ""}`}
          onClick={() => setView("today")}
        >
          <CalendarCheck size={15} /> Today <span className="cook-tab-count">{todayCount}</span>
        </button>
        <button
          className={`cook-tab ${view === "tomorrow" ? "active" : ""}`}
          onClick={() => setView("tomorrow")}
        >
          <CalendarClock size={15} /> Tomorrow <span className="cook-tab-count">{tomorrowCount}</span>
        </button>
        <button
          className={`cook-tab ${view === "upcoming" ? "active" : ""}`}
          onClick={() => setView("upcoming")}
        >
          <CalendarDays size={15} /> Upcoming <span className="cook-tab-count">{upcomingCount}</span>
        </button>
        <button
          className={`cook-tab ${view === "previous" ? "active" : ""}`}
          onClick={() => setView("previous")}
        >
          <History size={15} /> Past <span className="cook-tab-count">{previousCount}</span>
        </button>
        <button
          className={`cook-tab ${view === "reports" ? "active" : ""}`}
          onClick={() => setView("reports")}
        >
          <AlertCircle size={15} /> My reports{" "}
          <span className="cook-tab-count">{(myComplaints || []).length}</span>
        </button>
        <button
          className={`cook-tab ${view === "profile" ? "active" : ""}`}
          onClick={() => setView("profile")}
        >
          <UserRound size={15} /> Profile
        </button>
      </div>

      {/* BOOKINGS VIEWS */}
      {view !== "profile" && view !== "reports" && (
        <div>

          {loadingBookings && <p className="cook-loading-text">Loading bookings...</p>}

          {bookingError && <p className="error">{bookingError}</p>}

          {!loadingBookings && bookings && bookings.length > 0 ? (
            visibleBookings.length > 0 ? (
            <div className="bookings-list-modern cook-bookings-grid">
              {visibleBookings.map((booking) => (
                <div
                  key={booking._id}
                  className={`booking-item-card cook-booking-card cb-card st-${booking.status} clickable`}
                  data-status={booking.status}
                  onClick={(e) => openBooking(e, booking._id)}
                  onKeyDown={(e) => openBookingKey(e, booking._id)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open booking details for ${booking.customer?.name || "booking"}`}
                >
                  <div className="cb-top">
                    <div className="cb-id">
                      <span className="cook-avatar cb-avatar" aria-hidden="true">
                        {booking.customer?.name?.[0]?.toUpperCase() || "C"}
                      </span>
                      <div className="cb-id-text">
                        <div className="cb-name-row">
                          <h3>{booking.customer?.name || "Client"}</h3>
                          {(() => {
                            const tag = dayTagLabel(booking, today);
                            return tag ? (
                              <span
                                className={`cook-day-tag ${tag === "Today" ? "is-today" : "is-tomorrow"}`}
                              >
                                {tag}
                              </span>
                            ) : null;
                          })()}
                        </div>
                        <p className="cb-sub">
                          {booking.serviceType ? (
                            <span className="cb-sub-item">
                              <Soup size={12} />
                              {String(booking.serviceType).replace(/_/g, " ")}
                            </span>
                          ) : null}
                          {booking.guests ? (
                            <span className="cb-sub-item">
                              <Users size={12} />
                              {booking.guests} guest{Number(booking.guests) === 1 ? "" : "s"}
                            </span>
                          ) : null}
                          {!booking.serviceType && !booking.guests ? (
                            <span className="cb-sub-item">Booking #{String(booking._id || "").slice(-6).toUpperCase()}</span>
                          ) : null}
                        </p>
                      </div>
                    </div>
                    <div className="cb-badges">{getStatusLabel(booking.status)}</div>
                  </div>

                  <div className="cb-meta">
                    <div className="cb-meta-item">
                      <span className="cb-meta-ico" aria-hidden="true">
                        <CalendarDays size={15} />
                      </span>
                      <div>
                        <span className="cb-meta-label">When</span>
                        {(() => {
                          const tag = dayTagLabel(booking, today);
                          return tag ? (
                            <span className="cb-meta-value">{formatTimeRange12(booking.startTime, booking.endTime, "-")}</span>
                          ) : (
                            <span className="cb-meta-value">{formatDate(booking.date)} · {formatTimeRange12(booking.startTime, booking.endTime, "-")}</span>
                          );
                        })()}
                      </div>
                    </div>
                    {(booking.address || booking.addressDetails?.society || booking.location?.lat != null) && (
                      <div className="cb-meta-item cb-meta-where">
                        <div>
                          <span className="cb-meta-label">Customer location</span>
                          <span className="cb-meta-value cb-where-text">
                            <MapPin size={14} className="cb-where-icon" aria-hidden="true" />
                            {customerLocationLabel(booking) || "Customer location"}
                          </span>
                          {mapsNavigateUrl(booking) && (
                            <a
                              className="cook-addr-directions cb-directions"
                              href={mapsNavigateUrl(booking)}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              aria-label="Open customer's location in Google Maps"
                            >
                              <Navigation size={15} />
                              {booking.location?.lat != null ? "Open GPS pin in Maps" : "Get Directions"}
                            </a>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {booking.notes && (
                    <p className="cb-note">
                      <span className="cb-note-label">Note</span> {booking.notes}
                    </p>
                  )}

                  {booking.hoursCompleted && (
                    <div className="cb-hours-done">
                      <BellRing size={16} />
                      <span>Cooking hours complete — please wrap up the session.</span>
                    </div>
                  )}

                  {booking.status === "requested" && (
                    <div className="booking-actions-row cb-actions cook-request-actions">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={actingOn === booking._id}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRequestAction(booking, "accept");
                        }}
                        aria-label={`Accept booking from ${booking.customer?.name || "customer"}`}
                      >
                        <Check size={16} /> {actingOn === booking._id ? "Accepting…" : "Accept"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger-outline"
                        disabled={actingOn === booking._id}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRequestAction(booking, "reject");
                        }}
                        aria-label={`Ignore booking from ${booking.customer?.name || "customer"}`}
                      >
                        <XCircle size={16} /> {actingOn === booking._id ? "Ignoring…" : "Ignore"}
                      </button>
                    </div>
                  )}

                  {["accepted", "confirmed", "in_progress"].includes(booking.status) && (
                    <div className="booking-actions-row cb-actions">
                      <Link to={`/bookings/${booking._id}`} className="btn btn-outline btn-sm">
                        {booking.serviceStartedAt ? "View more" : "Start with OTP"} <ArrowRight size={15} />
                      </Link>
                      {/* No manual complete here by design — bookings complete
                          automatically once the service hours end. Cancel is
                          available until 30 minutes before the scheduled start
                          (mirror of the backend cutoff — the button hides once
                          locked; schedule-reached alone is not a start). */}
                      {!booking.serviceStartedAt && !isCancelLocked(booking) && (
                        <button
                          className="btn btn-danger-outline btn-sm"
                          onClick={() => setPendingCancelId(booking._id)}
                          disabled={cancellingId === booking._id}
                        >
                          <XCircle size={16} /> {cancellingId === booking._id ? "Cancelling…" : "Cancel Booking"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            ) : (
              <div className="cook-empty">
                <div className="cook-empty-icon">
                  {view === "needs-action" ? (
                    <Inbox size={28} />
                  ) : view === "today" ? (
                    <CalendarCheck size={28} />
                  ) : view === "tomorrow" ? (
                    <CalendarClock size={28} />
                  ) : view === "upcoming" ? (
                    <CalendarDays size={28} />
                  ) : (
                    <History size={28} />
                  )}
                </div>
                <h3>
                  {view === "needs-action"
                    ? "No new requests"
                    : view === "today"
                    ? "No bookings today"
                    : view === "tomorrow"
                    ? "No bookings tomorrow"
                    : view === "upcoming"
                    ? "Nothing scheduled"
                    : "No past bookings"}
                </h3>
                <p>
                  {view === "needs-action"
                    ? "You're all caught up — new booking requests will pop up here."
                    : view === "today"
                    ? "Bookings scheduled for today will show up here."
                    : view === "tomorrow"
                    ? "Bookings scheduled for tomorrow will show up here."
                    : view === "upcoming"
                    ? "Accepted bookings will appear here with everything you need for the day."
                    : "Settled bookings (done or declined) will show up here."}
                </p>
              </div>
            )
          ) : (
            !loadingBookings && (
              <div className="cook-empty">
                <div className="cook-empty-icon">
                  <ChefHat size={28} />
                </div>
                <h3>No bookings yet</h3>
                <p>Stay marked Available so customers can find and book you.</p>
              </div>
            )
          )}
        </div>
      )}

      {/* REPORTS TAB: complaints the cook filed — status + admin replies. */}
      {view === "reports" && (
        <div>
          <h3 style={{ fontSize: "1.1rem", marginBottom: "0.25rem" }}>My reports to support</h3>
          <p style={{ color: "var(--slate-500)", fontSize: "0.9rem", marginBottom: "1rem" }}>
            Issues you reported about customers. File a new one from the booking details page.
          </p>
          {!myComplaints || myComplaints.length === 0 ? (
            <div className="cook-empty">
              <div className="cook-empty-icon">
                <ShieldCheck size={28} />
              </div>
              <h3>No reports filed</h3>
              <p>If a customer causes trouble, report it from the booking and track it here.</p>
            </div>
          ) : (
            <div className="bookings-list-modern cook-bookings-grid">
              {(myComplaints || []).map((c) => (
                <div key={c._id} className="booking-item-card cook-booking-card cb-card">
                  <div className="cb-top">
                    <div className="cb-id">
                      <span className="cook-avatar cb-avatar" aria-hidden="true">
                        <ShieldCheck size={18} />
                      </span>
                      <div className="cb-id-text">
                        <div className="cb-name-row">
                          <h3 style={{ textTransform: "capitalize" }}>
                            {(c.category || "other").replace(/_/g, " ")}
                          </h3>
                        </div>
                        <p className="cb-sub">
                          {c.booking?.date ? (
                            <span className="cb-sub-item">
                              <CalendarDays size={12} />
                              {formatDate(c.booking.date)}
                            </span>
                          ) : null}
                          {c.customer?.name ? (
                            <span className="cb-sub-item">
                              <UserRound size={12} />
                              {c.customer.name}
                            </span>
                          ) : null}
                        </p>
                      </div>
                    </div>
                    <div className="cb-badges">
                      <span
                        className={`badge ${
                          c.status === "resolved"
                            ? "badge-emerald"
                            : c.status === "rejected"
                              ? "badge-rose"
                              : c.status === "in_review"
                                ? "badge-blue"
                                : "badge-amber"
                        }`}
                        style={{ textTransform: "capitalize" }}
                      >
                        {(c.status || "open").replace(/_/g, " ")}
                      </span>
                    </div>
                  </div>
                  <p className="cb-note">{c.message}</p>
                  {c.adminNote && (
                    <p className="cb-note">
                      <span className="cb-note-label">Support reply</span> {c.adminNote}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* PROFILE TAB: cook profile + working hours + payouts + recent reviews */}
      {view === "profile" && (
        <div>
          <CookProfileManager onSaved={() => refetchCookProfile()} />
          {cookProfile && (
            <CookScheduleEditor profile={cookProfile} onSaved={() => refetchCookProfile()} />
          )}
          {cookProfile && <CookPayoutPanel />}
          <RecentReviewsPreview reviews={myReviews} loading={loadingReviews} />
        </div>
      )}

      {/* Booking request modal — auto-pops for every new `requested`
          booking (polling + queue above) and on "Respond to Request".
          Lives here so it sees requestModalBooking state + refetchBookings.
          Shows the job summary with Accept / Decline buttons. */}
      <BookingRequestModal
        open={!!requestModalBooking}
        onClose={() => {
          const closedId = requestModalBooking?._id;
          setRequestModalBooking(null);
          popNextPendingRequest(closedId);
        }}
        booking={requestModalBooking}
        onAction={() => {
          /* Modal handles its own API call + toast + close; we just
             refetch here in case parent state is stale. */
          const actedId = requestModalBooking?._id;
          refetchBookings();
          popNextPendingRequest(actedId);
        }}
      />
      <ConfirmDialog
        open={!!pendingCancelId}
        title="Cancel this booking session?"
        message="The customer will be notified and the slot will be released. This cannot be undone."
        confirmLabel="Yes, cancel it"
        tone="danger"
        busy={!!cancellingId}
        onCancel={() => setPendingCancelId(null)}
        onConfirm={handleCancel}
      />
    </div>
  );
};

const RecentReviewsPreview = ({ reviews, loading }) => {
  const list = (reviews || []).slice(0, 3);
  const total = (reviews || []).length;
  if (loading) return <p className="cook-loading-text">Loading reviews...</p>;
  if (!list.length) return null;
  return (
    <div className="cook-card cook-spaced-top">
      <div className="cook-recent-head">
        <h3>Recent reviews ({total})</h3>
        {total > 3 && (
          <Link to="/dashboard/cook-reviews" className="cook-link-btn">
            See all reviews →
          </Link>
        )}
      </div>
      <div className="cook-recent-list">
        {list.map((rev) => (
          <div key={rev._id} className="cook-recent-row">
            <span className="cook-avatar">
              {rev.customer?.name?.[0]?.toUpperCase() || "C"}
            </span>
            <div className="cook-review-who">
              <div className="cook-recent-row-head">
                <strong>{rev.customer?.name || "Customer"}</strong>
                <span className="cook-stars">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <Star
                      key={s}
                      size={13}
                      fill={s <= Number(rev.rating || 0) ? "#f59e0b" : "none"}
                      color={s <= Number(rev.rating || 0) ? "#f59e0b" : "#cbd5e1"}
                    />
                  ))}
                </span>
              </div>
              {rev.comment ? (
                <p className="cook-recent-comment">"{rev.comment}"</p>
              ) : (
                <p className="cook-recent-nocomment">Rated {rev.rating}/5 with no written feedback.</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// Profile tab reuses the shared cook profile form (same as the Cook Setup
// page) so the two can never diverge again.
const CookProfileManager = ({ onSaved }) => {
  return (
    <div className="cook-profile-wrap">
      <CookProfileForm
        createTitle="Create Your Cook Profile"
        manageTitle="Edit Your Cook Profile"
        onSaved={onSaved}
      />
    </div>
  );
};

export default CookDashboard;
