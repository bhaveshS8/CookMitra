import { useState, useEffect, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useSelector } from "react-redux";
import {
  Cake,
  Heart,
  Users,
  Sparkles,
  CalendarDays,
  CalendarCheck,
  ChefHat,
  UtensilsCrossed,
  Clock3,
  MapPin,
  BadgeIndianRupee,
  ArrowRight,
  ArrowLeft,
  Minus,
  Plus,
  Check,
  CheckCircle2,
  ShieldCheck,
  PartyPopper,
} from "lucide-react";
import API from "../api/axios";
import { localTodayStr, localTomorrowStr, formatDate } from "../utils/constants";
import {
  formatCurrency,
  EVENT_TYPE_FALLBACK,
  EVENT_SERVICES,
  EVENT_FOOD_TYPES,
  EVENT_SERVICE_LABEL,
  previewEventPrice,
} from "../utils/eventConstants";
import { useShowToast } from "../store/hooks";
import LoginPromptModal from "../components/LoginPromptModal";

const EVENT_ICONS = {
  cake: <Cake size={26} />,
  heart: <Heart size={26} />,
  users: <Users size={26} />,
  sparkles: <Sparkles size={26} />,
  calendar: <CalendarDays size={26} />,
};

const eventIcon = (icon) => EVENT_ICONS[String(icon || "").toLowerCase()] || <PartyPopper size={26} />;

