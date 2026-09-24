import React from "react";
import { Link, useParams } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import AdminDocViewer from "../components/AdminDocViewer";
import AdminDocUpload from "../components/AdminDocUpload";
import { formatCurrency, formatDate, SERVICE_DETAILS, formatTimeRange12 } from "../utils/constants";
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

const BookingCard = ({ booking }) => (
  <div className="booking-item-card">
    <div className="booking-item-top">
      <div>
        <h3 style={{ margin: 0 }}>
          {booking.customer?.name || "Customer"}
        </h3>
        <span style={{ fontSize: "0.85rem", color: "var(--slate-500)" }}>
          {serviceLabel(booking.serviceType)} • {formatDate(booking.date)} •{" "}
          {formatTimeRange12(booking.startTime, booking.endTime)} ({booking.durationHours || "—"} hrs)
        </span>
      </div>
      <span className="badge badge-festive">{booking.status?.toUpperCase()}</span>
    </div>

    <div className="booking-metadata-grid">
      <div className="meta-field">
        <label>
          <User size={13} style={{ verticalAlign: "-2px" }} /> Customer
        </label>
        <span>{booking.customer?.name || "—"}</span>
        {booking.customer?.phone && (
          <span>
            <a
              href={`https://wa.me/91${String(booking.customer.phone).replace(/\D/g, "").slice(-10)}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#16a34a", fontWeight: 600 }}
            >
              <Phone size={13} style={{ verticalAlign: "-2px" }} /> +91{" "}
              {String(booking.customer.phone).replace(/\D/g, "").slice(-10)}
            </a>
          </span>
        )}
      </div>
      <div className="meta-field">
        <label>
          <MapPin size={13} style={{ verticalAlign: "-2px" }} /> Service Address
        </label>
        <span>{fullAddress(booking) || "—"}</span>
      </div>
      <div className="meta-field">
        <label>
          <Wallet size={13} style={{ verticalAlign: "-2px" }} /> Amount
        </label>
        <span style={{ color: "var(--primary)", fontWeight: 700 }}>
          {formatCurrency(booking.payment?.paidAmount || booking.amount)}
        </span>
      </div>
      <div className="meta-field">
        <label>
          <Clock size={13} style={{ verticalAlign: "-2px" }} /> Duration
        </label>
        <span>{booking.durationHours || "—"} hrs</span>
      </div>
    </div>

    {/* Customer rating for this service */}
    {booking.status === "completed" && (
      booking.review ? (
        <div style={{ marginTop: "0.75rem", padding: "0.6rem 0.9rem", background: "var(--accent-amber-light, #fef3c7)", border: "1px solid var(--accent-amber, #f59e0b)", borderRadius: "var(--radius-sm)", fontSize: "0.88rem" }}>
          <strong>
            ★ {booking.review.rating}/5
            <span style={{ marginLeft: "0.3rem" }}>
              {[1, 2, 3, 4, 5].map((s) => (
                <span key={s} style={{ color: s <= booking.review.rating ? "#f59e0b" : "#cbd5e1" }}>★</span>
              ))}
            </span>
          </strong>
          {booking.review.customer?.name && (
            <span style={{ color: "var(--slate-600)" }}> — {booking.review.customer.name}</span>
          )}
          {booking.review.comment && (
            <div style={{ marginTop: "0.25rem", color: "var(--slate-700)" }}>{booking.review.comment}</div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: "0.75rem", fontSize: "0.82rem", color: "var(--slate-500)" }}>
          No customer rating yet for this service.
        </div>
      )
    )}
  </div>
);

const AdminCookProfile = () => {
  const { id } = useParams();
  const { data, loading, error, refetch } = useFetch(`/cooks/admin-overview/${id}`);

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
  // Newer bookings first in both tabs (creation time, newest → oldest).
  const byNewest = (a, b) =>
    new Date(b?.createdAt).getTime() - new Date(a?.createdAt).getTime() ||
    String(b?._id || "").localeCompare(String(a?._id || ""));
  const current = bookings.filter((b) => CURRENT_STATUSES.includes(b.status)).sort(byNewest);
  const past = bookings.filter((b) => !CURRENT_STATUSES.includes(b.status)).sort(byNewest);
  const serviceRows = Object.entries(summary?.earningsByService || {});
  const avgRating = profile.rating?.average
    ? Number(profile.rating.average).toFixed(1)
    : reviews.length
      ? (reviews.reduce((s, r) => s + Number(r.rating || 0), 0) / reviews.length).toFixed(1)
      : null;

  return (
    <div className="dashboard-container">
      <div style={{ marginBottom: "1.5rem" }}>
        <Link to="/admin" className="back-link-bar">
          <ArrowLeft size={16} /> Back to Admin
        </Link>
      </div>

      <div className="dashboard-header-row">
        <div>
          <span className="badge badge-festive" style={{ marginBottom: "0.5rem" }}>
            <ChefHat size={14} /> Cook Dossier
          </span>
          <h1 style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
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
          <p style={{ color: "var(--slate-600)", margin: 0 }}>
            {profile.experienceYears || 0} yrs experience • {formatCurrency(profile.rate)}/hr (legacy rack rate — bookings use slab pricing) •{" "}
            {profile.serviceArea || "No service area set"} • ★ {avgRating || 0} (
            {profile.rating?.count ?? reviews.length} reviews)
          </p>
        </div>
      </div>

      {/* Earnings summary */}
      <div className="bookings-list-modern" style={{ marginBottom: "2rem" }}>
        <div className="booking-item-card">
          <div className="booking-metadata-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
            <div className="meta-field">
              <label>
                <Wallet size={13} style={{ verticalAlign: "-2px" }} /> Total Earned (paid only)
              </label>
              <span style={{ color: "var(--primary)", fontWeight: 800, fontSize: "1.25rem" }}>
                {formatCurrency(summary?.totalEarnings)}
              </span>
            </div>
            <div className="meta-field">
              <label>
                <Clock size={13} style={{ verticalAlign: "-2px" }} /> Total Service Hours
              </label>
              <span style={{ fontWeight: 800, fontSize: "1.25rem" }}>
                {summary?.totalHours || 0} hrs
              </span>
            </div>
            <div className="meta-field">
              <label>
                <CalendarCheck size={13} style={{ verticalAlign: "-2px" }} /> Current Bookings
              </label>
              <span style={{ fontWeight: 800, fontSize: "1.25rem" }}>
                {summary?.currentCount || 0}
              </span>
            </div>
            <div className="meta-field">
              <label>
                <CheckCircle2 size={13} style={{ verticalAlign: "-2px" }} /> Completed
              </label>
              <span style={{ fontWeight: 800, fontSize: "1.25rem" }}>
                {summary?.completedCount || 0} / {summary?.totalBookings || 0}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Profile, contact, address, documents */}
      <div className="bookings-list-modern" style={{ marginBottom: "2rem" }}>
        <div className="booking-item-card">
          <div className="booking-item-top">
            <h3 style={{ margin: 0 }}>Profile & Contact</h3>
          </div>
          <div className="booking-metadata-grid">
            <div className="meta-field">
              <label>
                <Phone size={13} style={{ verticalAlign: "-2px" }} /> Contact Number
              </label>
              <span>
                {cook.phone ? (
                  <a href={`tel:+91${cook.phone}`} style={{ fontWeight: 700 }}>
                    +91 {cook.phone}
                  </a>
                ) : (
                  "—"
                )}
              </span>
            </div>
            <div className="meta-field">
              <label>
                <Mail size={13} style={{ verticalAlign: "-2px" }} /> Email
              </label>
              <span>
                {cook.email ? <a href={`mailto:${cook.email}`}>{cook.email}</a> : "—"}
              </span>
            </div>
            <div className="meta-field">
              <label>
                <MapPin size={13} style={{ verticalAlign: "-2px" }} /> Home Address
              </label>
              <span>{profile.address || "Not provided"}</span>
            </div>
            <div className="meta-field">
              <label>Service Area</label>
              <span>{profile.serviceArea || "—"}</span>
            </div>
            <div className="meta-field">
              <label>Services Offered</label>
              <span>
                {(profile.serviceTypes || []).map(serviceLabel).join(", ") || "—"}
              </span>
            </div>
            <div className="meta-field">
              <label>Specialties</label>
              <span>{(profile.specialties || []).join(", ") || "—"}</span>
            </div>
          </div>
          {(profile.skills || profile.bio) && (
            <p style={{ fontSize: "0.9rem", color: "var(--slate-600)", margin: "0.75rem 0 0" }}>
              {profile.skills || profile.bio}
            </p>
          )}
        </div>

        <div className="booking-item-card">
          <div className="booking-item-top">
            <h3 style={{ margin: 0 }}>
              <FileText size={16} style={{ verticalAlign: "-3px" }} /> Verification Documents
            </h3>
          </div>
          {/* Click a thumbnail to preview — images open in a lightbox, PDFs preview inline */}
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

          {/* Admin can attach files the cook sent over email/WhatsApp */}
          <div
            style={{
              marginTop: "1rem",
              borderTop: "1px dashed var(--slate-200)",
              paddingTop: "1rem",
            }}
          >
            <AdminDocUpload
              cookId={profile._id}
              current={profile}
              onUploaded={refetch}
            />
          </div>
        </div>
      </div>

      {/* Earnings per service */}
      <h2 style={{ fontSize: "1.4rem", marginBottom: "1rem" }}>Earnings by Service</h2>
      {serviceRows.length > 0 ? (
        <div className="dossier-table-card">
          <div className="admin-table-wrapper">
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.95rem" }}>
            <thead style={{ background: "var(--slate-50)", borderBottom: "1px solid var(--slate-200)" }}>
              <tr>
                <th style={{ padding: "1rem" }}>Service</th>
                <th style={{ padding: "1rem" }}>Completed</th>
                <th style={{ padding: "1rem" }}>Hours</th>
                <th style={{ padding: "1rem" }}>Earned</th>
              </tr>
            </thead>
            <tbody>
              {serviceRows.map(([key, row]) => (
                <tr key={key} style={{ borderBottom: "1px solid var(--slate-100)" }}>
                  <td style={{ padding: "1rem", fontWeight: 700 }}>{serviceLabel(key)}</td>
                  <td style={{ padding: "1rem" }}>{row.count}</td>
                  <td style={{ padding: "1rem" }}>{row.hours} hrs</td>
                  <td style={{ padding: "1rem", fontWeight: 700, color: "var(--primary)" }}>
                    {formatCurrency(row.earnings)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ) : (
        <p style={{ color: "var(--slate-500)", marginBottom: "2rem" }}>
          No completed services yet — earnings will appear here.
        </p>
      )}

      {/* Customer ratings across services */}
      <h2 style={{ fontSize: "1.4rem", marginBottom: "1rem" }}>
        Customer Ratings ({reviews.length}){avgRating ? ` — ★ ${avgRating} average` : ""}
      </h2>
      {reviews.length > 0 ? (
        <div className="bookings-list-modern" style={{ marginBottom: "2rem" }}>
          {reviews.map((r) => (
            <div key={r._id} className="booking-item-card">
              <div className="booking-item-top">
                <div>
                  <h3 style={{ margin: 0 }}>
                    ★ {r.rating}/5
                    <span style={{ marginLeft: "0.4rem" }}>
                      {[1, 2, 3, 4, 5].map((s) => (
                        <span key={s} style={{ color: s <= r.rating ? "#f59e0b" : "#cbd5e1" }}>★</span>
                      ))}
                    </span>
                  </h3>
                  <span style={{ fontSize: "0.85rem", color: "var(--slate-500)" }}>
                    {r.customer?.name || "Customer"}
                    {r.booking?.date ? ` • ${serviceLabel(r.booking.serviceType)} • ${formatDate(r.booking.date)}` : ""}
                  </span>
                </div>
                <span style={{ fontSize: "0.8rem", color: "var(--slate-500)" }}>
                  {r.createdAt ? formatDate(r.createdAt) : ""}
                </span>
              </div>
              {r.comment && (
                <p style={{ fontSize: "0.9rem", color: "var(--slate-700)", margin: 0 }}>{r.comment}</p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p style={{ color: "var(--slate-500)", marginBottom: "2rem" }}>
          No customer ratings yet for this cook.
        </p>
      )}

      {/* Current bookings */}
      <h2 style={{ fontSize: "1.4rem", marginBottom: "1rem" }}>
        Current Bookings ({current.length})
      </h2>
      {current.length > 0 ? (
        <div className="bookings-list-modern" style={{ marginBottom: "2rem" }}>
          {current.map((b) => (
            <BookingCard key={b._id} booking={b} />
          ))}
        </div>
      ) : (
        <p style={{ color: "var(--slate-500)", marginBottom: "2rem" }}>No current bookings.</p>
      )}

      {/* Past bookings */}
      <h2 style={{ fontSize: "1.4rem", marginBottom: "1rem" }}>
        Past Bookings ({past.length})
      </h2>
      {past.length > 0 ? (
        <div className="bookings-list-modern">
          {past.map((b) => (
            <BookingCard key={b._id} booking={b} />
          ))}
        </div>
      ) : (
        <p style={{ color: "var(--slate-500)" }}>No past bookings.</p>
      )}
    </div>
  );
};

export default AdminCookProfile;
