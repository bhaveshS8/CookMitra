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

const getGoogleLabel = (text) =>
  text === "signup_with" ? "Sign up with Google" : "Continue with Google";

// Official four-colour Google "G" mark.
const GoogleGlyph = () => (
  <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
  </svg>
);

const GoogleSignInButton = ({
  role = "customer",
  text = "signin_with",
  onError,
  next = null,
}) => {
  const dispatch = useDispatch();
  const showToast = useShowToast();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef(null);
  const [btnWidth, setBtnWidth] = useState(320);
  const [wrapWidth, setWrapWidth] = useState(320);
  const [gsiReady, setGsiReady] = useState(false);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) {
        setWrapWidth((prev) => (Math.abs(prev - w) > 2 ? w : prev));
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
      <div className="google-btn-wrapper">
        <button
          type="button"
          className="google-btn google-btn--disabled"
          disabled
          title="Add REACT_APP_GOOGLE_CLIENT_ID in frontend/.env and GOOGLE_CLIENT_ID in backend/.env to enable Google sign-in"
        >
          <span className="google-btn-content">
            <span className="google-btn-icon">
              <GoogleGlyph />
            </span>
            <span className="google-btn-label">{getGoogleLabel(text)}</span>
            <span className="google-btn-badge">Setup required</span>
          </span>
        </button>
      </div>
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
      const { user } = await dispatch(googleLoginUser({ idToken, role })).unwrap();
      showToast(`Welcome${user?.name ? `, ${user.name}` : ""}!`, "success");
      if (user?.role === "cook") {
        track(AnalyticsEvents.COOK_SIGNUP_COMPLETE, { method: "google" });
      }
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

  const stateClass = loading ? " is-loading" : gsiReady ? " is-ready" : " is-pending";
  // Stretch Google's 40px-tall iframe to fill the visual button so the whole
  // surface stays clickable (e.g. wide registration card vs. GSI's 400px cap).
  const gsiScaleX = Math.min(1.5, Math.max(1, wrapWidth / (btnWidth || 1)));

  return (
    <div className="google-btn-wrapper" ref={wrapRef}>
      {/*
        The visual button is ours; Google's own button (iframe) sits on top,
        fully transparent, so the real OAuth popup/credential flow is unchanged.
      */}
      <div
        className={`google-btn${stateClass}`}
        style={{ "--gsi-scale-x": gsiScaleX }}
      >
        <span className="google-btn-content" aria-hidden="true">
          <span className="google-btn-icon">
            <GoogleGlyph />
          </span>
          <span className="google-btn-label">{getGoogleLabel(text)}</span>
        </span>

        <GoogleLogin
          onSuccess={handleSuccess}
          onError={handleError}
          text={text}
          shape="rectangular"
          theme="outline"
          size="large"
          width={String(btnWidth)}
          containerProps={{
            className: "google-btn-gsi",
            style: { width: "100%", height: "100%" },
          }}
        />

        {loading && (
          <span className="google-btn-loading" role="status">
            <span className="google-btn-spinner" aria-hidden="true" />
            Signing in with Google…
          </span>
        )}
      </div>
    </div>
  );
};

export default GoogleSignInButton;
