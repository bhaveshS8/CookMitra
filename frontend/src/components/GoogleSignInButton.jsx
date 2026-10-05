import { useEffect, useRef, useState } from "react";
import { GoogleLogin } from "@react-oauth/google";
import { useNavigate } from "react-router-dom";
import { useDispatch } from "react-redux";
import { googleLoginUser } from "../store/authSlice";
import { useShowToast } from "../store/hooks";
import { AnalyticsEvents, track } from "../utils/analytics";
import { safeNextPath } from "../utils/bookingDraft";

const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;
const isGoogleConfigured =
  GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.includes("your_google_client_id_here");

const getDashboardPath = (user) => {
  if (user?.role === "cook") return "/dashboard/cook-bookings";
  if (user?.role === "admin") return "/admin";
  return "/";
};

// Reusable Google button for both Login (existing users) and Register
// (new users created with `role`). Handles token exchange + navigation.
const GoogleSignInButton = ({
  role = "customer",
  text = "signin_with",
  onError,
  next = null,
  referralCode = "",
}) => {
  const dispatch = useDispatch();
  const showToast = useShowToast();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  // GSI only accepts fixed pixel widths (200–400), so a hardcoded width can
  // never match the form on every screen — instead measure the wrapper and
  // pass the closest valid width, making the official button exactly fill
  // the login/signup card from 320px phones up to desktop.
  const wrapRef = useRef(null);
  const [btnWidth, setBtnWidth] = useState(320);
  // Shimmer placeholder until Google's iframe mounts, so the button area
  // never looks broken/empty on slow networks (no layout shift either —
  // the skeleton matches the official button's 40px height).
  const [gsiReady, setGsiReady] = useState(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) {
        const next = Math.min(400, Math.max(200, w));
        setBtnWidth((prev) => (Math.abs(prev - next) > 2 ? next : prev));
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (el.querySelector("iframe")) {
      setGsiReady(true);
      return;
    }
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => {
      if (el.querySelector("iframe")) {
        setGsiReady(true);
        mo.disconnect();
      }
    });
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  if (!isGoogleConfigured) {
    return (
      <button
        type="button"
        className="btn btn-outline btn-block btn-lg google-btn-disabled"
        disabled
        title="Add REACT_APP_GOOGLE_CLIENT_ID in frontend/.env and GOOGLE_CLIENT_ID in backend/.env to enable Google sign-in"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#4285F4"
            d="M23.5 12.3c0-.9-.1-1.5-.3-2.3H12v4.3h6.5c0 1.1-.7 2.7-2.1 3.8l-.1.1 3 2.4h.1c1.9-1.8 3.1-4.4 3.1-8.3z"
          />
          <path
            fill="#34A853"
            d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.1 0-5.8-2.1-6.8-5l-.1.1-3.1 2.4v.1C3.9 21.3 7.7 24 12 24z"
          />
          <path
            fill="#FBBC05"
            d="M5.2 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.7.4-2.4l-.1-.1-3.1-2.4H2C.7 9.7 0 10.8 0 12s.7 2.3 2 4.9l3.2-2.5z"
          />
          <path
            fill="#EA4335"
            d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.7 0 3.9 2.7 2 7.1l3.2 2.5c1-2.9 3.7-4.9 6.8-4.9z"
          />
        </svg>
        Continue with Google (setup required)
      </button>
    );
  }

  const handleSuccess = async (credentialResponse) => {
    const idToken = credentialResponse?.credential;
    if (!idToken) {
      const msg = "Google sign-in failed. Please try again.";
      showToast(msg, "error");
      onError?.(msg);
      return;
    }
    setLoading(true);
    try {
      const { user } = await dispatch(googleLoginUser({ idToken, role, referralCode })).unwrap();
      showToast(`Welcome${user?.name ? `, ${user.name}` : ""}!`, "success");
      if (user?.role === "cook") {
        track(AnalyticsEvents.COOK_SIGNUP_COMPLETE, { method: "google" });
      }
      // Interrupted booking? Customers go straight back to it.
      const resumeTo = user?.role === "customer" ? safeNextPath(next) : null;
      navigate(resumeTo || getDashboardPath(user));
    } catch (err) {
      const msg =
        err.response?.data?.message ||
        "Google sign-in failed. Please try again.";
      showToast(msg, "error");
      onError?.(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleError = () => {
    const msg = "Google sign-in was cancelled or failed.";
    showToast(msg, "error");
    onError?.(msg);
  };

  return (
    <div className="google-btn-wrapper" ref={wrapRef}>
      {loading && <div className="google-btn-loading">Signing in with Google…</div>}
      {!gsiReady && !loading && (
        <div className="google-btn-skeleton" aria-hidden="true">
          <span className="google-btn-skeleton-g">G</span>
          <span>{text === "signup_with" ? "Sign up with Google" : "Sign in with Google"}</span>
        </div>
      )}
      <GoogleLogin
        onSuccess={handleSuccess}
        onError={handleError}
        text={text}
        shape="rectangular"
        theme="outline"
        size="large"
        width={String(btnWidth)}
      />
    </div>
  );
};

export default GoogleSignInButton;
