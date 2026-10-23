import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useSelector } from "react-redux";
import { formatDate, isReviewable, formatTimeRange12 } from "../utils/constants";
import API from "../api/axios";
import heroImg from "../assets/hero.png";
import DishCarousel from "../components/DishCarousel";
import HomeCoupons from "../components/HomeCoupons";
import ReviewForm from "../components/ReviewForm";
import CookAvatar from "../components/CookAvatar";
import Register from "./Register";
import {
  ArrowRight,
  CalendarClock,
  ChefHat,
  Star,
  CheckCircle2,
  CalendarCheck,
  Compass,
  UserCheck,
  Award,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

/* "How Cook Mitra Works" steps. Kept as data so the icon, numeral and copy
   stay together and the stepper renders identically at every breakpoint. */
const HOW_STEPS = [
  {
    step: "01",
    Icon: Compass,
    title: "Share Requirements",
    text: "Pick a service, date, dishes and location — tell us what you need for your gathering.",
  },
  {
    step: "02",
    Icon: UserCheck,
    title: "Pick Cook & Slot",
    text: "See verified cooks free on your date with their open time slots — tap one to send your booking request.",
  },
  {
    step: "03",
    Icon: CalendarCheck,
    title: "OTP-Verified Start",
    text: "Cook arrives at your home, you share the OTP — session starts securely with live tracking and UPI payment after approval.",
  },
  {
    step: "04",
    Icon: Award,
    title: "Savor & Review",
    text: "Enjoy delicious authentic flavors with your family, then share your review and experience with the community.",
  },
];

const CountUp = ({ to, decimals = 0, suffix = "", duration = 1400 }) => {
  const [val, setVal] = useState(0);
  const ref = useRef(null);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) {
      setVal(to);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !started.current) {
            started.current = true;
            const t0 = performance.now();
            const tick = (t) => {
              const p = Math.min(1, (t - t0) / duration);
              const eased = 1 - Math.pow(1 - p, 3);
              setVal(to * eased);
              if (p < 1) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            io.disconnect();
          }
        });
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [to, duration]);

  return (
    <span ref={ref}>
      {val.toFixed(decimals)}
      {suffix}
    </span>
  );
};

// Curated Diwali faral, sweets and celebration mains, so the strip matches
// the festival the hero promotes.
const TICKER_DISHES = [
  "Chakli",
  "Karanji",
  "Shankarpali",
  "Bhajani Chivda",
  "Besan Ladoo",
  "Motichoor Ladoo",
  "Kaju Katli",
  "Gulab Jamun",
  "Jalebi",
  "Soan Papdi",
  "Dry Fruit Barfi",
  "Mathri",
  "Namkeen Sev",
  "Malpua",
  "Rabri",
  "Basundi",
  "Puri & Aloo Sabzi",
  "Dal Makhani",
  "Paneer Butter Masala",
  "Veg Biryani",
  "Chole Bhature",
  "Badam Halwa",
];

const DISMISSED_RATINGS_KEY = "home-rate-dismissed";

const PendingRatingCard = ({ booking, onRated, onDismiss }) => {
  return (
    <article className="hrc-card">
      <button
        type="button"
        onClick={() => onDismiss(booking._id)}
        aria-label={`Dismiss rating for ${booking.cook?.name || "cook"}`}
        title="Dismiss"
        className="hrc-x"
      >
        <X size={15} />
      </button>
      <div className="hrc-card-head">
        <span className="hrc-avatar" aria-hidden="true">
          <CookAvatar
            photoUrl={booking.cook?.photoUrl}
            name={booking.cook?.name}
            alt=""
            fallback={booking.cook?.name?.[0]?.toUpperCase() || <ChefHat size={18} />}
          />
        </span>
        <div className="hrc-who">
          <div className="hrc-name">How was {booking.cook?.name || "your cook"}?</div>
          <div className="hrc-chips">
            {(booking.serviceType || "").replace(/_/g, " ") && (
              <span className="rf-chipmeta">{(booking.serviceType || "").replace(/_/g, " ")}</span>
            )}
            {booking.date && <span className="rf-chipmeta">{formatDate(booking.date)}</span>}
            {booking.startTime && booking.endTime && (
              <span className="rf-chipmeta">{formatTimeRange12(booking.startTime, booking.endTime)}</span>
            )}
          </div>
        </div>
      </div>
      <ReviewForm bookingId={booking._id} onSubmitted={() => onRated(booking._id)} variant="bare" />
    </article>
  );
};

