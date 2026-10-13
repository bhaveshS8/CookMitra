import React from "react";
import { Link, useParams } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import AdminDocViewer from "../components/AdminDocViewer";
import { formatCurrency, formatDate, SERVICE_DETAILS, formatTimeRange12, isUnpaidCancelled } from "../utils/constants";
import "./AdminCookProfile.css";
import {
  ArrowLeft,
  ChefHat,
  Phone,
  Mail,
  MapPin,
  FileText,
  Wallet,
  Clock,
  CalendarCheck,
  CheckCircle2,
  User,
  Receipt,
  Undo2,
  XCircle,
} from "lucide-react";

const CURRENT_STATUSES = ["requested", "accepted", "confirmed", "in_progress"];

const serviceLabel = (key) =>
  SERVICE_DETAILS[key]?.label || String(key || "").replace(/_/g, " ");

const fullAddress = (b) => {
  const parts = [b?.address];
  const d = b?.addressDetails || {};
  [d.flatNo, d.society, d.landmark, d.city].forEach((p) => {
    if (p) parts.push(p);
  });
  return parts.filter(Boolean).join(", ");
};

const Stars = ({ value }) => (
  <span className="dossier-stars" aria-label={`${value} out of 5 stars`}>
    {[1, 2, 3, 4, 5].map((s) => (
      <span key={s} className={s <= value ? "" : "off"}>★</span>
    ))}
  </span>
);

const BookingCard = ({ booking }) => (
  <div className="dossier-card dossier-booking">
    <div className="dossier-booking-top">
      <div>
        <h3>
          {booking.customer?.name || "Customer"}
        </h3>
        <span className="dossier-booking-sub">
          {serviceLabel(booking.serviceType)} • {formatDate(booking.date)} •{" "}
          {formatTimeRange12(booking.startTime, booking.endTime)} ({booking.durationHours || "—"} hrs)
        </span>
      </div>
      <span className="badge badge-festive">{booking.status?.toUpperCase()}</span>
    </div>

    <div className="dossier-grid">
      <div className="dossier-field">
        <label>
          <User size={13} /> Customer
        </label>
        <span className="value">{booking.customer?.name || "—"}</span>
        {booking.customer?.phone && (
          <span className="value">
            <a
              href={`https://wa.me/91${String(booking.customer.phone).replace(/\D/g, "").slice(-10)}`}
              target="_blank"
              rel="noreferrer"
            >
              <Phone size={13} /> +91{" "}
              {String(booking.customer.phone).replace(/\D/g, "").slice(-10)}
            </a>
          </span>
        )}
      </div>
      <div className="dossier-field">
        <label>
          <MapPin size={13} /> Service Address
        </label>
        <span className="value">{fullAddress(booking) || "—"}</span>
      </div>
      <div className="dossier-field">
        <label>
          <Wallet size={13} /> Amount
        </label>
        <span className="value accent">
          {formatCurrency(booking.payment?.paidAmount || booking.amount)}
        </span>
      </div>
      <div className="dossier-field">
        <label>
          <Clock size={13} /> Duration
        </label>
        <span className="value">{booking.durationHours || "—"} hrs</span>
      </div>
    </div>

    {booking.status === "completed" && (
      booking.review ? (
        <div className="dossier-review-box">
          <strong className="dossier-rating-hero">
            ★ {booking.review.rating}/5
            <Stars value={booking.review.rating} />
          </strong>
          {booking.review.customer?.name && (
            <span className="who"> — {booking.review.customer.name}</span>
          )}
          {booking.review.comment && (
            <div className="dossier-review-comment">{booking.review.comment}</div>
          )}
        </div>
      ) : (
        <div className="dossier-no-rating">
          No customer rating yet for this service.
        </div>
      )
    )}
  </div>
);

const statusBadge = (status) => {
  switch (status) {
    case "completed":
      return "badge-emerald";
    case "cancelled":
      return "badge-rose";
    case "rejected":
    case "expired":
    case "failed":
      return "badge-slate";
    default:
      return "badge-amber";
  }
};

