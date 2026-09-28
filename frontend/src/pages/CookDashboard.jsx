import React, { useState, useEffect, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import API from "../api/axios";
import { useSelector } from "react-redux";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate, playAlarmSound, hasServiceHoursStarted, localTodayStr } from "../utils/constants";
import CookProfileForm from "../components/CookProfileForm";
import CookAvailabilityToggle from "../components/CookAvailabilityToggle";
import CookEventBookings from "../components/CookEventBookings";
import { resolveFileUrl } from "../components/CookDocUploads";
import { Check, X, XCircle, BellRing, ArrowRight, Star, MapPin, CalendarDays, Inbox, History, UserRound, Wallet, ChefHat, AlertCircle, ShieldCheck, Clock } from "lucide-react";

const CookDashboard = () => {
  const { data: bookings, loading: loadingBookings, error: bookingError, refetch: refetchBookings } = useFetch("/bookings/cook");
  const { data: cookProfile, loading: loadingProfile, refetch: refetchCookProfile } = useFetch("/cooks/me");
  const { data: myReviews, loading: loadingReviews } = useFetch("/reviews/cook-me");
  const { data: myComplaints } = useFetch("/complaints/my");
  const showToast = useShowToast();
  const user = useSelector((s) => s.auth.user);
  const navigate = useNavigate();
  const [view, setView] = useState("needs-action");
  const [cancellingId, setCancellingId] = useState(null);
  const seenHoursDone = useRef(new Set());
  const firstLoadDone = useRef(false);

  // Poll bookings so the hours-complete alarm fires without refresh.
  // Calmed for scale: 30s -> 60s + hidden-tab pause, so a dashboard left open
  // in a background tab stops hitting the API entirely.
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) refetchBookings();
    };
    const id = setInterval(tick, 60000);
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

  const handleAction = async (bookingId, action) => {
    try {
      await API.patch(`/bookings/${bookingId}/${action}`);
      showToast(
        action === "accept" ? "Booking accepted" : action === "reject" ? "Booking declined" : `Booking ${action}d`,
        action === "reject" ? "info" : "success"
      );
      refetchBookings();
    } catch (err) {
      showToast(err.response?.data?.message || `Failed to ${action} booking`, "error");
    }
  };

  const handleCancel = async (bookingId) => {    if (cancellingId) return;
    if (!window.confirm("Are you sure you want to cancel this booking session?")) return;
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
      case "rejected":
        return <span className="badge badge-rose">Declined</span>;
      case "cancelled":
        return <span className="badge badge-slate">Cancelled</span>;
      default:
        return <span className="badge badge-slate">{status}</span>;
    }
  };

  // Counts for the greeting + tabs. Per-booking payment badges show earnings
  // where they matter (on each card).
  const pendingRequests = bookings?.filter((b) => b.status === "requested")?.length || 0;

  // Views: needs-action (new requests) vs upcoming (all live) vs previous.
  const isPrevious = (b) => ["completed", "cancelled", "rejected"].includes(b.status);  // Actionable first: new requests on top, then scheduled, then by date.
  const statusRank = (s) =>
    ({ requested: 0, accepted: 1, confirmed: 1, in_progress: 2 }[s] ?? 3);
  const visibleBookings = [...(bookings || [])]
    .filter((b) => {
      if (view === "needs-action") return b.status === "requested";
      if (view === "upcoming") return !isPrevious(b);
      if (view === "previous") return isPrevious(b);
      return true;
    })
    .sort((a, b) => {
      if (view === "previous") return new Date(b.date) - new Date(a.date);
      return statusRank(a.status) - statusRank(b.status) || new Date(a.date) - new Date(b.date);
    });
  const previousCount = (bookings || []).filter(isPrevious).length;
  const upcomingCount = (bookings || []).length - previousCount;
  const completedCount = bookings?.filter((b) => b.status === "completed")?.length || 0;
  // Paid-out earnings (real gateway payments only — mirrors the server rule).
  const totalEarned = (bookings || []).reduce(
    (s, b) =>
      b.payment?.status === "paid" && b.payment?.razorpayPaymentId
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

  return (
    <div className="dashboard-container cook-dash">
      {/* Hero — greeting, verification, rating, availability */}
      <div className="cook-modern-hero cook-hero">
        <div className="cook-modern-hero-inner">
          <div className="cook-modern-avatar-wrap">
            {cookProfile?.photoUrl ? (
              <img src={resolveFileUrl(cookProfile.photoUrl)} alt={user?.name || "Cook"} className="cook-modern-avatar" />
            ) : (
              <span className="cook-modern-avatar-fallback">
                {firstName?.[0]?.toUpperCase() || <ChefHat size={32} />}
              </span>
            )}
            {approval === "approved" && (
              <span className="verified-dot" title="Verified cook">✓</span>
            )}
          </div>
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
          <Inbox size={15} /> New <span className="cook-tab-count">{pendingRequests}</span>
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
          className={`cook-tab ${view === "events" ? "active" : ""}`}
          onClick={() => setView("events")}
        >
          <CalendarDays size={15} /> Events
        </button>
        <button
          className={`cook-tab ${view === "reports" ? "active" : ""}`}
          onClick={() => setView("reports")}
        >
          <AlertCircle size={15} /> My reports{" "}
          <span className="cook-tab-count">{(myComplaints || []).length}</span>
        </button>
        <button
          className={`cook-tab ${view === "slots" ? "active" : ""}`}
          onClick={() => setView("slots")}
        >
          <Clock size={15} /> Slots
        </button>
        <button
          className={`cook-tab ${view === "profile" ? "active" : ""}`}
          onClick={() => setView("profile")}
        >
          <UserRound size={15} /> Profile
        </button>
      </div>

      {/* BOOKINGS VIEWS */}
      {view !== "profile" && view !== "reports" && view !== "slots" && view !== "events" && (
        <div>

          {loadingBookings && <p className="cook-loading-text">Loading bookings...</p>}

          {bookingError && <p className="error">{bookingError}</p>}

          {!loadingBookings && bookings && bookings.length > 0 ? (
            visibleBookings.length > 0 ? (
            <div className="bookings-list-modern">
              {visibleBookings.map((booking) => (
                <div
                  key={booking._id}
                  className={`booking-item-card cook-booking-card st-${booking.status} clickable`}
                  onClick={(e) => openBooking(e, booking._id)}
                  onKeyDown={(e) => openBookingKey(e, booking._id)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open booking details for ${booking.customer?.name || "booking"}`}
                >
                  <div className="cook-card-top">
                    <div className="cook-customer-row">
                      <span className="cook-avatar">
                        {booking.customer?.name?.[0]?.toUpperCase() || "C"}
                      </span>
                      <div className="cook-customer-meta">
                        <h3>{booking.customer?.name || "Client"}</h3>
                        <p className="cook-when">
                          <CalendarDays size={13} />
                          {formatDate(booking.date)} · {booking.startTime} - {booking.endTime}
                        </p>
                        {booking.address && (
                          <p className="cook-addr">
                            <MapPin size={13} />
                            <span>{booking.address}</span>
                          </p>
                        )}
                      </div>
                    </div>
                    <div>{getStatusLabel(booking.status)}</div>
                  </div>

                  <div className="cook-money">
                    <span className="cook-money-amount">
                      {formatCurrency(booking.payment?.status === "paid"
                        ? booking.payment.paidAmount || booking.amount || 0
                        : booking.amount || 0)}
                    </span>
                    {booking.payment?.status === "paid" ? (
                      <span className="cook-pay-pill paid"><Check size={12} /> Paid</span>
                    ) : (
                      <span className="cook-pay-pill unpaid">Unpaid</span>
                    )}
                  </div>

                  {booking.notes && (
                    <p className="cook-card-note">
                      Note: {booking.notes}
                    </p>
                  )}

                  {booking.hoursCompleted && (
                    <div className="cook-hours-done">
                      <BellRing size={16} />
                      <span>Cooking hours complete — please wrap up the session.</span>
                    </div>
                  )}

                  {booking.status === "requested" && (
                    <div className="booking-actions-row">
                      <button className="btn btn-success" onClick={() => handleAction(booking._id, "accept")}>
                        <Check size={16} /> Accept
                      </button>
                      <button className="btn btn-danger-outline" onClick={() => handleAction(booking._id, "reject")}>
                        <X size={16} /> Decline
                      </button>
                      <Link to={`/bookings/${booking._id}`} className="btn btn-outline btn-sm">
                        Open <ArrowRight size={15} />
                      </Link>
                    </div>
                  )}

                  {["accepted", "confirmed", "in_progress"].includes(booking.status) && (
                    <div className="booking-actions-row">
                      <Link to={`/bookings/${booking._id}`} className="btn btn-outline btn-sm">
                        {booking.serviceStartedAt ? "View more" : "Start with OTP"} <ArrowRight size={15} />
                      </Link>
                      {/* No manual complete here by design — bookings complete
                          automatically once the service hours end. */}
                      {!hasServiceHoursStarted(booking) && (
                        <button
                          className="btn btn-danger-outline btn-sm"
                          onClick={() => handleCancel(booking._id)}
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
                  {view === "needs-action" ? <Inbox size={28} /> : view === "upcoming" ? <CalendarDays size={28} /> : <History size={28} />}
                </div>
                <h3>
                  {view === "needs-action" ? "No new requests" : view === "upcoming" ? "Nothing scheduled" : "No past bookings"}
                </h3>
                <p>
                  {view === "needs-action"
                    ? "You're all caught up — new booking requests will pop up here."
                    : view === "upcoming"
                    ? "Accepted bookings will appear here with everything you need for the day."
                    : "Completed, cancelled and declined bookings will show up here."}
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

      {/* EVENTS TAB: CookMitra-assigned event bookings (§13) with full
          event details + event earnings. */}
      {view === "events" && (
        <div>
          <h3 style={{ fontSize: "1.1rem", marginBottom: "0.25rem" }}>Event Assignments</h3>
          <p style={{ color: "var(--slate-500)", fontSize: "0.9rem", marginBottom: "1rem" }}>
            Birthdays, anniversaries and family functions CookMitra assigns to you.
          </p>
          <CookEventBookings />
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
            <div className="bookings-list-modern">
              {(myComplaints || []).map((c) => (
                <div key={c._id} className="booking-item-card">
                  <div className="cook-card-top">
                    <div>
                      <h3 style={{ margin: 0, textTransform: "capitalize" }}>
                        {(c.category || "other").replace(/_/g, " ")}
                      </h3>
                      <p className="cook-when">
                        {c.booking?.date ? formatDate(c.booking.date) : ""}{" "}
                        {c.customer?.name ? `· ${c.customer.name}` : ""}
                      </p>
                    </div>
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
                  <p className="cook-card-note">{c.message}</p>
                  {c.adminNote && (
                    <p className="cook-card-note">
                      <strong>Support reply:</strong> {c.adminNote}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* SLOTS TAB: publish/block availability windows per day. */}
      {view === "slots" && <SlotManager />}

      {/* PROFILE TAB: cook profile + recent reviews */}
      {view === "profile" && (
        <div>
          <CookProfileManager onSaved={() => refetchCookProfile()} />
          <RecentReviewsPreview reviews={myReviews} loading={loadingReviews} />
        </div>
      )}
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

// Slots tab: publish availability windows per day (POST /availability) and
// remove them (DELETE /availability/:id). Days with no windows stay fully
// open (08:00–20:00); adding a window restricts that day to listed windows.
// Existing bookings are unaffected by window changes.
const SlotManager = () => {
  const showToast = useShowToast();
  const { data: mySlots, loading, refetch } = useFetch("/availability/my");
  const [date, setDate] = useState(localTodayStr());
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("13:00");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const dayKey = (d) => {
    try {
      return new Date(d).toLocaleDateString("en-CA");
    } catch {
      return "";
    }
  };
  const daySlots = (mySlots || [])
    .filter((s) => dayKey(s.date) === date)
    .sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!date || !startTime || !endTime) {
      showToast("Pick a date, start and end time", "error");
      return;
    }
    if (startTime >= endTime) {
      showToast("End time must be after start time", "error");
      return;
    }
    setSaving(true);
    try {
      await API.post("/availability", { date, startTime, endTime });
      showToast("Availability window added — customers can now book it.", "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Could not add window", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (slot) => {
    if (!window.confirm(`Remove ${slot.startTime}–${slot.endTime} on ${date}? Existing bookings stay valid.`)) return;
    setDeletingId(slot._id);
    try {
      await API.delete(`/availability/${slot._id}`);
      showToast("Window removed.", "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Could not remove window", "error");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div>
      <h3 style={{ fontSize: "1.1rem", marginBottom: "0.25rem" }}>Availability windows</h3>
      <p style={{ color: "var(--slate-500)", fontSize: "0.9rem", marginBottom: "1rem" }}>
        Days with no windows stay fully open (8 AM – 8 PM). Add windows to restrict a day,
        or remove them all to reopen it. Use the Available/Unavailable toggle above for full days off.
      </p>
      <form onSubmit={handleAdd} className="bk-card" style={{ marginBottom: "1rem" }}>
        <div className="bk-addr-grid">
          <input
            type="date"
            className="bk-addr-input"
            value={date}
            min={localTodayStr()}
            onChange={(e) => setDate(e.target.value)}
            required
          />
          <input
            type="time"
            className="bk-addr-input"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            required
          />
          <input
            type="time"
            className="bk-addr-input"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            required
          />
        </div>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving} style={{ marginTop: "0.6rem" }}>
          {saving ? "Adding…" : "Add window"}
        </button>
      </form>
      {loading ? (
        <p className="cook-loading-text">Loading windows…</p>
      ) : daySlots.length === 0 ? (
        <div className="cook-empty">
          <div className="cook-empty-icon">
            <Clock size={28} />
          </div>
          <h3>Whole day open</h3>
          <p>No windows on {date || "this date"} — customers can book any time 8 AM – 8 PM.</p>
        </div>
      ) : (
        <div className="bookings-list-modern">
          {daySlots.map((s) => (
            <div key={s._id} className="booking-item-card">
              <div className="cook-card-top">
                <div>
                  <h3 style={{ margin: 0 }}>{s.startTime} – {s.endTime}</h3>
                  <p className="cook-when">{date}</p>
                </div>
                <button
                  className="btn btn-danger-outline btn-sm"
                  onClick={() => handleDelete(s)}
                  disabled={deletingId === s._id}
                >
                  <X size={15} /> {deletingId === s._id ? "Removing…" : "Remove"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
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
