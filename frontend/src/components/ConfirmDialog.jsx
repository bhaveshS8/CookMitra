// ConfirmDialog — modern replacement for window.confirm()/window.prompt().
// Controlled: the caller owns `open` plus the pending payload, e.g.
//   const [pending, setPending] = useState(null);
//   <ConfirmDialog open={!!pending} title=... message=...
//     onCancel={() => setPending(null)} onConfirm={() => doIt(pending)} />
// Optional `input` ({ label, placeholder, initialValue }) turns it into a
// prompt-style dialog; the typed value is passed to onConfirm(value).
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Info, CheckCircle2, X, Loader2 } from "lucide-react";

const TONES = {
  danger: { Icon: AlertTriangle, cls: "cf-danger" },
  brand: { Icon: Info, cls: "cf-brand" },
  emerald: { Icon: CheckCircle2, cls: "cf-emerald" },
};

const ConfirmDialog = ({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "brand",
  busy = false,
  input,
  // Optional explicit decision checkbox (e.g. the refund clawback gate):
  // { label, initialChecked }. `requireCheckbox` keeps the confirm button
  // disabled until it is ticked, and onConfirm receives (value, checked).
  checkbox,
  requireCheckbox = false,
  onCancel,
  onConfirm,
}) => {
  const [value, setValue] = useState("");
  const [checked, setChecked] = useState(false);
  const confirmRef = useRef(null);

  // Reset the prompt field, lock body scroll, focus confirm, close on Escape.
  useEffect(() => {
    if (!open) return undefined;
    setValue(input?.initialValue || "");
    setChecked(Boolean(checkbox?.initialChecked));
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = setTimeout(() => confirmRef.current?.focus(), 60);
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      clearTimeout(focusTimer);
    };
    // Re-run per opening so a stale prompt value never leaks across dialogs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const { Icon, cls } = TONES[tone] || TONES.brand;

  // Portaled to document.body: escapes .main-content's pageIn stacking
  // context so the sticky navbar can never paint over the dialog.
  return createPortal(
    <div
      className="cf-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel?.();
      }}
    >
      <div
        className={`cf-card ${cls}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="cf-title"
        aria-describedby={message ? "cf-desc" : undefined}
      >
        <button
          type="button"
          className="cf-close"
          onClick={onCancel}
          disabled={busy}
          aria-label="Close dialog"
        >
          <X size={17} />
        </button>
        <div className="cf-icon" aria-hidden="true">
          <Icon size={24} />
        </div>
        <h3 id="cf-title" className="cf-title">
          {title}
        </h3>
        {message && (
          <p id="cf-desc" className="cf-desc">
            {message}
          </p>
        )}
        {input && (
          <label className="cf-field">
            <span>{input.label}</span>
            {input.singleLine ? (
              <input
                className="cf-input"
                type="text"
                inputMode={input.inputMode || "text"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={input.placeholder}
                disabled={busy}
              />
            ) : (
              <textarea
                rows={3}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={input.placeholder}
                disabled={busy}
              />
            )}
          </label>
        )}
        {checkbox && (
          <label className="cf-check">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              disabled={busy}
            />
            <span>{checkbox.label}</span>
          </label>
        )}
        <div className="cf-actions">
          <button
            type="button"
            className="btn btn-outline cf-btn"
            onClick={onCancel}
            disabled={busy}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`btn cf-btn ${
              tone === "danger" ? "btn-danger" : tone === "emerald" ? "btn-success" : "btn-primary"
            }`}
            onClick={() => onConfirm?.(value, checked)}
            disabled={busy || (requireCheckbox && !checked)}
          >
            {busy ? (
              <>
                <Loader2 size={16} className="spin" /> Working…
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ConfirmDialog;
