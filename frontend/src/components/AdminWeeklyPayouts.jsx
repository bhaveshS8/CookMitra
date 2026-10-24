import React, { useState, useEffect, useCallback, useRef } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate } from "../utils/constants";
import { useSignedDocUrl } from "../utils/docUrls";
import {
  mondayOfWeekIST,
  weekKeyIST,
  formatWeekLabel,
  toDateInputValue,
  DAY_MS,
} from "../utils/weeklyPayout";
import {
  Banknote,
  CheckCircle2,
  Clock3,
  AlertCircle,
  RefreshCw,
  History,
  X,
  Upload,
  Eye,
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Landmark,
} from "lucide-react";

export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export const RECEIPT_ACCEPT = "image/jpeg,image/png,image/webp";
const RECEIPT_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

export const validateReceiptFile = (file) => {
  if (!file) return "A receipt/proof photo is required to settle a payout";
  if (!RECEIPT_MIME.has(file.type)) return "Receipt must be a JPG, PNG or WEBP photo";
  if (file.size > RECEIPT_MAX_BYTES) return "Receipt photo is too large — it must be 5MB or less";
  if (file.size === 0) return "This file looks empty — choose a valid receipt photo";
  return "";
};

export const METHOD_LABEL = { upi: "UPI", bank_transfer: "Bank transfer", other: "Other" };

const ProofViewer = ({ receiptUrl, label, onClose }) => {
  const { url, loading, error } = useSignedDocUrl(receiptUrl);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);
  return (
    <div className="admin-doc-lightbox" onClick={onClose}>
      <div className="admin-doc-lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <div className="admin-doc-lightbox-bar">
          <strong>{label || "Settlement receipt"}</strong>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className="btn btn-outline btn-sm">
                Open original
              </a>
            )}
            <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
              <X size={14} /> Close
            </button>
          </div>
        </div>
        {loading && <p style={{ padding: "1rem" }}>Preparing secure preview…</p>}
        {!loading && (error || !url) && (
          <p style={{ padding: "1rem" }}>{error || "Receipt preview unavailable."}</p>
        )}
        {!loading && url && <img src={url} alt={label || "Settlement receipt"} />}
      </div>
    </div>
  );
};

