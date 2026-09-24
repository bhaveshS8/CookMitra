import React, { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { Lock, AlertCircle, Loader2, CheckCircle2, Eye, EyeOff } from "lucide-react";
import cookMitraLogo from "../assets/logo.png";

// Reset password: consumes ?token= with a new password via
// POST /auth/reset-password. Invalid/expired tokens surface the API message.
const ResetPassword = () => {
  const [searchParams] = useSearchParams();
  const [token] = useState(searchParams.get("token") || "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const showToast = useShowToast();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters long");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await API.post("/auth/reset-password", { token, password });
      setDone(true);
      showToast(res.data?.message || "Password reset!", "success");
    } catch (err) {
      const msg = err.response?.data?.message || "Reset failed. Your link may have expired.";
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
          <h2>Choose a new password</h2>
          <p>Links expire 1 hour after they are sent.</p>
        </div>

        {error && (
          <div className="error-alert-banner" style={{ marginBottom: "0.75rem" }}>
            <AlertCircle size={15} /> {error}
          </div>
        )}

        {!token ? (
          <div className="auth-resume-note">
            This reset link is missing its token. Please request a{" "}
            <Link to="/forgot-password">new reset link</Link>.
          </div>
        ) : done ? (
          <div>
            <div className="auth-resume-note">
              <CheckCircle2 size={14} /> Password updated — please sign in with your new
              password.
            </div>
            <div className="auth-footer-prompt" style={{ marginTop: "1rem" }}>
              <Link to="/login">Go to sign in →</Link>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="booking-form-group">
              <label htmlFor="rp-password">New password</label>
              <div className="input-with-icon password-input-wrapper">
                <Lock size={18} className="input-icon-prefix" />
                <input
                  id="rp-password"
                  type={showPassword ? "text" : "password"}
                  className="form-control"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
                <button
                  type="button"
                  className="password-toggle-btn"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <div className="booking-form-group">
              <label htmlFor="rp-confirm">Confirm new password</label>
              <div className="input-with-icon password-input-wrapper">
                <Lock size={18} className="input-icon-prefix" />
                <input
                  id="rp-confirm"
                  type={showConfirmPassword ? "text" : "password"}
                  className="form-control"
                  placeholder="Repeat the new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
                <button
                  type="button"
                  className="password-toggle-btn"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                >
                  {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={loading}>
              {loading ? (
                <>
                  <Loader2 size={19} className="spin" /> Saving…
                </>
              ) : (
                "Set new password"
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default ResetPassword;
