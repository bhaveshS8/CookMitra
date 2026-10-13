import React, { useEffect, useRef, useState } from "react";
import { Tag, CheckCircle2, X, Loader2 } from "lucide-react";
import API from "../api/axios";
import { formatCurrency } from "../utils/constants";
import { AnalyticsEvents, track } from "../utils/analytics";

const CouponApply = ({ amount, serviceType, onApplied, initialCode }) => {
  const [code, setCode] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(null);
  const lastAmount = useRef(amount);
  const lastService = useRef(serviceType);
  const initialTried = useRef(null);
  // Monotonic validate-request id. Only the latest request may commit its
  // result: slower older responses are discarded, and changing amount /
  // service invalidates any in-flight validation for the old price.
  const reqId = useRef(0);
  // In-flight request key (code + price + service). An identical submission
  // while one is pending is ignored (rapid double-click / Enter+click
  // dedupe); a DIFFERENT code supersedes it — sequencing still guarantees
  // the oldest result can never overwrite the newest. A plain boolean busy
  // flag would wrongly block replacing a coupon while one validates.
  const inflightKey = useRef(null);

  useEffect(() => {
    if (applied && (lastAmount.current !== amount || lastService.current !== serviceType)) {
      setApplied(null);
      setCode("");
      setError("");
      onApplied?.(null);
    }
    if (lastAmount.current !== amount || lastService.current !== serviceType) {
      reqId.current += 1; // invalidate in-flight validation for the old price
      inflightKey.current = null; // a fresh price accepts fresh attempts
      setApplying(false); // never stick in "Applying…"
    }
    lastAmount.current = amount;
    lastService.current = serviceType;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, serviceType]);

  useEffect(() => {
    const c = String(initialCode || "").trim().toUpperCase();
    if (!c || applying || applied || initialTried.current === `${c}|${amount}|${serviceType}`) return;
    initialTried.current = `${c}|${amount}|${serviceType}`;
    setCode(c);
    apply(c, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCode, amount, serviceType]);

  const apply = async (override, auto = false) => {
    // NOTE: callers must pass a coupon-code string (or nothing for the
    // input value). Never pass the click Event itself — String(event) would
    // serialize to garbage ("[object MouseEvent]") and every button Apply
    // would fail validation. Non-string overrides fall back to the input.
    const raw = typeof override === "string" ? override : code;
    const c = String(raw ?? "").trim().toUpperCase().replace(/[^A-Za-z0-9]+/g, "");
    if (!c) return;
    const key = `${c}|${amount}|${serviceType}`;
    if (inflightKey.current === key) return; // exact duplicate already validating
    inflightKey.current = key;
    const myReq = ++reqId.current;
    setApplying(true);
    setError("");
    try {
      const res = await API.post("/coupons/validate", { code: c, amount, serviceType });
      if (myReq !== reqId.current) return; // stale: a newer request won
      const result = {
        code: res.data.code,
        discount: res.data.discount,
        payable: res.data.payable,
        fullFee: res.data.fullFee,
      };
      setApplied(result);
      onApplied?.(result, { auto });
      track(AnalyticsEvents.COUPON_APPLIED, {
        coupon_code: result.code,
        discount: Number(result.discount) || 0,
        amount: Number(amount) || 0,
      });
    } catch (err) {
      if (myReq !== reqId.current) return; // stale: a newer request won
      const status = err.response?.status;
      const msg =
        status === 401
          ? "Please log in as a customer to use coupons."
          : err.response?.data?.message || "This coupon is not valid for this booking.";
      setError(msg);
      // A failed validation changes nothing: a previously applied coupon
      // stays applied (and stays in the parent) — the backend revalidates
      // authoritatively at booking creation either way. In particular, never
      // wipe the parent with onApplied(null) here while still displaying the
      // old coupon as applied.
    } finally {
      // Release the in-flight slot only if a newer request hasn't taken it;
      // reset the spinner only if no newer request owns the UI.
      if (inflightKey.current === key) inflightKey.current = null;
      if (myReq === reqId.current) {
        setApplying(false);
      }
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
            setCode(e.target.value.toUpperCase().replace(/[^A-Za-z0-9]+/g, ""));
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
          onClick={() => apply()}
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