const payoutChip = (payoutStatus) => {
  switch (payoutStatus) {
    case "paid":
      return { cls: "positive", label: "Payout paid" };
    case "approved":
      return { cls: "info", label: "Payout approved" };
    case "held":
      return { cls: "danger", label: "Payout held" };
    case "rejected":
      return { cls: "neutral", label: "Payout rejected" };
    default:
      return { cls: "warning", label: "Payout pending" };
  }
};

const PastBookingCard = ({ booking }) => {
  const pay = booking.payment || {};
  const info = booking.payoutInfo || {};
  const cancel = booking.cancellationInfo || {};
  const settled = booking.payout?.status === "settled";
  const payout = payoutChip(info.payoutStatus);
  const cookPayout = Number(info.cookPayoutAmount || booking.cookPayout || 0);
  const showRefund = pay.refundStatus && !["none", "rejected"].includes(pay.refundStatus);
  const cancelReason = cancel.cancellationReasonNote || cancel.cancellationReason || "";
  const who = cancel.cancelledBy || booking.cancelledBy || "";
  const customerInitial = String(booking.customer?.name || "C").trim().charAt(0).toUpperCase();

  return (
    <div className={`dossier-card dossier-booking dossier-past st-${booking.status || "unknown"}`}>
      <div className="dossier-booking-top">
        <div className="dossier-past-head">
          <span className="dossier-past-ava" aria-hidden="true">{customerInitial}</span>
          <div>
            <h3>
              {booking.customer?.name || "Customer"}
            </h3>
            <span className="dossier-booking-sub">
              {serviceLabel(booking.serviceType)} • {formatDate(booking.date)} •{" "}
              {formatTimeRange12(booking.startTime, booking.endTime)} ({booking.durationHours || "—"} hrs)
            </span>
          </div>
        </div>
        <span className={`badge ${statusBadge(booking.status)} dossier-status`}>
          <span className="dot" aria-hidden="true" />{booking.status?.toUpperCase()}
        </span>
      </div>

      <div className="dossier-past-grid">
        <div className="dossier-tile">
          <label>
            <User size={12} /> Customer
          </label>
          <span className="t-value">{booking.customer?.name || "—"}</span>
          {booking.customer?.phone && (
            <span className="t-sub">
              <a
                href={`https://wa.me/91${String(booking.customer.phone).replace(/\D/g, "").slice(-10)}`}
                target="_blank"
                rel="noreferrer"
              >
                <Phone size={12} /> +91{" "}
                {String(booking.customer.phone).replace(/\D/g, "").slice(-10)}
              </a>
            </span>
          )}
        </div>
        <div className="dossier-tile">
          <label>
            <MapPin size={12} /> Service Address
          </label>
          <span className="t-value">{fullAddress(booking) || "—"}</span>
        </div>
        <div className="dossier-tile highlight">
          <label>
            <Wallet size={12} /> Customer Paid
          </label>
          <span className="t-value">
            {formatCurrency(pay.paidAmount || booking.amount)}
          </span>
          <span className="t-sub">payment: {pay.status || "—"}</span>
        </div>
        <div className="dossier-tile">
          <label>
            <Receipt size={12} /> Cook Payout
          </label>
          <span className="t-value">{cookPayout ? formatCurrency(cookPayout) : "—"}</span>
          {info.payoutCycleRef && (
            <span className="t-sub">cycle {info.payoutCycleRef}</span>
          )}
        </div>
        <div className="dossier-tile">
          <label>
            <Clock size={12} /> Duration
          </label>
          <span className="t-value">{booking.durationHours || "—"} hrs</span>
        </div>
        {info.payoutHoldReason && (
          <div className="dossier-tile">
            <label>
              <XCircle size={12} /> Hold Reason
            </label>
            <span className="t-value">{info.payoutHoldReason}</span>
          </div>
        )}
      </div>

      <div className="dossier-outcome">
        {booking.status === "completed" && (
          <span className="dossier-chip positive">
            <CheckCircle2 size={13} /> Service completed
          </span>
        )}
        <span className={`dossier-chip ${settled ? "positive" : payout.cls}`}>
          <Receipt size={13} /> {settled ? "Payout settled" : payout.label}
        </span>
        {pay.status === "paid" && (
          <span className="dossier-chip positive">
            <Wallet size={13} /> Paid {formatCurrency(pay.paidAmount || booking.amount)}
          </span>
        )}
        {showRefund && (
          <span className="dossier-chip warning">
            <Undo2 size={13} /> Refund {pay.refundStatus}
            {Number(pay.refundAmount) > 0 ? ` ${formatCurrency(pay.refundAmount)}` : ""}
          </span>
        )}
      </div>

      {booking.status === "cancelled" && (
        <div className="dossier-cancel-box">
          <strong>
            <XCircle size={13} /> Cancelled{who ? ` by ${who}` : ""}
            {cancel.cancelledAt ? ` • ${formatDate(cancel.cancelledAt)}` : ""}
          </strong>
          {cancelReason && <div>{cancelReason}</div>}
          {cancel.cancellationCategory && (
            <div>Category: {String(cancel.cancellationCategory).replace(/_/g, " ")}</div>
          )}
          {Number(cancel.finalRefundAmount) > 0 && (
            <div>
              Refund {formatCurrency(cancel.finalRefundAmount)} • status: {cancel.refundStatus || "—"}
            </div>
          )}
        </div>
      )}

      {booking.status === "completed" && (
        booking.review ? (
          <div className="dossier-review-box">
            <strong className="dossier-rating-hero">
              ★ {booking.review.rating}/5
              <Stars value={booking.review.rating} />
            </strong>
            {booking.review.customer?.name && (
              <span className="who"> — {booking.review.customer.name}</span>
            )}
            {booking.review.comment && (
              <div className="dossier-review-comment">{booking.review.comment}</div>
            )}
          </div>
        ) : (
          <div className="dossier-no-rating">
            No customer rating yet for this service.
          </div>
        )
      )}

      <div className="dossier-card-foot">
        <span>#{String(booking._id || "?").slice(-6).toUpperCase()}</span>
        <span>Booked {booking.createdAt ? formatDate(booking.createdAt) : "—"}</span>
      </div>
    </div>
  );
};