const PendingCookRatings = () => {
  const user = useSelector((s) => s.auth.user);
  const [bookings, setBookings] = useState([]);
  const [dismissed, setDismissed] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(DISMISSED_RATINGS_KEY) || "[]");
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    if (!user || user.role !== "customer") return;
    let cancelled = false;
    API.get("/bookings/my")
      .then((res) => {
        if (!cancelled) setBookings(Array.isArray(res.data) ? res.data : []);
      })
      .catch(() => {
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user || user.role !== "customer") return null;

  const persistDismissed = (ids) => {
    const capped = [...new Set(ids)].slice(-100);
    setDismissed(capped);
    try {
      localStorage.setItem(DISMISSED_RATINGS_KEY, JSON.stringify(capped));
    } catch {
    }
  };

  const rateable = (bookings || []).filter(
    (b) => !b.review && !dismissed.includes(b._id) && isReviewable(b)
  );

  const handleDismissOne = (id) => {
    if (dismissed.includes(id)) return;
    persistDismissed([...dismissed, id]);
  };

  const handleDismissAll = () => {
    persistDismissed([...new Set([...dismissed, ...rateable.map((b) => b._id)])]);
  };

  const handleRated = (id) => {
    setBookings((prev) => prev.filter((b) => b._id !== id));
  };

  if (rateable.length === 0) return null;

  return (
    <section aria-label="Rate your cook" className="hrc-section">
      <span className="hrc-glow hrc-glow-a" aria-hidden="true" />
      <span className="hrc-glow hrc-glow-b" aria-hidden="true" />
      <div className="hrc-head">
        <div>
          <p className="hrc-eyebrow">
            <Star size={13} /> Your feedback matters
          </p>
          <h2 className="hrc-title">
            Rate your cook <span className="hrc-count">{rateable.length}</span>
          </h2>
          <p className="hrc-sub">
            Your service hours are complete — tap the stars to rate. A written review is optional.
          </p>
        </div>
        <button
          type="button"
          onClick={handleDismissAll}
          className="hrc-dismiss"
          aria-label="Dismiss all rating prompts"
          title="Dismiss all"
        >
          <X size={15} /> Dismiss all
        </button>
      </div>
      <div className="hrc-grid">
        {rateable.map((b) => (
          <PendingRatingCard key={b._id} booking={b} onRated={handleRated} onDismiss={handleDismissOne} />
        ))}
      </div>
    </section>
  );
};

const STAT_MINIMUMS = { bookings: 20, ratings: 5 };

