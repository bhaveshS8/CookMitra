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
  X,
} from "lucide-react";

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

const TICKER_DISHES = [
  "Modak",
  "Puran Poli",
  "Chakli",
  "Karanji",
  "Masala Dosa",
  "Samosa",
  "Gulab Jamun",
  "Ladoo",
  "Shankarpali",
  "Sabudana Khichdi",
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
      role: "Ganesh Festival in Pune",
      quote: "Booking a cook for Modaks was the best decision we made. We learned the traditional pleating technique and enjoyed fresh steamed Ukadiche Modak.",
      rating: 5,
      avatar: "VK",
    },
    {
      name: "Rohit & Meera Sen",
      role: "Navratri Feast Host",
      quote: "Finding an experienced fasting food specialist in minutes was magical. The Sabudana Khichdi and fruit salads were extraordinary!",
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
            <h1 className="hero-v2-title hero-enter" style={{ "--d": "0.15s" }}>
              Festive Feasts, <span className="hero-v2-accent">Cooked Fresh</span> in Your Kitchen
            </h1>
            <p className="hero-v2-sub hero-enter" style={{ "--d": "0.25s" }}>
              Celebrate Navratri with vrat-friendly feasts — sabudana khichdi,
              kuttu parathas, samak rice & more — cooked fresh in your kitchen
              by verified home cooks. OTP-verified starts, secure UPI payments,
              and real-time alerts.
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
                    <ChefHat size={18} /> Book a Cook <ArrowRight size={18} />
                  </Link>
                </>
              )}
            </div>

            <div className="hero-v2-proof hero-enter" style={{ "--d": "0.45s" }}>
              <div className="hero-v2-avatars">
                <span>AD</span><span>VK</span><span>RS</span>
                <span className="hero-v2-avatars-more">+2k</span>
              </div>
              <div className="hero-v2-rating">
                <div className="hero-v2-stars">
                  {[...Array(5)].map((_, i) => (
                    <Star key={i} size={14} fill="#fbbf24" color="#fbbf24" />
                  ))}
                </div>
                <span className="hero-v2-rating-num">4.9</span>
              </div>
              <span className="hero-v2-proof-text">
                Loved by <strong>2,400+ families</strong>
              </span>
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
                alt="Festive Indian feast with traditional dishes and sweets"
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
                Sign up to book verified festive cooks, manage your reservations,
                and bring authentic festival flavors to your home.
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
            Bring the joy of authentic festive cooking to your home in four simple steps.
          </p>
        </div>

        <div className="how-it-works-grid">
          <div className="how-card">
            <div className="how-card-header">
              <div className="how-icon-box">
                <Compass size={26} />
              </div>
              <span className="how-step-badge">01</span>
            </div>
            <h3>1. Share Requirements</h3>
            <p>Pick a service, date, dishes and location — tell us what you need for your gathering.</p>
          </div>

          <div className="how-card">
            <div className="how-card-header">
              <div className="how-icon-box">
                <UserCheck size={26} />
              </div>
              <span className="how-step-badge">02</span>
            </div>
            <h3>2. Pick Cook & Slot</h3>
            <p>See verified cooks free on your date with their open time slots — tap one to send your booking request.</p>
          </div>

          <div className="how-card">
            <div className="how-card-header">
              <div className="how-icon-box">
                <CalendarCheck size={26} />
              </div>
              <span className="how-step-badge">03</span>
            </div>
            <h3>3. OTP-Verified Start</h3>
            <p>Cook arrives at your home, you share the OTP — session starts securely with live tracking and UPI payment after approval.</p>
          </div>

          <div className="how-card">
            <div className="how-card-header">
              <div className="how-icon-box">
                <Award size={26} />
              </div>
              <span className="how-step-badge">04</span>
            </div>
            <h3>4. Savor & Review</h3>
            <p>Enjoy delicious authentic flavors with your family, then share your review and experience with the community.</p>
          </div>
        </div>
      </section>

      <section className="testimonials-section home-band band-abyss">
        <div className="section-header">
          <span className="section-eyebrow">Customer Stories</span>
          <h2 className="section-title">Loved by Festival Hosts</h2>
          <p className="section-description">
            Read how Cook Mitra brought authentic celebrations into modern homes.
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
                <ChefHat size={14} /> For Home Chefs · Earn Festive Income
              </span>
              <h2>Are You a Skilled Home Cook?</h2>
              <p className="cta-cook-sub">
                Turn your family recipes into festive earnings. Share your traditional
                culinary recipes and cooking skills with families in your city —
                on flexible slots, with a verified profile.
              </p>
              <ul className="cta-cook-perks">
                <li>
                  <span className="cta-cook-perk-icon"><ChefHat size={17} /></span>
                  <span><strong>Share recipes</strong><em>Traditional festive dishes</em></span>
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
              <p className="cta-cook-note">No joining fee · Festive demand in Pune</p>
            </div>
          </div>
        </section>
        </div>
      )}
    </div>
  );
};

export default Home;

