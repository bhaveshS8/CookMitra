import React, { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useDispatch } from "react-redux";
import { loginUser } from "../store/authSlice";
import { useShowToast } from "../store/hooks";
import { safeNextPath } from "../utils/bookingDraft";
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  ArrowRight,
  AlertCircle,
  CalendarCheck,
  Wallet,
  Star,
  ShieldCheck,
  Loader2,
} from "lucide-react";
import cookMitraLogo from "../assets/logo.png";
import GoogleSignInButton from "../components/GoogleSignInButton";

const Login = () => {
  const [formData, setFormData] = useState({ email: "", password: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const dispatch = useDispatch();
  const showToast = useShowToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // ?next=… is set when login interrupted a booking — customers return to it.
  const next = safeNextPath(searchParams.get("next"));
  const registerTo = next ? `/register?next=${encodeURIComponent(next)}` : "/register";

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const { user } = await dispatch(
        loginUser({ email: formData.email, password: formData.password, rememberMe })
      ).unwrap();

      showToast(`Welcome back, ${user.name}!`, "success");

      if (user.role === "cook") {
        navigate("/dashboard/cook-bookings");
      } else if (user.role === "admin") {
        navigate("/admin");
      } else if (next) {
        navigate(next);
      } else {
        navigate("/");
      }
    } catch (err) {
      const msg = err.response?.data?.message || "Invalid credentials. Please try again.";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-split">
      <aside className="login-showcase">
        <div className="login-showcase-glow login-showcase-glow-1" />
        <div className="login-showcase-glow login-showcase-glow-2" />
        <div className="login-showcase-inner">
          <Link to="/" className="login-brand">
            <img
              src={cookMitraLogo}
              alt="Cook Mitra logo"
              className="brand-logo-img"
            />
            <span>
              Cook<span className="brand-accent">Mitra</span>
            </span>
          </Link>

          <h1 className="login-showcase-title">Welcome back</h1>
          <p className="login-showcase-sub">
            Sign in to manage your bookings, profile and festive favourites.
          </p>

          <ul className="login-perks">
            <li className="login-perk-item">
              <span className="login-perk-icon">
                <CalendarCheck size={17} />
              </span>
              Live booking updates & history
            </li>
            <li className="login-perk-item">
              <span className="login-perk-icon">
                <Star size={17} />
              </span>
              4.8-rated verified home cooks
            </li>
            <li className="login-perk-item">
              <span className="login-perk-icon">
                <Wallet size={17} />
              </span>
              Secure UPI & card payments
            </li>
          </ul>

          <div className="login-showcase-proof">
            <div className="login-avatars">
              <span>PS</span>
              <span>AR</span>
              <span>MK</span>
              <span className="login-avatars-more">12k+</span>
            </div>
            <div>
              <div className="login-proof-stars">★★★★★ 4.8/5</div>
              <div className="login-proof-text">Loved by 12,000+ households</div>
            </div>
          </div>
        </div>
      </aside>

      <div className="login-form-side">
        <div className="login-card">
          <div className="login-card-header">
            <div className="login-mobile-brand">
              <img
                src={cookMitraLogo}
                alt="Cook Mitra logo"
                className="brand-logo-img"
                style={{ width: 36, height: 36 }}
              />
              <span>
                Cook<span className="brand-accent">Mitra</span>
              </span>
            </div>
            <h2>Sign in</h2>
            <p>Enter your email and password to continue</p>
          </div>

          {next && (
            <div className="auth-resume-note">
              You were booking a cook — sign in to pick up right where you left off.
            </div>
          )}

          {error && (
            <div className="error-alert-banner login-error">
              <AlertCircle size={16} /> {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="login-form">
            <div className="booking-form-group">
              <label htmlFor="login-email">Email address</label>
              <div className="input-with-icon">
                <Mail size={18} className="input-icon-prefix" />
                <input
                  id="login-email"
                  type="email"
                  name="email"
                  className="form-control login-input"
                  placeholder="name@example.com"
                  value={formData.email}
                  onChange={handleChange}
                  autoComplete="email"
                  required
                />
              </div>
            </div>

            <div className="booking-form-group">
              <div className="login-label-row">
                <label htmlFor="login-password">Password</label>
                <Link
                  to={formData.email ? `/forgot-password?email=${encodeURIComponent(formData.email)}` : "/forgot-password"}
                  className="login-link-btn"
                  tabIndex={-1}
                >
                  Forgot password?
                </Link>
              </div>
              <div className="input-with-icon password-input-wrapper">
                <Lock size={18} className="input-icon-prefix" />
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  name="password"
                  className="form-control login-input"
                  placeholder="Enter your password"
                  value={formData.password}
                  onChange={handleChange}
                  autoComplete="current-password"
                  required
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

            <label className="login-remember">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              />
              <span className="login-checkbox" aria-hidden="true" />
              Keep me signed in on this device
            </label>

            <button
              type="submit"
              className="btn btn-primary btn-block btn-lg login-submit"
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 size={19} className="spin" /> Signing in...
                </>
              ) : (
                <>
                  Sign in <ArrowRight size={19} />
                </>
              )}
            </button>
          </form>

          <div className="auth-divider">
            <span>or</span>
          </div>

          <GoogleSignInButton
            text="signin_with"
            onError={setError}
            next={next}
          />

          <div className="auth-google-role-note">
            New here? Join with Google — account type will be set during setup.
          </div>

          <div className="auth-footer-prompt">
            Don&apos;t have an account yet? <Link to={registerTo}>Create an account</Link>
          </div>

          <div className="login-secure-note">
            <ShieldCheck size={14} /> Protected with encrypted sign-in
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;