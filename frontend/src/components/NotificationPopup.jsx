import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSelector } from "react-redux";
import { useNavigate, useLocation } from "react-router-dom";
import { Bell, X, ChevronRight } from "lucide-react";
import API from "../api/axios";

const POLL_MS = 30000;
const POPUP_TTL_MS = 9000;
const MAX_POPUPS = 3;

const targetFor = (n) => {
  if (n?.link) return n.link;
  const b = n?.booking;
  const id = typeof b === "string" ? b : b?._id;
  if (id) return `/bookings/${id}`;
  return "/dashboard/notifications";
};

const normalizeList = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
};

const NotificationPopup = () => {
  const user = useSelector((s) => s.auth.user);
  const navigate = useNavigate();
  const location = useLocation();
  const isBookingRoute = /^\/(cook-on-demand|cooks(\/|$)|bookings(\/|$))/.test(
    location.pathname || ""
  );
  const [popups, setPopups] = useState([]);
  const knownIds = useRef(new Set());
  const initialized = useRef(false);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setPopups((prev) => prev.filter((p) => p._id !== id));
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const queuePopup = useCallback(
    (n) => {
      if (isBookingRoute) {
        try {
          window.dispatchEvent(new CustomEvent("notifications-updated"));
        } catch {
        }
        return;
      }
      if (user?.role === "cook" && n?.type === "booking_request") {
        try {
          window.dispatchEvent(new CustomEvent("notifications-updated"));
        } catch {
        }
        return;
      }
      const id = String(n._id || n.id || `${Date.now()}-${Math.random()}`);
      setPopups((prev) => {
        if (prev.some((p) => String(p._id) === id)) return prev;
        const next = [
          ...prev,
          { _id: id, notifId: n._id || n.id, type: n.type, message: n.message, target: targetFor(n) },
        ];
        return next.slice(-MAX_POPUPS);
      });
      if (!timers.current.has(id)) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), POPUP_TTL_MS)
        );
      }
      try {
        window.dispatchEvent(new CustomEvent("notifications-updated"));
      } catch {
      }
    },
    [dismiss, isBookingRoute, user?.role]
  );

  useEffect(() => {
    if (isBookingRoute) setPopups([]);
  }, [isBookingRoute]);

  useEffect(() => {
    knownIds.current = new Set();
    initialized.current = false;
    setPopups([]);
  }, [user?._id, user?.id]);

  useEffect(() => {
    if (!user || !["customer", "cook", "admin"].includes(user.role)) return;
    let cancelled = false;

    const poll = async (isFirst = false) => {
      if (document.hidden) return;
      try {
        const { data } = await API.get("/notifications");
        if (cancelled) return;
        const list = normalizeList(data);
        if (!initialized.current || isFirst) {
          list.forEach((n) => {
            const key = String(n._id || n.id || "");
            if (key) knownIds.current.add(key);
          });
          initialized.current = true;
          return;
        }
        const fresh = list.filter((n) => {
          const key = String(n._id || n.id || "");
          return key && !knownIds.current.has(key) && !n.read;
        });
        list.forEach((n) => {
          const key = String(n._id || n.id || "");
          if (key) knownIds.current.add(key);
        });
        fresh
          .slice()
          .reverse()
          .forEach(queuePopup);
      } catch {
      }
    };

    poll(true);
    const id = setInterval(() => poll(false), POLL_MS);
    const onVis = () => {
      if (!document.hidden) poll(false);
    };
    const onFocus = () => poll(false);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
    };
  }, [user, queuePopup]);

  useEffect(
    () => () => {
      timers.current.forEach((t) => clearTimeout(t));
      timers.current.clear();
    },
    []
  );

  const openPopup = async (p) => {
    if (p.notifId) {
      try {
        await API.patch(`/notifications/${p.notifId}/read`);
      } catch {
      }
      try {
        window.dispatchEvent(new CustomEvent("notifications-updated"));
      } catch {
      }
    }
    dismiss(p._id);
    navigate(p.target || "/dashboard/notifications");
  };

  if (!popups.length) return null;

  return (
    <div className="notif-popup-stack" aria-live="polite" aria-label="New notifications">
      {popups.map((p) => (
        <div
          key={p._id}
          className="notif-popup-card"
          role="alert"
          onClick={() => openPopup(p)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openPopup(p);
            }
          }}
          tabIndex={0}
        >
          <span className="notif-popup-icon" aria-hidden="true">
            <Bell size={18} />
          </span>
          <div className="notif-popup-body">
            <strong className="notif-popup-title">New notification</strong>
            <p className="notif-popup-message">{p.message || "You have a new update."}</p>
            <span className="notif-popup-link">
              View <ChevronRight size={14} />
            </span>
          </div>
          <button
            type="button"
            className="notif-popup-close"
            aria-label="Dismiss notification"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(p._id);
            }}
          >
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
};

export default NotificationPopup;
