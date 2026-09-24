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
} from "lucide-react";

const TYPE_META = {
  booking_request: { label: "New booking request", icon: Calendar, color: "var(--accent-amber)" },
  booking_accepted: { label: "Booking accepted", icon: CheckCircle2, color: "var(--accent-emerald)" },
  booking_rejected: { label: "Booking declined", icon: XCircle, color: "#dc2626" },
  booking_confirmed: { label: "Booking confirmed", icon: CheckCircle2, color: "var(--accent-blue)" },
  booking_completed: { label: "Booking completed", icon: CheckCheck, color: "var(--accent-emerald)" },
  booking_cancelled: { label: "Booking cancelled", icon: XCircle, color: "var(--slate-500)" },
  booking_expired: { label: "Booking expired", icon: Clock, color: "var(--slate-500)" },
  service_started: { label: "Service started", icon: ChefHat, color: "var(--accent-emerald)" },
  cook_arrived: { label: "Cook arrived", icon: ChefHat, color: "var(--accent-emerald)" },
  cooking_hours_completed: { label: "Cooking hours complete", icon: Clock, color: "var(--accent-amber)" },
  review_received: { label: "New review", icon: Star, color: "var(--accent-amber)" },
  profile_approved: { label: "Profile approved", icon: ShieldCheck, color: "var(--accent-emerald)" },
  profile_rejected: { label: "Profile needs attention", icon: AlertCircle, color: "#dc2626" },
  payout_settled: { label: "Payout sent", icon: CheckCircle2, color: "var(--accent-emerald)" },
  refund_processed: { label: "Refund processed", icon: CheckCircle2, color: "var(--accent-emerald)" },
  general: { label: "Update", icon: Bell, color: "var(--primary)" },
};

// Where a notification taps through to. Every actionable notification gets a
// destination — "pay within 5 minutes" with nowhere to go is a dead end.
// Explicit `link` wins (e.g. admin consoles), else the linked booking's
// details page, else nothing.
const targetFor = (n) => {
  // Only same-origin relative paths are tappable — never absolute URLs,
  // protocol-relative links, or schemes (backend validates too; this is the
  // render-side backstop so a bad stored link can never navigate off-site).
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
  const [filter, setFilter] = useState("all");
  const [actioning, setActioning] = useState(null);

  const fetchNotifications = async () => {
    try {
      setLoading(true);
      setError(null);
      const { data } = await API.get("/notifications");
      setNotifications(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.response?.data?.message || "Could not load notifications");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNotifications();
    // Calmed for scale: 30s -> 60s + hidden-tab pause (the Notification list is
    // still refreshed immediately when the tab becomes visible again).
    const poll = async () => {
      if (document.hidden) return;
      try {
        const { data } = await API.get("/notifications");
        setNotifications(Array.isArray(data) ? data : []);
      } catch {
        // keep stale list on background poll failure
      }
    };
    const id = setInterval(poll, 60000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", poll);
    };
  }, []);

  // Tell the navbar badge to refresh immediately (it no longer polls on its
  // own — the popup + explicit nudges drive it, with a slow safety poll).
  const nudgeBadge = () => {
    try {
      window.dispatchEvent(new CustomEvent("notifications-updated"));
    } catch {
      // non-fatal
    }
  };

  const handleMarkRead = async (id) => {
    setActioning(id);
    try {
      const { data } = await API.patch(`/notifications/${id}/read`);
      setNotifications((prev) => prev.map((n) => (n._id === id ? data : n)));
      nudgeBadge();
    } catch (err) {
      showToast(err.response?.data?.message || "Could not mark as read", "error");
    } finally {
      setActioning(null);
    }
  };

  const handleMarkAllRead = async () => {
    setActioning("all");
    try {
      await API.patch("/notifications/read-all");
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      nudgeBadge();
      showToast("All notifications marked as read", "success");
    } catch (err) {
      showToast(err.response?.data?.message || "Could not mark all as read", "error");
    } finally {
      setActioning(null);
    }
  };

  const unreadCount = notifications.filter((n) => !n.read).length;
  const filtered =
    filter === "unread"
      ? notifications.filter((n) => !n.read)
      : filter === "read"
        ? notifications.filter((n) => n.read)
        : notifications;

  const backTo = user?.role === "cook" ? "/dashboard/cook-bookings" : "/dashboard/my-bookings";
  const backLabel = user?.role === "cook" ? "Back to Cook Dashboard" : "Back to My Bookings";

  return (
    <div className="dashboard-container notif-page">
      <Link to={backTo} className="back-link-bar">
        <ArrowLeft size={16} /> {backLabel}
      </Link>

      <div className="dashboard-header-row notif-header">
        <div>
          <h1 className="notif-page-title">Notifications</h1>
      </div>
        {unreadCount > 0 && (
          <button
            className="btn btn-outline btn-sm"
            onClick={handleMarkAllRead}
            disabled={actioning === "all"}
          >
            <CheckCheck size={16} />
            {actioning === "all" ? "Marking..." : "Mark all as read"}
          </button>
        )}
      </div>

      <div className="tabs-navigation-bar">
        <button className={`tab-btn ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>
          All ({notifications.length})
        </button>
        <button className={`tab-btn ${filter === "unread" ? "active" : ""}`} onClick={() => setFilter("unread")}>
          Unread ({unreadCount})
        </button>
        <button className={`tab-btn ${filter === "read" ? "active" : ""}`} onClick={() => setFilter("read")}>
          Read ({notifications.length - unreadCount})
        </button>
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
      ) : filtered.length > 0 ? (
        <div className="bookings-list-modern">
          {filtered.map((n) => {
            const meta = TYPE_META[n.type] || TYPE_META.general;
            const Icon = meta.icon;
            const target = targetFor(n);
            const open = () => {
              if (!target) return;
              // Opening the destination counts as reading it.
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
                  {!n.read && (
                    <button
                      className="btn btn-outline btn-sm notif-mark-read"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleMarkRead(n._id);
                      }}
                      disabled={actioning === n._id}
                      title="Mark as read"
                    >
                      <CheckCircle2 size={15} />
                      {actioning === n._id ? "..." : "Mark read"}
                    </button>
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
          <h3>{filter === "all" ? "No notifications yet" : `No ${filter} notifications`}</h3>
          <p style={{ fontSize: "0.95rem", color: "var(--slate-600)", marginBottom: "1rem" }}>
            {filter === "all" ? (
              <>
                Booking requests, acceptances, arrivals, and reviews show up here as activity
                happens on your account.
              </>
            ) : (
              <>Try a different filter — or check back after your next booking update.</>
            )}
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
