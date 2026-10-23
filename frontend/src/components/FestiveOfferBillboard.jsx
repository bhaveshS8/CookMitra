import React, { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "react-router-dom";
import API from "../api/axios";
import {
  X,
  Copy,
  Check,
  ChefHat,
  Gift,
  Flame,
  Star,
  ArrowRight,
  Sparkles,
} from "lucide-react";

const HIDE_KEY = "cm-diwali-offer-hide";
const SHOW_DELAY_MS = 1500;
// Diwali 2026 — Lakshmi Puja is on Nov 8. Update per festival.
const OFFER_END = new Date("2026-11-09T00:00:00");
// Fallback code; must exist in backend couponCatalog.
const FALLBACK_COUPON = {
  code: "FIRSTFREE",
  discountType: "percent",
  percent: 100,
  maxDiscount: 649,
  minOrder: 0,
  firstBookingOnly: true,
};

const isFreeCoupon = (coupon) => {
  if (!coupon?.code) return false;
  const code = String(coupon.code).replace(/[^a-z0-9]/gi, "").toUpperCase();
  return Number(coupon.percent) === 100 || code === "FIRSTFREE";
};

function useCountdown() {
  const calc = () => {
    const diff = Math.max(0, OFFER_END.getTime() - Date.now());
    return {
      d: Math.floor(diff / 86400000),
      h: Math.floor((diff / 3600000) % 24),
      m: Math.floor((diff / 60000) % 60),
      s: Math.floor((diff / 1000) % 60),
      expired: diff <= 0,
    };
  };
  const [t, setT] = useState(calc);
  useEffect(() => {
    const id = setInterval(() => setT(calc()), 1000);
    return () => clearInterval(id);
  }, []);
  return t;
}

const pad = (n) => String(n).padStart(2, "0");

const FestiveOfferBillboard = () => {
  const location = useLocation();
  const isBookingRoute = /^\/(cook-on-demand|cooks(\/|$)|bookings(\/|$))/.test(
    location.pathname || ""
  );
  const [showModal, setShowModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const dismissedRef = useRef(false);
  const { d, h, m, s, expired } = useCountdown();

  const [heroCoupon, setHeroCoupon] = useState(FALLBACK_COUPON);
  useEffect(() => {
    let alive = true;
    API.get("/coupons/active")
      .then((res) => {
        const raw = Array.isArray(res?.data) ? res.data : res?.data?.data;
        const list = Array.isArray(raw) ? raw.filter((c) => c && c.code) : [];
        if (!alive || !list.length) return;
        // The free first-booking coupon is always the hero, even if the
        // API order or an admin edit puts other offers ahead of it.
        const free = list.find(isFreeCoupon);
        const picked =
          free ||
          list
            .slice()
            .sort((a, b) => Number(b.percent || 0) - Number(a.percent || 0))[0];
        setHeroCoupon({ ...picked, code: String(picked.code).toUpperCase() });
      })
      .catch(() => {
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (isBookingRoute || dismissedRef.current) return undefined;
    let timer;
    try {
      const hidden = localStorage.getItem(HIDE_KEY);
      if (!hidden) {
        timer = setTimeout(() => setShowModal(true), SHOW_DELAY_MS);
      }
    } catch {
      timer = setTimeout(() => setShowModal(true), SHOW_DELAY_MS);
    }
    return () => clearTimeout(timer);
  }, [isBookingRoute]);

  useEffect(() => {
    if (!showModal) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [showModal]);

  useEffect(() => {
    if (!showModal) return;
    const onKey = (e) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showModal]);

  const closeModal = (persist = false) => {
    dismissedRef.current = true;
    setShowModal(false);
    try {
      if (persist) localStorage.setItem(HIDE_KEY, "1");
    } catch {
    }
  };

  useEffect(() => {
    if (isBookingRoute) setShowModal(false);
  }, [isBookingRoute]);

  const heroCode = heroCoupon.code || FALLBACK_COUPON.code;
  const heroPercent = Number(heroCoupon.percent || 0);
  const heroIsFree = isFreeCoupon(heroCoupon);
  const heroCap = Number(heroCoupon.maxDiscount || 0)
    ? `up to ₹${Number(heroCoupon.maxDiscount)}`
    : null;
  const heroValue = heroIsFree
    ? "FREE"
    : heroCoupon.discountType === "flat" && heroCoupon.flatAmount != null
      ? `₹${heroCoupon.flatAmount}`
      : `${heroPercent}%`;
  const heroUnit = heroIsFree ? "ON US" : "OFF";
  const heroSubline = heroIsFree
    ? `First cook session${heroCap ? ` · ${heroCap}` : ""}`
    : heroCoupon.minOrder
      ? `Min order ₹${heroCoupon.minOrder}`
      : "On festive bookings";

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(heroCode);
    } catch {
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <>
      {showModal && !isBookingRoute && (
        <div
          className="festive-overlay"
          onClick={closeModal}
          role="dialog"
          aria-modal="true"
          aria-label={
            heroIsFree
              ? "Diwali offer — your first cook booking is free"
              : "Diwali offer"
          }
        >
          <div
            className="festive-card festive-diwali"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="festive-rangoli" aria-hidden="true" />
            <button
              className="festive-close"
              onClick={closeModal}
              aria-label="Close festive offer"
            >
              <X size={17} />
            </button>

            <div className="festive-body">
              <div className="festive-main">
                <p className="festive-eyebrow">
                  <span aria-hidden="true">🪔</span> Diwali Special · Ends{" "}
                  {expired ? "tonight" : "Nov 8"}
                </p>

                <h2 className="festive-title">
                  <span className="festive-title-first">
                    {heroIsFree
                      ? "Your first Diwali feast"
                      : `Get ${heroPercent}% OFF`}
                  </span>{" "}
                  <span className="festive-title-gold">
                    {heroIsFree ? "is on us" : "this Diwali"}
                  </span>
                </h2>

                <p className="festive-desc">
                  {heroIsFree ? (
                    <>
                      Light up the celebration with a verified cook in{" "}
                      <strong>your kitchen</strong> — faral, sweets &amp; a full
                      festive spread. Your first booking is{" "}
                      <strong>completely free</strong>
                      {heroCap ? ` (${heroCap})` : ""} with code{" "}
                      <strong className="festive-desc-code">{heroCode}</strong>.
                    </>
                  ) : (
                    <>
                      Celebrate Diwali with a verified cook in{" "}
                      <strong>your kitchen</strong> — faral, sweets &amp; a full
                      festive spread. Use code{" "}
                      <strong className="festive-desc-code">{heroCode}</strong>{" "}
                      at checkout.
                    </>
                  )}
                </p>

                <div className="festive-offer-row">
                  <div
                    className={`festive-mega${heroIsFree ? " festive-mega-free" : ""}`}
                  >
                    <div className="festive-mega-num">
                      <span className="mega-20">{heroValue}</span>
                      <span className="mega-off">{heroUnit}</span>
                    </div>
                    <div className="festive-mega-side">
                      <span className="festive-mega-stars" aria-hidden="true">
                        {[...Array(5)].map((_, i) => (
                          <Star key={i} size={11} fill="#ffd24d" color="#ffd24d" />
                        ))}
                      </span>
                      <span>{heroSubline}</span>
                    </div>
                  </div>

                  <div className="festive-countdown" role="timer" aria-label="Offer countdown">
                    <span className="festive-count-head">
                      <Flame size={14} className="festive-count-flame" />
                      <span className="festive-count-label">
                        {expired ? "Offer ends tonight — hurry!" : "Offer ends in"}
                      </span>
                    </span>
                    <div className="festive-count-boxes">
                      {[
                        [pad(d), "days"],
                        [pad(h), "hrs"],
                        [pad(m), "min"],
                        [pad(s), "sec"],
                      ].map(([v, l]) => (
                        <span key={l} className="festive-count-box">
                          <strong>{v}</strong>
                          <em>{l}</em>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <p className="festive-showcase-note">
                  Verified cooks · OTP-verified sessions ·{" "}
                  {heroIsFree
                    ? "One free booking per customer"
                    : heroCoupon.minOrder
                      ? `Min order ₹${heroCoupon.minOrder}`
                      : "No minimum order"}
                </p>
              </div>

              <div className="festive-bottom-row">
                <div className="festive-coupon">
                  <span className="festive-coupon-label">
                    <Gift size={15} />
                    {heroIsFree ? "Your free code" : "Your code"}
                  </span>
                  <strong className="festive-coupon-code">{heroCode}</strong>
                  <button
                    className="festive-copy-btn"
                    onClick={copyCode}
                    aria-label={`Copy offer code ${heroCode}`}
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? "Copied!" : "Copy code"}
                  </button>
                </div>

                <div className="festive-actions">
                  <Link
                    to="/cook-on-demand"
                    className="btn btn-lg festive-cta"
                    onClick={() => closeModal()}
                  >
                    {heroIsFree ? (
                      <Sparkles size={20} />
                    ) : (
                      <ChefHat size={20} />
                    )}
                    {heroIsFree
                      ? "Book my free cook"
                      : `Claim ${heroPercent}% OFF`}{" "}
                    <ArrowRight size={20} />
                  </Link>
                  <button className="festive-maybe" onClick={() => closeModal()}>
                    Maybe later
                  </button>
                  <button
                    className="festive-maybe festive-never"
                    onClick={() => closeModal(true)}
                  >
                    Don't show again
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default FestiveOfferBillboard;
