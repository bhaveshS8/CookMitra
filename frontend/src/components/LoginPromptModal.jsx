import React, { useEffect } from "react";
import { Link } from "react-router-dom";
import { LogIn, UserPlus, X, ChevronRight } from "lucide-react";

const LoginPromptModal = ({ open, onClose, returnTo }) => {
  const loginTo = returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login";
  const registerTo = returnTo ? `/register?next=${encodeURIComponent(returnTo)}` : "/register";
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="login-modal-overlay" onClick={onClose}>
      <div
        className="login-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="login-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={20} />
        </button>

        <div className="login-modal-icon">
          <LogIn size={26} />
        </div>

        <h3 id="login-modal-title">Login to continue booking</h3>
        <p className="login-modal-sub">
          Sign in to your account to send a booking request and track it live.
          New here? Creating an account takes less than a minute.
        </p>

        <Link to={loginTo} className="btn btn-primary btn-block btn-lg login-modal-cta">
          <LogIn size={18} /> Login to Continue Booking
        </Link>
        <Link to={registerTo} className="btn btn-outline btn-block login-modal-cta-alt">
          <UserPlus size={18} /> Create a New Account
        </Link>

        <button type="button" className="login-modal-maybe" onClick={onClose}>
          Maybe later <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
};

export default LoginPromptModal;
