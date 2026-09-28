import React, { useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { useFetch } from "../hooks/useFetch";
import { normalizeRole } from "../store/authSlice";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate } from "../utils/constants";
import AddCookModal from "../components/AddCookModal";
import AdminDocViewer from "../components/AdminDocViewer";
import AdminDocUpload from "../components/AdminDocUpload";
import CouponManagement from "../components/CouponManagement";
import EventBookingAdmin from "../components/EventBookingAdmin";
import EventPricingManager from "../components/EventPricingManager";
import EventTypeManager from "../components/EventTypeManager";
import VisitStats from "../components/VisitStats";
import AnalyticsPanel from "../components/AnalyticsPanel";
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
  XCircle,
  BarChart3,
} from "lucide-react";
import { resolveFileUrl } from "../components/CookDocUploads";

const AdminDashboard = () => {  const [activeTab, setActiveTab] = useState("cooks");

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
          className={`tab-btn ${activeTab === "cooks" ? "active" : ""}`}
          onClick={() => setActiveTab("cooks")}
        >
          <ChefHat size={17} /> Cook Approvals
        </button>
        <button
          className={`tab-btn ${activeTab === "bookings" ? "active" : ""}`}
          onClick={() => setActiveTab("bookings")}
        >
          <Calendar size={17} /> Platform Bookings
        </button>
        <button
          className={`tab-btn ${activeTab === "event-bookings" ? "active" : ""}`}
          onClick={() => setActiveTab("event-bookings")}
        >
          <Calendar size={17} /> Event Bookings
        </button>
        <button
          className={`tab-btn ${activeTab === "event-types" ? "active" : ""}`}
          onClick={() => setActiveTab("event-types")}
        >
          <ChefHat size={17} /> Events
        </button>
        <button
          className={`tab-btn ${activeTab === "event-pricing" ? "active" : ""}`}
          onClick={() => setActiveTab("event-pricing")}
        >
          <Tag size={17} /> Event Pricing
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
          className={`tab-btn ${activeTab === "analytics" ? "active" : ""}`}
          onClick={() => setActiveTab("analytics")}
        >
          <BarChart3 size={17} /> Analytics
        </button>
      </div>

      {activeTab === "cooks" && <CookManagement />}
      {activeTab === "bookings" && <BookingManagement />}
      {activeTab === "event-bookings" && <EventBookingAdmin />}
      {activeTab === "event-types" && <EventTypeManager />}
      {activeTab === "event-pricing" && <EventPricingManager />}
      {activeTab === "users" && <UserManagement />}
      {activeTab === "admins" && <AdminManagement />}
      {activeTab === "leads" && <LeadManagement />}
      {activeTab === "coupons" && <CouponManagement />}
      {activeTab === "visits" && <VisitStats />}
      {activeTab === "analytics" && <AnalyticsPanel />}
    </div>
  );
};

