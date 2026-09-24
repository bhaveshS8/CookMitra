import React, { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useDispatch } from "react-redux";
import { registerUser } from "../store/authSlice";
import { useShowToast } from "../store/hooks";
import { AnalyticsEvents, track } from "../utils/analytics";
import { safeNextPath } from "../utils/bookingDraft";
import {
  authErrorMessage,
  fieldErrorsFromResponse,
  normalizeEmail,
  normalizePhone,
  passwordStrength,
  strengthLabel,
  validateEmail,
  validateName,
  validatePassword,
  validatePhone,
} from "../utils/authValidation";
import {
  Mail,
  Lock,
  User,
  Phone,
  Eye,
  EyeOff,
  ChefHat,
  CalendarCheck,
  AlertCircle,
  ArrowRight,
  Loader2,
  Check,
  ShieldCheck,
  BadgeCheck,
  Wallet,
  Users,
} from "lucide-react";
import cookMitraLogo from "../assets/logo.png";
// Google sign-in intentionally disabled for now — re-enable together with the
// commented <GoogleSignInButton /> block below.
// import GoogleSignInButton from "../components/GoogleSignInButton";

const Register = () => {
  const [searchParams] = useSearchParams();
  const initialRole = searchParams.get("role") === "cook" ? "cook" : "customer";
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
    confirmPassword: "",
    role: initialRole,
  });

  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const dispatch = useDispatch();
  const showToast = useShowToast();
  const navigate = useNavigate();
  // ?next=… resumes an interrupted booking for new customers.
  const next = safeNextPath(searchParams.get("next"));
  const loginTo = next ? `/login?next=${encodeURIComponent(next)}` : "/login";

  const strength = useMemo(() => passwordStrength(formData.password), [formData.password]);
  const isCook = formData.role === "cook";

  const handleChange = (e) => {
    const { name } = e.target;
    let { value } = e.target;
    // Mobile must be exactly 10 digits — strip non-digits as the user types.
    if (name === "phone") value = String(value).replace(/\D/g, "").slice(0, 10);
    setFormData((prev) => ({ ...prev, [name]: value }));
    setFieldErrors((prev) => (prev[name] ? { ...prev, [name]: "" } : prev));
    if (error) setError("");
  };

  // Numbers-only mobile field: block non-digit keystrokes (letters, symbols,
  // spaces) while keeping navigation + clipboard shortcuts working.
  const handlePhoneKeyDown = (e) => {
    const navKeys = [
      "Backspace",
      "Delete",
      "Tab",
      "Escape",
      "Enter",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ];
    if (navKeys.includes(e.key)) return;
    if ((e.ctrlKey || e.metaKey) && ["a", "c", "v", "x", "z", "y"].includes(e.key.toLowerCase()))
      return;
    if (!/^[0-9]$/.test(e.key)) e.preventDefault();
  };

  // Paste only the digits from clipboard content into the mobile field.
  const handlePhonePaste = (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData?.getData("text") || "").replace(/\D/g, "");
    if (!pasted) return;
    const input = e.target;
    const cur = String(formData.phone || "");
    const start = input.selectionStart ?? cur.length;
    const end = input.selectionEnd ?? start;
    const next = (cur.slice(0, start) + pasted + cur.slice(end))
      .replace(/\D/g, "")
      .slice(0, 10);
    setFormData((prev) => ({ ...prev, phone: next }));
    setFieldErrors((prev) => (prev.phone ? { ...prev, phone: "" } : prev));
    if (error) setError("");
  };

  const setRole = (role) => {
    setFormData((prev) => ({ ...prev, role }));
  };

  const validate = () => {
    const errors = {};
    const nameErr = validateName(formData.name);
    if (nameErr) errors.name = nameErr;
    const emailErr = validateEmail(formData.email);
    if (emailErr) errors.email = emailErr;
    const phoneErr = validatePhone(formData.phone);
    if (phoneErr) errors.phone = phoneErr;
    const pwErr = validatePassword(formData.password);
    if (pwErr) errors.password = pwErr;
    if (!formData.confirmPassword) errors.confirmPassword = "Please confirm your password";
    else if (formData.password !== formData.confirmPassword)
      errors.confirmPassword = "Passwords do not match";
    if (!["customer", "cook"].includes(formData.role)) errors.role = "Choose an account type";
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
    track(AnalyticsEvents.COOK_SIGNUP_START, { method: "email", role: formData.role });

    try {
      const payload = {
        name: String(formData.name).trim(),
        email: normalizeEmail(formData.email),
        phone: normalizePhone(formData.phone),
        password: formData.password,
        role: formData.role,
      };
      const { user } = await dispatch(registerUser(payload)).unwrap();
      showToast(`Welcome to Cook Mitra, ${user.name}!`, "success");
      if (user.role === "cook") {
        track(AnalyticsEvents.COOK_SIGNUP_COMPLETE, { method: "email" });
        navigate("/dashboard/cook-bookings");
      } else if (next) {
        navigate(next);
      } else {
        navigate("/");
      }
    } catch (err) {
      const serverMsg = err?.response?.data?.message || "";
      const serverData = err?.response?.data || {};
      // Duplicate email: backend returns 400 with "Email already exists..."
      // (legacy builds returned "Email already registered"). Show it both as
      // a banner and inline under the email field so the user knows to use
      // another email.
      const isEmailExists =
        serverData.code === "EMAIL_EXISTS" ||
        serverData.field === "email" ||
        /already\s+(registered|exists)/i.test(serverMsg);
      const serverFields = fieldErrorsFromResponse(err);
      if (isEmailExists && !serverFields.email) {
        serverFields.email = "Email already exists, please enter another email";
      }
      if (Object.keys(serverFields).length) {
        // Backend uses `phone`/`mobile` interchangeably — show under `phone`.
        if (serverFields.mobile && !serverFields.phone) serverFields.phone = serverFields.mobile;
        setFieldErrors((prev) => ({ ...prev, ...serverFields }));
      }
      let msg = authErrorMessage(err, "Registration failed. Please try again.");
      if (isEmailExists) msg = "Email already exists, please enter another email";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setLoading(false);
    }
  };

  const inputProps = (name, errKey) => ({
    "aria-invalid": Boolean(fieldErrors[errKey || name]),
    "aria-describedby": fieldErrors[errKey || name] ? `${name}-error` : undefined,
  });

  return (
    <div className="login-split register-split">
      {/* ---- Professional showcase panel ---- */}
      <aside className="login-showcase register-showcase">
        <div className="login-showcase-glow login-showcase-glow-1" />
        <div className="login-showcase-glow login-showcase-glow-2" />
        <div className="login-showcase-inner">
          <Link to="/" className="login-brand" tabIndex={-1}>
            <img src={cookMitraLogo} alt="Cook Mitra logo" className="brand-logo-img" />
            <span>
              Cook<span className="brand-accent">Mitra</span>
            </span>
          </Link>

          <span className="register-eyebrow-badge">
            <Users size={14} /> Join 12,000+ happy households
          </span>
          <h1 className="login-showcase-title">Create your account</h1>
          <p className="login-showcase-sub">
            {isCook
              ? "Offer your cooking services, get verified bookings and grow your income."
              : "Book verified home cooks for daily meals, parties and festive occasions."}
          </p>

          <ul className="login-perks">
            <li className="login-perk-item">
              <span className="login-perk-icon">
                <BadgeCheck size={17} />
              </span>
              ID-verified, background-checked cooks
            </li>
            <li className="login-perk-item">
              <span className="login-perk-icon">
                <CalendarCheck size={17} />
              </span>
              Flexible slots — same-day availability
            </li>
            <li className="login-perk-item">
              <span className="login-perk-icon">
                <Wallet size={17} />
              </span>
              Secure UPI & card payments
            </li>
          </ul>

          <ol className="register-steps">
            <li className="register-step active">
              <span className="register-step-dot">1</span> Account
            </li>
            <li className="register-step-sep" />
            <li className="register-step">
              <span className="register-step-dot">2</span> Verify
            </li>
            <li className="register-step-sep" />
            <li className="register-step">
              <span className="register-step-dot">3</span> {isCook ? "Earn" : "Book"}
            </li>
          </ol>

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

      {/* ---- Form panel ---- */}
      <div className="login-form-side register-form-side">
        <div className="login-card register-card">
          <div className="login-card-header register-card-header">
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
            <h2>Create an account</h2>
            <p>
              {isCook
                ? "Set up your cook profile and start receiving bookings."
                : "Your Cook. Your Occasion. Your Kitchen."}
            </p>
          </div>

          {next && (
            <div className="auth-resume-note">
              You were booking a cook — your details are saved and waiting after signup.
            </div>
          )}

          {/* Role selector */}
          <div
            className="role-segmented-control register-role-grid"
            role="radiogroup"
            aria-label="Account type"
          >
            <button
              type="button"
              role="radio"
              aria-checked={formData.role === "customer"}
              className={`role-segment-btn register-role-tile ${
                formData.role === "customer" ? "active" : ""
              }`}
              onClick={() => setRole("customer")}
            >
              <span className="register-role-icon">
                <CalendarCheck size={19} />
              </span>
              <span className="register-role-text">
                <strong>Book a Cook</strong>
                <span className="role-hint">For households & hosts</span>
              </span>
              <span className="register-role-check" aria-hidden="true">
                <Check size={14} />
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={formData.role === "cook"}
              className={`role-segment-btn register-role-tile ${
                formData.role === "cook" ? "active" : ""
              }`}
              onClick={() => setRole("cook")}
            >
              <span className="register-role-icon">
                <ChefHat size={19} />
              </span>
              <span className="register-role-text">
                <strong>Join as Cook</strong>
                <span className="role-hint">Offer cooking services</span>
              </span>
              <span className="register-role-check" aria-hidden="true">
                <Check size={14} />
              </span>
            </button>
          </div>

          {error && (
            <div className="error-alert-banner register-error" role="alert">
              <AlertCircle size={16} /> {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="register-form" noValidate>
            <div className="booking-form-group">
              <label htmlFor="reg-name">
                Full name <span className="register-required" aria-hidden="true">*</span>
              </label>
              <div className="input-with-icon">
                <User size={18} className="input-icon-prefix" />
                <input
                  id="reg-name"
                  type="text"
                  name="name"
                  className="form-control register-input"
                  placeholder="e.g. Priya Sharma"
                  value={formData.name}
                  onChange={handleChange}
                  onBlur={() =>
                    setFieldErrors((p) => ({ ...p, name: validateName(formData.name) || "" }))
                  }
                  autoComplete="name"
                  maxLength={80}
                  {...inputProps("reg-name", "name")}
                  required
                />
              </div>
              {fieldErrors.name && (
                <div className="field-error" id="reg-name-error" role="alert">
                  {fieldErrors.name}
                </div>
              )}
            </div>

            <div className="register-grid-2">
              <div className="booking-form-group">
                <label htmlFor="reg-email">
                  Email <span className="register-required" aria-hidden="true">*</span>
                </label>
                <div className="input-with-icon">
                  <Mail size={18} className="input-icon-prefix" />
                  <input
                    id="reg-email"
                    type="email"
                    name="email"
                    className="form-control register-input"
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
                    {...inputProps("reg-email", "email")}
                    required
                  />
                </div>
                {fieldErrors.email && (
                  <div className="field-error" id="reg-email-error" role="alert">
                    {fieldErrors.email}
                  </div>
                )}
              </div>

              <div className="booking-form-group">
                <label htmlFor="reg-phone">
                  Mobile number <span className="register-required" aria-hidden="true">*</span>
                </label>
                <div className="input-with-icon">
                  <Phone size={18} className="input-icon-prefix" />
                  <input
                    id="reg-phone"
                    type="tel"
                    name="phone"
                    className="form-control register-input"
                    placeholder="10-digit mobile number"
                    value={formData.phone}
                    onChange={handleChange}
                    onKeyDown={handlePhoneKeyDown}
                    onPaste={handlePhonePaste}
                    onBlur={() =>
                      setFieldErrors((p) => ({ ...p, phone: validatePhone(formData.phone) || "" }))
                    }
                    autoComplete="tel"
                    inputMode="numeric"
                    pattern="[0-9]{10}"
                    minLength={10}
                    maxLength={10}
                    {...inputProps("reg-phone", "phone")}
                    required
                  />
                </div>
                {fieldErrors.phone ? (
                  <div className="field-error" id="reg-phone-error" role="alert">
                    {fieldErrors.phone}
                  </div>
                ) : (
                  <div className="field-hint">Enter your 10-digit mobile number.</div>
                )}
              </div>
            </div>

            <div className="register-grid-2">
              <div className="booking-form-group">
                <label htmlFor="reg-password">
                  Password <span className="register-required" aria-hidden="true">*</span>
                </label>
                <div className="input-with-icon password-input-wrapper">
                  <Lock size={18} className="input-icon-prefix" />
                  <input
                    id="reg-password"
                    type={showPassword ? "text" : "password"}
                    name="password"
                    className="form-control register-input"
                    placeholder="Min. 8 characters"
                    value={formData.password}
                    onChange={handleChange}
                    onBlur={() =>
                      setFieldErrors((p) => ({
                        ...p,
                        password: validatePassword(formData.password) || "",
                      }))
                    }
                    autoComplete="new-password"
                    maxLength={128}
                    {...inputProps("reg-password", "password")}
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
                {fieldErrors.password && (
                  <div className="field-error" id="reg-password-error" role="alert">
                    {fieldErrors.password}
                  </div>
                )}
              </div>

              <div className="booking-form-group">
                <label htmlFor="reg-confirm">
                  Confirm <span className="register-required" aria-hidden="true">*</span>
                </label>
                <div className="input-with-icon">
                  <Lock size={18} className="input-icon-prefix" />
                  <input
                    id="reg-confirm"
                    type={showPassword ? "text" : "password"}
                    name="confirmPassword"
                    className="form-control register-input"
                    placeholder="Repeat password"
                    value={formData.confirmPassword}
                    onChange={handleChange}
                    autoComplete="new-password"
                    maxLength={128}
                    {...inputProps("reg-confirm", "confirmPassword")}
                    required
                  />
                </div>
                {fieldErrors.confirmPassword && (
                  <div className="field-error" id="reg-confirm-error" role="alert">
                    {fieldErrors.confirmPassword}
                  </div>
                )}
              </div>
            </div>

            {formData.password && (
              <div className="password-strength register-strength" aria-live="polite">
                <div className="register-strength-bars" aria-hidden="true">
                  {[1, 2, 3, 4].map((seg) => (
                    <span
                      key={seg}
                      className={`register-strength-seg ${
                        strength >= seg ? `on strength-${strength}` : ""
                      }`}
                    />
                  ))}
                </div>
                <span className="password-strength-label">
                  <strong>{strengthLabel(strength)}</strong>
                  <span className="register-strength-hint">
                    {" "}
                    — use 10+ characters with mixed case, numbers & symbols.
                  </span>
                </span>
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary btn-block btn-lg login-submit register-submit"
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 size={19} className="spin" /> Creating your account…
                </>
              ) : (
                <>
                  Create account <ArrowRight size={19} />
                </>
              )}
            </button>

            <p className="register-terms">
              By creating an account, you agree to our <Link to="/terms">Terms</Link> and{" "}
              <Link to="/privacy">Privacy Policy</Link>.
            </p>
          </form>

          {/* <div className="auth-divider">
            <span>or</span>
          </div>

          <GoogleSignInButton
            role={formData.role}
            text="signup_with"
            onError={setError}
            next={next}
          /> */}

          <div className="auth-footer-prompt">
            Already have an account? <Link to={loginTo}>Sign in</Link>
          </div>

          <div className="login-secure-note">
            <ShieldCheck size={14} /> Protected with encrypted sign-up
          </div>
        </div>
      </div>
    </div>
  );
};

export default Register;