const STEPS = [
  { label: "Event", desc: "What are you celebrating?" },
  { label: "Details", desc: "Date, guests & menu" },
  { label: "Service", desc: "Service & hours" },
  { label: "Location", desc: "Where & how far" },
  { label: "Price", desc: "Review & request" },
];

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const EventBooking = () => {
  const user = useSelector((s) => s.auth.user);
  const showToast = useShowToast();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [eventTypes, setEventTypes] = useState(EVENT_TYPE_FALLBACK);
  const [pricing, setPricing] = useState(null);
  const [form, setForm] = useState({
    eventType: "",
    eventDate: localTomorrowStr(),
    startTime: "18:00",
    guestCount: "20",
    foodType: "Full Meal",
    menu: "",
    serviceType: "preparation_cooking",
    duration: "4",
    additionalCook: "0",
    extraHours: "0",
    address: "",
    area: "",
    landmark: "",
    distanceKm: "5",
    customerNotes: "",
  });
  const [formError, setFormError] = useState("");
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step ]);

  // Catalogue + price table (public endpoints — guests can browse).
  useEffect(() => {
    let cancelled = false;
    API.get("/events")
      .then((res) => {
        if (!cancelled && Array.isArray(res.data) && res.data.length > 0) {
          setEventTypes(res.data);
        }
      })
      .catch(() => {
        // fallback catalogue stays
      });
    API.get("/event-pricing")
      .then((res) => {
        if (!cancelled && res.data) setPricing(res.data);
      })
      .catch(() => {
        // preview fallback stays
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (name, value) => setForm((f) => ({ ...f, [name]: value }));

  const adjustNumber = (name, delta, { min, max, step = 1, integer = true }) => {
    setForm((f) => {
      const cur = Number(f[name]);
      const base = Number.isFinite(cur) ? cur : min;
      let next = Math.min(max, Math.max(min, base + delta * step));
      if (integer) next = Math.round(next);
      else next = Math.round(next * 2) / 2;
      return { ...f, [name]: String(next) };
    });
  };

  // Live preview from the (admin-editable) price table.
  const preview = useMemo(
    () =>
      previewEventPrice(pricing, {
        serviceType: form.serviceType,
        duration: Number(form.duration),
        distanceKm: Number(form.distanceKm),
        additionalCook: Number(form.additionalCook),
        extraHours: Number(form.extraHours),
      }),
    [pricing, form.serviceType, form.duration, form.distanceKm, form.additionalCook, form.extraHours]
  );

  const validateDetails = () => {
    if (!form.eventDate) return "Please choose your event date";
    if (form.eventDate < localTodayStr()) return "That date already passed — please pick today or a future date";
    if (!form.startTime) return "Please choose a start time";
    const g = Number(form.guestCount);
    if (!Number.isInteger(g) || g < 1 || g > 1000) return "Guest count must be between 1 and 1000";
    if (!form.menu.trim()) return "Please enter your menu — e.g. Puri, Bhaji, Rice, Dal, Salad and Gulab Jamun";
    return "";
  };

  const validateService = () => {
    const d = Number(form.duration);
    if (!Number.isFinite(d) || d < 1 || d > 8) return "Duration must be between 1 and 8 hours";
    return "";
  };

  const validateLocation = () => {
    if (!form.address.trim()) return "Please enter the event address";
    if (!form.area.trim()) return "Please enter the area (e.g. Hadapsar, Pune)";
    const dist = Number(form.distanceKm);
    if (!Number.isFinite(dist) || dist < 0) return "Please enter the approximate distance in km";
    return "";
  };

  const nextFrom = (validator) => {
    const err = validator ? validator() : "";
    if (err) {
      setFormError(err);
      return;
    }
    setFormError("");
    setStep((s) => Math.min(STEPS.length, s + 1));
  };

  // Step 5 entry: authoritative server quote (§19).
  const loadQuote = async () => {
    setQuoting(true);
    setQuote(null);
    try {
      const res = await API.post("/event-pricing/calculate", {
        serviceType: form.serviceType,
        duration: Number(form.duration),
        distanceKm: Number(form.distanceKm),
        additionalCook: Number(form.additionalCook),
        extraHours: Number(form.extraHours),
      });
      setQuote(res.data);
    } catch (err) {
      // Server unreachable/validation — fall back to the local preview so
      // the customer still sees a price (booking re-validates server-side).
      if (preview) {
        setQuote({ ...preview, previewOnly: true });
      } else {
        setFormError(err.response?.data?.message || "Could not calculate the price. Please check your inputs.");
      }
    } finally {
      setQuoting(false);
    }
  };

  const goToReview = () => {
    const err = validateLocation();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError("");
    setStep(5);
    loadQuote();
  };

  const handleRequestBooking = async () => {
    if (!user) {
      setShowLoginModal(true);
      return;
    }
    if (user.role !== "customer") {
      showToast("Only customer accounts can request event bookings", "error");
      return;
    }
    setSubmitting(true);
    setFormError("");
    try {
      const res = await API.post("/event-bookings", {
        eventType: form.eventType,
        eventDate: form.eventDate,
        startTime: form.startTime,
        duration: Number(form.duration),
        guestCount: Number(form.guestCount),
        address: form.address.trim(),
        area: form.area.trim(),
        landmark: form.landmark.trim(),
        foodType: form.foodType,
        menu: form.menu.trim(),
        serviceType: form.serviceType,
        additionalCook: Number(form.additionalCook),
        extraHours: Number(form.extraHours),
        distanceKm: Number(form.distanceKm),
        customerNotes: form.customerNotes.trim(),
      });
      showToast("Booking request received! CookMitra will assign a suitable cook.", "success");
      navigate(`/event-bookings/${res.data?._id}`);
    } catch (err) {
      setFormError(err.response?.data?.message || "Booking request failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const shownQuote = quote || preview;
  const travelFree = shownQuote && Number(shownQuote.travelCharge) === 0;

  return (
    <div className="ondemand-page od-modern events-page">
      <div className="od-hero">
        <div className="od-hero-text">
          <span className="od-eyebrow">
            <PartyPopper size={12} /> CookMitra Events
          </span>
          <h1 className="od-title">Book an Event Cook</h1>
          <p className="od-sub">
            <ShieldCheck size={13} />
            <span className="od-sub-text">Birthdays · Anniversaries · Family functions — you celebrate, we cook</span>
          </p>
        </div>
        {preview && (
          <div className="od-hero-price" aria-live="polite">
            <span>Estimated</span>
            <strong>{formatCurrency(preview.totalAmount)}</strong>
          </div>
        )}
      </div>

      <ol className="od-steps-modern" aria-label="Event booking progress">
        {STEPS.map((s, i) => {
          const n = i + 1;
          const state = step > n ? "done" : step === n ? "active" : "";
          return (
            <li key={s.label} className={`od-step-item ${state}`} aria-current={step === n ? "step" : undefined}>
              <span className="od-step-num" aria-hidden="true">
                {step > n ? <Check size={13} /> : n}
              </span>
              <span className="od-step-text">
                <span className="od-step-name">{s.label}</span>
                <span className="od-step-desc">{s.desc}</span>
              </span>
              {i < STEPS.length - 1 && <span className="od-step-link" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>

      {step > 1 && (
        <div className="od-livebar" aria-live="polite">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setStep((s) => s - 1)}>
            <ArrowLeft size={15} /> Go Back
          </button>
          {form.eventType && <span className="od-livechip">{form.eventType}</span>}
          <span className="od-livechip">{form.eventDate || "Pick a date"}</span>
          <span className="od-livechip">
            {EVENT_SERVICE_LABEL(form.serviceType)} · {form.duration || "–"} hr
          </span>
          {preview && <span className="od-livechip od-livechip-price">{formatCurrency(preview.totalAmount)}</span>}
        </div>
      )}

      {/* STEP 1 — Select event */}
      {step === 1 && (
        <div className="ondemand-form-card">
          <h3>Step 1 — What are you celebrating?</h3>
          <p className="ondemand-form-sub">Pick your occasion — CookMitra assigns a suitable cook for you.</p>
          <div className="service-pick-grid">
            {eventTypes.map((t) => {
              const name = t.name || t;
              const active = form.eventType === name;
              return (
                <button
                  type="button"
                  key={t._id || name}
                  className={`service-pick-card ${active ? "selected" : ""}`}
                  onClick={() => {
                    set("eventType", name);
                    setFormError("");
                  }}
                >
                  <span className="service-pick-check" aria-hidden="true">
                    {active && <CheckCircle2 size={18} />}
                  </span>
                  <span className="service-pick-icon">{eventIcon(t.icon)}</span>
                  <strong>{name}</strong>
                  <span>{t.description || "Home event"}</span>
                </button>
              );
            })}
          </div>
          {formError && <div className="error-message">{formError}</div>}
          <div className="od-stickybar">
            <button
              type="button"
              className="btn btn-primary btn-block btn-lg od-cta"
              onClick={() => {
                if (!form.eventType) {
                  setFormError("Please select your event type");
                  return;
                }
                setFormError("");
                setStep(2);
              }}
            >
              Continue <ArrowRight size={17} />
            </button>
          </div>
        </div>
      )}

      {/* STEP 2 — Event details */}
      {step === 2 && (
        <div className="ondemand-form-card">
          <h3>Step 2 — Event details</h3>
          <div className="form-row">
            <div className="form-group">
              <label>
                <CalendarCheck size={15} /> Event Date *
              </label>
              <input
                type="date"
                className="form-control"
                value={form.eventDate}
                min={localTodayStr()}
                onChange={(e) => set("eventDate", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>
                <Clock3 size={15} /> Start Time *
              </label>
              <input
                type="time"
                className="form-control"
                value={form.startTime}
                onChange={(e) => set("startTime", e.target.value)}
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>
                <Users size={15} /> Number of Guests *
              </label>
              <div className="od-stepper">
                <button type="button" className="od-step-btn" aria-label="Fewer guests" onClick={() => adjustNumber("guestCount", -1, { min: 1, max: 1000 })}>
                  <Minus size={16} />
                </button>
                <input
                  type="text"
                  inputMode="numeric"
                  className="form-control"
                  value={form.guestCount}
                  onChange={(e) => set("guestCount", e.target.value)}
                  aria-label="Number of guests"
                />
                <button type="button" className="od-step-btn" aria-label="More guests" onClick={() => adjustNumber("guestCount", 1, { min: 1, max: 1000 })}>
                  <Plus size={16} />
                </button>
              </div>
            </div>
            <div className="form-group">
              <label>
                <UtensilsCrossed size={15} /> Food Type *
              </label>
              <select className="form-control" value={form.foodType} onChange={(e) => set("foodType", e.target.value)}>
                {EVENT_FOOD_TYPES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>
              <UtensilsCrossed size={15} /> Menu — dishes you need *
            </label>
            <textarea
              className="form-control"
              rows={3}
              placeholder="e.g. Puri, Bhaji, Rice, Dal, Salad and Gulab Jamun"
              value={form.menu}
              onChange={(e) => set("menu", e.target.value)}
            />
          </div>
          {formError && <div className="error-message">{formError}</div>}
          <div className="od-stickybar">
            <button type="button" className="btn btn-primary btn-block btn-lg od-cta" onClick={() => nextFrom(validateDetails)}>
              Continue <ArrowRight size={17} />
            </button>
          </div>
        </div>
      )}

      {/* STEP 3 — Service & hours */}
      {step === 3 && (
        <div className="ondemand-form-card">
          <h3>Step 3 — Service & hours</h3>
          <p className="ondemand-form-sub">Three simple services — price depends on hours.</p>
          <div className="service-pick-grid">
            {EVENT_SERVICES.map((s) => (
              <button
                type="button"
                key={s.id}
                className={`service-pick-card ${form.serviceType === s.id ? "selected" : ""}`}
                onClick={() => set("serviceType", s.id)}
              >
                <span className="service-pick-check" aria-hidden="true">
                  {form.serviceType === s.id && <CheckCircle2 size={18} />}
                </span>
                <span className="service-pick-icon">
                  <ChefHat size={24} />
                </span>
                <strong>{s.label}</strong>
                <span>{s.desc}</span>
              </button>
            ))}
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>
                <Clock3 size={15} /> Service Hours (1–8) *
              </label>
              <div className="od-stepper">
                <button type="button" className="od-step-btn" aria-label="Fewer hours" onClick={() => adjustNumber("duration", -1, { min: 1, max: 8 })}>
                  <Minus size={16} />
                </button>
                <input
                  type="text"
                  inputMode="numeric"
                  className="form-control"
                  value={form.duration}
                  onChange={(e) => set("duration", e.target.value)}
                  aria-label="Service hours"
                />
                <button type="button" className="od-step-btn" aria-label="More hours" onClick={() => adjustNumber("duration", 1, { min: 1, max: 8 })}>
                  <Plus size={16} />
                </button>
              </div>
            </div>
            <div className="form-group">
              <label>
                <Users size={15} /> Additional Cooks (₹{pricing?.additionalCookPrice ?? 400} each)
              </label>
              <div className="od-stepper">
                <button type="button" className="od-step-btn" aria-label="Fewer cooks" onClick={() => adjustNumber("additionalCook", -1, { min: 0, max: 10 })}>
                  <Minus size={16} />
                </button>
                <input
                  type="text"
                  inputMode="numeric"
                  className="form-control"
                  value={form.additionalCook}
                  onChange={(e) => set("additionalCook", e.target.value)}
                  aria-label="Additional cooks"
                />
                <button type="button" className="od-step-btn" aria-label="More cooks" onClick={() => adjustNumber("additionalCook", 1, { min: 0, max: 10 })}>
                  <Plus size={16} />
                </button>
              </div>
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>
                <Clock3 size={15} /> Extra Hours (beyond the slot above)
              </label>
              <div className="od-stepper">
                <button type="button" className="od-step-btn" aria-label="Fewer extra hours" onClick={() => adjustNumber("extraHours", -1, { min: 0, max: 12 })}>
                  <Minus size={16} />
                </button>
                <input
                  type="text"
                  inputMode="numeric"
                  className="form-control"
                  value={form.extraHours}
                  onChange={(e) => set("extraHours", e.target.value)}
                  aria-label="Extra hours"
                />
                <button type="button" className="od-step-btn" aria-label="More extra hours" onClick={() => adjustNumber("extraHours", 1, { min: 0, max: 12 })}>
                  <Plus size={16} />
                </button>
              </div>
            </div>
          </div>
          {formError && <div className="error-message">{formError}</div>}
          <div className="od-stickybar">
            <div className="od-summary" aria-live="polite">
              <span>{EVENT_SERVICE_LABEL(form.serviceType)}</span>
              <span>{form.duration || "–"} hr</span>
              <strong className="od-summary-price">{preview ? formatCurrency(preview.totalAmount) : "—"}</strong>
            </div>
            <button type="button" className="btn btn-primary btn-block btn-lg od-cta" onClick={() => nextFrom(validateService)}>
              Continue <ArrowRight size={17} />
            </button>
          </div>
        </div>
      )}

      {/* STEP 4 — Location */}
      {step === 4 && (
        <div className="ondemand-form-card">
          <h3>Step 4 — Event location</h3>
          <div className="form-group">
            <label>
              <MapPin size={15} /> Full Address *
            </label>
            <input
              type="text"
              className="form-control"
              placeholder="Flat / house no., street, society"
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
            />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>Area *</label>
              <input
                type="text"
                className="form-control"
                placeholder="e.g. Hadapsar, Pune"
                value={form.area}
                onChange={(e) => set("area", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>Landmark</label>
              <input
                type="text"
                className="form-control"
                placeholder="Near…"
                value={form.landmark}
                onChange={(e) => set("landmark", e.target.value)}
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>
                <MapPin size={15} /> Distance from CookMitra hub (km) *
              </label>
              <input
                type="text"
                inputMode="decimal"
                className="form-control"
                placeholder="e.g. 7"
                value={form.distanceKm}
                onChange={(e) => set("distanceKm", e.target.value)}
              />
              <small style={{ color: "var(--slate-500)" }}>
                Travel: 0–3 km FREE · 3–5 km ₹50 · 5–8 km ₹100 · 8–10 km ₹150 · 10–15 km ₹250 · 15–20 km ₹350 · 20+ km ₹450
              </small>
            </div>
            <div className="form-group">
              <label>Special Instructions</label>
              <input
                type="text"
                className="form-control"
                placeholder="Anything the cook should know"
                value={form.customerNotes}
                onChange={(e) => set("customerNotes", e.target.value)}
              />
            </div>
          </div>
          {formError && <div className="error-message">{formError}</div>}
          <div className="od-stickybar">
            <button type="button" className="btn btn-primary btn-block btn-lg od-cta" onClick={goToReview}>
              View Price <ArrowRight size={17} />
            </button>
          </div>
        </div>
      )}

      {/* STEP 5 — Price & request */}
      {step === 5 && (
        <div className="ondemand-form-card">
          <h3>Step 5 — Price breakdown</h3>
          {quoting ? (
            <div className="loading-spinner-wrapper">
              <div className="spinner"></div>
              <p>Calculating your price...</p>
            </div>
          ) : shownQuote ? (
            <>
              <div className="booking-metadata-grid">
                <div className="meta-field">
                  <label>
                    {EVENT_SERVICE_LABEL(form.serviceType)} · {form.duration} hr
                  </label>
                  <span>{formatCurrency(shownQuote.serviceAmount)}</span>
                </div>
                <div className="meta-field">
                  <label>Additional Cook × {clampNum(form.additionalCook, 0, 10, 0)}</label>
                  <span>{formatCurrency(shownQuote.additionalCookAmount)}</span>
                </div>
                <div className="meta-field">
                  <label>Extra Hours × {form.extraHours || 0}</label>
                  <span>{formatCurrency(shownQuote.extraHourAmount)}</span>
                </div>
                <div className="meta-field">
                  <label>Travel · {form.distanceKm || 0} km {travelFree ? "(FREE)" : ""}</label>
                  <span>{formatCurrency(shownQuote.travelCharge)}</span>
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "var(--slate-50)",
                  border: "1px solid var(--slate-200)",
                  borderRadius: "10px",
                  padding: "0.85rem 1rem",
                  marginTop: "1rem",
                }}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", fontWeight: 700 }}>
                  <BadgeIndianRupee size={17} /> Total Amount
                </span>
                <strong style={{ fontSize: "1.4rem", color: "var(--primary)" }}>
                  {formatCurrency(shownQuote.totalAmount)}
                </strong>
              </div>
              <div
                style={{
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  borderRadius: "10px",
                  padding: "0.75rem 1rem",
                  marginTop: "1rem",
                  fontSize: "0.9rem",
                  color: "#92400e",
                }}
              >
                {form.eventType} · {formatDate(form.eventDate)} · {form.startTime} · {form.guestCount} guests
                <br />
                {form.address}, {form.area}
                {form.landmark ? ` (Near ${form.landmark})` : ""}
                <br />
                Menu ({form.foodType}): {form.menu}
              </div>
              {quote?.previewOnly && (
                <p style={{ fontSize: "0.82rem", color: "var(--slate-500)", marginTop: "0.5rem" }}>
                  Showing an estimate — the final price is confirmed server-side when you request.
                </p>
              )}
            </>
          ) : (
            <div className="no-data">
              <p>Could not calculate the price.</p>
              <button type="button" className="btn btn-outline btn-sm" onClick={loadQuote}>
                Retry
              </button>
            </div>
          )}
          {formError && <div className="error-message">{formError}</div>}
          <div className="od-stickybar">
            <button
              type="button"
              className="btn btn-primary btn-block btn-lg od-cta"
              disabled={quoting || submitting || !shownQuote}
              onClick={handleRequestBooking}
            >
              {submitting ? "Sending request..." : (
                <>
                  <CheckCircle2 size={17} /> Request Booking · {shownQuote ? formatCurrency(shownQuote.totalAmount) : ""}
                </>
              )}
            </button>
            <p className="od-sticky-note">
              No cook to choose — CookMitra assigns a suitable verified cook after your request.
            </p>
          </div>
          <p style={{ textAlign: "center", marginTop: "0.75rem", fontSize: "0.88rem" }}>
            <Link to="/dashboard/event-bookings">View my event bookings</Link>
          </p>
        </div>
      )}

      <LoginPromptModal open={showLoginModal} onClose={() => setShowLoginModal(false)} />
    </div>
  );
};

export default EventBooking;
