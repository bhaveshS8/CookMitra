import React, { useEffect } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useSelector } from "react-redux";
import {
  Home,
  ChefHat,
  Calendar,
  User,
  ClipboardList,
  Wallet,
  Star,
} from "lucide-react";

/*
 * Phone-only bottom tab bar for signed-in users — a web port of the app's
 * CustomerTabs / CookTabs (Home · Book · Bookings · Profile).
 *
 * Deliberately NOT shown for guests or admins: the app's tabs only exist
 * inside the authenticated navigator, and the site's navbar drawer already
 * owns the guest Login/Register path.
 */

/*
 * The app renders its tab bar only on the four root screens and drops it on
 * pushed screens. These routes are the web equivalent of "pushed": the auth
 * flows, and the wizards/details that already pin their own action bar to the
 * bottom of the viewport (.od-stickybar, .bk-stickybar, .bd-actionbar).
 * Without this the bar would stack a second translucent deck on top of them.
 */
const HIDE_PREFIXES = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/cook-on-demand",
  "/cooks/",
  "/bookings/",
];

const TABS = {
  customer: [
    { to: "/", label: "Home", Icon: Home, end: true },
    { to: "/cook-on-demand", label: "Book", Icon: ChefHat },
    { to: "/dashboard/my-bookings", label: "Bookings", Icon: Calendar },
    { to: "/dashboard/profile", label: "Profile", Icon: User },
  ],
  cook: [
    { to: "/dashboard/cook-bookings", label: "Jobs", Icon: ClipboardList },
    { to: "/cook/earnings", label: "Earnings", Icon: Wallet },
    { to: "/dashboard/cook-reviews", label: "Reviews", Icon: Star },
    { to: "/dashboard/cook-profile", label: "Profile", Icon: User },
  ],
};

const MobileTabBar = () => {
  const { pathname } = useLocation();
  const user = useSelector((s) => s.auth.user);
  const token = useSelector((s) => s.auth.token);

  const tabs = token && user ? TABS[user.role] : null;
  const hidden = HIDE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  const visible = Boolean(tabs) && !hidden;

  /*
   * Drives the footer clearance in mobile-tabbar.css. Only set while the bar
   * is actually on screen, so hidden routes keep their normal footer spacing.
   */
  useEffect(() => {
    document.body.classList.toggle("has-mtabbar", visible);
    return () => document.body.classList.remove("has-mtabbar");
  }, [visible]);

  if (!visible) return null;

  return (
    <nav className="mtabbar" aria-label="Primary">
      {tabs.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          aria-label={label}
          className={({ isActive }) => `mtab-item${isActive ? " active" : ""}`}
        >
          <span className="mtab-ico">
            <Icon size={21} strokeWidth={2.1} />
          </span>
          <span className="mtab-label">{label}</span>
        </NavLink>
      ))}
    </nav>
  );
};

export default MobileTabBar;