const CookManagement = () => {
  const { data: cooks, loading, refetch } = useFetch("/cooks");
  const showToast = useShowToast();
  const [filterStatus, setFilterStatus] = useState("all");
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

  const filteredCooks = cooks
    ? cooks.filter((c) => (filterStatus === "all" ? true : c.approvalStatus === filterStatus))
    : [];

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem", flexWrap: "wrap", gap: "0.75rem" }}>
        <h2 style={{ fontSize: "1.4rem" }}>Cook Profile Verifications</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowAddCook(true)}
          >
            <Plus size={16} /> Add Cook
          </button>
          {["all", "pending", "approved", "rejected"].map((st) => (
            <button
              key={st}
              onClick={() => setFilterStatus(st)}
              className={`btn btn-sm ${filterStatus === st ? "btn-primary" : "btn-secondary"}`}
              style={{ textTransform: "capitalize" }}
            >
              {st}
            </button>
          ))}
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
          {filteredCooks.map((cook) => (
            <div key={cook._id} className="admin-cook-card">
              <div className="acc-head">
                <div className="acc-ava">
                  {cook.photoUrl ? (
                    <img src={resolveFileUrl(cook.photoUrl)} alt={cook.user?.name || "Cook"} />
                  ) : (
                    (cook.user?.name || "C")[0].toUpperCase()
                  )}
                  <span
                    className={`acc-ava-dot acc-dot-${cook.approvalStatus || "pending"}`}
                    title={cook.approvalStatus}
                  />
                </div>
                <div className="acc-id">
                  <h3>{cook.user?.name || "Cook Applicant"}</h3>
                  <p>
                    <Mail size={12} /> {cook.user?.email}
                  </p>
                </div>
                <span
                  className={`badge acc-badge ${
                    cook.approvalStatus === "approved"
                      ? "badge-emerald"
                      : cook.approvalStatus === "rejected"
                      ? "badge-rose"
                      : "badge-amber"
                  }`}
                >
                  {cook.approvalStatus === "approved" ? (
                    <CheckCircle2 size={13} />
                  ) : cook.approvalStatus === "rejected" ? (
                    <XCircle size={13} />
                  ) : (
                    <Clock size={13} />
                  )}
                  {cook.approvalStatus?.toUpperCase() || "PENDING"}
                </span>
              </div>

              <div className="acc-chips">
                <span className="acc-chip">
                  <Briefcase size={13} /> {cook.experienceYears} yrs experience
                </span>
                <span className="acc-chip acc-chip-rate">
                  <Wallet size={13} /> {formatCurrency(cook.rate)}/hr
                </span>
                {cook.serviceArea && (
                  <span className="acc-chip">
                    <MapPin size={13} /> {cook.serviceArea}
                  </span>
                )}
                {(cook.specialties || []).slice(0, 3).map((s) => (
                  <span key={s} className="acc-chip acc-chip-spec">
                    <ChefHat size={13} /> {s}
                  </span>
                ))}
                {(cook.specialties?.length || 0) > 3 && (
                  <span className="acc-chip acc-chip-spec">
                    +{cook.specialties.length - 3} more
                  </span>
                )}
              </div>

              {(cook.skills || cook.bio) && <p className="acc-bio">{cook.skills || cook.bio}</p>}

              {/* ID verification uploads — click a thumb to preview */}
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

              {/* Admin can attach files the cook sent over email/WhatsApp */}
              <div
                style={{
                  marginTop: "0.75rem",
                  borderTop: "1px dashed var(--slate-200)",
                  paddingTop: "0.75rem",
                }}
              >
                <AdminDocUpload
                  cookId={cook._id}
                  current={cook}
                  onUploaded={refetch}
                />
              </div>

              {cook.approvalStatus === "pending" && (
                <div className="booking-actions-row">
                  <button
                    className="btn btn-success btn-sm"
                    onClick={() => handleApproval(cook._id, "approved")}
                  >
                    <Check size={16} /> Approve Cook
                  </button>
                  <button
                    className="btn btn-danger-outline btn-sm"
                    onClick={() => handleApproval(cook._id, "rejected")}
                  >
                    <X size={16} /> Reject Application
                  </button>
                </div>
              )}
              <div className="booking-actions-row">
                <Link to={`/admin/cooks/${cook._id}`} className="btn btn-outline btn-sm">
                  View Full Profile & Earnings
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ color: "var(--slate-500)" }}>No cooks found matching this status.</p>
      )}
    </div>
  );
};

