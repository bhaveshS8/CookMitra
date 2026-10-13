import React, { useState } from "react";
import { createPortal } from "react-dom";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { AlertCircle, XCircle, X, SearchCheck } from "lucide-react";

// Stable machine-readable codes (backend COOK_CANCELLATION_REASONS).
// Labels are display-only — the value is what gets persisted.
export const COOK_CANCEL_REASONS = [
  { value: "MEDICAL_EMERGENCY", label: "Medical or family emergency" },
  { value: "ILLNESS", label: "Illness or health concern" },
  { value: "PERSONAL_UNAVAILABILITY", label: "Unexpected personal unavailability" },
  { value: "TRANSPORT_ISSUE", label: "Transport or travel problem" },
  { value: "LOCATION_UNREACHABLE", label: "Unable to reach the customer's location" },
  { value: "SCHEDULING_CONFLICT", label: "Scheduling conflict or incorrect booking details" },
  { value: "CUSTOMER_REQUESTED", label: "Customer requested cancellation" },
  { value: "OTHER", label: "Other" },
];

// Cook-initiated cancellation with automatic replacement search.
// On success the booking leaves the cook's plate and re-enters the
// finding-cook pool; onCancelled receives the updated booking.
const CookCancelModal = ({ bookingId, onClose, onCancelled }) => {
  const showToast = useShowToast();
  const [reason, setReason] = useState("MEDICAL_EMERGENCY");
  const [reasonNote, setReasonNote] = useState("");
  const [confirming, setConfirming] = useState(false);

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
      if (res.data?.replacement) {
        showToast("Cancellation recorded — we are finding a replacement cook for the customer.", "info");
      } else if (res.data?.deleted) {
        showToast("Booking cancelled and removed (no payment was made).", "info");
      } else {
        showToast("Booking cancelled.", "info");
      }
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
        if (e.target === e.currentTarget && !confirming) onClose?.();
      }}
    >
      <div className="cf-card cf-danger cancel-modal" role="dialog" aria-modal="true" aria-label="Cancel booking as cook">
        <button type="button" className="cf-close" onClick={onClose} disabled={confirming} aria-label="Close dialog">
          <X size={17} />
        </button>
        <h3 className="cf-title">Cancel this booking?</h3>
        <div className="info-alert-banner" role="note">
          <SearchCheck size={16} /> Cancelling releases this booking back to the finding-cook pool —
          another eligible cook will be notified automatically. You will no longer be assigned to it.
        </div>
        <label className="cf-field">
          <span>Reason for cancelling (required)</span>
          <select className="cf-input" value={reason} onChange={(e) => setReason(e.target.value)}>
            {COOK_CANCEL_REASONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </label>
        <label className="cf-field">
          <span>{reason === "OTHER" ? "Please describe (required)" : "Additional details (optional)"}</span>
          <textarea
            rows={3}
            maxLength={500}
            value={reasonNote}
            onChange={(e) => setReasonNote(e.target.value)}
            placeholder="Tell us briefly what happened…"
          />
        </label>
        <p className="bd-mini-note">
          <AlertCircle size={13} style={{ verticalAlign: "-2px" }} /> Repeated last-minute cancellations
          are tracked on your cook profile and may be reviewed by our team.
        </p>
        <div className="cf-actions">
          <button type="button" className="btn btn-outline cf-btn" onClick={onClose} disabled={confirming}>
            Keep booking
          </button>
          <button type="button" className="btn btn-danger cf-btn" onClick={confirm} disabled={confirming}>
            <XCircle size={15} /> {confirming ? "Cancelling…" : "Confirm cancellation"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default CookCancelModal;
