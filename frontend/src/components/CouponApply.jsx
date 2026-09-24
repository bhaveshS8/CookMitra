import React, { useEffect, useRef, useState } from "react";
import { Tag, CheckCircle2, X, Loader2 } from "lucide-react";
import API from "../api/axios";
import { formatCurrency } from "../utils/constants";
import { AnalyticsEvents, track } from "../utils/analytics";

// "Have a Coupon Code?" — enter → Apply → instant discount + final amount.
// Props: amount (pre-discount fee), serviceType, onApplied(result|null),
// initialCode (a previously applied code restored after login/retry —
// re-validated once against the live fee, never trusted blindly).
// The server re-validates everything at booking time; this is a preview.
const CouponApply = ({ amount, serviceType, onApplied, initialCode }) => {
  const [code, setCode] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(null);
  const lastAmount = useRef(amount);
  const lastService = useRef(serviceType);
  const initialTried = useRef(null);

  // The preview belongs to a specific fee + service — a changed total
  // (e.g. different hours) forces a fresh apply instead of showing stale math.
  useEffect(() => {
    if (applied && (lastAmount.current !== amount || lastService.current !== serviceType)) {
      setApplied(null);
      setCode("");
      setError("");
      onApplied?.(null);
    }
    lastAmount.current = amount;
    lastService.current = serviceType;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, serviceType]);

  // Restore a code carried across the login wall / retry: re-validate it
  // against the live fee exactly once (a stale/invalid code just surfaces
  // the server error instead of silently discounting).
  useEffect(() => {
    const c = String(initialCode || "").trim().toUpperCase();
    if (!c || applying || applied || initialTried.current === `${c}|${amount}|${serviceType}`) return;
    initialTried.current = `${c}|${amount}|${serviceType}`;
    setCode(c);
    apply(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode, amount, serviceType]);

  const apply = async (override) => {
    const c = String(override ?? code).trim().toUpperCase();
    if (!c || applying) return;
    setApplying(true);
    setError("");
    try {
      const res = await API.post("/coupons/validate", { code: c, amount, serviceType });
      const result = {
        code: res.data.code,
        discount: res.data.discount,
        payable: res.data.payable,
        fullFee: res.data.fullFee,
      };
      setApplied(result);
      onApplied?.(result);
      track(AnalyticsEvents.COUPON_APPLIED, {
        coupon_code: result.code,
        discount: Number(result.discount) || 0,
        amount: Number(amount) || 0,
      });
    } catch (err) {
      const status = err.response?.status;
      const msg =
        status === 401
          ? "Please log in as a customer to use coupons."
          : err.response?.data?.message || "This coupon is not valid for this booking.";
      setError(msg);
      onApplied?.(null);
    } finally {
      setApplying(false);
    }
  };

  const remove = () => {
    setApplied(null);
    setCode("");
    setError("");
    onApplied?.(null);
  };

  if (applied) {
    return (
      <div className="coupon-applied">
        <span className="coupon-applied-badge">
          <CheckCircle2 size={15} /> {applied.code}
        </span>
        <span className="coupon-applied-text">
          Coupon applied successfully! You saved {formatCurrency(applied.discount)}.
        </span>
        <button type="button" className="coupon-remove" onClick={remove} aria-label="Remove coupon">
          <X size={14} /> Remove
        </button>
      </div>
    );
  }

  return (
    <div className="coupon-apply">
      <label className="coupon-apply-label">
        <Tag size={14} /> Have a Coupon Code?
      </label>
      <div className="coupon-apply-row">
        <input
          type="text"
          className="form-control coupon-input"
          value={code}
          onChange={(e) => {
            setCode(e.target.value.toUpperCase());
            setError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
          placeholder="e.g. WELCOME50"
          maxLength={24}
          aria-label="Coupon code"
        />
        <button
          type="button"
          className="btn btn-outline btn-sm coupon-apply-btn"
          onClick={apply}
          disabled={applying || !code.trim()}
        >
          {applying ? (
            <>
              <Loader2 size={14} className="spin" /> Applying…
            </>
          ) : (
            "Apply"
          )}
        </button>
      </div>
      {error && <p className="coupon-error" role="alert">{error}</p>}
    </div>
  );
};

export default CouponApply;
