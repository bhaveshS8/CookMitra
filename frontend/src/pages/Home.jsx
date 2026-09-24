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
  Users,
  GraduationCap,
  HandHelping,
  Star,
  CheckCircle2,
  CalendarCheck,
  Compass,
  UserCheck,
  Award,
  ShieldCheck,
  X,
} from "lucide-react";

// Animated number that counts up when scrolled into view.
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

// One rateable booking card: cook info + star rating (comment optional) +
// per-card cross button to dismiss. Disappears once the rating is submitted.
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

// Home section: after service hours end, prompt the customer to rate each
// unrated cook. Hidden for guests/cooks/admins, after rating (review exists),
// or after the user taps the cross button (dismiss persisted in localStorage).
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
        // silent: rating prompt is optional, must never break Home
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user || user.role !== "customer") return null;

  const persistDismissed = (ids) => {
    // Cap the list so it can't grow unbounded in localStorage.
    const capped = [...new Set(ids)].slice(-100);
    setDismissed(capped);
    try {
      localStorage.setItem(DISMISSED_RATINGS_KEY, JSON.stringify(capped));
    } catch {
      // storage optional
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
    // Drop the card immediately; the saved review also excludes it on refetch.
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

// Homepage trust stats — live from GET /api/stats/public (see backend
// routes/stats.js). Hardcoded marketing numbers are a CCPA 2022
// misleading-ad exposure for a payment merchant, so the hero only renders a
// stat once it is meaningful, and falls back to honest "growing" copy.
const STAT_MINIMUMS = { cooks: 5, bookings: 20, ratings: 5 };

const HeroStats = () => {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let cancelled = false;
    API.get("/stats/public")
      .then((res) => {
        if (!cancelled) setStats(res.data || null);
      })
      .catch(() => {
        // Stats are decorative — the hero must render without them.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const showCooks = (stats?.cooks ?? 0) >= STAT_MINIMUMS.cooks;
  const showBookings = (stats?.bookings ?? 0) >= STAT_MINIMUMS.bookings;
  const showRating =
    (stats?.ratingCount ?? 0) >= STAT_MINIMUMS.ratings && stats?.ratingAverage != null;

  // Pre-launch: nothing is meaningful yet — render nothing instead of
  // placeholder stats.
  if (!showCooks && !showBookings && !showRating) {
    return null;
  }

  return (
    <div className="hero-v2-stats">
      {showCooks && (
        <>
          <div className="hero-v2-stat">
            <div className="hero-v2-stat-num"><CountUp to={stats.cooks} suffix="+" /></div>
            <div className="hero-v2-stat-label">Verified Cooks</div>
          </div>
          <div className="hero-v2-stat-sep" />
        </>
      )}
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

  // Scroll-reveal for page sections (adds .visible as they enter view).
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

  const services = [
    {
      id: "cook_for_me",
      title: "Cook for Me",
      tagline: "Most Popular",
      description: "Host effortlessly while a skilled chef prepares authentic festival meals right in your home kitchen.",
      icon: <ChefHat size={24} />,
      bg: "linear-gradient(135deg, #fff7ed, #ffedd5)",
      color: "#c2410c",
      accent: "linear-gradient(135deg, #f59e0b, #ea580c)",
      perks: ["Full meal prep & plating", "Traditional authentic spices", "Kitchen left clean & tidy"],
    },
    {
      id: "cook_with_me",
      title: "Cook With Me",
      tagline: "Family Favourite",
      description: "Team up with an experienced home chef to knead, fry, shape, and cook festive snacks together.",
      icon: <Users size={24} />,
      bg: "linear-gradient(135deg, #ecfdf5, #d1fae5)",
      color: "#047857",
      accent: "linear-gradient(135deg, #10b981, #047857)",
      perks: ["Hands-on partnership", "Great for family bonding", "Share traditional recipes"],
    },
    {
      id: "teach_me",
      title: "Teach Me",
      tagline: "Learn Heritage",
      description: "Master intricate culinary techniques like one-string sugar syrup, chakli spiral shaping, and modak pleating.",
      icon: <GraduationCap size={24} />,
      bg: "linear-gradient(135deg, #eff6ff, #dbeafe)",
      color: "#1d4ed8",
      accent: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
      perks: ["Step-by-step guidance", "Troubleshooting tips", "Heritage secret ratios"],
    },
    {
      id: "preparation_help",
      title: "Preparation Help",
      tagline: "Save Hours",
      description: "Get reliable helping hands for labor-intensive tasks like grating coconut, chopping, kneading, and deep-frying.",
      icon: <HandHelping size={24} />,
      bg: "linear-gradient(135deg, #f5f3ff, #ede9fe)",
      color: "#6d28d9",
      accent: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
      perks: ["Saves hours of prep time", "Ideal for large gatherings", "Focused prep assistance"],
    },
  ];

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
      {/* Sweets & festive dishes carousel, right below the navbar */}
      <DishCarousel />
      {/* Pending cook ratings: after service hours end, unrated customers rate here */}
      <PendingCookRatings />
      {/* Hero Section */}
      <section className="hero-v2">
        <div className="hero-v2-glow hero-v2-glow-1" aria-hidden="true" />
        <div className="hero-v2-glow hero-v2-glow-2" aria-hidden="true" />
        <div className="hero-v2-glow hero-v2-glow-3" aria-hidden="true" />

        {/* Festive toran garland */}
        <div className="hero-toran" aria-hidden="true">
          {["🌼", "🏵️", "🌿", "🌼", "🏵️", "🌿", "🌼", "🏵️", "🌿", "🌼", "🏵️", "🌿", "🌼", "🏵️", "🌿", "🌼"].map((f, i) => (
            <span key={i} className="hero-toran-flower" style={{ animationDelay: `${(i % 8) * 0.25}s` }}>
              {f}
            </span>
          ))}
        </div>

        <div className="hero-v2-inner">
          <div className="hero-v2-left">
            <p className="hero-devotional hero-enter" style={{ "--d": "0.1s" }}>
              ॥ गणपती बाप्पा मोरया ॥
            </p>
            <h1 className="hero-v2-title hero-enter" style={{ "--d": "0.15s" }}>
              Festive Feasts, <span className="hero-v2-accent">Cooked Fresh</span> in Your Kitchen
            </h1>
            <p className="hero-v2-sub hero-enter" style={{ "--d": "0.25s" }}>
              Welcome Bappa home with ukadiche modak, puran poli, chakli & more —
              cooked fresh in your kitchen by verified home cooks. OTP-verified
              starts, secure UPI payments, and real-time alerts.
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
                  <a href="#services" className="btn btn-lg hero-v2-btn-ghost">
                    Explore Services ↓
                  </a>
                </>
              )}
            </div>

            {/* Single social-proof row: avatars + rating + happy families */}
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

      {/* Scrolling dishes ticker */}
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

      {/* Live festive offers — admin-managed coupons from /api/coupons/active */}
      <HomeCoupons />

      {/* User Registration — guests only; logged-in customers,
           cooks and admins already have accounts */}
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

      {/* How It Works Section */}
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

      {/* Services Showcase */}
      <section className="services-section" id="services">
        <div className="section-header">
          <span className="section-eyebrow">Tailored For Your Occasion</span>
          <h2 className="section-title">Flexible Cooking Services</h2>
          <p className="section-description">
            Whether you need hands-off catering or a private masterclass, our verified cooks adapt to your preferences.
          </p>
        </div>

        <div className="services-grid-modern">
          {services.map((svc) => (
            <article key={svc.id} className="service-card-modern">
              <span className="service-accent-bar" style={{ background: svc.accent }} aria-hidden="true" />
              <div className="service-card-top">
                <div
                  className="service-icon-wrapper"
                  style={{ background: svc.bg, color: svc.color }}
                >
                  {svc.icon}
                </div>
                <span className="service-tagline" style={{ color: svc.color, background: svc.bg }}>
                  {svc.tagline}
                </span>
              </div>
              <h3>{svc.title}</h3>
              <p className="service-desc">{svc.description}</p>
              <ul className="service-card-perks">
                {svc.perks.map((perk, i) => (
                  <li key={i}>
                    <CheckCircle2 size={16} style={{ color: svc.color }} /> {perk}
                  </li>
                ))}
              </ul>
              <Link
                to={`/cook-on-demand?serviceType=${svc.id}`}
                className="service-learn-more"
                style={{ color: svc.color }}
                aria-label={`Book now - ${svc.title}`}
              >
                <span>Book now</span>
                <ArrowRight size={15} />
              </Link>
            </article>
          ))}
        </div>
      </section>

      {/* Customer Testimonials */}
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

      {/* Call to Action Banner — invite home chefs to earn. Shown to guests
          and customers; hidden for cooks/admins who already have those roles.
          Deep-links to /register?role=cook so the Register page preselects
          the "Join as Cook" tab instead of defaulting to customer. */}
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



