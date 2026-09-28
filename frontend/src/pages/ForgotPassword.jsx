import React, { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { Mail, AlertCircle, ArrowLeft, Loader2, KeyRound } from "lucide-react";
import cookMitraLogo from "../assets/logo.png";

// Forgot password: asks for the account email, calls
// POST /auth/forgot-password (always a generic reply — no enumeration).
// Outside production the API returns a dev-only resetToken, which we surface
// as a direct link so the flow is testable without SMTP email delivery.
const ForgotPassword = () => {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState(searchParams.get("email") || "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [devToken, setDevToken] = useState("");
  const showToast = useShowToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await API.post("/auth/forgot-password", { email });
      setDone(true);
      if (res.data?.resetToken) setDevToken(res.data.resetToken);
      showToast("If an account exists, a reset link is on its way.", "success");
    } catch (err) {
      const msg = err.response?.data?.message || "Something went wrong. Please try again.";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrapper">
      <div className="auth-card-modern">
        <div className="auth-header">
          <img src={cookMitraLogo} alt="Cook Mitra logo" className="auth-brand-logo" />
          <h2>Reset your password</h2>
          <p>Enter your account email and we&apos;ll send a 1-hour reset link.</p>
        </div>

        {error && (
          <div className="error-alert-banner" style={{ marginBottom: "0.75rem" }}>
            <AlertCircle size={15} /> {error}
          </div>
        )}

        {done ? (
          <div>
            <div className="auth-resume-note">
              If an account exists for <strong>{email}</strong>, a reset link is on its way
              (valid 1 hour). Also check spam.
            </div>
            {devToken && (
              <div className="auth-resume-note" style={{ marginTop: "0.75rem" }}>
                <KeyRound size={14} /> Dev mode (no email configured):{" "}
                <Link to={`/reset-password?token=${encodeURIComponent(devToken)}`}>
                  continue with this test link
                </Link>
                .
              </div>
            )}
            <div className="auth-footer-prompt" style={{ marginTop: "1rem" }}>
              <Link to="/login">
                <ArrowLeft size={14} /> Back to sign in
              </Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="booking-form-group">
              <label htmlFor="fp-email">Email address</label>
              <div className="input-with-icon">
                <Mail size={18} className="input-icon-prefix" />
                <input
                  id="fp-email"
                  type="email"
                  className="form-control"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  required
                />
              </div>
            </div>
            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 size={19} className="spin" /> Sending…
                </>
              ) : (
                "Send reset link"
              )}
            </button>
            <div className="auth-footer-prompt" style={{ marginTop: "1rem" }}>
              <Link to="/login">
                <ArrowLeft size={14} /> Back to sign in
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default ForgotPassword;
