import React, { useEffect } from "react";
import { useShowToast } from "../store/hooks";
import { formatDate } from "../utils/constants";
import { Star, User } from "lucide-react";

// Reviews received from customers — star rating + words.
// Shared by the all-reviews page (full list).
const CookReviewsBlock = ({ reviews, loading, error }) => {
  const showToast = useShowToast();
  const list = reviews || [];
  const avg =
    list.length > 0
      ? (list.reduce((sum, r) => sum + Number(r.rating || 0), 0) / list.length).toFixed(1)
      : null;

  useEffect(() => {
    if (error) {
      showToast(error, "error", 6000);
    }
  }, [error, showToast]);

  if (loading) {
    return (
      <div className="loading-spinner-wrapper">
        <div className="spinner"></div>
        <p className="cook-loading-text">Loading your reviews...</p>
      </div>
    );
  }

  return (
    <div>
      {/* Summary */}
      <div className="cook-rating-hero">
        <div className="cook-rating-hero-row">
          <div
            className="stat-icon-wrapper cook-rating-hero-icon"
          >
            <Star size={28} />
          </div>
          <div>
            <div className="stat-metric-number">
              {avg ? `${avg}/5` : "No ratings yet"}
            </div>
            <div className="cook-rating-hero-stars">
              {[1, 2, 3, 4, 5].map((s) => (
                <Star
                  key={s}
                  size={16}
                  fill={avg && s <= Math.round(Number(avg)) ? "#fbbf24" : "none"}
                  color={avg && s <= Math.round(Number(avg)) ? "#fbbf24" : "rgba(255,255,255,0.4)"}
                />
              ))}
            </div>
            <div className="stat-metric-title">
              Based on {list.length} customer review{list.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>
      </div>

      {/* Review cards */}
      {list.length > 0 ? (
        <div className="bookings-list-modern">
          {list.map((rev) => (
            <div key={rev._id} className="cook-review-item">
              <div className="cook-review-top">
                <div className="cook-avatar">
                  {rev.customer?.name ? rev.customer.name[0].toUpperCase() : <User size={22} />}
                </div>
                <div className="cook-review-who">
                  <h4>{rev.customer?.name || "Verified Customer"}</h4>
                  <span className="cook-review-date">
                    {rev.createdAt ? formatDate(rev.createdAt) : ""}
                    {rev.booking?.serviceType ? ` • ${rev.booking.serviceType.replace(/_/g, " ")}` : ""}
                  </span>
                </div>
                <span className="badge badge-amber">
                  <Star size={13} /> {rev.rating}/5
                </span>
              </div>
              <div className="cook-stars cook-review-stars">
                {[1, 2, 3, 4, 5].map((s) => (
                  <Star
                    key={s}
                    size={16}
                    fill={s <= rev.rating ? "#f59e0b" : "none"}
                    color={s <= rev.rating ? "#f59e0b" : "#cbd5e1"}
                  />
                ))}
              </div>
              {rev.comment ? (
                <p className="cook-review-comment">
                  "{rev.comment}"
                </p>
              ) : (
                <p className="cook-review-nocomment">
                  Rated {rev.rating}/5 with no written feedback.
                </p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="cook-empty">
          <div className="cook-empty-icon">
            <Star size={28} />
          </div>
          <h3>No Reviews Yet</h3>
          <p>
            Once customers rate your completed services, their star rating and words will appear
            here — and on your public cook profile.
          </p>
        </div>
      )}
    </div>
  );
};

export default CookReviewsBlock;
