import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate, formatTime12 } from "../utils/constants";
import { AlertCircle, Loader2, Receipt, X } from "lucide-react";

const REASONS = [
  "Service was not provided",
  "Cook did not arrive",
  "Service was partially completed",
  "Service was not completed",
  "Other",
];

const friendlyError = (err, fallback) => {
  const msg = err?.response?.data?.message;
  if (typeof msg === "string" && msg.trim()) return msg;
  return fallback;
};

const prettyService = (s) =>
  String(s || "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());

const RefundRequestModal = ({ booking, eligibility, onClose, onRequested }) => {
  const showToast = useShowToast();
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const paidAmount = eligibility?.paidAmount || booking?.payment?.paidAmount || booking?.amount || 0;
  const refundable = eligibility?.refundableAmount || paidAmount || 0;

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape" && !submitting) onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, submitting]);

  const reasonOk = REASONS.includes(reason);
  const noteOk = note.length <= 500;
  const canReview = reasonOk && noteOk && !submitting;
  const canSubmit = canReview && reviewing && !submitting;

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const res = await API.post(`/bookings/${booking._id}/refund-request`, {
        reason,
        ...(note.trim() ? { note: note.trim().slice(0, 500) } : {}),
      });
      showToast("Refund request submitted — our admin team will review it.", "success");
      onRequested?.(res.data);
      onClose?.();
    } catch (err) {
      const msg = friendlyError(err, "We couldn't submit the refund request. Please try again.");
      setSubmitError(msg);
      showToast(msg, "error");
      setReviewing(false);
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    if (!submitting) onClose?.();
  };

  return createPortal(
    <div className="login-modal-overlay" onClick={close}>
      <div
        className="rf-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="refund-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="login-modal-close"
          onClick={close}
          aria-label="Close"
          disabled={submitting}
        >
          <X size={20} />
        </button>

        <div className="rf-head">
          <span className="rf-icon" aria-hidden="true">
            <Receipt size={22} />
          </span>
          <div>
            <h3 id="refund-title">Request refund</h3>
            <p className="rf-sub">Reviewed by the Cook Mitra admin team — never automatic.</p>
          </div>
        </div>

        <div className="rf-body">
          <section className="rf-summary" aria-label="Booking summary">
            <dl className="rf-summary-grid">
              <div>
                <dt>Booking</dt>
                <dd>{prettyService(booking?.serviceType) || "Session"}</dd>
              </div>
              <div>
                <dt>Scheduled</dt>
                <dd>
                  {formatDate(booking?.date)}
                  <br />
                  {formatTime12(booking?.startTime)}
                  {booking?.endTime ? ` – ${formatTime12(booking.endTime)}` : ""}
                </dd>
              </div>
              <div>
                <dt>Amount paid</dt>
                <dd>{paidAmount ? formatCurrency(paidAmount) : "—"}</dd>
              </div>
              <div>
                <dt>Service status</dt>
                <dd>Not completed</dd>
              </div>
            </dl>
            <p className="rf-eligible" aria-live="polite">
              Refund eligibility: eligible
              {refundable && refundable !== paidAmount ? ` · refundable ${formatCurrency(refundable)}` : ""}
            </p>
          </section>

          <label className="rf-label" htmlFor="rf-reason">
            Reason
          </label>
          <select
            id="rf-reason"
            className="rf-select"
            value={reason}
            disabled={submitting}
            onChange={(e) => {
              setReason(e.target.value);
              setReviewing(false);
              setSubmitError("");
            }}
          >
            <option value="">Select a reason…</option>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>

          <label className="rf-label" htmlFor="rf-note">
            Additional details <span className="rf-optional">(optional, max 500 characters)</span>
          </label>
          <textarea
            id="rf-note"
            className="rf-textarea"
            rows={4}
            value={note}
            maxLength={500}
            disabled={submitting}
            onChange={(e) => {
              setNote(e.target.value);
              setReviewing(false);
              setSubmitError("");
            }}
            placeholder="Tell us briefly what happened (no sensitive personal information needed)"
            aria-describedby="rf-note-count"
          />
          <p id="rf-note-count" className="rf-count">
            {note.length}/500
          </p>

          {submitError ? <p className="rf-error" role="alert">{submitError}</p> : null}

          {reviewing ? (
            <section className="rf-confirm" aria-label="Confirm refund request" aria-live="polite">
              <h4 className="rf-section-title">Are you sure you want to request a refund?</h4>
              <p>
                Amount paid: <strong>{paidAmount ? formatCurrency(paidAmount) : "—"}</strong>
              </p>
              <p>
                Reason: <strong>{reason}</strong>
              </p>
              <p className="rf-confirm-note">
                <AlertCircle size={14} aria-hidden="true" /> Your request will be reviewed by the Cook Mitra
                admin team. The refund is NOT automatic.
              </p>
            </section>
          ) : null}
        </div>

        <div className="rf-actions">
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => (reviewing ? setReviewing(false) : close())}
            disabled={submitting}
          >
            {reviewing ? "Back" : "Cancel"}
          </button>
          {!reviewing ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!canReview}
              onClick={() => setReviewing(true)}
            >
              Review request
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={submit}
              disabled={!canSubmit}
            >
              {submitting ? (
                <>
                  <Loader2 size={15} className="rf-spin" /> Submitting…
                </>
              ) : (
                "Submit refund request"
              )}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default RefundRequestModal;
