import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { useDispatch } from "react-redux";
import { updateUser } from "../store/authSlice";
import { useShowToast } from "../store/hooks";
import { ArrowLeft, MapPin, Phone, Save, AlertCircle, UserRound, ShieldCheck } from "lucide-react";

const CustomerProfile = () => {
  const dispatch = useDispatch();
  const showToast = useShowToast();
  const [formData, setFormData] = useState({
    name: "",
    phone: "",
    address: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const res = await API.get("/auth/me");
        const data = res.data;
        dispatch(updateUser({
          name: data.name,
          phone: data.phone,
          address: data.address,
        }));
        setFormData({
          name: data.name || "",
          phone: data.phone || "",
          address: data.address || "",
        });
      } catch (err) {
        setError(err.response?.data?.message || "Failed to load profile");
      } finally {
        setLoading(false);
      }
    };
    fetchProfile();
  }, [dispatch]);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      const msg = "Name is required";
      setError(msg);
      showToast(msg, "error");
      return;
    }
    if (!formData.phone.trim()) {
      const msg = "Contact number is required";
      setError(msg);
      showToast(msg, "error");
      return;
    }
    setSaving(true);
    setError("");

    const payload = {
      name: formData.name.trim(),
      phone: formData.phone.trim(),
      address: formData.address.trim(),
    };

    try {
      const res = await API.put("/auth/me", payload);
      const data = res.data;
      dispatch(updateUser({
        name: data.name,
        phone: data.phone,
        address: data.address,
      }));
      showToast("Profile updated successfully!", "success");
    } catch (err) {
      const msg = err.response?.data?.message || "Failed to update profile";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="loading-spinner-wrapper">
        <div className="spinner"></div>
        <p>Loading profile...</p>
      </div>
    );
  }

  return (
    <div className="dashboard-container my-profile-page">
      <div style={{ maxWidth: 720, margin: "0 auto", width: "100%" }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <Link to="/dashboard/my-bookings" className="back-link-bar">
          <ArrowLeft size={16} /> Back to My Bookings
        </Link>
      </div>

      <div className="od-hero">
        <div className="od-hero-text">
          <span className="od-eyebrow">
            <UserRound size={12} /> Your account
          </span>
          <h1 className="od-title">My Profile</h1>
          <p className="od-sub">
            <ShieldCheck size={13} />
            <span className="od-sub-text">
              Name, contact and address your cook uses to reach you
            </span>
          </p>
        </div>
      </div>

      <div className="profile-card-block">

        {error && (
          <div className="error-alert-banner">
            <AlertCircle size={16} /> {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="booking-form-group">
            <label>Full Name</label>
            <input
              name="name"
              className="form-control"
              value={formData.name}
              onChange={handleChange}
              placeholder="Enter your full name"
              required
            />
          </div>

          <div className="booking-form-group">
            <label>Contact Number</label>
            <div className="input-with-icon">
              <Phone size={16} className="input-icon-prefix" />
              <input
                name="phone"
                className="form-control"
                value={formData.phone}
                onChange={handleChange}
                placeholder="e.g. 9876543210"
                required
              />
            </div>
            <span className="field-hint">Used by your cook to reach you on WhatsApp.</span>
          </div>

          <div className="booking-form-group">
            <label>Address</label>
            <div className="input-with-icon">
              <MapPin size={16} className="input-icon-prefix" />
              <textarea
                name="address"
                rows={3}
                className="form-control"
                value={formData.address}
                onChange={handleChange}
                placeholder="e.g. Flat 12, Green Park Apartments, Pune"
              />
            </div>
            <span className="field-hint">Your cooking venue / home address.</span>
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-block btn-lg"
            disabled={saving}
            style={{ marginTop: "1rem" }}
          >
            <Save size={18} />
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </form>
      </div>
      </div>
    </div>
  );
};

export default CustomerProfile;
