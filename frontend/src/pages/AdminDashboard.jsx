import React, { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { useFetch } from "../hooks/useFetch";
import { normalizeRole } from "../store/authSlice";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate, formatTimeRange12, playAlarmSound } from "../utils/constants";
import AddCookModal from "../components/AddCookModal";
import BookingRequestModal from "../components/BookingRequestModal";
import AdminDocViewer from "../components/AdminDocViewer";
import AdminDocUpload from "../components/AdminDocUpload";
import CouponManagement from "../components/CouponManagement";
import VisitStats from "../components/VisitStats";
import AnalyticsPanel from "../components/AnalyticsPanel";
import AdminPayoutsPanel from "../components/AdminPayoutsPanel";
import ConfirmDialog from "../components/ConfirmDialog";
import {
  ShieldAlert,
  Users,
  Calendar,
  ChefHat,
  Check,
  X,
  CheckCircle2,
  AlertCircle,
  MessageCircle,
  Tag,
  Trash2,
  Plus,
  Ban,
  ShieldCheck,
  UserPlus,
  Mail,
  Lock,
  User,
  Phone,
  Eye,
  EyeOff,
  Copy,
  Briefcase,
  MapPin,
  Wallet,
  Clock,
  Clock3,
  Star,
  UtensilsCrossed,
  Hourglass,
  ArrowRight,
  Banknote,
  XCircle,
  BarChart3,
  Upload,
} from "lucide-react";
import { resolveFileUrl } from "../components/CookDocUploads";

const AdminDashboard = () => {  const [activeTab, setActiveTab] = useState("bookings");

  return (
    <div className="dashboard-container">
      <div className="dashboard-header-row">
        <div>
          <span className="badge badge-festive" style={{ marginBottom: "0.5rem" }}>
            <ShieldAlert size={14} /> System Administration
          </span>
          <h1>Admin Control Panel</h1>
          <p style={{ color: "var(--slate-600)", margin: 0 }}>
            Oversee cook verification, monitor marketplace bookings, and audit user accounts.
          </p>
        </div>
        <div>
          <Link to="/admin/complaints" className="btn btn-outline btn-sm">
            <ShieldAlert size={15} /> Cook Complaints
          </Link>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs-navigation-bar">
        <button
          className={`tab-btn ${activeTab === "bookings" ? "active" : ""}`}
          onClick={() => setActiveTab("bookings")}
        >
          <Calendar size={17} /> Platform Bookings
        </button>
        <button
          className={`tab-btn ${activeTab === "cooks" ? "active" : ""}`}
          onClick={() => setActiveTab("cooks")}
        >
          <ChefHat size={17} /> Cook Approvals
        </button>
        <button
          className={`tab-btn ${activeTab === "users" ? "active" : ""}`}
          onClick={() => setActiveTab("users")}
        >
          <Users size={17} /> User Directory
        </button>
        <button
          className={`tab-btn ${activeTab === "admins" ? "active" : ""}`}
          onClick={() => setActiveTab("admins")}
        >
          <ShieldCheck size={17} /> Admins
        </button>
        <button
          className={`tab-btn ${activeTab === "leads" ? "active" : ""}`}
          onClick={() => setActiveTab("leads")}
        >
          <MessageCircle size={17} /> WhatsApp Enquiries
        </button>
        <button
          className={`tab-btn ${activeTab === "coupons" ? "active" : ""}`}
          onClick={() => setActiveTab("coupons")}
        >
          <Tag size={17} /> Coupons
        </button>
        <button
          className={`tab-btn ${activeTab === "visits" ? "active" : ""}`}
          onClick={() => setActiveTab("visits")}
        >
          <Eye size={17} /> Site Visits
        </button>
        <button
          className={`tab-btn ${activeTab === "payouts" ? "active" : ""}`}
          onClick={() => setActiveTab("payouts")}
        >
          <Wallet size={17} /> Payouts
        </button>
        <button
          className={`tab-btn ${activeTab === "analytics" ? "active" : ""}`}
          onClick={() => setActiveTab("analytics")}
        >
          <BarChart3 size={17} /> Analytics
        </button>
      </div>

      {activeTab === "cooks" && <CookManagement />}
      {activeTab === "bookings" && <BookingManagement />}
      {activeTab === "users" && <UserManagement />}
      {activeTab === "admins" && <AdminManagement />}
      {activeTab === "leads" && <LeadManagement />}
      {activeTab === "coupons" && <CouponManagement />}
      {activeTab === "payouts" && <AdminPayoutsPanel />}
      {activeTab === "visits" && <VisitStats />}
      {activeTab === "analytics" && <AnalyticsPanel />}
    </div>
  );
};