const HeroStats = () => {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let cancelled = false;
    API.get("/stats/public")
      .then((res) => {
        if (!cancelled) setStats(res.data || null);
      })
      .catch(() => {
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const showBookings = (stats?.bookings ?? 0) >= STAT_MINIMUMS.bookings;
  const showRating =
    (stats?.ratingCount ?? 0) >= STAT_MINIMUMS.ratings && stats?.ratingAverage != null;

  if (!showBookings && !showRating) {
    return null;
  }

  return (
    <div className="hero-v2-stats">
      {showBookings && (
        <>
          <div className="hero-v2-stat">
            <div className="hero-v2-stat-num"><CountUp to={stats.bookings} suffix="+" /></div>
            <div className="hero-v2-stat-label">Sessions Completed</div>
          </div>
          <div className="hero-v2-stat-sep" />
        </>
      )}
      {showRating && (
        <div className="hero-v2-stat">
          <div className="hero-v2-stat-num"><CountUp to={stats.ratingAverage} decimals={1} suffix=" ★" /></div>
          <div className="hero-v2-stat-label">Average Rating</div>
        </div>
      )}
    </div>
  );
};

const Home = () => {
  const user = useSelector((s) => s.auth.user);

  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08 }
    );
    const sections = document.querySelectorAll(".home-container section");
    sections.forEach((el) => {
      el.classList.add("reveal");
      io.observe(el);
    });
    return () => io.disconnect();
  }, []);

  const testimonials = [
    {
      name: "Ananya Deshpande",
      role: "Host, Diwali Celebration in Pune",
      quote: "Priya ji made the crunchiest Chaklis and melt-in-mouth Karanjis for our Diwali party. Our guests could not stop praising the taste!",
      rating: 5,
      avatar: "AD",
    },
    {
      name: "Vikram Kulkarni",
      role: "Diwali Faral Party in Pune",
      quote: "Our cook made crisp chakli, flaky karanji and rich kaju katli for our Diwali get-together. Everything tasted just like home — and my kitchen stayed spotless!",
      rating: 5,
      avatar: "VK",
    },
    {
      name: "Rohit & Meera Sen",
      role: "Diwali Feast Host",
      quote: "Booking a cook for our Diwali dinner was the best decision. Dal makhani, paneer butter masala and warm gulab jamun arrived fresh — the whole family was impressed!",
      rating: 5,
      avatar: "RS",
    },
  ];

  return (
    <div className="home-container">
      <DishCarousel />
      <PendingCookRatings />
      <section className="hero-v2">
        <div className="hero-v2-glow hero-v2-glow-1" aria-hidden="true" />
        <div className="hero-v2-glow hero-v2-glow-2" aria-hidden="true" />
        <div className="hero-v2-glow hero-v2-glow-3" aria-hidden="true" />

        <div className="hero-toran" aria-hidden="true">
          {["🌼", "🏵️", "🌿", "🌼", "🏵️", "🌿", "🌼", "🏵️", "🌿", "🌼", "🏵️", "🌿", "🌼", "🏵️", "🌿", "🌼"].map((f, i) => (
            <span key={i} className="hero-toran-flower" style={{ animationDelay: `${(i % 8) * 0.25}s` }}>
              {f}
            </span>
          ))}
        </div>

        <div className="hero-v2-inner">
          <div className="hero-v2-left">
            {/* Phone-only entry point (hidden ≥641px — see responsive.css). */}
            <span className="hero-v2-eyebrow hero-enter" style={{ "--d": "0.1s" }}>
              <Sparkles size={13} /> Diwali Special · Faral, Sweets &amp; Feasts
            </span>
            <h1 className="hero-v2-title hero-enter" style={{ "--d": "0.15s" }}>
              Diwali Feasts, <span className="hero-v2-accent">Cooked Fresh</span> in Your Kitchen
            </h1>
            <p className="hero-v2-sub hero-enter" style={{ "--d": "0.25s" }}>
              Celebrate Diwali with chakli, karanji, kaju katli &amp; a full
              festive spread — cooked fresh in your kitchen by verified home
              cooks. Your first booking is free, with OTP-verified starts,
              secure UPI payments and real-time alerts.
            </p>

            <div className="hero-v2-actions hero-enter" style={{ "--d": "0.35s" }}>
              {user?.role === "admin" ? (
                <Link to="/admin" className="btn btn-lg hero-v2-btn-primary">
                  Go to Admin Dashboard <ArrowRight size={18} />
                </Link>
              ) : user?.role === "cook" ? (
                <Link to="/dashboard/cook-bookings" className="btn btn-lg hero-v2-btn-primary">
                  Go to Cook Dashboard <ArrowRight size={18} />
                </Link>
              ) : (
                <>
                  <Link to="/cook-on-demand" className="btn btn-lg hero-v2-btn-primary">
                    <ChefHat size={18} /> Book a Diwali Cook <ArrowRight size={18} />
                  </Link>
                </>
              )}
            </div>

            <div className="hero-v2-perks hero-enter" style={{ "--d": "0.55s" }}>
              {["100% Verified Cooks", "OTP-Verified Start", "Secure UPI"].map((p) => (
                <span key={p}>
                  <CheckCircle2 size={14} /> {p}
                </span>
              ))}
            </div>
          </div>

          <div className="hero-v2-right hero-enter" style={{ "--d": "0.3s" }}>
            <div className="hero-v2-cook-wrap">
              <img
                src={heroImg}
                alt="Diwali Indian feast with traditional dishes and sweets"
                className="hero-v2-cook-img"
                loading="eager"
              />
            </div>
            <div className="hero-diyas" aria-hidden="true">
              <span>🪔</span>
              <span className="hero-diya-big">🪔</span>
              <span>🪔</span>
            </div>

            <div className="hero-v2-float hero-v2-float-rating">
              <div className="hero-v2-float-stars">
                {[...Array(5)].map((_, i) => (
                  <Star key={i} size={12} fill="#fbbf24" color="#fbbf24" />
                ))}
              </div>
              <span className="hero-v2-float-num">4.9</span>
              <span className="hero-v2-float-label">2,400+ reviews</span>
            </div>

            <div className="hero-v2-float hero-v2-float-live">
              <span className="hero-v2-float-live-dot" />
              <div>
                <div className="hero-v2-float-live-title">Cook Arrived</div>
                <div className="hero-v2-float-live-sub">OTP-verified start</div>
              </div>
            </div>
          </div>
        </div>

        <HeroStats />
      </section>

      <div className="dish-marquee" aria-hidden="true">
        <div className="dish-marquee-track">
          {[0, 1].map((half) => (
            <div key={half} style={{ display: "flex" }} aria-hidden={half === 1}>
              {TICKER_DISHES.map((dish) => (
                <span key={dish} className="mq-item">
                  {dish} <i>•</i>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <HomeCoupons />

      {!user && (
        <section className="lead-section">
          <div className="lead-grid">
            <div className="lead-copy">
              <span className="section-eyebrow">Join Cook Mitra</span>
              <h2 className="section-title" style={{ textAlign: "left" }}>
                Create Your Account
              </h2>
              <p className="section-description" style={{ textAlign: "left", margin: "0 0 1.5rem" }}>
                Sign up to book verified home cooks, manage your reservations,
                and bring the true taste of Diwali to your home.
              </p>
              <ul className="lead-benefits">
                <li><CheckCircle2 size={16} /> Book verified cooks in your area</li>
                <li><CheckCircle2 size={16} /> Manage bookings and track live</li>
                <li><CheckCircle2 size={16} /> Rate and review your experience</li>
              </ul>
            </div>
            <div className="lead-form-card home-registration-form">
              <Register />
            </div>
          </div>
        </section>
      )}

      <section className="home-band band-slate">
        <div className="section-header">
          <span className="section-eyebrow">Simple & Transparent</span>
          <h2 className="section-title">How Cook Mitra Works</h2>
          <p className="section-description">
            Bring the joy of Diwali cooking home in four simple steps.
          </p>
        </div>

        <div className="how-it-works-grid">
          {HOW_STEPS.map(({ step, Icon, title, text }) => (
            <div className="how-card" key={step}>
              <span className="how-ghost" aria-hidden="true">
                {step}
              </span>
              <span className="how-icon-box">
                <Icon size={21} strokeWidth={2.2} />
              </span>
              <span className="how-step-label">Step {step}</span>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="testimonials-section home-band band-abyss">
        <div className="section-header">
          <span className="section-eyebrow">Customer Stories</span>
          <h2 className="section-title">Loved by Diwali Hosts</h2>
          <p className="section-description">
            Read how Cook Mitra brought the light and warmth of Diwali into modern homes.
          </p>
        </div>

        <div className="testimonials-grid">
          {testimonials.map((t, idx) => (
            <div key={idx} className="testimonial-card">
              <div>
                <div className="testimonial-stars">
                  {[...Array(t.rating)].map((_, i) => (
                    <Star key={i} size={18} fill="#f59e0b" />
                  ))}
                </div>
                <p className="testimonial-quote">"{t.quote}"</p>
              </div>
              <div className="testimonial-author">
                <div className="testimonial-avatar">{t.avatar}</div>
                <div className="testimonial-info">
                  <h4>{t.name}</h4>
                  <p>{t.role}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {user?.role !== "cook" && user?.role !== "admin" && (
        <div className="cta-cook-wrap">
        <section className="cta-banner cta-cook">
          <div className="cta-cook-glow cta-cook-glow-1" aria-hidden="true" />
          <div className="cta-cook-glow cta-cook-glow-2" aria-hidden="true" />
          <div className="cta-cook-pattern" aria-hidden="true" />
          <div className="cta-cook-grid">
            <div className="cta-cook-copy">
              <span className="cta-cook-badge">
                <ChefHat size={14} /> For Home Chefs · Earn This Diwali
              </span>
              <h2>Are You a Skilled Home Cook?</h2>
              <p className="cta-cook-sub">
                Turn your family recipes into Diwali earnings. Share your traditional
                faral and Diwali sweets with families in your city — on flexible
                slots, with a verified profile.
              </p>
              <ul className="cta-cook-perks">
                <li>
                  <span className="cta-cook-perk-icon"><ChefHat size={17} /></span>
                  <span><strong>Share recipes</strong><em>Diwali faral &amp; sweets</em></span>
                </li>
                <li>
                  <span className="cta-cook-perk-icon"><CalendarClock size={17} /></span>
                  <span><strong>Flexible slots</strong><em>You choose timings</em></span>
                </li>
                <li>
                  <span className="cta-cook-perk-icon"><ShieldCheck size={17} /></span>
                  <span><strong>Verified profile</strong><em>Build trust & reviews</em></span>
                </li>
              </ul>
              <div className="cta-cook-actions">
                <Link to="/register?role=cook" className="btn btn-lg cta-cook-btn-primary">
                  <ChefHat size={18} /> {user ? "Join as a Cook" : "Register as a Cook"} <ArrowRight size={18} />
                </Link>
                {!user && (
                  <Link to="/login" className="btn btn-lg cta-cook-btn-ghost">
                    Already a cook? Sign in
                  </Link>
                )}
              </div>
              <p className="cta-cook-note">No joining fee · Diwali demand in Pune</p>
            </div>
          </div>
        </section>
        </div>
      )}
    </div>
  );
};

export default Home;

