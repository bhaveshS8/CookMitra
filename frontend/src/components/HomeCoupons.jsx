import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { Copy, Check, BadgePercent, Sparkles, ArrowRight } from "lucide-react";

// "Festive Offers" section on the home page — lists every currently usable
// coupon from GET /api/coupons/active (admin-managed via the dashboard).
// Renders nothing when the backend is unreachable or there are no live offers,
// so the home page stays clean instead of showing an empty section.
const HomeCoupons = () => {
  const [coupons, setCoupons] = useState([]);
  const [copiedCode, setCopiedCode] = useState(null);

  useEffect(() => {
    let alive = true;
    API.get("/coupons/active")
      .then((res) => {
        // Tolerate the paginated envelope ({ data, pagination }) as well as
        // the bare array, so ?page/limit use can never blank the section.
        const list = Array.isArray(res?.data) ? res.data : res?.data?.data;
        if (alive && Array.isArray(list)) {
          setCoupons(list.filter((c) => c && c.code));
        }
      })
      .catch(() => {
        /* backend down — hide the section entirely */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!coupons.length) return null;

  const copyCode = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* clipboard blocked — still show feedback */
    }
    setCopiedCode(code);
    setTimeout(() => setCopiedCode((c) => (c === code ? null : c)), 1800);
  };

  const fmtDate = (d) => {
    const date = new Date(d);
    return Number.isNaN(date.getTime())
      ? null
      : date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  };

  // Customer-facing cards never advertise the restrictive terms — no rupee
  // cap ("up to ₹70"), no per-customer limit ("one per customer"). The limits
  // still apply at checkout, but the card headline stays a clean % OFF.
  // The copy lives in the DB description (admin-editable), so strip it at
  // render time instead of trusting stored text.
  const cleanCouponDescription = (text) => {
    const cleaned = String(text || "")
      .replace(/\s*\bup\s*to\s*₹\s*[\d,]+/gi, "")
      .replace(/[\s,]*\b(?:once|one|1\s*x?)\s*per\s*(?:customers?|users?)\b\s*[,.]?/gi, "")
      .replace(/\(\s*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+,/g, ",")
      .replace(/^,\s*|\s*,$/g, "")
      .trim();
    return cleaned;
  };

  return (
    <section className="home-coupons home-band band-abyss" id="offers">
      <div className="section-header">
        <span className="section-eyebrow">🪔 Ganesh Utsav Specials</span>
        <h2 className="section-title">Festive Offers For You</h2>
        <p className="section-description">
          Apply a coupon while booking — one offer per session, straight off
          your bill.
        </p>
      </div>

      <div className="coupon-grid">
        {coupons.map((c, i) => (
          <article
            key={c.code}
            className={`coupon-card${i === 0 ? " coupon-card-top" : ""}`}
            style={{ "--d": `${0.06 * i}s` }}
          >
            {i === 0 && (
              <span className="coupon-best">
                <Sparkles size={13} /> Best Offer
              </span>
            )}
            <div className="coupon-off">
              <BadgePercent size={26} />
              <span>
                {c.discountType === "flat" && c.flatAmount != null
                  ? `₹${c.flatAmount} OFF`
                  : `${c.percent}% OFF`}
              </span>
            </div>
            <div className="coupon-code-row">
              <h3 className="coupon-code">{c.code}</h3>
              <button
                type="button"
                className="coupon-copy"
                onClick={() => copyCode(c.code)}
                aria-label={`Copy coupon code ${c.code}`}
              >
                {copiedCode === c.code ? (
                  <>
                    <Check size={14} /> Copied
                  </>
                ) : (
                  <>
                    <Copy size={14} /> Copy
                  </>
                )}
              </button>
            </div>
            {c.description && cleanCouponDescription(c.description) && (
              <p className="coupon-desc">{cleanCouponDescription(c.description)}</p>
            )}
            <ul className="coupon-meta">
              {c.minOrder ? <li>Min order ₹{c.minOrder}</li> : null}
              {c.discountType !== "flat" && c.maxDiscount ? <li>Up to ₹{c.maxDiscount} off</li> : null}
              {c.perUserLimit != null ? (
                <li>{Number(c.perUserLimit) === 1 ? "One per customer" : `${c.perUserLimit} per customer`}</li>
              ) : null}
              {c.firstBookingOnly ? <li>First booking only</li> : null}
              {c.validTo ? <li>Valid till {fmtDate(c.validTo)}</li> : null}
            </ul>
          </article>
        ))}
      </div>

      <div className="coupon-cta">
        <Link to="/cook-on-demand" className="btn btn-lg hero-v2-btn-primary">
          Book a Festive Cook <ArrowRight size={18} />
        </Link>
      </div>
    </section>
  );
};

export default HomeCoupons;
