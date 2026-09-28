import React from "react";
import { Link } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import CookReviewsBlock from "../components/CookReviewsBlock";
import { ArrowLeft, Star, RefreshCw } from "lucide-react";

const CookReviews = () => {
  const { data: reviews, loading, error, refetch } = useFetch("/reviews/cook-me");

  return (
    <div className="dashboard-container cook-dash">
      <div className="cook-back-row">
        <Link to="/dashboard/cook-bookings" className="back-link-bar">
          <ArrowLeft size={16} /> Back to Cook Dashboard
        </Link>
      </div>

      <div className="cook-page-head">
        <div>
          <span className="badge badge-festive cook-intro-badge">
            <Star size={14} /> Customer Feedback
          </span>
          <div className="cook-page-head-title">
            <h1>All Reviews ({reviews?.length || 0})</h1>
          </div>
          <p className="cook-page-sub">
            Every rating customers left on your completed services.
          </p>
        </div>
        <div className="cook-page-actions">
          <button className="btn btn-outline btn-sm" onClick={() => refetch()} disabled={loading}>
            <RefreshCw size={15} /> {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      <CookReviewsBlock reviews={reviews} loading={loading} error={error} />
    </div>
  );
};

export default CookReviews;
