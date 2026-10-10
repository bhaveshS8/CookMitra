import React from "react";
import { AlertCircle, ShieldCheck, Timer, RotateCcw } from "lucide-react";
import {
  VERIFICATION_QUESTION,
  YES_LABEL,
  NO_LABEL,
  BLOCKED_TITLE,
  BLOCKED_BODY,
  formatCountdown,
} from "../utils/womanPresence";

// Mandatory woman-presence verification step. Rendered immediately before
// the Find Cook submit in every customer booking flow. Records the
// customer's explicit confirmation — it never claims to verify physical
// presence. Fully controlled by the useWomanPresence hook (server is the
// source of truth for the lockout).
const WomanPresenceCheck = ({ wp }) => {
  const {
    presence,
    restriction,
    status,
    busy,
    error,
    remaining,
    blocked,
    selectYes,
    selectNo,
    submitDecline,
    retryStatus,
    legacy,
  } = wp;

  if (blocked && restriction?.blockedUntil) {
    return (
      <div className="wp-card wp-blocked" role="alert" aria-live="assertive">
        <div className="wp-blocked-head">
          <span className="wp-blocked-icon" aria-hidden="true">
            <Timer size={18} />
          </span>
          <h3 className="wp-blocked-title">{BLOCKED_TITLE}</h3>
        </div>
        {BLOCKED_BODY.split("\n\n").map((para, i) => (
          <p key={i} className="wp-blocked-text">
            {para}
          </p>
        ))}
        <div className="wp-countdown" aria-live="polite">
          <span className="wp-countdown-label">Try again in</span>
          <strong className="wp-countdown-value" data-testid="wp-countdown">
            {formatCountdown(remaining)}
          </strong>
        </div>
      </div>
    );
  }

  return (
    <div className="wp-card" data-testid="wp-question">
      {status === "loading" && (
        <p className="wp-checking" aria-live="polite">
          <span className="wp-pulse" aria-hidden="true" />
          <span>Verifying booking eligibility… you can answer below meanwhile.</span>
        </p>
      )}
      <div className="wp-q-head">
        <span className="wp-q-icon" aria-hidden="true">
          <ShieldCheck size={16} />
        </span>
        <p className="wp-question" id="wp-question-label">
          {VERIFICATION_QUESTION}
        </p>
      </div>
      <div className="wp-options" role="radiogroup" aria-labelledby="wp-question-label">
        <button
          type="button"
          role="radio"
          aria-checked={presence === "yes"}
          className={`wp-option ${presence === "yes" ? "selected" : ""}`}
          onClick={selectYes}
          disabled={busy}
          data-testid="wp-yes"
        >
          <span className="wp-radio" aria-hidden="true" />
          <span className="wp-option-text">{YES_LABEL}</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={presence === "no"}
          className={`wp-option wp-no ${presence === "no" ? "selected" : ""}`}
          onClick={selectNo}
          disabled={busy}
          data-testid="wp-no"
        >
          <span className="wp-radio" aria-hidden="true" />
          <span className="wp-option-text">{NO_LABEL}</span>
        </button>
      </div>
      {legacy && (
        <p className="wp-hint" aria-live="polite">
          Note: compatibility mode — your explicit YES is required to continue.
        </p>
      )}
      {presence === "no" && !blocked && busy && (
        <p className="wp-hint wp-hint-warn" aria-live="polite">
          Recording your response… booking is paused until this completes.
        </p>
      )}
      {busy && (
        <p className="wp-hint" aria-live="polite">
          Recording… please wait.
        </p>
      )}
      {error && (
        <div className="wp-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{error}</span>
          <button
            type="button"
            className="wp-retry"
            onClick={() => (status === "error" && !presence ? retryStatus() : submitDecline())}
            disabled={busy}
          >
            <RotateCcw size={13} aria-hidden="true" /> Retry
          </button>
        </div>
      )}
      {status === "error" && !error && !presence && (
        <div className="wp-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>Could not check booking eligibility. Please retry.</span>
          <button type="button" className="wp-retry" onClick={retryStatus} disabled={busy}>
            <RotateCcw size={13} aria-hidden="true" /> Retry
          </button>
        </div>
      )}
    </div>
  );
};

export default WomanPresenceCheck;
