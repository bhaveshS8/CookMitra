import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { Copy, Check, BadgePercent, Sparkles, ArrowRight, ShoppingBag, Clock, Users } from "lucide-react";

const HomeCoupons = () => {
  const [coupons, setCoupons] = useState([]);
  const [copiedCode, setCopiedCode] = useState(null);

  useEffect(() => {
    let alive = true;
    API.get("/coupons/active")
      .then((res) => {
        const list = Array.isArray(res?.data) ? res.data : res?.data?.data;
        if (alive && Array.isArray(list)) {
          setCoupons(list.filter((c) => c && c.code));
        }
      })
      .catch(() => {
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

  /* Split the discount into a large value and a small unit so the ticket stub
     can set them at different sizes ("30%" over "OFF"). */
  const couponBadge = (c) =>
    c.discountType === "flat" && c.flatAmount != null
      ? { value: `₹${c.flatAmount}`, label: "OFF" }
      : { value: `${c.percent}%`, label: "OFF" };

  return (
    <section className="home-coupons home-band band-abyss" id="offers">
      <div className="section-header">
        <span className="section-eyebrow">
          <Sparkles size={12} aria-hidden="true" />
          {coupons.length} Live {coupons.length === 1 ? "Offer" : "Offers"}
        </span>
        <h2 className="section-title">Festive Offers For You</h2>
        <p className="section-description">
          Apply a coupon while booking — one offer per session, straight off
          your bill.
        </p>
      </div>

      <div className="coupon-grid">
        {coupons.map((c, i) => {
          const badge = couponBadge(c);
          return (
            <article
              key={c.code}
              className={`coupon-card${i === 0 ? " coupon-card-top" : ""}`}
              style={{ "--d": `${0.06 * i}s` }}
            >
              {i === 0 && (
                <span className="coupon-best">
                  <Sparkles size={11} aria-hidden="true" /> Best Offer
                </span>
              )}

              {/* Discount stub — the visual anchor of the ticket. */}
              <div className="coupon-stub">
                <span className="coupon-stub-gloss" aria-hidden="true" />
                <span className="coupon-stub-icon">
                  <BadgePercent size={15} aria-hidden="true" />
                </span>
                <span className="coupon-stub-value">{badge.value}</span>
                <span className="coupon-stub-label">{badge.label}</span>
              </div>

              {/* Perforation: a dashed tear line plus die-cut notches that bite
                  out of the card edge, so the stub reads as a detachable stub. */}
              <div className="coupon-perf" aria-hidden="true">
                <span className="coupon-notch coupon-notch-top" />
                <span className="coupon-notch coupon-notch-bottom" />
              </div>

              <div className="coupon-body">
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
                        <Check size={14} aria-hidden="true" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy size={14} aria-hidden="true" /> Copy
                      </>
                    )}
                  </button>
                </div>
                {c.description && cleanCouponDescription(c.description) && (
                  <p className="coupon-desc">{cleanCouponDescription(c.description)}</p>
                )}
                <ul className="coupon-meta">
                  {c.minOrder ? (
                    <li>
                      <ShoppingBag size={11} aria-hidden="true" />
                      Min order ₹{c.minOrder}
                    </li>
                  ) : null}
                  {c.discountType !== "flat" && c.maxDiscount ? (
                    <li>
                      <BadgePercent size={11} aria-hidden="true" />
                      Up to ₹{c.maxDiscount} off
                    </li>
                  ) : null}
                  {c.perUserLimit != null ? (
                    <li>
                      <Users size={11} aria-hidden="true" />
                      {Number(c.perUserLimit) === 1
                        ? "One per customer"
                        : `${c.perUserLimit} per customer`}
                    </li>
                  ) : null}
                  {c.firstBookingOnly ? (
                    <li>
                      <Sparkles size={11} aria-hidden="true" />
                      First booking only
                    </li>
                  ) : null}
                  {c.validTo ? (
                    <li>
                      <Clock size={11} aria-hidden="true" />
                      Valid till {fmtDate(c.validTo)}
                    </li>
                  ) : null}
                </ul>
              </div>
            </article>
          );
        })}
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