const BookingManagement = () => {
  const { data: bookings, loading, refetch } = useFetch("/bookings");
  const showToast = useShowToast();
  const [bookingFilter, setBookingFilter] = useState("all");

  const handleAction = async (bookingId, action) => {
    // Same guardrails as the cook dashboard: confirm before changing the slot.
    if (
      action === "accept" &&
      !window.confirm(
        "Accept this request on behalf of the cook? The slot will be BOOKED and the customer will have 5 minutes to pay."
      )
    )
      return;
    if (
      action === "reject" &&
      !window.confirm(
        "Decline this request on behalf of the cook? The customer will be notified and the slot stays open."
      )
    )
      return;
    if (
      action === "complete" &&
      !window.confirm(
        "Mark this service as completed on behalf of the cook? The customer will be asked to rate the cook."
      )
    )
      return;
    if (
      action === "cancel" &&
      !window.confirm(
        "Cancel this booking as admin? Paid bookings are refunded and the slot is released."
      )
    )
      return;
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
    }
  };

  const isPast = (b) => ["completed", "cancelled", "rejected", "expired"].includes(b.status);
  const isUpcoming = (b) => ["accepted", "confirmed", "in_progress"].includes(b.status);

  const newCount = (bookings || []).filter((b) => b.status === "requested").length;
  const upcomingCount = (bookings || []).filter(isUpcoming).length;
  const pastCount = (bookings || []).filter(isPast).length;

  const statusRank = (s) =>
    ({ requested: 0, accepted: 1, confirmed: 1, in_progress: 2 }[s] ?? 3);

  const visibleBookings = [...(bookings || [])]
    .filter((b) => {
      if (bookingFilter === "new") return b.status === "requested";
      if (bookingFilter === "upcoming") return isUpcoming(b);
      if (bookingFilter === "past") return isPast(b);
      return true;
    })
    .sort((a, b) => {
      if (bookingFilter === "past") return new Date(b.date) - new Date(a.date);
      return statusRank(a.status) - statusRank(b.status) || new Date(a.date) - new Date(b.date);
    });

  const paymentLabel = (booking) => {
    const paid = booking.payment?.status === "paid";
    const amount = paid
      ? Number(booking.payment?.paidAmount || booking.amount || 0)
      : Number(booking.amount || 0);
    return { paid, amount };
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem", flexWrap: "wrap", gap: "0.75rem" }}>
        <h2 style={{ fontSize: "1.4rem", margin: 0 }}>All Platform Bookings</h2>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
          {[
            { id: "all", label: `All (${(bookings || []).length})` },
            { id: "new", label: `New (${newCount})` },
            { id: "upcoming", label: `Upcoming (${upcomingCount})` },
            { id: "past", label: `Past Services (${pastCount})` },
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setBookingFilter(f.id)}
              className={`btn btn-sm ${bookingFilter === f.id ? "btn-primary" : "btn-secondary"}`}
            >
              {f.label}
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
            return (
            <div key={booking._id} className="booking-item-card">
              <div className="booking-item-top">
                <div>
                  <h3 style={{ margin: 0 }}>Customer: {booking.customer?.name}</h3>
                  <span style={{ fontSize: "0.85rem", color: "var(--slate-500)" }}>
                    Cook: {booking.cook?.name || "Assigned Cook"} • Service: {booking.serviceType?.replace(/_/g, " ")}
                  </span>
                </div>
                <span className="badge badge-festive">{booking.status?.toUpperCase()}</span>
              </div>

              <div className="booking-metadata-grid">
                <div className="meta-field">
                  <label>Date</label>
                  <span>{formatDate(booking.date)}</span>
                </div>
                <div className="meta-field">
                  <label>Time</label>
                  <span>{booking.startTime} - {booking.endTime}</span>
                </div>
                <div className="meta-field">
                  <label>Amount</label>
                  <span style={{ color: "var(--primary)", fontWeight: 700 }}>
                    {formatCurrency(amount)}
                  </span>
                </div>
                <div className="meta-field">
                  <label>Payment</label>
                  <span
                    className={`badge ${paid ? "badge-emerald" : "badge-amber"}`}
                    style={{ alignSelf: "flex-start" }}
                  >
                    {paid
                      ? `PAID${booking.payment?.testMode ? " • TEST" : ""}`
                      : `UNPAID • ${String(booking.payment?.status || "pending").toUpperCase()}`}
                  </span>
                </div>
                <div className="meta-field">
                  <label>Customer Rating</label>
                  <span>
                    {booking.review ? (
                      <>★ {booking.review.rating}/5{booking.review.comment ? ` — ${booking.review.comment}` : ""}</>
                    ) : booking.status === "completed" ? (
                      "Not rated yet"
                    ) : (
                      "—"
                    )}
                  </span>
                </div>
              </div>

              {(booking.status === "requested") && (
                <div className="booking-actions-row">
                  <button
                    className="btn btn-success btn-sm"
                    onClick={() => handleAction(booking._id, "accept")}
                  >
                    <Check size={16} /> Admin Accept
                  </button>
                  <button
                    className="btn btn-danger-outline btn-sm"
                    onClick={() => handleAction(booking._id, "reject")}
                  >
                    <X size={16} /> Admin Reject
                  </button>
                  <Link to={`/bookings/${booking._id}`} className="btn btn-outline btn-sm">
                    View Details
                  </Link>
                </div>
              )}
              {isUpcoming(booking) && (
                <div className="booking-actions-row">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => handleAction(booking._id, "complete")}
                  >
                    <Check size={16} /> Mark Completed
                  </button>
                  <button
                    className="btn btn-danger-outline btn-sm"
                    onClick={() => handleAction(booking._id, "cancel")}
                  >
                    <X size={16} /> Admin Cancel
                  </button>
                  <Link to={`/bookings/${booking._id}`} className="btn btn-outline btn-sm">
                    View Details
                  </Link>
                </div>
              )}
              {isPast(booking) && (
                <div className="booking-actions-row">
                  <Link to={`/bookings/${booking._id}`} className="btn btn-outline btn-sm">
                    View Details
                  </Link>
                </div>
              )}
            </div>
            );
          })}
        </div>
      ) : (
        <p style={{ color: "var(--slate-500)" }}>
          {bookings && bookings.length > 0 ? "No bookings match this filter." : "No bookings in database."}
        </p>
      )}
    </div>
  );
};

