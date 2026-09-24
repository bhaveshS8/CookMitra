import React from "react";
import { Link, useParams } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import BookingForm from "../components/BookingForm";
import CookAvatar from "../components/CookAvatar";
import { useShowToast } from "../store/hooks";
import { formatCurrency, SERVICE_DETAILS } from "../utils/constants";
import {
  ArrowLeft,
  MapPin,
  Star,
  Award,
  ShieldCheck,
  Sparkles,
  MessageSquare,
  CheckCircle2,
  XCircle,
} from "lucide-react";

const CookProfile = () => {
  const { id } = useParams();
  const { data: cook, loading: loadingCook, error: cookError } = useFetch(`/cooks/${id}`);
  const { data: reviews } = useFetch(`/reviews/cook/${id}`);
  const showToast = useShowToast();

  if (loadingCook) {
    return (
      <div className="loading-spinner-wrapper">
        <div className="spinner"></div>
        <p style={{ color: "var(--slate-500)", fontWeight: 600 }}>Loading cook profile...</p>
      </div>
    );
  }

  if (cookError || !cook) {
    return (
      <div className="cook-profile-page-container">
        <div style={{ marginBottom: "1.5rem" }}>
          <Link to="/cook-on-demand" className="back-link-bar">
            <ArrowLeft size={16} /> Back to Book a Cook
          </Link>
        </div>
        <div className="error-alert-banner">
          <XCircle size={18} /> {cookError || "Cook profile not found"}
        </div>
      </div>
    );
  }

  const handleBookingSubmit = (booking) => {
    const status = booking?.status ? String(booking.status).toUpperCase() : "";
    showToast(`Booking request sent!${status ? ` Status: ${status}` : ""}`, "success");
  };

  const reviewCount = cook?.rating?.count || 0;
  // Never fabricate a rating: unreviewed cooks show "New".
  const avgRating = reviewCount > 0 ? Number(cook?.rating?.average) || 0 : null;

  return (
    <div className="cook-profile-page-container">
      {/* Back Link */}
      <div style={{ marginBottom: "1.5rem" }}>
        <Link to="/cook-on-demand" className="back-link-bar">
          <ArrowLeft size={16} /> Back to Book a Cook
        </Link>
      </div>

      {/* Hero Banner Card */}
      <div className="cook-profile-hero">
        <div className="cook-profile-avatar-large">
          <CookAvatar photoUrl={cook?.photoUrl} name={cook?.user?.name} />
        </div>

        <div className="cook-profile-hero-content" style={{ flex: 1 }}>
          <div className="cook-profile-badges">
            <span className="badge badge-emerald">
              <ShieldCheck size={14} /> Verified Cook
            </span>
            <span className="badge badge-festive">
              <Award size={14} /> {cook?.experienceYears || 5}+ Years Experience
            </span>
          </div>

          <h1>{cook?.user?.name}</h1>

          <div className="cook-profile-meta">
            <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
              <MapPin size={16} style={{ color: "var(--primary)" }} />
              <span>{cook?.serviceArea || "Pune & Surrounds"}</span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              {avgRating == null ? (
                <span style={{ color: "var(--slate-500)", fontSize: "0.9rem" }}>New cook — no reviews yet</span>
              ) : (
                <>
                  <div className="star-rating-display">
                    {[...Array(5)].map((_, i) => (
                      <Star
                        key={i}
                        size={16}
                        fill={i < Math.round(avgRating) ? "#f59e0b" : "none"}
                        color={i < Math.round(avgRating) ? "#f59e0b" : "#cbd5e1"}
                      />
                    ))}
                  </div>
                  <strong style={{ color: "var(--slate-800)" }}>{avgRating.toFixed(1)}</strong>
                  <span style={{ color: "var(--slate-500)", fontSize: "0.9rem" }}>({reviewCount} reviews)</span>
                </>
              )}
            </div>
          </div>

          <div className="cook-profile-rate">
            <span style={{ fontSize: "1.5rem", fontWeight: 800, color: "var(--slate-900)" }}>
              {formatCurrency(cook?.rate)}
            </span>
            <span style={{ fontSize: "0.88rem", color: "var(--slate-500)" }}>/ hour session</span>
          </div>
        </div>
      </div>

      {/* Main Grid: Left Column Info, Right Column Booking Widget */}
      <div className="cook-profile-grid">
        <div className="cook-profile-left-col">
          {/* About */}
          <div className="profile-card-block">
            <h2>About {cook?.user?.name}</h2>
            <p style={{ lineHeight: 1.7, color: "var(--slate-700)", fontSize: "1rem" }}>
              {cook?.skills || cook?.bio || "A passionate home chef devoted to keeping authentic festive culinary traditions alive. Specializing in traditional recipes prepared with hand-ground spices, pure ghee, and immense dedication."}
            </p>
          </div>

          {/* Specialties */}
          <div className="profile-card-block">
            <h2>Festive Specialties</h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>
              {cook?.specialties?.map((s, i) => (
                <span key={i} className="badge badge-festive" style={{ padding: "0.45rem 0.9rem", fontSize: "0.9rem" }}>
                  <Sparkles size={14} /> {s}
                </span>
              ))}
            </div>
          </div>

          {/* Services Offered */}
          <div className="profile-card-block">
            <h2>Services Offered</h2>
            <div className="cook-services-grid">
              {cook?.serviceTypes?.map((type, i) => {
                const info = SERVICE_DETAILS[type] || { label: type.replace(/_/g, " "), description: "" };
                return (
                  <div key={i} className="cook-service-tile">
                    <div className="cook-service-tile-head">
                      <CheckCircle2 size={16} /> {info.label}
                    </div>
                    <p>{info.description || "Available for this booking service"}</p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Customer Reviews */}
          <div className="profile-card-block">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.25rem" }}>
              <h2 style={{ margin: 0 }}>Customer Reviews ({reviews?.length || 0})</h2>
            </div>

            {reviews && reviews.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                {reviews.map((rev) => (
                  <div key={rev._id} className="cook-review-card">
                    <div className="cook-review-head">
                      <strong style={{ color: "var(--slate-900)" }}>{rev.customer?.name || "Verified Customer"}</strong>
                      <div className="star-rating-display">
                        {[...Array(5)].map((_, i) => (
                          <Star
                            key={i}
                            size={14}
                            fill={i < rev.rating ? "#f59e0b" : "none"}
                            color={i < rev.rating ? "#f59e0b" : "#cbd5e1"}
                          />
                        ))}
                      </div>
                    </div>
                    <p style={{ margin: 0, fontSize: "0.92rem", color: "var(--slate-700)" }}>
                      {rev.comment}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ textAlign: "center", padding: "2rem", color: "var(--slate-500)" }}>
                <MessageSquare size={32} style={{ margin: "0 auto 0.75rem", opacity: 0.5 }} />
                <p>No reviews yet for this cook. Be the first to book and share your experience!</p>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Sticky Booking Widget */}
        <div className="cook-profile-right-col">
          <BookingForm
            cookId={id}
            cookUserId={cook?.user?._id}
            cookPhone={cook?.user?.phone}
            cookName={cook?.user?.name}
            cookPhotoUrl={cook?.photoUrl}
            onSubmit={handleBookingSubmit}
          />
        </div>
      </div>
    </div>
  );
};

export default CookProfile;
