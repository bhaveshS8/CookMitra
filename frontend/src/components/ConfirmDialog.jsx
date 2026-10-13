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
  checkbox,
  requireCheckbox = false,
  onCancel,
  onConfirm,
}) => {
  const [value, setValue] = useState("");
  const [checked, setChecked] = useState(false);
  const confirmRef = useRef(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const { Icon, cls } = TONES[tone] || TONES.brand;

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
