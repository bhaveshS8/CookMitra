import React, { useId, useMemo, useState } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { Star, CheckCircle2, Loader2, Send, Quote, Sparkles, Check } from "lucide-react";

const RATING_META = {
  1: { label: "Poor experience", tone: "bad" },
  2: { label: "Could be better", tone: "warn" },
  3: { label: "Good & tasty", tone: "info" },
  4: { label: "Very good experience", tone: "good" },
  5: { label: "Outstanding festive cooking!", tone: "great" },
};

const QUICK_TAGS = [
  "Delicious food",
  "On time",
  "Clean & tidy",
  "Great communication",
  "Would book again",
];

const STARS = [1, 2, 3, 4, 5];

/** Read-only star row (also used by the cook-side "Customer rating" card). */
export const ReviewStars = ({ value = 0, size = 18 }) => (
  <span className="rf-stars-static" aria-hidden="true">
    {STARS.map((s) => (
      <Star
        key={s}
        size={size}
        fill={s <= value ? "#f59e0b" : "none"}
        color={s <= value ? "#f59e0b" : "#cbd5e1"}
      />
    ))}
  </span>
);

/**
 * Customer rating form + submitted-review card.
 * Props: bookingId, existingReview, onSubmitted, variant ("card" | "bare").
 * "bare" drops the outer chrome so the host page/card provides the header.
 */
const ReviewForm = ({ bookingId, existingReview, onSubmitted, variant = "card" }) => {
  const showToast = useShowToast();
  const bare = variant === "bare";
  const commentId = useId();

  const [rating, setRating] = useState(existingReview?.rating || undefined);
  const [hoverRating, setHoverRating] = useState(0);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const done = submitted || !!existingReview;
  const shownRating = submitted ? rating : existingReview?.rating || rating;
  const shownComment = existingReview?.comment || (submitted ? comment.trim() : "");
  const shownDate = existingReview?.createdAt || (submitted ? new Date().toISOString() : null);

  const activeMeta = RATING_META[hoverRating || rating];
  const doneMeta = RATING_META[shownRating];

  // Quick tags toggle phrases in/out of the comment box (WYSIWYG — the
  // textarea is the single source of truth for what gets submitted).
  const activeTags = useMemo(
    () => new Set(comment.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean)),
    [comment]
  );
  const isTagOn = (tag) => activeTags.has(tag.toLowerCase());

  const toggleTag = (tag) =>
    setComment((prev) => {
      const parts = prev.split(",").map((p) => p.trim()).filter(Boolean);
      const idx = parts.findIndex((p) => p.toLowerCase() === tag.toLowerCase());
      if (idx >= 0) parts.splice(idx, 1);
      else parts.push(tag);
      return parts.join(", ");
    });

  // Arrow keys move the rating when a star is focused (radiogroup pattern,
  // wrapping around at the ends).
  const handleStarsKeyDown = (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const cur = rating || 0;
    const next =
      e.key === "ArrowRight" ? (cur % 5) + 1 : cur <= 1 ? 5 : cur - 1;
    setRating(next);
    setError("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!rating) {
      setError("Please select a star rating");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await API.post("/reviews", { booking: bookingId, rating, comment: comment.trim() });
      setSubmitted(true);
      showToast("Thank you! Your review has been published.", "success");
      onSubmitted?.();
    } catch (err) {
      const msg = err.response?.data?.message || "Failed to submit review";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setLoading(false);
    }
  };

  /* ---------- Submitted / existing review ---------- */
  if (done) {
    return (
      <div className={`review-card${bare ? " review-card--bare" : ""}`}>
        <div className="review-card-head">
          <span className="review-card-badge">
            <CheckCircle2 size={16} />
          </span>
          <div className="review-card-headtext">
            <strong>{submitted ? "Review published — thank you!" : "Your review"}</strong>
            {shownDate && (
              <span className="review-card-date">
                {new Date(shownDate).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </span>
            )}
          </div>
        </div>
        <div className="review-card-score">
          <ReviewStars value={shownRating} size={20} />
          <span className="review-card-num">{shownRating}/5</span>
          {doneMeta && (
            <span className={`review-card-label tone-${doneMeta.tone}`}>{doneMeta.label}</span>
          )}
        </div>
        {shownComment && (
          <div className="review-card-comment">
            <Quote size={14} />
            <p>“{shownComment}”</p>
          </div>
        )}
      </div>
    );
  }

  /* ---------- Rating form ---------- */
  return (
    <div className={`review-form-container${bare ? " review-form-container--bare" : ""}`}>
      <form className="review-form" onSubmit={handleSubmit} noValidate>
        {!bare && (
          <div className="review-form-head">
            <span className="review-form-icon">
              <Sparkles size={18} />
            </span>
            <div>
              <h4 className="review-form-title">Rate your cook</h4>
              <p className="review-form-sub">
                Your feedback helps other customers book with confidence.
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="rf-error" role="alert">
            {error}
          </div>
        )}

        <div className="rf-rate">
          <div
            className="rf-stars"
            role="radiogroup"
            aria-label="Star rating"
            onKeyDown={handleStarsKeyDown}
          >
            {STARS.map((starVal) => {
              const active = (hoverRating || rating || 0) >= starVal;
              return (
                <button
                  key={starVal}
                  type="button"
                  role="radio"
                  aria-checked={rating === starVal}
                  aria-label={`Rate ${starVal} out of 5`}
                  className={`rf-star${active ? " rf-star--on" : ""}`}
                  onClick={() => {
                    setRating(starVal);
                    setError("");
                  }}
                  onMouseEnter={() => setHoverRating(starVal)}
                  onMouseLeave={() => setHoverRating(0)}
                >
                  <Star size={34} fill={active ? "currentColor" : "none"} />
                </button>
              );
            })}
          </div>
          <span
            className={`rf-rate-pill${activeMeta ? ` tone-${activeMeta.tone}` : ""}`}
            aria-live="polite"
          >
            {activeMeta ? `${hoverRating || rating}★ · ${activeMeta.label}` : "Select a star rating"}
          </span>
        </div>

        <div className="rf-field">
          <div className="rf-label-row">
            <label className="rf-label" htmlFor={commentId}>
              Share your experience <span className="rf-optional">(optional)</span>
            </label>
            <span className="rf-count" aria-hidden="true">{comment.length}/500</span>
          </div>
          <div className="rf-tags">
            {QUICK_TAGS.map((tag) => (
              <button
                key={tag}
                type="button"
                className={`rf-tag${isTagOn(tag) ? " rf-tag--on" : ""}`}
                aria-pressed={isTagOn(tag)}
                onClick={() => toggleTag(tag)}
              >
                {isTagOn(tag) && <Check size={12} />}
                {tag}
              </button>
            ))}
          </div>
          <textarea
            id={commentId}
            rows={3}
            maxLength={500}
            className="form-control rf-textarea"
            placeholder="How was the flavor, cleanliness, timing and preparation?"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        <div className="rf-actions">
          <button type="submit" className="btn btn-primary" disabled={loading || !rating}>
            {loading ? (
              <>
                <Loader2 size={16} className="rf-spin" /> Submitting…
              </>
            ) : (
              <>
                <Send size={16} /> {rating ? `Submit ${rating}★ review` : "Submit Review"}
              </>
            )}
          </button>
          {!rating && <span className="rf-hint">Select a star rating to continue</span>}
        </div>
      </form>
    </div>
  );
};

export default ReviewForm;