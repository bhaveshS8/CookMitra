import React, { useState, useEffect, useRef } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { useDispatch, useSelector } from "react-redux";
import { logoutUser } from "../store/authSlice";
import { useShowToast } from "../store/hooks";
import API from "../api/axios";
import {
  ChefHat,
  Menu,
  X,
  Calendar,
  LogOut,
  ShieldAlert,
  Bell,
  User,
} from "lucide-react";
import cookMitraLogo from "../assets/logo.png";
import { resolveFileUrl } from "./CookDocUploads";
import LocationPicker from "./LocationPicker";

// Avatar showing the cook's uploaded profile photo when available,
// falling back to the name initial (also when the URL is stale/broken).
const NavAvatar = ({ name, photo }) => {
  const [imgOk, setImgOk] = useState(true);
  useEffect(() => setImgOk(true), [photo]);
  return (
    <div className="user-avatar-sm">
      {photo && imgOk ? (
        <img src={resolveFileUrl(photo)} alt={name || "User"} onError={() => setImgOk(false)} />
      ) : (
        name ? name[0].toUpperCase() : "U"
      )}
    </div>
  );
};

const Navbar = () => {
  const user = useSelector((s) => s.auth.user);
  const dispatch = useDispatch();
  const showToast = useShowToast();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  // Interval handle for the unread-notifications poll (cleared on unmount and
  // while the tab is hidden).
  const pollRef = useRef(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // Cook profile photo lives on CookProfile (not the auth user), so the
  // navbar loads it separately and refreshes on the "cook-photo-updated"
  // event fired by the profile editors after a successful save.
  const [cookPhoto, setCookPhoto] = useState("");

  useEffect(() => {
    let cancelled = false;
    const fetchCookPhoto = async () => {
      if (!user || user.role !== "cook") {
        if (!cancelled) setCookPhoto("");
        return;
      }
      try {
        const { data } = await API.get("/cooks/me");
        if (!cancelled) setCookPhoto(data?.photoUrl || "");
      } catch {
        if (!cancelled) setCookPhoto("");
      }
    };
    fetchCookPhoto();
    const onPhotoUpdated = () => fetchCookPhoto();
    window.addEventListener("cook-photo-updated", onPhotoUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener("cook-photo-updated", onPhotoUpdated);
    };
  }, [user]);

  // Unread badge for cook + customer inboxes.
  useEffect(() => {
    if (!user || !["customer", "cook"].includes(user.role)) {
      setUnreadCount(0);
      return;
    }
    let cancelled = false;
    const fetchUnread = async () => {
      try {
        const { data } = await API.get("/notifications");
        if (!cancelled && Array.isArray(data)) {
          setUnreadCount(data.filter((n) => !n.read).length);
        }
      } catch {
        // badge is best-effort; page shows the full error state
      }
    };
    fetchUnread();
    // Deduplicated polling (Phase 16): the global NotificationPopup already
    // polls every 30s and dispatches "notifications-updated" on arrivals, and
    // the Notifications page nudges on reads — so the badge needs no fast
    // poll of its own. Refresh on event + visibility/focus + a slow 5-minute
    // safety net (hidden-tab aware). Cuts steady-state inbox polling in half.
    const startPoll = () => {
      stopPoll();
      pollRef.current = setInterval(() => {
        if (!document.hidden) fetchUnread();
      }, 300000);
    };
    const stopPoll = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
    const onVis = () => {
      if (document.hidden) stopPoll();
      else {
        fetchUnread();
        startPoll();
      }
    };
    const onFocus = () => {
      if (!document.hidden) fetchUnread();
    };
    startPoll();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    // Refresh the badge immediately when a new-notification popup fires
    // (or a popup tap / Notifications page marks one as read) instead of
    // waiting for the safety poll.
    window.addEventListener("notifications-updated", fetchUnread);
    return () => {
      cancelled = true;
      stopPoll();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("notifications-updated", fetchUnread);
    };
  }, [user]);

  const handleLogout = () => {
    dispatch(logoutUser());
    showToast("Logged out successfully", "info");
    setMobileMenuOpen(false);
    navigate("/login");
  };

  const closeMobile = () => setMobileMenuOpen(false);

  const isAdmin = user?.role === "admin";
  const isCook = user?.role === "cook";
  const hideCustomerPages = isAdmin || isCook;
  // Avatar / user chip links to the role's own profile page.
  const profilePath =
    user?.role === "customer"
      ? "/dashboard/profile"
      : user?.role === "cook"
        ? "/dashboard/cook-profile"
        : "/admin";

  return (
    <nav className={`navbar ${scrolled ? "is-scrolled" : ""}`}>
      <div className="navbar-inner">
        {/* Brand Logo */}
        <Link to="/" className="navbar-brand" onClick={closeMobile}>
          <img
            src={cookMitraLogo}
            alt="Cook Mitra logo"
            className="brand-logo-img"
          />
          <span>
            Cook<span className="brand-accent">Mitra</span>
          </span>
        </Link>

        {/* Desktop Navigation */}
        <div className="navbar-nav">
          <LocationPicker />
          {!hideCustomerPages && (
            <>
              <NavLink to="/cook-on-demand" className="btn btn-primary btn-sm">
                <ChefHat size={16} />
                Book a Cook
              </NavLink>

              <div className="nav-divider"></div>
            </>
          )}

          {user ? (
            <>
              {user.role === "customer" && (
                <NavLink
                  to="/dashboard/my-bookings"
                  className={({ isActive }) =>
                    isActive ? "nav-link active" : "nav-link"
                  }
                >
                  <Calendar size={17} />
                  My Bookings
                </NavLink>
              )}

              {user.role === "customer" && (
                <NavLink
                  to="/dashboard/profile"
                  className={({ isActive }) =>
                    isActive ? "nav-link active" : "nav-link"
                  }
                >
                  <User size={17} />
                  Profile
                </NavLink>
              )}

              {user.role === "cook" && (
                <NavLink
                  to="/dashboard/cook-bookings"
                  className={({ isActive }) =>
                    isActive ? "nav-link active" : "nav-link"
                  }
                >
                  <ChefHat size={17} />
                  Cook Dashboard
                </NavLink>
              )}

              {user.role === "admin" && (
                <NavLink
                  to="/admin"
                  className={({ isActive }) =>
                    isActive ? "nav-link active" : "nav-link"
                  }
                >
                  <ShieldAlert size={17} />
                  Admin
                </NavLink>
              )}

              {(user.role === "customer" || user.role === "cook") && (
                <NavLink
                  to="/dashboard/notifications"
                  title="Notifications"
                  aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
                  className={({ isActive }) =>
                    isActive ? "nav-link nav-icon-btn active" : "nav-link nav-icon-btn"
                  }
                >
                  <Bell size={23} />
                  {unreadCount > 0 && (
                    <span className="nav-icon-badge">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                  )}
                </NavLink>
              )}

              <div className="nav-divider"></div>

              {/* User Profile Pill — clicking goes to the profile page */}
              <Link
                to={profilePath}
                className="navbar-user-chip navbar-profile-link"
                title="Go to my profile"
                aria-label="Go to my profile"
              >
                <NavAvatar name={user.name} photo={cookPhoto} />
                <div className="user-info-text">
                  <span className="user-name-label">{user.name}</span>
                  <span className="user-role-badge">{user.role}</span>
                </div>
              </Link>

              <button
                onClick={handleLogout}
                className="btn btn-outline btn-sm"
                title="Log out"
              >
                <LogOut size={16} />
                Logout
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="btn btn-outline btn-sm">
                Login
              </Link>
              <Link to="/register" className="btn btn-primary btn-sm">
                Register
              </Link>
            </>
          )}
        </div>

        {/* Mobile actions: avatar + bell + menu toggle (small screens only) */}
        <div className="navbar-mobile-actions">
          {user && (
            <Link
              to={profilePath}
              className="nav-icon-btn mobile-avatar"
              title="Go to my profile"
              aria-label={`Go to my profile (${user.name})`}
              onClick={closeMobile}
            >
              <NavAvatar name={user.name} photo={cookPhoto} />
            </Link>
          )}
          {user && (user.role === "customer" || user.role === "cook") && (
            <NavLink
              to="/dashboard/notifications"
              title="Notifications"
              aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
              className={({ isActive }) =>
                isActive
                  ? "nav-link nav-icon-btn mobile-bell active"
                  : "nav-link nav-icon-btn mobile-bell"
              }
              onClick={closeMobile}
            >
              <Bell size={24} />
              {unreadCount > 0 && (
                <span className="nav-icon-badge">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </NavLink>
          )}
          <button
            className="mobile-toggle-btn"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label="Toggle navigation menu"
          >
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </div>

      {/* Mobile Dropdown Drawer */}
      {mobileMenuOpen && (
        <div className="mobile-menu open">
          <LocationPicker />
          {!hideCustomerPages && (
            <>
              <NavLink
                to="/cook-on-demand"
                className="btn btn-primary btn-block"
                onClick={closeMobile}
              >
                <ChefHat size={18} />
                Book a Cook
              </NavLink>
            </>
          )}

          {user ? (
            <>
              {user.role === "customer" && (
                <NavLink
                  to="/dashboard/my-bookings"
                  className={({ isActive }) =>
                    isActive ? "nav-link active" : "nav-link"
                  }
                  onClick={closeMobile}
                >
                  <Calendar size={18} />
                  My Bookings
                </NavLink>
              )}

              {user.role === "customer" && (
                <NavLink
                  to="/dashboard/profile"
                  className={({ isActive }) =>
                    isActive ? "nav-link active" : "nav-link"
                  }
                  onClick={closeMobile}
                >
                  <User size={18} />
                  Profile
                </NavLink>
              )}

              {user.role === "cook" && (
                <NavLink
                  to="/dashboard/cook-bookings"
                  className={({ isActive }) =>
                    isActive ? "nav-link active" : "nav-link"
                  }
                  onClick={closeMobile}
                >
                  <ChefHat size={18} />
                  Cook Dashboard
                </NavLink>
              )}

              {user.role === "admin" && (
                <NavLink
                  to="/admin"
                  className={({ isActive }) =>
                    isActive ? "nav-link active" : "nav-link"
                  }
                  onClick={closeMobile}
                >
                  <ShieldAlert size={18} />
                  Admin
                </NavLink>
              )}

              {(user.role === "customer" || user.role === "cook") && (
                <NavLink
                  to="/dashboard/notifications"
                  className={({ isActive }) =>
                    isActive ? "nav-link active" : "nav-link"
                  }
                  onClick={closeMobile}
                >
                  <Bell size={18} />
                  Notifications
                  {unreadCount > 0 && (
                    <span className="nav-pill-badge">
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </span>
                  )}
                </NavLink>
              )}

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0.5rem 0",
                  borderTop: "1px solid var(--slate-100)",
                }}
              >
                <Link
                  to={profilePath}
                  className="mobile-profile-link"
                  onClick={closeMobile}
                  aria-label="Go to my profile"
                  style={{ minWidth: 0, flex: 1 }}
                >
                  <NavAvatar name={user.name} photo={cookPhoto} />
                  <div style={{ minWidth: 0, overflow: "hidden" }}>
                    <div style={{ fontWeight: 700, fontSize: "0.9rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{user.name}</div>
                    <div style={{ fontSize: "0.75rem", color: "var(--primary)", textTransform: "capitalize" }}>{user.role}</div>
                  </div>
                </Link>
                <button onClick={handleLogout} className="btn btn-outline btn-sm">
                  <LogOut size={16} />
                  Logout
                </button>
              </div>
            </>
          ) : (
            <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.5rem" }}>
              <Link to="/login" className="btn btn-outline btn-block" onClick={closeMobile}>
                Login
              </Link>
              <Link to="/register" className="btn btn-primary btn-block" onClick={closeMobile}>
                Register
              </Link>
            </div>
          )}
        </div>
      )}
    </nav>
  );
};

export default Navbar;
