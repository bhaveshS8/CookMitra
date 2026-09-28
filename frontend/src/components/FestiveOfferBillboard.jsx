import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
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
} from "lucide-react";

const SEEN_KEY = "cm-festive-offer-seen";
const HIDE_KEY = "cm-festive-offer-hide";
// Ganesh Utsav 2026 (Sept 14 – Sept 25) — offer runs till midnight after
// Visarjan on Anant Chaturdashi (Sept 25).
const OFFER_END = new Date("2026-09-26T00:00:00");
// Promo code shown on the popup. Fetched live from the backend
// /api/coupons/active list (admin-managed); this is the graceful fallback and
// must always name a real code from backend/utils/couponCatalog.js.
const OFFER_CODE = "FESTIVE20";
const OFFER_PERCENT = 20;

const MODAK_IMG =
  "https://images.pexels.com/photos/33643272/pexels-photo-33643272.jpeg";

const PURAN_POLI_IMG = "https://images.pexels.com/photos/38229508/pexels-photo-38229508.jpeg";

const LADOO_IMG = "https://images.pexels.com/photos/8887021/pexels-photo-8887021.jpeg";

 
const FOODS = [
  {
    name: "Modak",
    tag: "Bappa's favourite",
    tagClass: "hot",
    src: MODAK_IMG,
    alt: "Steamed Ukadiche Modak for Ganesh Chaturthi",
  },
  {
    name: "Puran Poli",
    tag: "Classic",
    tagClass: "hot",
    src: PURAN_POLI_IMG,
    alt: "Sweet Puran Poli flatbread",
  },
  {
    name: "Ladoo",
    tag: "Festive",
    tagClass: "hot",
    src: LADOO_IMG,
    alt: "Festive besan ladoo sweets",
  },
];

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
  const [showModal, setShowModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const { d, h, m, s, expired } = useCountdown();

  const [heroCode, setHeroCode] = useState(OFFER_CODE);
  const [heroPercent, setHeroPercent] = useState(OFFER_PERCENT);
  useEffect(() => {
    let alive = true;
    API.get("/coupons/active")
      .then((res) => {
        const list = Array.isArray(res?.data)
          ? res.data
              .filter((c) => c && c.code)
              .sort((a, b) => Number(b.percent || 0) - Number(a.percent || 0))
          : [];
        if (alive && list.length) {
          const top = list[0];
          setHeroCode(String(top.code).toUpperCase());
          if (top.percent != null) setHeroPercent(Number(top.percent));
        }
      })
      .catch(() => {
        /* backend down — keep the fallback default */
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let timer;
    try {
      const hidden = localStorage.getItem(HIDE_KEY);
      const seen = sessionStorage.getItem(SEEN_KEY);
      if (!hidden && !seen) {
        // Delayed entry so the hero paints first — less intrusive,
        // better LCP and first impression.
        timer = setTimeout(() => setShowModal(true), 8000);
      }
    } catch {
      timer = setTimeout(() => setShowModal(true), 8000);
    }
    return () => clearTimeout(timer);
  }, []);

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
    setShowModal(false);
    try {
      sessionStorage.setItem(SEEN_KEY, "1");
      if (persist) localStorage.setItem(HIDE_KEY, "1");
    } catch {
      /* storage unavailable — modal simply reappears next visit */
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(heroCode);
    } catch {
      /* clipboard blocked — still show feedback */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <>
      {/* Entry popup billboard */}
      {showModal && (
        <div
          className="festive-overlay"
          onClick={closeModal}
          role="dialog"
          aria-modal="true"
          aria-label="Festive offer"
        >
          <div className="festive-card" onClick={(e) => e.stopPropagation()}>
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
                  <span aria-hidden="true">🪔</span> Ganesh Utsav · Ends {expired ? "tonight" : "Sept 25"}
                </p>

                <h2 className="festive-title">
                  <span className="festive-title-first">Get {heroPercent}% OFF</span>{" "}
                  <span className="festive-title-gold">festive feasts</span>
                </h2>

                <p className="festive-desc">
                  Hot modaks, puran poli &amp; naivedya — cooked fresh in{" "}
                  <strong>your kitchen</strong>. Use code{" "}
                  <strong className="festive-desc-code">{heroCode}</strong> at
                  checkout.
                </p>

                <div className="festive-offer-row">
                  <div className="festive-mega">
                    <div className="festive-mega-num">
                      <span className="mega-20">{heroPercent}%</span>
                      <span className="mega-off">OFF</span>
                    </div>
                    <div className="festive-mega-side">
                      <span className="festive-mega-stars" aria-hidden="true">
                        {[...Array(5)].map((_, i) => (
                          <Star key={i} size={11} fill="#ffd24d" color="#ffd24d" />
                        ))}
                      </span>
                      <span>with code {heroCode}</span>
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
              </div>

              <div className="festive-showcase">
                <div className="festive-foods">
                  {FOODS.map((f) => (
                    <figure key={f.name} className="festive-food">
                      <span className="festive-food-ring">
                        <img
                          src={f.src}
                          srcSet={`${f.src}?auto=compress&cs=tinysrgb&w=160 160w, ${f.src}?auto=compress&cs=tinysrgb&w=320 320w, ${f.src}?auto=compress&cs=tinysrgb&w=480 480w`}
                          sizes="(max-width: 380px) 26vw, (max-width: 560px) 30vw, 128px"
                          width={320}
                          height={320}
                          alt={f.alt}
                          loading="lazy"
                        />
                        <span className={`festive-food-tag ${f.tagClass}`}>{f.tag}</span>
                      </span>
                      <figcaption>{f.name}</figcaption>
                    </figure>
                  ))}
                </div>
                <p className="festive-showcase-note">
                  Verified cooks · OTP-verified sessions · Min order ₹349
                </p>
              </div>

              <div className="festive-bottom-row">
                <div className="festive-coupon">
                  <span className="festive-coupon-label">
                    <Gift size={15} /> Your code
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
                    <ChefHat size={20} /> Claim {heroPercent}% OFF <ArrowRight size={20} />
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