const CookManagement = () => {
  const { data: cooks, loading, refetch } = useFetch("/cooks");
  const showToast = useShowToast();
  const [showAddCook, setShowAddCook] = useState(false);

  const handleApproval = async (cookId, status) => {
    try {
      await API.patch(`/cooks/${cookId}/approval`, { status });
      showToast(`Cook profile marked as ${status}!`, "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Action failed", "error");
    }
  };

  // Approval directory (P2-18): All / Pending / Approved / Rejected views so
  // approved and rejected records are never hidden from the directory.
  // Filtering is a display convenience only — every action re-checks
  // admin authorization server-side.
  const [cookFilter, setCookFilter] = useState("pending");
  const COOK_FILTERS = [
    { key: "all", label: "All" },
    { key: "pending", label: "Pending" },
    { key: "approved", label: "Approved" },
    { key: "rejected", label: "Rejected" },
  ];
  const filteredCooks = (cooks || []).filter((c) =>
    cookFilter === "all" ? true : (c.approvalStatus || "pending") === cookFilter
  );
  const cookCounts = (cooks || []).reduce(
    (acc, c) => {
      const k = c.approvalStatus || "pending";
      acc.all += 1;
      if (acc[k] !== undefined) acc[k] += 1;
      return acc;
    },
    { all: 0, pending: 0, approved: 0, rejected: 0 }
  );

  return (
    <div>
      <div className="admin-section-head admin-section-head--toolbar">
        <h2>Cook Profile Verifications</h2>
        <div className="admin-section-actions">
          <div className="admin-bookings-filters" role="tablist" aria-label="Cook approval filter">
            {COOK_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={cookFilter === f.key}
                className={`admin-filter-chip ${cookFilter === f.key ? "is-active" : ""}`}
                onClick={() => setCookFilter(f.key)}
              >
                {f.label}
                <span className="admin-filter-count">{cookCounts[f.key] ?? 0}</span>
              </button>
            ))}
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowAddCook(true)}
          >
            <Plus size={16} /> Add Cook
          </button>
        </div>
      </div>

      <AddCookModal
        open={showAddCook}
        onClose={() => setShowAddCook(false)}
        onCreated={() => {
          refetch();
          setShowAddCook(false);
        }}
      />

      {loading ? (
        <div className="loading-spinner-wrapper">
          <div className="spinner"></div>
          <p>Loading cooks...</p>
        </div>
      ) : filteredCooks.length > 0 ? (
        <div className="bookings-list-modern">
          {filteredCooks.map((cook) => {
            const status = cook.approvalStatus || "pending";
            return (
            <article key={cook._id} className={`admin-cook-card acc-status-${status}`}>
              {/* ── Header: avatar + identity + status ── */}
              <header className="acc-head">
                <div className="acc-ava acc-ava-wrap">
                  {cook.photoUrl ? (
                    <img src={resolveFileUrl(cook.photoUrl)} alt={cook.user?.name || "Cook"} />
                  ) : (
                    <span className="acc-ava-initial">{(cook.user?.name || "C")[0].toUpperCase()}</span>
                  )}
                  <span
                    className={`acc-ava-dot acc-dot-${status}`}
                    aria-hidden="true"
                  />
                </div>
                <div className="acc-id">
                  <h3>{cook.user?.name || "Cook Applicant"}</h3>
                  <p className="acc-id-email">
                    <Mail size={12} />
                    {cook.user?.email}
                  </p>
                </div>
                <span
                  className={`acc-badge acc-badge-${status}`}
                  aria-label={`Approval status: ${status}`}
                >
                  {status === "approved" ? (
                    <CheckCircle2 size={14} />
                  ) : status === "rejected" ? (
                    <XCircle size={14} />
                  ) : (
                    <Clock size={14} />
                  )}
                  {status === "approved" ? "Approved" : status === "rejected" ? "Rejected" : "Pending"}
                </span>
              </header>

              {/* ── Fact tiles: experience + rate + service area ── */}
              <div className="acc-stats">
                <div className="acc-stat">
                  <span className="acc-stat-ico"><Briefcase size={14} /></span>
                  <span className="acc-stat-body">
                    <span className="acc-stat-label">Experience</span>
                    <span className="acc-stat-value">{cook.experienceYears} yrs</span>
                  </span>
                </div>
                <div className="acc-stat acc-stat-rate">
                  <span className="acc-stat-ico"><Wallet size={14} /></span>
                  <span className="acc-stat-body">
                    <span className="acc-stat-label">Rate</span>
                    <span className="acc-stat-value">{formatCurrency(cook.rate)}/hr</span>
                  </span>
                </div>
                {cook.serviceArea && (
                  <div className="acc-stat acc-stat-area">
                    <span className="acc-stat-ico"><MapPin size={14} /></span>
                    <span className="acc-stat-body">
                      <span className="acc-stat-label">Service area</span>
                      <span className="acc-stat-value">{cook.serviceArea}</span>
                    </span>
                  </div>
                )}
              </div>

              {/* ── Specialties ── */}
              {(cook.specialties || []).length > 0 && (
                <div className="acc-section">
                  <span className="acc-section-label">Specialties</span>
                  <div className="acc-specialties">
                    {(cook.specialties || []).slice(0, 4).map((s) => (
                      <span key={s} className="acc-spec-chip">
                        <ChefHat size={12} /> {s}
                      </span>
                    ))}
                    {(cook.specialties?.length || 0) > 4 && (
                      <span className="acc-spec-chip acc-spec-more">
                        +{cook.specialties.length - 4} more
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* ── Bio / skills ── */}
              {(cook.skills || cook.bio) && (
                <div className="acc-section">
                  <span className="acc-section-label">About</span>
                  <p className="acc-bio-text">{cook.skills || cook.bio}</p>
                </div>
              )}

              {/* ── Verification documents ── */}
              <div className="acc-section acc-docs-section">
                <span className="acc-section-label">
                  <ShieldCheck size={13} />
                  Verification documents
                </span>
                <AdminDocViewer
                  docs={[
                    { label: "Aadhaar Card", url: cook.aadharCardUrl },
                    { label: "PAN Card", url: cook.panCardUrl },
                    { label: "Profile Photo", url: cook.photoUrl },
                    ...(cook.documents || []).map((d) => ({
                      label: d.label || "Document",
                      url: d.url,
                    })),
                  ]}
                />
              </div>

              {/* ── Admin upload on behalf of cook (collapsed by default) ── */}
              <details className="acc-upload-zone">
                <summary className="acc-upload-head">
                  <Upload size={13} />
                  <span>Attach additional document</span>
                </summary>
                <div className="acc-upload-body">
                  <AdminDocUpload
                    cookId={cook._id}
                    current={cook}
                    onUploaded={refetch}
                  />
                </div>
              </details>

              {/* ── Actions: one clear footer bar ── */}
              <footer className="acc-actions">
                <div className="acc-actions-main">
                  {status === "pending" && (
                    <>
                      <button
                        className="acc-btn acc-btn-approve"
                        onClick={() => handleApproval(cook._id, "approved")}
                      >
                        <Check size={16} /> Approve cook
                      </button>
                      <button
                        className="acc-btn acc-btn-reject"
                        onClick={() => handleApproval(cook._id, "rejected")}
                      >
                        <X size={16} /> Reject
                      </button>
                    </>
                  )}
                  {status !== "pending" && (
                    <span className="acc-decision-note">
                      {status === "approved" ? (
                        <><CheckCircle2 size={14} /> Application approved</>
                      ) : (
                        <><XCircle size={14} /> Application rejected</>
                      )}
                    </span>
                  )}
                </div>
                <Link to={`/admin/cooks/${cook._id}`} className="acc-btn-link">
                  Full dossier
                  <ArrowRight size={14} />
                </Link>
              </footer>
            </article>
            );
          })}
        </div>
      ) : (
        <div className="admin-bookings-empty">
          <span className="admin-bookings-empty-ico"><ChefHat size={22} /></span>
          <h3>{(cooks || []).length > 0 ? "Nothing matches this filter" : "No cooks yet"}</h3>
          <p>
            {(cooks || []).length > 0
              ? "Try a different status filter to see more applications."
              : "Cook applications will appear here as soon as they sign up."}
          </p>
        </div>
      )}
    </div>
  );
};

const BookingManagement = () => {
  const { data: bookings, loading, refetch } = useFetch("/bookings");
  const showToast = useShowToast();
  const [bookingFilter, setBookingFilter] = useState("all");
  // F-06: per-booking busy state — double-clicking Accept/Complete/Cancel
  // previously double-fired the PATCH (the cook dashboard already has this).
  const [actingId, setActingId] = useState(null);
  // { bookingId, action } awaiting dialog confirmation.
  const [pendingAction, setPendingAction] = useState(null);

  // ── Incoming-request popup ──
  // A customer request interrupts the admin the same way it interrupts the
  // cook: the newest unseen request auto-opens in BookingRequestModal (older
  // ones queue behind it), and the list polls every 15s — paused on hidden
  // tabs — so a request created while this tab is open pops without a manual
  // refresh.
  const [requestModalBooking, setRequestModalBooking] = useState(null);
  const seenRequestIds = useRef(new Set());
  const requestsInit = useRef(false);

  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) refetch();
    }, 15000);
    const onVisible = () => {
      if (!document.hidden) refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refetch]);

  const byNewest = (a, b) =>
    new Date(b?.createdAt).getTime() - new Date(a?.createdAt).getTime() ||
    String(b._id || "").localeCompare(String(a._id || ""));

  useEffect(() => {
    if (!bookings) return;
    const requested = (bookings || []).filter((b) => b?.status === "requested").sort(byNewest);
    if (!requestsInit.current) {
      requestsInit.current = true;
      if (!requested.length) return;
      // Seed everything except the newest as seen, then pop the newest so an
      // already-waiting request greets the admin on open too.
      requested.slice(1).forEach((b) => seenRequestIds.current.add(String(b._id)));
      const newest = requested[0];
      seenRequestIds.current.add(String(newest._id));
      if (!requestModalBooking) {
        setRequestModalBooking(newest);
        playAlarmSound();
      }
      return;
    }
    const fresh = requested.filter((b) => !seenRequestIds.current.has(String(b._id)));
    if (!fresh.length) return;
    fresh.forEach((b) => seenRequestIds.current.add(String(b._id)));
    if (!requestModalBooking) {
      setRequestModalBooking([...fresh].sort(byNewest)[0]);
      playAlarmSound();
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

  // After a dialog closes (accept / decline / dismiss), pop the next
  // still-pending request so stacked arrivals are each answered in turn.
  const popNextPendingRequest = (excludeId) => {
    const next = (bookings || [])
      .filter((b) => b?.status === "requested" && String(b._id) !== String(excludeId || ""))
      .sort(byNewest)[0];
    if (next) {
      seenRequestIds.current.add(String(next._id));
      setTimeout(() => {
        setRequestModalBooking(next);
        playAlarmSound();
      }, 350);
    }
  };

  const ACTION_COPY = {
    accept: {
      title: "Accept this request?",
      message: "Accept on behalf of the cook? The slot will be BOOKED and the customer will have 5 minutes to pay.",
      confirmLabel: "Accept request",
      tone: "emerald",
    },
    reject: {
      title: "Decline this request?",
      message: "Decline on behalf of the cook? The customer will be notified and the slot stays open.",
      confirmLabel: "Decline request",
      tone: "danger",
    },
    complete: {
      title: "Mark service completed?",
      message: "Mark this service as completed on behalf of the cook? The customer will be asked to rate the cook.",
      confirmLabel: "Mark completed",
      tone: "emerald",
    },
    cancel: {
      title: "Cancel this booking?",
      message: "Cancel this booking as admin? Paid bookings are refunded and the slot is released.",
      confirmLabel: "Cancel booking",
      tone: "danger",
    },
  };

  const handleAction = async () => {
    const pending = pendingAction;
    if (actingId || !pending) return;
    const { bookingId, action } = pending;
    setPendingAction(null);
    setActingId(`${bookingId}:${action}`);
    try {
      await API.patch(`/bookings/${bookingId}/${action}`);
      showToast(
        action === "accept"
          ? "Request accepted on behalf of the cook — the cook has been notified!"
          : action === "complete"
          ? "Service marked completed on behalf of the cook!"
          : action === "cancel"
          ? "Booking cancelled — slot released."
          : "Request declined on behalf of the cook — the cook has been notified!",
        action === "reject" ? "info" : "success"
      );
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Action failed", "error");
    } finally {
      setActingId(null);
    }
  };

  const isPast = (b) => ["completed", "cancelled", "rejected", "expired", "unattended"].includes(b.status);
  const isUpcoming = (b) => ["accepted", "confirmed", "in_progress"].includes(b.status);

  const newCount = (bookings || []).filter((b) => b.status === "requested").length;
  const upcomingCount = (bookings || []).filter(isUpcoming).length;
  const pastCount = (bookings || []).filter(isPast).length;

  // Every tab shows newer bookings first (creation time, newest → oldest).
  const createdMs = (b) => {
    const t = new Date(b?.createdAt).getTime();
    return Number.isFinite(t) ? t : 0;
  };

  const visibleBookings = [...(bookings || [])]
    .filter((b) => {
      if (bookingFilter === "new") return b.status === "requested";
      if (bookingFilter === "upcoming") return isUpcoming(b);
      if (bookingFilter === "past") return isPast(b);
      return true;
    })
    .sort(
      (a, b) =>
        createdMs(b) - createdMs(a) ||
        String(b._id || "").localeCompare(String(a._id || ""))
    );

  const paymentLabel = (booking) => {
    const paid = booking.payment?.status === "paid";
    const amount = paid
      ? Number(booking.payment?.paidAmount || booking.amount || 0)
      : Number(booking.amount || 0);
    return { paid, amount };
  };

  const prettyService = (s) =>
    String(s || "General service")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());

  const STATUS_META = {
    requested: { label: "New request", pill: "badge-amber" },
    accepted: { label: "Accepted", pill: "badge-blue" },
    confirmed: { label: "Confirmed", pill: "badge-blue" },
    in_progress: { label: "In progress", pill: "badge-purple" },
    completed: { label: "Completed", pill: "badge-emerald" },
    cancelled: { label: "Cancelled", pill: "badge-slate" },
    rejected: { label: "Declined", pill: "badge-rose" },
    expired: { label: "Expired", pill: "badge-slate" },
    unattended: { label: "Unattended", pill: "badge-rose" },
  };
  const statusMeta = (s) => STATUS_META[s] || { label: String(s || "Booking").replace(/_/g, " "), pill: "badge-slate" };

  return (
    <div className="admin-bookings">
      <div className="admin-bookings-head">
        <div className="admin-bookings-title">
          <h2>All Platform Bookings</h2>
          <p>{(bookings || []).length} total • {newCount} awaiting cook decision</p>
        </div>
        <div className="admin-bookings-filters" role="tablist" aria-label="Filter bookings">
          {[
            { id: "all", label: "All", count: (bookings || []).length },
            { id: "new", label: "New", count: newCount },
            { id: "upcoming", label: "Upcoming", count: upcomingCount },
            { id: "past", label: "Past", count: pastCount },
          ].map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={bookingFilter === f.id}
              onClick={() => setBookingFilter(f.id)}
              className={`admin-filter-chip ${bookingFilter === f.id ? "is-active" : ""}`}
            >
              {f.label}
              <span className="admin-filter-count">{f.count}</span>
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="loading-spinner-wrapper">
          <div className="spinner"></div>
          <p>Loading bookings...</p>
        </div>
      ) : visibleBookings.length > 0 ? (
        <div className="bookings-list-modern">
          {visibleBookings.map((booking) => {
            const { paid, amount } = paymentLabel(booking);
            const meta = statusMeta(booking.status);
            const customerName = booking.customer?.name || "Customer";
            const cookName = booking.cook?.name || "Awaiting cook";
            const rating = booking.review?.rating;
            const ref = String(booking._id || "").slice(-6).toUpperCase();
            return (
            <article key={booking._id} className={`admin-booking-card st-${booking.status}`}>
              <div className="abc-top">
                <div className="abc-parties">
                  <span className="abc-ava abc-ava-customer" aria-hidden="true">
                    {(customerName || "C").charAt(0).toUpperCase()}
                  </span>
                  <div className="abc-route">
                    <p className="abc-customer">{customerName}</p>
                    <p className="abc-cook">
                      <ChefHat size={12} />
                      <span>{cookName}</span>
                      <span className="abc-dot" aria-hidden="true" />
                      <UtensilsCrossed size={12} />
                      <span>{prettyService(booking.serviceType)}</span>
                    </p>
                  </div>
                  <ArrowRight size={15} className="abc-route-arrow" aria-hidden="true" />
                  <span className="abc-ava abc-ava-cook" aria-hidden="true">
                    {(cookName || "C").charAt(0).toUpperCase()}
                  </span>
                </div>
                <div className="abc-badges">
                  <span className={`badge ${meta.pill}`}>{meta.label}</span>
                  <span className={`badge ${paid ? "badge-emerald" : "badge-amber"}`}>
                    {paid ? (
                      <><Check size={12} /> Paid{booking.payment?.testMode ? " • Test" : ""}</>
                    ) : (
                      <><Hourglass size={12} /> {String(booking.payment?.status || "Pending").toUpperCase()}</>
                    )}
                  </span>
                  {booking.status === "cancelled" && (
                    <span className="badge badge-slate" title="Who cancelled this booking">
                      Cancelled by{" "}
                      {booking.cancelledBy === "cook"
                        ? `cook (${cookName})`
                        : booking.cancelledBy === "customer"
                          ? `customer (${customerName})`
                          : booking.cancelledBy === "admin"
                            ? "admin (support)"
                            : "unknown"}
                    </span>
                  )}
                </div>
              </div>

              <div className="abc-meta">
                <div className="abc-meta-item">
                  <span className="abc-meta-ico"><Calendar size={14} /></span>
                  <div>
                    <label>Schedule</label>
                    <span>{formatDate(booking.date)} • {formatTimeRange12(booking.startTime, booking.endTime, "-") || "Time TBD"}</span>
                  </div>
                </div>
                <div className="abc-meta-item">
                  <span className="abc-meta-ico"><Banknote size={14} /></span>
                  <div>
                    <label>Amount</label>
                    <span className="abc-amount">{formatCurrency(amount)}</span>
                  </div>
                </div>
                <div className="abc-meta-item">
                  <span className="abc-meta-ico"><MapPin size={14} /></span>
                  <div>
                    <label>Venue</label>
                    <span title={booking.address || "Address on details page"}>{booking.address || "See details"}</span>
                  </div>
                </div>
                <div className="abc-meta-item">
                  <span className="abc-meta-ico"><Star size={14} /></span>
                  <div>
                    <label>Rating</label>
                    <span>
                      {rating ? (
                        <>★ {rating}/5{booking.review?.comment ? ` — ${booking.review.comment}` : ""}</>
                      ) : booking.status === "completed" ? (
                        "Not rated yet"
                      ) : (
                        "—"
                      )}
                    </span>
                  </div>
                </div>
              </div>

              {(booking.selectedItems?.length > 0 || booking.guests || booking.durationHours) && (
                <div className="abc-chips">
                  {booking.guests ? (
                    <span className="abc-chip"><Users size={12} /> {booking.guests} guests</span>
                  ) : null}
                  {booking.durationHours ? (
                    <span className="abc-chip"><Clock3 size={12} /> {booking.durationHours}h session</span>
                  ) : null}
                  {(booking.selectedItems || []).slice(0, 3).map((item, i) => (
                    <span key={i} className="abc-chip abc-chip-dish">{item}</span>
                  ))}
                  {(booking.selectedItems || []).length > 3 && (
                    <span className="abc-chip abc-chip-more">+{(booking.selectedItems || []).length - 3} more</span>
                  )}
                </div>
              )}
              {ref && <span className="abc-ref">#{ref}</span>}

              <div className="abc-actions">
              {(booking.status === "requested") && (
                <>
                  <button
                    className="btn btn-success btn-sm abc-btn"
                    onClick={() => setPendingAction({ bookingId: booking._id, action: "accept" })}
                    disabled={actingId === `${booking._id}:accept`}
                  >
                    <Check size={15} /> {actingId === `${booking._id}:accept` ? "Working…" : "Accept"}
                  </button>
                  <button
                    className="btn btn-danger-outline btn-sm abc-btn"
                    onClick={() => setPendingAction({ bookingId: booking._id, action: "reject" })}
                    disabled={actingId === `${booking._id}:reject`}
                  >
                    <X size={15} /> {actingId === `${booking._id}:reject` ? "Working…" : "Decline"}
                  </button>
                  <Link to={`/bookings/${booking._id}`} className="btn btn-outline btn-sm abc-btn abc-btn-details">
                    Details <ArrowRight size={14} />
                  </Link>
                </>
              )}
              {isUpcoming(booking) && (
                <>
                  <button
                    className="btn btn-primary btn-sm abc-btn"
                    onClick={() => setPendingAction({ bookingId: booking._id, action: "complete" })}
                    disabled={actingId === `${booking._id}:complete`}
                  >
                    <Check size={15} /> {actingId === `${booking._id}:complete` ? "Working…" : "Complete"}
                  </button>
                  <button
                    className="btn btn-danger-outline btn-sm abc-btn"
                    onClick={() => setPendingAction({ bookingId: booking._id, action: "cancel" })}
                    disabled={actingId === `${booking._id}:cancel`}
                  >
                    <X size={15} /> {actingId === `${booking._id}:cancel` ? "Working…" : "Cancel"}
                  </button>
                  <Link to={`/bookings/${booking._id}`} className="btn btn-outline btn-sm abc-btn abc-btn-details">
                    Details <ArrowRight size={14} />
                  </Link>
                </>
              )}
              {isPast(booking) && (
                <Link to={`/bookings/${booking._id}`} className="btn btn-outline btn-sm abc-btn abc-btn-details">
                  View details <ArrowRight size={14} />
                </Link>
              )}
              </div>
            </article>
            );
          })}
        </div>
      ) : (
        <div className="admin-bookings-empty">
          <span className="admin-bookings-empty-ico"><Calendar size={22} /></span>
          <h3>{bookings && bookings.length > 0 ? "Nothing matches this filter" : "No bookings yet"}</h3>
          <p>{bookings && bookings.length > 0 ? "Try a different filter to see more platform activity." : "New customer requests will appear here as soon as they are created."}</p>
        </div>
      )}

      {/* Popup: each incoming customer request auto-opens for the admin with
          Accept / Decline (on behalf of the cook). Stacked requests queue up
          and are popped in turn as each dialog closes. */}
      <BookingRequestModal
        open={Boolean(requestModalBooking)}
        booking={requestModalBooking}
        onBehalf
        onAction={() => refetch()}
        onClose={() => {
          const closing = requestModalBooking;
          setRequestModalBooking(null);
          popNextPendingRequest(closing?._id);
        }}
      />
      <ConfirmDialog
        open={!!pendingAction}
        title={ACTION_COPY[pendingAction?.action]?.title || "Are you sure?"}
        message={ACTION_COPY[pendingAction?.action]?.message}
        confirmLabel={ACTION_COPY[pendingAction?.action]?.confirmLabel || "Confirm"}
        tone={ACTION_COPY[pendingAction?.action]?.tone || "brand"}
        busy={!!actingId}
        onCancel={() => setPendingAction(null)}
        onConfirm={handleAction}
      />
    </div>
  );
};

const UserManagement = () => {
  const { data: users, loading, refetch } = useFetch("/auth/users");
  const showToast = useShowToast();
  // { kind: "status", user, status } | { kind: "delete", user } | null
  const [pendingUserAction, setPendingUserAction] = useState(null);

  // The API stores spec-UPPERCASE roles (ADMIN/COOK/CUSTOMER) — normalize the
  // whole list so the admin-protection check and role badge below work.
  const list = (users || []).map((u) => ({ ...u, role: normalizeRole(u.role) }));

  const handleStatus = async () => {
    const pending = pendingUserAction;
    if (!pending || pending.kind !== "status") return;
    const { user, status } = pending;
    const blocking = status === "suspended";
    setPendingUserAction(null);
    try {
      await API.patch(`/auth/users/${user._id}/status`, { status });
      showToast(
        blocking
          ? `${user.name}'s account has been blocked.`
          : `${user.name}'s account has been unblocked.`,
        "success"
      );
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Action failed", "error");
    }
  };

  const handleDelete = async () => {
    const pending = pendingUserAction;
    if (!pending || pending.kind !== "delete") return;
    const { user } = pending;
    setPendingUserAction(null);
    try {
      await API.delete(`/auth/users/${user._id}`);
      showToast(`${user.name}'s account has been permanently deleted.`, "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Delete failed", "error");
    }
  };

  const statusBadge = (status) =>
    status === "suspended" ? (
      <span className="badge badge-rose">Blocked</span>
    ) : status === "inactive" ? (
      <span className="badge badge-slate">Inactive</span>
    ) : (
      <span className="badge badge-emerald">{status || "Active"}</span>
    );

  return (
    <div>
      <div className="admin-section-head">
        <div>
          <h2>Registered Accounts</h2>
          <p className="admin-section-sub">Search, block or remove marketplace accounts.</p>
        </div>
      </div>
      {loading ? (
        <div className="loading-spinner-wrapper">
          <div className="spinner"></div>
          <p>Loading users...</p>
        </div>
      ) : list.length > 0 ? (
        <div className="admin-table-card">
          <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th>User Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u._id}>
                  <td data-label="User Name" className="admin-td-strong">{u.name}</td>
                  <td data-label="Email" className="admin-td-muted admin-td-wrap">{u.email}</td>
                  <td data-label="Role">
                    <span className="badge badge-festive" style={{ textTransform: "capitalize" }}>
                      {u.role}
                    </span>
                  </td>
                  <td data-label="Status">{statusBadge(u.status)}</td>
                  <td data-label="Actions">
                    {u.role === "admin" ? (
                      <span className="admin-td-protected">Protected</span>
                    ) : (
                      <div className="admin-actions">
                        {u.status === "suspended" ? (
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => setPendingUserAction({ kind: "status", user: u, status: "active" })}
                          >
                            <ShieldCheck size={15} /> Unblock
                          </button>
                        ) : (
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => setPendingUserAction({ kind: "status", user: u, status: "suspended" })}
                          >
                            <Ban size={15} /> Block
                          </button>
                        )}
                        <button
                          className="btn btn-danger-outline btn-sm"
                          onClick={() => setPendingUserAction({ kind: "delete", user: u })}
                        >
                          <Trash2 size={15} /> Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ) : (
        <div className="admin-bookings-empty">
          <p>No users found.</p>
        </div>
      )}
      <ConfirmDialog
        open={!!pendingUserAction}
        title={
          pendingUserAction?.kind === "delete"
            ? `Delete ${pendingUserAction.user.name}'s account?`
            : pendingUserAction?.status === "suspended"
              ? `Block ${pendingUserAction.user.name}'s account?`
              : `Unblock ${pendingUserAction?.user.name}'s account?`
        }
        message={
          pendingUserAction?.kind === "delete"
            ? `This permanently removes their ${
                pendingUserAction.user.role === "cook" ? "cook profile, availability slots, " : ""
              }bookings, reviews and notifications. This cannot be undone.`
            : pendingUserAction?.status === "suspended"
              ? "They will be logged out and unable to sign in until unblocked."
              : "They will be able to sign in again."
        }
        confirmLabel={
          pendingUserAction?.kind === "delete"
            ? "Delete account"
            : pendingUserAction?.status === "suspended"
              ? "Block account"
              : "Unblock account"
        }
        tone={pendingUserAction?.kind === "delete" || pendingUserAction?.status === "suspended" ? "danger" : "emerald"}
        onCancel={() => setPendingUserAction(null)}
        onConfirm={() => (pendingUserAction?.kind === "delete" ? handleDelete() : handleStatus())}
      />
    </div>
  );
};

