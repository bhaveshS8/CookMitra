import React, { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useDispatch } from "react-redux";
import { registerUser } from "../store/authSlice";
import { useShowToast } from "../store/hooks";
import { AnalyticsEvents, track } from "../utils/analytics";
import { safeNextPath } from "../utils/bookingDraft";
import {
  Mail,
  Lock,
  User,
  Phone,
  Eye,
  EyeOff,
  ChefHat,
  Calendar,
  AlertCircle,
} from "lucide-react";
import cookMitraLogo from "../assets/logo.png";
import GoogleSignInButton from "../components/GoogleSignInButton";

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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const dispatch = useDispatch();
  const showToast = useShowToast();
  const navigate = useNavigate();
  // ?next=… resumes an interrupted booking for new customers.
  const next = safeNextPath(searchParams.get("next"));

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const setRole = (role) => {
    setFormData((prev) => ({ ...prev, role }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (formData.password !== formData.confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (formData.password.length < 6) {
      setError("Password must be at least 6 characters long");
      return;
    }

    setLoading(true);
    setError("");
    track(AnalyticsEvents.COOK_SIGNUP_START, { method: "email", role: formData.role });

    try {
      const { confirmPassword, ...data } = formData;
      const { user } = await dispatch(registerUser(data)).unwrap();
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
      const msg = err.response?.data?.message || "Registration failed. Please try again.";
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
          <img
            src={cookMitraLogo}
            alt="Cook Mitra logo"
            className="auth-brand-logo"
          />
          <h2>Create an Account</h2>
          <p>Your Cook. Your Occasion. Your Kitchen.</p>
        </div>

        {next && (
          <div className="auth-resume-note">
            You were booking a cook — your details are saved and waiting after signup.
          </div>
        )}

        {/* Role Selector Segmented Control */}
        <div className="role-segmented-control">
          <button
            type="button"
            className={`role-segment-btn ${formData.role === "customer" ? "active" : ""}`}
            onClick={() => setRole("customer")}
          >
            <Calendar size={18} />
            <span>Book a Cook</span>
            <span className="role-hint">For households & hosts</span>
          </button>
          <button
            type="button"
            className={`role-segment-btn ${formData.role === "cook" ? "active" : ""}`}
            onClick={() => setRole("cook")}
          >
            <ChefHat size={18} />
            <span>Join as Cook</span>
            <span className="role-hint">Offer cooking services</span>
          </button>
        </div>

        {error && (
          <div className="error-alert-banner">
            <AlertCircle size={16} /> {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="booking-form-group">
            <label>Full Name</label>
            <div className="input-with-icon">
              <User size={18} className="input-icon-prefix" />
              <input
                type="text"
                name="name"
                className="form-control"
                placeholder="e.g. Priya Sharma"
                value={formData.name}
                onChange={handleChange}
                required
              />
            </div>
          </div>

          <div className="booking-form-group">
            <label>Email Address</label>
            <div className="input-with-icon">
              <Mail size={18} className="input-icon-prefix" />
              <input
                type="email"
                name="email"
                className="form-control"
                placeholder="name@example.com"
                value={formData.email}
                onChange={handleChange}
                required
              />
            </div>
          </div>

          <div className="booking-form-group">
            <label>Phone Number</label>
            <div className="input-with-icon">
              <Phone size={18} className="input-icon-prefix" />
              <input
                type="tel"
                name="phone"
                className="form-control"
                placeholder="e.g. 9876543210"
                value={formData.phone}
                onChange={handleChange}
                required
              />
            </div>
          </div>

          <div className="booking-form-group">
            <label>Password</label>
            <div className="input-with-icon password-input-wrapper">
              <Lock size={18} className="input-icon-prefix" />
              <input
                type={showPassword ? "text" : "password"}
                name="password"
                className="form-control"
                placeholder="At least 6 characters"
                value={formData.password}
                onChange={handleChange}
                required
                minLength={6}
              />
              <button
                type="button"
                className="password-toggle-btn"
                onClick={() => setShowPassword(!showPassword)}
                aria-label="Toggle password view"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <div className="booking-form-group">
            <label>Confirm Password</label>
            <div className="input-with-icon">
              <Lock size={18} className="input-icon-prefix" />
              <input
                type={showPassword ? "text" : "password"}
                name="confirmPassword"
                className="form-control"
                placeholder="Confirm your password"
                value={formData.confirmPassword}
                onChange={handleChange}
                required
              />
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-block btn-lg"
            disabled={loading}
            style={{ marginTop: "1rem" }}
          >
            {loading ? "Creating Account..." : "Create Account"}
          </button>
        </form>

        <div className="auth-divider">
          <span>or</span>
        </div>

        <GoogleSignInButton
          role={formData.role}
          text="signup_with"
          onError={setError}
          next={next}
        />

        <div className="auth-footer-prompt">
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
};

export default Register;
