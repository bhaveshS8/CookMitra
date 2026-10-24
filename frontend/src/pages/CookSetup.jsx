import React from "react";
import { Link } from "react-router-dom";
import { useFetch } from "../hooks/useFetch";
import CookProfileForm from "../components/CookProfileForm";
import CookScheduleEditor from "../components/CookScheduleEditor";
import CookPayoutPanel from "../components/CookPayoutPanel";
import { ArrowLeft, ChefHat, BadgeCheck, MapPin, Star } from "lucide-react";

// Single canonical cook profile page: profile form + schedule + payout
// details + recent reviews. Every profile navigation in the cook login
// (dashboard hero button, notice links, avatar, navbar) points here — there
// is no second profile surface.
const CookSetup = () => {
  const { data: cookProfile, refetch: refetchCookProfile } = useFetch("/cooks/me");
  const { data: myReviews, loading: loadingReviews } = useFetch("/reviews/cook-me");

  return (
    <div className="cook-setup-page">
      <div className="cook-back-row">
        <Link to="/dashboard/cook-bookings" className="back-link-bar">
          <ArrowLeft size={16} /> Back to Cook Dashboard
        </Link>
      </div>

      <div className="cook-setup-intro-card">
        <span className="badge badge-festive cook-intro-badge">
          <ChefHat size={14} /> Chef profile
        </span>
        <h1>Your public chef page</h1>
        <p className="cook-setup-intro-sub">
          Families see this before they book you — a complete profile gets approved faster.
          You keep 85% of every booking; discounts are on us.
        </p>
        <ul className="cook-setup-steps">
          <li><BadgeCheck size={13} /> Skills + experience</li>
          <li><MapPin size={13} /> Service area</li>
          <li><Star size={13} /> ID verification</li>
        </ul>
      </div>

      <div className="cook-profile-wrap">
        <CookProfileForm
          showStatus
          createTitle="Create Your Cook Profile"
          manageTitle="Edit Your Cook Profile"
          onSaved={() => refetchCookProfile()}
        />
      </div>
      {cookProfile && (
        <CookScheduleEditor profile={cookProfile} onSaved={() => refetchCookProfile()} />
      )}
      {cookProfile && <CookPayoutPanel />}
      <RecentReviewsPreview reviews={myReviews} loading={loadingReviews} />
    </div>
  );
};

const RecentReviewsPreview = ({ reviews, loading }) => {
  const list = (reviews || []).slice(0, 3);
  const total = (reviews || []).length;
  if (loading) return <p className="cook-loading-text">Loading reviews...</p>;
  if (!list.length) return null;
  return (
    <div className="cook-card cook-spaced-top">
      <div className="cook-recent-head">
        <h3>Recent reviews ({total})</h3>
        {total > 3 && (
          <Link to="/dashboard/cook-reviews" className="cook-link-btn">
            See all reviews →
          </Link>
        )}
      </div>
      <div className="cook-recent-list">
        {list.map((rev) => (
          <div key={rev._id} className="cook-recent-row">
            <span className="cook-avatar">
              {rev.customer?.name?.[0]?.toUpperCase() || "C"}
            </span>
            <div className="cook-review-who">
              <div className="cook-recent-row-head">
                <strong>{rev.customer?.name || "Customer"}</strong>
                <span className="cook-stars">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <Star
                      key={s}
                      size={13}
                      fill={s <= Number(rev.rating || 0) ? "#f59e0b" : "none"}
                      color={s <= Number(rev.rating || 0) ? "#f59e0b" : "#cbd5e1"}
                    />
                  ))}
                </span>
              </div>
              {rev.comment ? (
                <p className="cook-recent-comment">"{rev.comment}"</p>
              ) : (
                <p className="cook-recent-nocomment">Rated {rev.rating}/5 with no written feedback.</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CookSetup;