const AdminCookProfile = () => {
  const { id } = useParams();
  const { data, loading, error } = useFetch(`/cooks/admin-overview/${id}`);

  if (loading) {
    return (
      <div className="loading-spinner-wrapper">
        <div className="spinner"></div>
        <p>Loading cook dossier...</p>
      </div>
    );
  }

  if (error || !data?.profile) {
    return (
      <div className="dashboard-container">
        <Link to="/admin" className="back-link-bar">
          <ArrowLeft size={16} /> Back to Admin
        </Link>
        <div className="error-alert-banner">{error || "Cook profile not found"}</div>
      </div>
    );
  }

  const { profile, bookings = [], reviews = [], summary } = data;
  const cook = profile.user || {};
  const byNewest = (a, b) =>
    new Date(b?.createdAt).getTime() - new Date(a?.createdAt).getTime() ||
    String(b?._id || "").localeCompare(String(a?._id || ""));
  const trackable = (bookings || []).filter((b) => !isUnpaidCancelled(b));
  const current = trackable.filter((b) => CURRENT_STATUSES.includes(b.status)).sort(byNewest);
  const past = trackable.filter((b) => !CURRENT_STATUSES.includes(b.status)).sort(byNewest);
  const serviceRows = Object.entries(summary?.earningsByService || {});
  const avgRating = profile.rating?.average
    ? Number(profile.rating.average).toFixed(1)
    : reviews.length
      ? (reviews.reduce((s, r) => s + Number(r.rating || 0), 0) / reviews.length).toFixed(1)
      : null;

  const initials = String(cook.name || "C").trim().charAt(0).toUpperCase();

  return (
    <div className="dashboard-container dossier-page">
      <div className="dossier-back">
        <Link to="/admin" className="back-link-bar">
          <ArrowLeft size={16} /> Back to Admin
        </Link>
      </div>

      <div className="dossier-hero">
        <span className="dossier-avatar" aria-hidden="true">{initials}</span>
        <div className="dossier-hero-main">
          <span className="badge badge-festive dossier-eyebrow">
            <ChefHat size={14} /> Cook Dossier
          </span>
          <h1 className="dossier-title">
            {cook.name || "Cook"}
            <span
              className={`badge ${
                profile.approvalStatus === "approved"
                  ? "badge-emerald"
                  : profile.approvalStatus === "rejected"
                  ? "badge-rose"
                  : "badge-amber"
              }`}
            >
              {profile.approvalStatus?.toUpperCase()}
            </span>
          </h1>
          <p className="dossier-sub">
            <strong>{profile.experienceYears || 0} yrs</strong> experience • <strong>{formatCurrency(profile.rate)}/hr</strong> (legacy rack rate — bookings use slab pricing) •{" "}
            {profile.serviceArea || "No service area set"} • <span className="dossier-rating-hero">★ {avgRating || 0}</span> (
            {profile.rating?.count ?? reviews.length} reviews)
          </p>
        </div>
      </div>

      <div className="dossier-stats">
        <div className="dossier-stat">
          <span className="dossier-stat-icon"><Wallet size={20} /></span>
          <div>
            <span className="dossier-stat-label">Total Earned (paid only)</span>
            <span className="dossier-stat-value accent">
              {formatCurrency(summary?.totalEarnings)}
            </span>
          </div>
        </div>
        <div className="dossier-stat">
          <span className="dossier-stat-icon"><Clock size={20} /></span>
          <div>
            <span className="dossier-stat-label">Total Service Hours</span>
            <span className="dossier-stat-value">
              {summary?.totalHours || 0} <span className="dossier-stat-unit">hrs</span>
            </span>
          </div>
        </div>
        <div className="dossier-stat">
          <span className="dossier-stat-icon"><CalendarCheck size={20} /></span>
          <div>
            <span className="dossier-stat-label">Current Bookings</span>
            <span className="dossier-stat-value">
              {summary?.currentCount || 0}
            </span>
          </div>
        </div>
        <div className="dossier-stat">
          <span className="dossier-stat-icon"><CheckCircle2 size={20} /></span>
          <div>
            <span className="dossier-stat-label">Completed</span>
            <span className="dossier-stat-value">
              {summary?.completedCount || 0} / {summary?.totalBookings || 0}
            </span>
          </div>
        </div>
      </div>

      <div className="dossier-card">
        <div className="dossier-card-head">
          <h3>Profile & Contact</h3>
        </div>
        <div className="dossier-grid">
          <div className="dossier-field">
            <label>
              <Phone size={13} /> Contact Number
            </label>
            <span className="value">
              {cook.phone ? (
                <a href={`tel:+91${cook.phone}`}>
                  +91 {cook.phone}
                </a>
              ) : (
                <span className="value muted">—</span>
              )}
            </span>
          </div>
          <div className="dossier-field">
            <label>
              <Mail size={13} /> Email
            </label>
            <span className="value">
              {cook.email ? <a href={`mailto:${cook.email}`}>{cook.email}</a> : <span className="value muted">—</span>}
            </span>
          </div>
          <div className="dossier-field">
            <label>
              <MapPin size={13} /> Home Address
            </label>
            <span className={profile.address ? "value" : "value muted"}>{profile.address || "Not provided"}</span>
          </div>
          <div className="dossier-field">
            <label>Service Area</label>
            <span className={profile.serviceArea ? "value" : "value muted"}>{profile.serviceArea || "—"}</span>
          </div>
          <div className="dossier-field">
            <label>Services Offered</label>
            <span className={(profile.serviceTypes || []).length ? "value" : "value muted"}>
              {(profile.serviceTypes || []).map(serviceLabel).join(", ") || "—"}
            </span>
          </div>
          <div className="dossier-field">
            <label>Specialties</label>
            <span className={(profile.specialties || []).length ? "value" : "value muted"}>{(profile.specialties || []).join(", ") || "—"}</span>
          </div>
        </div>
        {(profile.skills || profile.bio) && (
          <p className="dossier-bio">
            {profile.skills || profile.bio}
          </p>
        )}
      </div>

      <div className="dossier-card">
        <div className="dossier-card-head">
          <h3>
            <FileText size={16} /> Verification Documents
          </h3>
        </div>
        <AdminDocViewer
          docs={[
            { label: "Aadhaar Card", url: profile.aadharCardUrl },
            { label: "PAN Card", url: profile.panCardUrl },
            { label: "Profile Photo", url: profile.photoUrl },
            ...(profile.documents || []).map((doc) => ({
              label: doc.label || "Document",
              url: doc.url,
            })),
          ]}
        />
      </div>

      <h2 className="dossier-section-title">Earnings by Service</h2>
      {serviceRows.length > 0 ? (
        <div className="dossier-card dossier-card-flush">
          <div className="dossier-table-wrap dossier-table-wrap-flush">
          <table className="dossier-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Completed</th>
                <th>Hours</th>
                <th>Earned</th>
              </tr>
            </thead>
            <tbody>
              {serviceRows.map(([key, row]) => (
                <tr key={key}>
                  <td className="cell-strong">{serviceLabel(key)}</td>
                  <td>{row.count}</td>
                  <td>{row.hours} hrs</td>
                  <td className="cell-money">
                    {formatCurrency(row.earnings)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ) : (
        <p className="dossier-empty">
          No completed services yet — earnings will appear here.
        </p>
      )}

      <h2 className="dossier-section-title">
        Customer Ratings <span className="count">{reviews.length}</span>{avgRating ? ` — ★ ${avgRating} average` : ""}
      </h2>
      {reviews.length > 0 ? (
        <div className="dossier-stack">
          {reviews.map((r) => (
            <div key={r._id} className="dossier-card dossier-review">
              <div className="dossier-review-top">
                <div>
                  <h3 className="dossier-rating-hero dossier-rating-title">
                    ★ {r.rating}/5
                    <Stars value={r.rating} />
                  </h3>
                  <span className="dossier-review-meta">
                    {r.customer?.name || "Customer"}
                    {r.booking?.date ? ` • ${serviceLabel(r.booking.serviceType)} • ${formatDate(r.booking.date)}` : ""}
                  </span>
                </div>
                <span className="dossier-review-date">
                  {r.createdAt ? formatDate(r.createdAt) : ""}
                </span>
              </div>
              {r.comment && (
                <p className="dossier-review-comment">{r.comment}</p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="dossier-empty">
          No customer ratings yet for this cook.
        </p>
      )}

      <h2 className="dossier-section-title">
        Current Bookings <span className="count">{current.length}</span>
      </h2>
      {current.length > 0 ? (
        <div className="dossier-stack">
          {current.map((b) => (
            <BookingCard key={b._id} booking={b} />
          ))}
        </div>
      ) : (
        <p className="dossier-empty">No current bookings.</p>
      )}

      <h2 className="dossier-section-title">
        Past Bookings <span className="count">{past.length}</span>
      </h2>
      {past.length > 0 ? (
        <div>
          {past.map((b) => (
            <PastBookingCard key={b._id} booking={b} />
          ))}
        </div>
      ) : (
        <p className="dossier-empty">No past bookings.</p>
      )}
    </div>
  );
};

export default AdminCookProfile;