// Admin registration: only an existing logged-in admin reaches this tab, so
// new admin accounts can only be created by admins (the public /register
// form and Google sign-in accept customer/cook roles only). The new admin
// signs in afterwards on the regular /login page.
const AdminManagement = () => {
  const { data: users, loading, refetch } = useFetch("/auth/users");
  const showToast = useShowToast();
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
    confirmPassword: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // Credentials are hashed server-side, so this success banner is the only
  // place the new admin's password is ever visible — share it once, then it
  // is gone.
  const [createdCreds, setCreatedCreds] = useState(null);
  const [copied, setCopied] = useState("");

  const admins = (users || []).filter((u) => normalizeRole(u.role) === "admin");

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const copyText = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // clipboard unavailable — select the text manually instead
      }
      ta.remove();
    }
    setCopied(key);
    setTimeout(() => setCopied(""), 2000);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (form.password.length < 8) {
      setError("Password must be at least 8 characters long");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const { confirmPassword, ...data } = form;
      const res = await API.post("/auth/admins", data);
      setCreatedCreds({
        name: res.data?.user?.name || data.name,
        email: res.data?.user?.email || data.email,
        password: data.password,
      });
      setForm({ name: "", email: "", phone: "", password: "", confirmPassword: "" });
      showToast(`Admin account created for ${res.data?.user?.name || data.name}!`, "success");
      refetch();
    } catch (err) {
      const msg = err.response?.data?.message || "Failed to create admin account";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: "1.4rem", marginBottom: "0.4rem" }}>Admin Accounts</h2>
      <p style={{ color: "var(--slate-600)", margin: "0 0 1.5rem", fontSize: "0.92rem" }}>
        Register a new administrator. They will sign in with these credentials on the
        regular login page and land on this control panel.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "1.25rem",
          alignItems: "start",
        }}
      >
        {/* Registration form */}
        <div className="profile-card-block" style={{ margin: 0 }}>
          <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <UserPlus size={18} style={{ color: "var(--primary)" }} /> Register New Admin
          </h3>

          {error && (
            <div className="error-alert-banner" style={{ marginBottom: "0.75rem" }}>
              <AlertCircle size={16} /> {error}
            </div>
          )}

          {createdCreds && (
            <div
              style={{
                background: "var(--accent-emerald-light, #ecfdf5)",
                border: "1px solid var(--accent-emerald, #10b981)",
                borderRadius: "10px",
                padding: "0.85rem 1rem",
                marginBottom: "0.9rem",
                fontSize: "0.88rem",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", fontWeight: 800, color: "#065f46", marginBottom: "0.5rem" }}>
                <CheckCircle2 size={17} /> Admin “{createdCreds.name}” created!
              </div>
              <div style={{ color: "var(--slate-600)", marginBottom: "0.5rem" }}>
                Share these login credentials now — the password is never shown again.
              </div>
              {[
                { key: "email", label: "Email", value: createdCreds.email },
                { key: "password", label: "Password", value: createdCreds.password },
              ].map((row) => (
                <div key={row.key} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.35rem" }}>
                  <span style={{ minWidth: 70, fontWeight: 700, color: "var(--slate-700)" }}>{row.label}:</span>
                  <code style={{ flex: 1, background: "#fff", border: "1px solid var(--slate-200)", borderRadius: "6px", padding: "0.25rem 0.5rem", overflowWrap: "anywhere" }}>
                    {row.value}
                  </code>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => copyText(row.value, row.key)}
                    title={`Copy ${row.label.toLowerCase()}`}
                  >
                    {copied === row.key ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="booking-form-group">
              <label>Full Name</label>
              <div className="input-with-icon">
                <User size={18} className="input-icon-prefix" />
                <input
                  type="text"
                  name="name"
                  className="form-control"
                  placeholder="e.g. Admin Sharma"
                  value={form.name}
                  onChange={handleChange}
                  required
                />
              </div>
            </div>

            <div className="booking-form-group">
              <label>Email Address</label>
              <div className="input-with-icon">
                <Mail size={18} className="input-icon-prefix" />
                <input
                  type="email"
                  name="email"
                  className="form-control"
                  placeholder="admin@example.com"
                  value={form.email}
                  onChange={handleChange}
                  required
                />
              </div>
            </div>

            <div className="booking-form-group">
              <label>Phone Number</label>
              <div className="input-with-icon">
                <Phone size={18} className="input-icon-prefix" />
                <input
                  type="tel"
                  name="phone"
                  className="form-control"
                  placeholder="e.g. 9876543210"
                  value={form.phone}
                  onChange={handleChange}
                  required
                />
              </div>
            </div>

            <div className="booking-form-group">
              <label>Password</label>
              <div className="input-with-icon password-input-wrapper">
                <Lock size={18} className="input-icon-prefix" />
                <input
                  type={showPassword ? "text" : "password"}
                  name="password"
                  className="form-control"
                  placeholder="At least 8 characters"
                  value={form.password}
                  onChange={handleChange}
                  required
                  minLength={8}
                />
                <button
                  type="button"
                  className="password-toggle-btn"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label="Toggle password view"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <div className="booking-form-group">
              <label>Confirm Password</label>
              <div className="input-with-icon">
                <Lock size={18} className="input-icon-prefix" />
                <input
                  type={showPassword ? "text" : "password"}
                  name="confirmPassword"
                  className="form-control"
                  placeholder="Confirm the password"
                  value={form.confirmPassword}
                  onChange={handleChange}
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-block"
              disabled={saving}
              style={{ marginTop: "0.5rem" }}
            >
              {saving ? "Creating Admin..." : <><UserPlus size={16} /> Create Admin Account</>}
            </button>
          </form>
        </div>

        {/* Existing admins */}
        <div className="profile-card-block" style={{ margin: 0 }}>
          <h3 style={{ marginTop: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <ShieldCheck size={18} style={{ color: "var(--primary)" }} /> Existing Admins ({admins.length})
          </h3>
          {loading ? (
            <div className="loading-spinner-wrapper">
              <div className="spinner"></div>
              <p>Loading admins...</p>
            </div>
          ) : admins.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              {admins.map((a) => (
                <div
                  key={a._id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.7rem",
                    padding: "0.65rem 0.8rem",
                    background: "var(--slate-50)",
                    border: "1px solid var(--slate-200)",
                    borderRadius: "var(--radius-md)",
                  }}
                >
                  <span
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: "50%",
                      background: "var(--primary-gradient)",
                      color: "#fff",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 800,
                      flexShrink: 0,
                    }}
                  >
                    {a.name?.[0]?.toUpperCase() || "A"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: "0.92rem" }}>{a.name}</div>
                    <div style={{ fontSize: "0.82rem", color: "var(--slate-500)", overflowWrap: "anywhere" }}>
                      {a.email}
                    </div>
                  </div>
                  <span className="badge badge-festive">Admin</span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ color: "var(--slate-500)", fontSize: "0.9rem" }}>No admin accounts found.</p>
          )}
          <p style={{ fontSize: "0.82rem", color: "var(--slate-500)", margin: "0.9rem 0 0" }}>
            Admin accounts are protected — they cannot be blocked or deleted from the User Directory.
          </p>
        </div>
      </div>
    </div>
  );
};

const LeadManagement = () => {
  const { data: leads, loading, refetch } = useFetch("/leads");
  const showToast = useShowToast();
  const [pendingDelete, setPendingDelete] = useState(null);

  const handleStatus = async (id, status) => {
    try {
      await API.patch(`/leads/${id}`, { status });
      showToast(`Enquiry marked as ${status}`, "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Update failed", "error");
    }
  };

  const handleDelete = async () => {
    const lead = pendingDelete;
    if (!lead) return;
    setPendingDelete(null);
    try {
      await API.delete(`/leads/${lead._id}`);
      showToast("Enquiry deleted", "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Delete failed", "error");
    }
  };

  return (
    <div>
      <h2 style={{ fontSize: "1.4rem", marginBottom: "1.5rem" }}>WhatsApp Enquiries</h2>
      {loading ? (
        <div className="loading-spinner-wrapper">
          <div className="spinner"></div>
          <p>Loading enquiries...</p>
        </div>
      ) : leads && leads.length > 0 ? (
        <div style={{ background: "white", borderRadius: "var(--radius-lg)", border: "1px solid var(--border-subtle)", overflow: "hidden" }}>
          <div className="admin-table-wrapper">
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.95rem" }}>
            <thead style={{ background: "var(--slate-50)", borderBottom: "1px solid var(--slate-200)" }}>
              <tr>
                <th style={{ padding: "1rem" }}>Name</th>
                <th style={{ padding: "1rem" }}>WhatsApp</th>
                <th style={{ padding: "1rem" }}>Location</th>
                <th style={{ padding: "1rem" }}>Status</th>
                <th style={{ padding: "1rem" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead._id} style={{ borderBottom: "1px solid var(--slate-100)" }}>
                  <td style={{ padding: "1rem", fontWeight: 700 }}>{lead.name}</td>
                  <td style={{ padding: "1rem" }}>
                    <a
                      href={`https://wa.me/91${lead.whatsapp}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "#16a34a", fontWeight: 600 }}
                    >
                      +91 {lead.whatsapp}
                    </a>
                  </td>
                  <td style={{ padding: "1rem", color: "var(--slate-600)" }}>
                    {lead.location}
                    {lead.coords?.lat != null && lead.coords?.lng != null && (
                      <>
                        <br />
                        <a
                          href={`https://www.google.com/maps/dir/?api=1&destination=${lead.coords.lat},${lead.coords.lng}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ color: "#1D4ED8", fontWeight: 600, fontSize: "0.85rem" }}
                        >
                          Open pinned location in Maps
                        </a>
                      </>
                    )}
                  </td>
                  <td style={{ padding: "1rem" }}>
                    <span className="badge badge-festive" style={{ textTransform: "capitalize" }}>
                      {lead.status}
                    </span>
                  </td>
                  <td style={{ padding: "1rem" }}>
                    <select
                      value={lead.status}
                      onChange={(e) => handleStatus(lead._id, e.target.value)}
                      style={{ padding: "0.4rem", borderRadius: "6px" }}
                    >
                      <option value="new">New</option>
                      <option value="contacted">Contacted</option>
                      <option value="converted">Converted</option>
                      <option value="closed">Closed</option>
                    </select>
                    <button
                      className="btn btn-danger-outline btn-sm"
                      style={{ marginLeft: "0.5rem" }}
                      onClick={() => setPendingDelete(lead)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ) : (
        <p style={{ color: "var(--slate-500)" }}>No enquiries yet.</p>
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete enquiry from ${pendingDelete?.name}?`}
        message="This cannot be undone."
        confirmLabel="Delete enquiry"
        tone="danger"
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
};

export default AdminDashboard;