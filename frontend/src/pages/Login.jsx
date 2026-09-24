import React, { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useDispatch } from "react-redux";
import { loginUser } from "../store/authSlice";
import { useShowToast } from "../store/hooks";
import { safeNextPath } from "../utils/bookingDraft";
import {
  authErrorMessage,
  fieldErrorsFromResponse,
  normalizeEmail,
  validateEmail,
  validatePassword,
} from "../utils/authValidation";
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  ArrowRight,
  AlertCircle,
  CalendarCheck,
  Wallet,
  ShieldCheck,
  Loader2,
  Users,
  BadgeCheck,
} from "lucide-react";
import cookMitraLogo from "../assets/logo.png";
// Google sign-in intentionally disabled for now — re-enable together with the
// commented <GoogleSignInButton /> block below.
// import GoogleSignInButton from "../components/GoogleSignInButton";

const Login = () => {
  const [formData, setFormData] = useState({ email: "", password: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [fieldErrors, setFieldErrors] = useState({});
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
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    // Clear the field's error as soon as the user fixes it.
    setFieldErrors((prev) => (prev[name] ? { ...prev, [name]: "" } : prev));
    if (error) setError("");
  };

  const validate = () => {
    const errors = {};
    const emailErr = validateEmail(formData.email);
    if (emailErr) errors.email = emailErr;
    if (!formData.password) errors.password = "Password is required";
    else {
      const pwErr = validatePassword(formData.password);
      if (pwErr) errors.password = pwErr;
    }
    setFieldErrors(errors);
    return errors;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;
    const errors = validate();
    if (Object.values(errors).some(Boolean)) {
      setError("Please fix the highlighted fields and try again.");
      return;
    }
    setLoading(true);
    setError("");

    try {
      const email = normalizeEmail(formData.email);
      const { user } = await dispatch(
        loginUser({ email, password: formData.password, rememberMe })
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
      const serverFields = fieldErrorsFromResponse(err);
      if (Object.keys(serverFields).length) setFieldErrors(serverFields);
      const msg = authErrorMessage(err, "Invalid credentials. Please try again.");
      setError(msg);
      showToast(msg, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-split">
      {/* ---- Professional showcase panel (mirrors register) ---- */}
      <aside className="login-showcase">
        <div className="login-showcase-glow login-showcase-glow-1" />
        <div className="login-showcase-glow login-showcase-glow-2" />
        <div className="login-showcase-inner">
          <Link to="/" className="login-brand" tabIndex={-1}>
            <img src={cookMitraLogo} alt="Cook Mitra logo" className="brand-logo-img" />
            <span>
              Cook<span className="brand-accent">Mitra</span>
            </span>
          </Link>

          <span className="login-eyebrow-badge">
            <Users size={14} /> Trusted by 12,000+ households
          </span>
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
                <BadgeCheck size={17} />
              </span>
              ID-verified, background-checked cooks
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

      {/* ---- Form panel (mirrors register card chrome) ---- */}
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
            <p>Access your CookMitra account</p>
          </div>

          {next && (
            <div className="auth-resume-note">
              You were booking a cook — sign in to pick up right where you left off.
            </div>
          )}

          {error && (
            <div className="error-alert-banner login-error" role="alert">
              <AlertCircle size={16} /> {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="login-form" noValidate>
            <div className="booking-form-group">
              <label htmlFor="login-email">
                Email address <span className="login-required" aria-hidden="true">*</span>
              </label>
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
                  onBlur={() =>
                    setFieldErrors((p) => ({ ...p, email: validateEmail(formData.email) || "" }))
                  }
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={254}
                  aria-invalid={Boolean(fieldErrors.email)}
                  aria-describedby={fieldErrors.email ? "login-email-error" : undefined}
                  required
                />
              </div>
              {fieldErrors.email && (
                <div className="field-error" id="login-email-error" role="alert">
                  {fieldErrors.email}
                </div>
              )}
            </div>

            <div className="booking-form-group">
              <div className="login-label-row">
                <label htmlFor="login-password">
                  Password <span className="login-required" aria-hidden="true">*</span>
                </label>
                <Link
                  to={
                    formData.email
                      ? `/forgot-password?email=${encodeURIComponent(normalizeEmail(formData.email))}`
                      : "/forgot-password"
                  }
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
                  maxLength={128}
                  aria-invalid={Boolean(fieldErrors.password)}
                  aria-describedby={fieldErrors.password ? "login-password-error" : undefined}
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
              {fieldErrors.password && (
                <div className="field-error" id="login-password-error" role="alert">
                  {fieldErrors.password}
                </div>
              )}
            </div>

            <div className="login-options-row">
              <label className="login-remember">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                <span className="login-checkbox" aria-hidden="true" />
                Keep me signed in on this device
              </label>
            </div>

            <button
              type="submit"
              className="btn btn-primary btn-block btn-lg login-submit"
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 size={19} className="spin" /> Signing in…
                </>
              ) : (
                <>
                  Sign in <ArrowRight size={19} />
                </>
              )}
            </button>

            <p className="login-terms">
              By signing in you agree to our <Link to="/terms">Terms</Link> and{" "}
              <Link to="/privacy">Privacy Policy</Link>.
            </p>
          </form>

          {/* <div className="auth-divider">
            <span>or</span>
          </div>

          <GoogleSignInButton
            text="signin_with"
            onError={setError}
            next={next}
          />

          <div className="auth-google-role-note">
            New here? Join with Google — account type will be set during setup.
          </div> */}

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
