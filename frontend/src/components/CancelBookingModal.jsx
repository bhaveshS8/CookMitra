import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createPortal } from "react-dom";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { formatCurrency } from "../utils/constants";
import { AlertCircle, XCircle, X } from "lucide-react";

export const CANCEL_REASONS = [
  { value: "CHANGE_OF_PLANS", label: "Change of plans" },
  { value: "WRONG_BOOKING_DETAILS", label: "Wrong booking details" },
  { value: "WRONG_ADDRESS", label: "Wrong address" },
  { value: "SERVICE_NO_LONGER_REQUIRED", label: "Service no longer required" },
  { value: "OTHER", label: "Other" },
];

// Cancel dialog driven ENTIRELY by GET /bookings/:id/cancellation-preview.
// The frontend never calculates charges or refunds — it only displays the
// backend's numbers and sends back { reason, reasonNote }.
const CancelBookingModal = ({ bookingId, onClose, onCancelled }) => {
  const showToast = useShowToast();
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState("CHANGE_OF_PLANS");
  const [reasonNote, setReasonNote] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    API.get(`/bookings/${bookingId}/cancellation-preview`)
      .then((res) => {
        if (alive) setPreview(res.data);
      })
      .catch((err) => {
        if (alive) {
          setPreview({
            canCancel: false,
            message: err.response?.data?.message || "Could not load cancellation details.",
          });
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [bookingId]);

  const confirm = async () => {
    if (confirming) return;
    if (reason === "OTHER" && !reasonNote.trim()) {
      showToast("Please describe your reason for cancelling.", "error");
      return;
    }
    setConfirming(true);
    try {
      const res = await API.patch(`/bookings/${bookingId}/cancel`, {
        reason,
        ...(reasonNote.trim() ? { reasonNote: reasonNote.trim().slice(0, 500) } : {}),
      });
      showToast("Booking cancelled.", "info");
      onCancelled?.(res.data);
      onClose();
    } catch (err) {
      showToast(err.response?.data?.message || "Failed to cancel booking", "error");
    } finally {
      setConfirming(false);
    }
  };

  return createPortal(
    <div
      className="cf-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !confirming && !loading) onClose?.();
      }}
    >
      <div className="cf-card cf-danger cancel-modal" role="dialog" aria-modal="true" aria-label="Cancel booking">
        <button type="button" className="cf-close" onClick={onClose} disabled={confirming} aria-label="Close dialog">
          <X size={17} />
        </button>
        <h3 className="cf-title">Cancel this booking?</h3>
        {loading ? (
          <p className="bd-mini-note">Loading cancellation details…</p>
        ) : !preview?.canCancel ? (
          <>
            <div className="error-alert-banner" role="alert">
              <AlertCircle size={16} /> {preview?.message || "This booking cannot be cancelled."}
            </div>
            <div className="cf-actions">
              <button type="button" className="btn btn-outline cf-btn" onClick={onClose}>
                Keep booking
              </button>
            </div>
          </>
        ) : (
          <>
            <dl className="cancel-breakdown">
              <div><dt>Booking amount</dt><dd>{formatCurrency(preview.bookingAmount)}</dd></div>
              <div><dt>Cancellation charge ({preview.cancellationChargePercent}%)</dt><dd>{formatCurrency(preview.bookingAmount - preview.grossRefund)}</dd></div>
              <div><dt>Refund ({preview.refundPercent}%)</dt><dd>{formatCurrency(preview.grossRefund)}</dd></div>
              {preview.nonRefundableCharges > 0 && (
                <div><dt>Non-refundable gateway charges</dt><dd>{formatCurrency(preview.nonRefundableCharges)}</dd></div>
              )}
              <div className="cancel-total"><dt>Estimated refund</dt><dd>{formatCurrency(preview.finalRefund)}</dd></div>
            </dl>
            <p className="bd-mini-note">{preview.message} Non-refundable payment charges may apply.</p>
            <label className="cf-field">
              <span>Reason for cancelling</span>
              <select className="cf-input" value={reason} onChange={(e) => setReason(e.target.value)}>
                {CANCEL_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </label>
            {reason === "OTHER" && (
              <label className="cf-field">
                <span>Please describe (required)</span>
                <textarea
                  rows={3}
                  maxLength={500}
                  value={reasonNote}
                  onChange={(e) => setReasonNote(e.target.value)}
                  placeholder="Tell us briefly why you are cancelling…"
                />
              </label>
            )}
            <p className="bd-mini-note">
              By cancelling you agree to our{" "}
              <Link to="/customer-cancellation-refund-policy" target="_blank" rel="noreferrer">Cancellation & Refund Policy</Link>.
            </p>
            <div className="cf-actions">
              <button type="button" className="btn btn-outline cf-btn" onClick={onClose} disabled={confirming}>
                Keep booking
              </button>
              <button type="button" className="btn btn-danger cf-btn" onClick={confirm} disabled={confirming}>
                <XCircle size={15} /> {confirming ? "Cancelling…" : "Confirm cancellation"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  );
};

// Cook/admin: record a customer no-show after reaching the venue.
export const NoShowModal = ({ bookingId, onClose, onMarked }) => {
  const showToast = useShowToast();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!reason.trim()) {
      showToast("Please describe what happened at the venue.", "error");
      return;
    }
    setSaving(true);
    try {
      const res = await API.post(`/bookings/${bookingId}/no-show`, { reason: reason.trim().slice(0, 500) });
      showToast("Customer no-show recorded.", "info");
      onMarked?.(res.data);
      onClose();
    } catch (err) {
      showToast(err.response?.data?.message || "Could not record no-show", "error");
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="cf-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose?.();
      }}
    >
      <div className="cf-card cf-danger cancel-modal" role="dialog" aria-modal="true" aria-label="Mark customer no-show">
        <button type="button" className="cf-close" onClick={onClose} disabled={saving} aria-label="Close dialog">
          <X size={17} />
        </button>
        <h3 className="cf-title">Mark customer no-show?</h3>
        <p className="bd-mini-note">
          Only when you reached the venue and the customer was unavailable, refused access,
          refused the confirmed service, or could not be contacted. No refund applies.
        </p>
        <label className="cf-field">
          <span>What happened at the venue (required)</span>
          <textarea
            rows={4}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Reached at 6:05 PM, called 4 times over 20 minutes, no answer, gate locked…"
          />
        </label>
        <div className="cf-actions">
          <button type="button" className="btn btn-outline cf-btn" onClick={onClose} disabled={saving}>
            Go back
          </button>
          <button type="button" className="btn btn-danger cf-btn" onClick={submit} disabled={saving}>
            {saving ? "Recording…" : "Record no-show"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default CancelBookingModal;
