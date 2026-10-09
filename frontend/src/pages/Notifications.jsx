import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import API from "../api/axios";
import { useSelector } from "react-redux";
import { useShowToast } from "../store/hooks";
import {
  Bell,
  CheckCheck,
  CheckCircle2,
  XCircle,
  Calendar,
  Star,
  ShieldCheck,
  ChefHat,
  Clock,
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  CalendarClock,
} from "lucide-react";

const TYPE_META = {
  booking_request: { label: "New booking request", icon: Calendar, color: "var(--accent-amber)" },
  booking_accepted: { label: "Booking accepted", icon: CheckCircle2, color: "var(--accent-emerald)" },
  booking_rejected: { label: "Booking declined", icon: XCircle, color: "#dc2626" },
  booking_confirmed: { label: "Booking confirmed", icon: CheckCircle2, color: "var(--accent-blue)" },
  booking_completed: { label: "Booking completed", icon: CheckCheck, color: "var(--accent-emerald)" },
  booking_cancelled: { label: "Booking cancelled", icon: XCircle, color: "var(--slate-500)" },
  booking_expired: { label: "Booking expired", icon: Clock, color: "var(--slate-500)" },
  booking_rescheduled: { label: "Booking rescheduled", icon: CalendarClock, color: "var(--accent-blue)" },
  booking_unattended: { label: "Cook didn't attend", icon: AlertCircle, color: "#dc2626" },
  service_started: { label: "Service started", icon: ChefHat, color: "var(--accent-emerald)" },
  cook_arrived: { label: "Cook arrived", icon: ChefHat, color: "var(--accent-emerald)" },
  cooking_hours_completed: { label: "Cooking hours complete", icon: Clock, color: "var(--accent-amber)" },
  review_received: { label: "New review", icon: Star, color: "var(--accent-amber)" },
  profile_approved: { label: "Profile approved", icon: ShieldCheck, color: "var(--accent-emerald)" },
  profile_rejected: { label: "Profile needs attention", icon: AlertCircle, color: "#dc2626" },
  payout_settled: { label: "Payout sent", icon: CheckCircle2, color: "var(--accent-emerald)" },
  payout_failed: { label: "Payout declined", icon: XCircle, color: "#dc2626" },
  refund_pending: { label: "Refund under review", icon: Clock, color: "var(--accent-amber)" },
  refund_processed: { label: "Refund processed", icon: CheckCircle2, color: "var(--accent-emerald)" },
  general: { label: "Update", icon: Bell, color: "var(--primary)" },
};

const targetFor = (n) => {
  if (typeof n.link === "string" && /^\/(?!\/)/.test(n.link) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(n.link)) {
    return n.link;
  }
  if (n.booking?._id || typeof n.booking === "string") {
    return `/bookings/${n.booking?._id || n.booking}`;
  }
  return null;
};

const showFullTimestamp = (iso) => {
  if (!iso) return false;
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  return days >= 7;
};

const timeAgo = (iso) => {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const Notifications = () => {
  const user = useSelector((s) => s.auth.user);
  const showToast = useShowToast();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchNotifications = async () => {
    try {
      setLoading(true);
      setError(null);
      const { data } = await API.get("/notifications");
      const list = Array.isArray(data) ? data : [];
      setNotifications(list);
      // Everything is seen on visit — mark all as read right away.
      if (list.some((n) => !n.read)) {
        try {
          await API.patch("/notifications/read-all");
          setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
          nudgeBadge();
        } catch {
          // Badge/list will sync on the next visit or poll.
        }
      }
    } catch (err) {
      setError(err.response?.data?.message || "Could not load notifications");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNotifications();
    const poll = async () => {
      if (document.hidden) return;
      try {
        const { data } = await API.get("/notifications");
        setNotifications(Array.isArray(data) ? data : []);
      } catch {
      }
    };
    const id = setInterval(poll, 60000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", poll);
    };
    // Mount-only: fetch once, then poll for new arrivals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nudgeBadge = () => {
    try {
      window.dispatchEvent(new CustomEvent("notifications-updated"));
    } catch {
    }
  };

  const handleMarkRead = async (id) => {
    try {
      const { data } = await API.patch(`/notifications/${id}/read`);
      setNotifications((prev) => prev.map((n) => (n._id === id ? data : n)));
      nudgeBadge();
    } catch (err) {
      showToast(err.response?.data?.message || "Could not mark as read", "error");
    }
  };

  const backTo = user?.role === "cook" ? "/dashboard/cook-bookings" : user?.role === "admin" ? "/admin" : "/dashboard/my-bookings";
  const backLabel = user?.role === "cook" ? "Back to Cook Dashboard" : user?.role === "admin" ? "Back to Admin Dashboard" : "Back to My Bookings";

  return (
    <div className="dashboard-container notif-page">
      <Link to={backTo} className="back-link-bar">
        <ArrowLeft size={16} /> {backLabel}
      </Link>

      <div className="dashboard-header-row notif-header">
        <div>
          <h1 className="notif-page-title">Notifications</h1>
      </div>
      </div>

      {error && (
        <div className="error-alert-banner">
          <AlertCircle size={18} /> {error}
        </div>
      )}

      {loading ? (
        <div className="loading-spinner-wrapper">
          <div className="spinner"></div>
          <p style={{ color: "var(--slate-500)", fontWeight: 600 }}>Loading notifications...</p>
        </div>
      ) : notifications.length > 0 ? (
        <div className="bookings-list-modern">
          {notifications.map((n) => {
            const meta = TYPE_META[n.type] || TYPE_META.general;
            const Icon = meta.icon;
            const target = targetFor(n);
            const open = () => {
              if (!target) return;
              if (!n.read) handleMarkRead(n._id);
              navigate(target);
            };
            return (
              <div
                key={n._id}
                className={`booking-item-card notif-item ${n.read ? "is-read" : "is-unread"}`}
                role={target ? "button" : undefined}
                tabIndex={target ? 0 : undefined}
                onClick={target ? open : undefined}
                onKeyDown={
                  target
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open();
                        }
                      }
                    : undefined
                }
                style={target ? { cursor: "pointer" } : undefined}
              >
                <div className="notif-item-row">
                  <div className="stat-icon-wrapper notif-icon" style={{ color: meta.color }}>
                    <Icon size={22} />
                  </div>
                  <div className="notif-body">
                    <div className="notif-meta-row">
                      <span className={`badge ${n.read ? "badge-slate" : "badge-festive"}`}>{meta.label}</span>
                      {!n.read && <span className="badge badge-amber">New</span>}
                      <span className="notif-ago">{timeAgo(n.createdAt)}</span>
                    </div>
                    <p className="notif-message">
                      {n.message}
                    </p>
                    {showFullTimestamp(n.createdAt) && (
                      <div className="notif-timestamp">
                        {new Date(n.createdAt).toLocaleString("en-IN", {
                          day: "numeric",
                          month: "short",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                  </div>
                  {target && (
                    <span className="my-booking-go notif-go" aria-hidden="true" title="Open">
                      <ChevronRight size={18} />
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="empty-state-card">
          <div className="empty-state-icon">
            <Bell size={28} />
          </div>
          <h3>No notifications yet</h3>
          <p style={{ fontSize: "0.95rem", color: "var(--slate-600)", marginBottom: "1rem" }}>
            Booking requests, acceptances, arrivals, and reviews show up here as activity
            happens on your account.
          </p>
          <Link to={backTo} className="btn btn-primary">
            {user?.role === "cook" ? <ChefHat size={16} /> : <Calendar size={16} />}
            {backLabel}
          </Link>
        </div>
      )}
    </div>
  );
};

export default Notifications;