const SettleDialog = ({ record, weekLabel, onClose, onSettled }) => {
  const showToast = useShowToast();
  const [method, setMethod] = useState("upi");
  const [reference, setReference] = useState("");
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [progress, setProgress] = useState(0);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (preview) URL.revokeObjectURL(preview);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickFile = (f) => {
    const err = validateReceiptFile(f);
    if (preview) URL.revokeObjectURL(preview);
    if (err) {
      setFile(null);
      setPreview("");
      setFieldError(err);
      return;
    }
    setFieldError("");
    setFile(f);
    try {
      setPreview(URL.createObjectURL(f));
    } catch {
      setPreview("");
    }
  };

  const submit = async () => {
    if (saving) return;
    if (!reference.trim()) {
      setFieldError("Enter the UPI / bank transaction ID first");
      return;
    }
    const fileErr = validateReceiptFile(file);
    if (fileErr) {
      setFieldError(fileErr);
      return;
    }
    setFieldError("");
    setSaving(true);
    setProgress(0);
    try {
      const fd = new FormData();
      fd.append("paymentMethod", method);
      fd.append("reference", reference.trim());
      fd.append("receipt", file);
      const res = await API.post(
        `/admin/cook-payouts/payouts/${record._id}/settle-weekly`,
        fd,
        {
          headers: { "Content-Type": "multipart/form-data" },
          onUploadProgress: (e) => {
            if (!alive.current) return;
            const total = e.total || file.size || 1;
            setProgress(Math.min(99, Math.round((e.loaded / total) * 100)));
          },
        }
      );
      if (!alive.current) return;
      setProgress(100);
      showToast(
        res.data?.alreadySettled
          ? "Already settled — showing the current record."
          : `Payout of ${formatCurrency(res.data?.settledAmount ?? record.remainingPayable)} recorded — the cook has been notified.`,
        "success"
      );
      try {
        window.dispatchEvent(new CustomEvent("weekly-payouts-updated"));
      } catch {
      }
      onSettled();
      onClose();
    } catch (err) {
      if (!alive.current) return;
      setProgress(0);
      if (err.response?.status === 409) {
        showToast("Already handled by another admin — refreshing to show the current state.", "info");
        try {
          window.dispatchEvent(new CustomEvent("weekly-payouts-updated"));
        } catch {
        }
        onSettled();
        onClose();
      } else {
        // Never report success on failure: keep the dialog open with the
        // pending balance untouched so the admin can retry.
        setFieldError(err.response?.data?.message || "Could not settle payout — nothing was recorded, please retry");
      }
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  return (
    <div className="admin-doc-lightbox" onClick={() => !saving && onClose()}>
      <div
        className="admin-doc-lightbox-inner"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settle weekly payout"
        style={{ maxWidth: 520 }}
      >
        <div className="admin-doc-lightbox-bar">
          <strong>Settle weekly payout</strong>
          <button type="button" className="btn btn-outline btn-sm" disabled={saving} onClick={onClose}>
            <X size={14} /> Close
          </button>
        </div>
        <div style={{ padding: "1rem 1.1rem 1.1rem", display: "flex", flexDirection: "column", gap: "0.7rem" }}>
          <div style={{ background: "var(--slate-50)", border: "1px solid var(--slate-100)", borderRadius: 12, padding: "0.7rem 0.85rem" }}>
            <div style={{ fontWeight: 800 }}>{record.cook?.name || "Cook"}</div>
            <div style={{ fontSize: "0.82rem", color: "var(--slate-500)" }}>
              Earning week {weekLabel} · {record.bookingCount ?? 0} booking{(record.bookingCount ?? 0) === 1 ? "" : "s"}
            </div>
            <div style={{ marginTop: "0.35rem", fontSize: "1.15rem", fontWeight: 800, color: "var(--primary)" }}>
              {formatCurrency(record.remainingPayable ?? record.totalPayable)}
              <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--slate-500)" }}> remaining payable</span>
            </div>
          </div>

          <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem", fontWeight: 700 }}>
            Payment method
            <select className="form-control" value={method} onChange={(e) => setMethod(e.target.value)} disabled={saving}>
              <option value="upi">UPI</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="other">Other</option>
            </select>
          </label>

          <label style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem", fontWeight: 700 }}>
            Transaction / reference ID
            <input
              className="form-control"
              placeholder="UPI txn id / bank UTR"
              value={reference}
              autoFocus
              disabled={saving}
              onChange={(e) => setReference(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </label>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem", fontWeight: 700 }}>
            Receipt / proof photo (required, JPG·PNG·WEBP ≤ 5MB)
            <label className="btn btn-outline btn-sm" style={{ justifyContent: "center", cursor: saving ? "default" : "pointer" }}>
              <Upload size={14} /> {file ? file.name : "Choose receipt photo"}
              <input
                type="file"
                accept={RECEIPT_ACCEPT}
                disabled={saving}
                style={{ display: "none" }}
                onChange={(e) => pickFile(e.target.files?.[0] || null)}
              />
            </label>
            {preview && (
              <img src={preview} alt="Receipt preview" style={{ width: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 10, border: "1px solid var(--slate-200)", background: "#fff" }} />
            )}
          </div>

          {saving && progress > 0 && (
            <div role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} style={{ height: 8, background: "var(--slate-100)", borderRadius: 99, overflow: "hidden" }}>
              <div style={{ width: `${progress}%`, height: "100%", background: "var(--primary-gradient)", transition: "width 0.2s ease" }} />
            </div>
          )}

          {fieldError && (
            <div className="error-alert-banner" role="alert">
              <AlertCircle size={16} /> {fieldError}
            </div>
          )}

          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-outline btn-sm" disabled={saving} onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={submit}>
              <CheckCircle2 size={14} /> {saving ? "Recording…" : "Confirm paid"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const AdminWeeklyPayouts = ({ mode = "pending" }) => {
  const isPending = mode !== "completed";
  const showToast = useShowToast();
  const [monday, setMonday] = useState(() => mondayOfWeekIST(new Date()));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [settleFor, setSettleFor] = useState(null);
  const [proof, setProof] = useState(null);
  const abortRef = useRef(null);

  const fetchWeek = useCallback(async () => {
    const key = weekKeyIST(monday);
    if (!key) {
      setError("Pick a valid week to view payouts");
      setLoading(false);
      return;
    }
    try {
      abortRef.current?.abort?.();
    } catch {
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const res = await API.get(
        `/admin/cook-payouts/weekly/${isPending ? "pending" : "completed"}?weekStart=${key}`,
        { signal: controller.signal }
      );
      setData(res.data || null);
      setError("");
    } catch (err) {
      if (err?.code === "ERR_CANCELED" || err?.name === "CanceledError" || err?.name === "AbortError") return;
      if (!err.response) setError("Cannot reach the server — is the backend running?");
      else setError(err.response?.data?.message || "Could not load weekly payouts");
    } finally {
      setLoading(false);
    }
  }, [monday, isPending]);

  useEffect(() => {
    fetchWeek();
    return () => {
      try {
        abortRef.current?.abort?.();
      } catch {
      }
    };
  }, [fetchWeek]);

  // Refresh both tabs after any successful settlement.
  useEffect(() => {
    const onUpdate = () => fetchWeek();
    window.addEventListener("weekly-payouts-updated", onUpdate);
    return () => window.removeEventListener("weekly-payouts-updated", onUpdate);
  }, [fetchWeek]);

  const shiftWeek = (dir) => setMonday((m) => new Date(new Date(m).getTime() + dir * 7 * DAY_MS));
  const weekLabel = data?.week?.label || formatWeekLabel(monday);
  const totals = data?.totals || {};
  const records = data?.records || [];

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("Copied", "info");
    } catch {
    }
  };

  return (
    <div className="admin-section">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", gap: "0.6rem", flexWrap: "wrap" }}>
        <h2 style={{ fontSize: "1.15rem", fontWeight: 800, margin: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {isPending ? <Clock3 size={18} style={{ color: "#d97706" }} /> : <History size={18} style={{ color: "var(--accent-emerald)" }} />}
          {isPending ? "Pending Payouts" : "Completed Payments"}
        </h2>
        <div style={{ display: "flex", alignItems: "center", gap: "0.45rem", flexWrap: "wrap" }}>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => shiftWeek(-1)} aria-label="Previous week">
            <ChevronLeft size={15} />
          </button>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.82rem", color: "var(--slate-600)", fontWeight: 700 }}>
            <CalendarDays size={14} />
            <input
              type="date"
              className="form-control"
              style={{ padding: "0.3rem 0.5rem", fontSize: "0.85rem", width: "auto" }}
              value={toDateInputValue(monday)}
              onChange={(e) => {
                const m = mondayOfWeekIST(e.target.value ? new Date(`${e.target.value}T12:00:00`) : new Date());
                if (m) setMonday(m);
              }}
              aria-label="Select earning week"
            />
          </label>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => shiftWeek(1)} aria-label="Next week">
            <ChevronRight size={15} />
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setMonday(mondayOfWeekIST(new Date()))}>
            This week
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={fetchWeek}>
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </div>

      <p style={{ margin: "0 0 0.9rem", fontSize: "0.86rem", color: "var(--slate-600)" }}>
        Earning week <strong>{weekLabel}</strong> (Monday–Sunday, IST)
        {totals.cycleCount > 0 && (
          <> · <strong>{formatCurrency(isPending ? totals.remaining : totals.totalPaid)}</strong> {isPending ? "remaining" : "paid"} · {totals.cookCount} cook{(totals.cookCount ?? 0) === 1 ? "" : "s"} · {totals.cycleCount} payout{(totals.cycleCount ?? 0) === 1 ? "" : "s"}</>
        )}
      </p>

      {error && (
        <div className="error-alert-banner" role="alert">
          <AlertCircle size={16} /> {error}
        </div>
      )}
      {loading && <p style={{ color: "var(--slate-500)" }}>{isPending ? "Loading pending payouts…" : "Loading completed payments…"}</p>}

      {!loading && !error && records.length === 0 && (
        <div className="empty-state-card">
          <div className="empty-state-icon">
            {isPending ? <CheckCircle2 size={26} /> : <Landmark size={26} />}
          </div>
          <h3>{isPending ? "No pending payouts this week" : "No completed payments this week"}</h3>
          <p style={{ color: "var(--slate-600)", fontSize: "0.92rem" }}>
            {isPending
              ? "Every cook's earnings for this week are settled, or no payout cycles were built for it yet."
              : "Settled payouts for this earning week will appear here with their receipts."}
          </p>
        </div>
      )}

      {!loading && !error && records.length > 0 && (
        <div className="bookings-list-modern">
          {records.map((r) => (
            <article key={r._id} className="booking-item-card">
              <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: "1 1 240px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.55rem", minWidth: 0 }}>
                    <span className="abc-ava abc-ava-cook" aria-hidden="true" style={{ width: 40, height: 40, fontSize: "0.95rem" }}>
                      {(r.cook?.name || "C")[0].toUpperCase()}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <strong>{r.cook?.name || "Cook"}</strong>
                      <div style={{ fontSize: "0.75rem", color: "var(--slate-400)", fontFamily: "var(--font-mono)" }}>
                        {String(r.cook?._id || "").slice(-6).toUpperCase()}
                        {r.cook?.phone ? ` · ${r.cook.phone}` : ""}
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop: "0.45rem", fontSize: "0.83rem", color: "var(--slate-600)" }}>
                    {r.bookingCount ?? 0} eligible booking{(r.bookingCount ?? 0) === 1 ? "" : "s"} · Gross {formatCurrency(r.grossCustomerValue)} · Net {formatCurrency(r.cookEarnings)}
                  </div>
                  <div style={{ marginTop: "0.2rem", fontSize: "0.8rem", color: "var(--slate-500)" }}>
                    {isPending ? (
                      <>Settled {formatCurrency(r.settledAmount)} · <strong>Remaining {formatCurrency(r.remainingPayable)}</strong></>
                    ) : (
                      <>Earning week {r.week?.label || weekLabel}{r.paidAt || r.paymentDate ? ` · Paid ${formatDate(r.paidAt || r.paymentDate)}` : ""}</>
                    )}
                  </div>
                  {!isPending && (
                    <div style={{ marginTop: "0.35rem", display: "flex", gap: "0.4rem", flexWrap: "wrap", fontSize: "0.78rem", color: "var(--slate-600)" }}>
                      <span className="badge badge-slate">{METHOD_LABEL[r.paymentMethod] || r.paymentMethod || "—"}</span>
                      {r.paymentReference && (
                        <button type="button" className="btn btn-outline btn-sm" style={{ padding: "0.15rem 0.5rem" }} onClick={() => copy(r.paymentReference)} title="Copy transaction reference">
                          {r.paymentReference}
                        </button>
                      )}
                      {r.settledBy?.name && <span style={{ alignSelf: "center" }}>by {r.settledBy.name}</span>}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: "right", minWidth: 150 }}>
                  <div style={{ fontWeight: 800, color: isPending ? "var(--primary)" : "var(--accent-emerald)", fontSize: "1.1rem" }}>
                    {formatCurrency(isPending ? r.remainingPayable ?? r.totalPayable : r.settledAmount ?? r.totalPayable)}
                  </div>
                  <div style={{ fontSize: "0.76rem", color: "var(--slate-500)" }}>
                    {isPending ? `of ${formatCurrency(r.totalPayable)} payable` : "amount paid"}
                  </div>
                  <div style={{ marginTop: "0.3rem" }}>
                    <span className={`badge ${isPending ? "badge-amber" : "badge-emerald"}`}>
                      {isPending ? (r.status === "approved" ? "Approved" : r.status === "under_verification" ? "Under verification" : "Pending") : "Paid"}
                    </span>
                  </div>
                  <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.4rem", justifyContent: "flex-end", flexWrap: "wrap" }}>
                    {isPending ? (
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setSettleFor(r)}>
                        <Banknote size={14} /> Settle payout
                      </button>
                    ) : (
                      r.receiptUrl && (
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => setProof(r)}>
                          <Eye size={14} /> View receipt
                        </button>
                      )
                    )}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {settleFor && (
        <SettleDialog
          record={settleFor}
          weekLabel={weekLabel}
          onClose={() => setSettleFor(null)}
          onSettled={fetchWeek}
        />
      )}
      {proof && (
        <ProofViewer
          receiptUrl={proof.receiptUrl}
          label={`Receipt — ${proof.cook?.name || "Cook"} · ${formatCurrency(proof.settledAmount ?? proof.totalPayable)}`}
          onClose={() => setProof(null)}
        />
      )}
    </div>
  );
};

export default AdminWeeklyPayouts;