const UserManagement = () => {
  const { data: users, loading, refetch } = useFetch("/auth/users");
  const showToast = useShowToast();

  // The API stores spec-UPPERCASE roles (ADMIN/COOK/CUSTOMER) — normalize the
  // whole list so the admin-protection check and role badge below work.
  const list = (users || []).map((u) => ({ ...u, role: normalizeRole(u.role) }));

  const handleStatus = async (user, status) => {
    const blocking = status === "suspended";
    if (
      blocking &&
      !window.confirm(
        `Block ${user.name}'s account? They will be logged out and unable to sign in until unblocked.`
      )
    )
      return;
    if (
      !blocking &&
      !window.confirm(`Unblock ${user.name}'s account? They will be able to sign in again.`)
    )
      return;
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

  const handleDelete = async (user) => {
    if (
      !window.confirm(
        `Permanently delete ${user.name}'s account? This also removes their ${
          user.role === "cook" ? "cook profile, availability slots, " : ""
        }bookings, reviews and notifications. This cannot be undone.`
      )
    )
      return;
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
      <h2 style={{ fontSize: "1.4rem", marginBottom: "1.5rem" }}>Registered Accounts</h2>
      {loading ? (
        <div className="loading-spinner-wrapper">
          <div className="spinner"></div>
          <p>Loading users...</p>
        </div>
      ) : list.length > 0 ? (
        <div style={{ background: "white", borderRadius: "var(--radius-lg)", border: "1px solid var(--border-subtle)", overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "0.95rem" }}>
            <thead style={{ background: "var(--slate-50)", borderBottom: "1px solid var(--slate-200)" }}>
              <tr>
                <th style={{ padding: "1rem" }}>User Name</th>
                <th style={{ padding: "1rem" }}>Email</th>
                <th style={{ padding: "1rem" }}>Role</th>
                <th style={{ padding: "1rem" }}>Status</th>
                <th style={{ padding: "1rem" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u._id} style={{ borderBottom: "1px solid var(--slate-100)" }}>
                  <td style={{ padding: "1rem", fontWeight: 700 }}>{u.name}</td>
                  <td style={{ padding: "1rem", color: "var(--slate-600)" }}>{u.email}</td>
                  <td style={{ padding: "1rem" }}>
                    <span className="badge badge-festive" style={{ textTransform: "capitalize" }}>
                      {u.role}
                    </span>
                  </td>
                  <td style={{ padding: "1rem" }}>{statusBadge(u.status)}</td>
                  <td style={{ padding: "1rem" }}>
                    {u.role === "admin" ? (
                      <span style={{ color: "var(--slate-400)", fontSize: "0.85rem" }}>Protected</span>
                    ) : (
                      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                        {u.status === "suspended" ? (
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => handleStatus(u, "active")}
                          >
                            <ShieldCheck size={15} /> Unblock
                          </button>
                        ) : (
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => handleStatus(u, "suspended")}
                          >
                            <Ban size={15} /> Block
                          </button>
                        )}
                        <button
                          className="btn btn-danger-outline btn-sm"
                          onClick={() => handleDelete(u)}
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
      ) : (
        <p style={{ color: "var(--slate-500)" }}>No users found.</p>
      )}
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
    if (form.password.length < 6) {
      setError("Password must be at least 6 characters long");
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
                  placeholder="At least 6 characters"
                  value={form.password}
                  onChange={handleChange}
                  required
                  minLength={6}
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

  const handleStatus = async (id, status) => {
    try {
      await API.patch(`/leads/${id}`, { status });
      showToast(`Enquiry marked as ${status}`, "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Update failed", "error");
    }
  };

  const handleDelete = async (lead) => {
    if (!window.confirm(`Delete enquiry from ${lead.name}? This cannot be undone.`)) return;
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
                      onClick={() => handleDelete(lead)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ color: "var(--slate-500)" }}>No enquiries yet.</p>
      )}
    </div>
  );
};

export default AdminDashboard;