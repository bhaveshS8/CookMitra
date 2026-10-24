import { useState, useEffect, useMemo } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useSelector, useDispatch } from "react-redux";
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
  LocateFixed,
  AlertCircle,
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
import { useShowToast, useSiteLocation } from "../store/hooks";
import { requestPreciseLocation } from "../store/locationSlice";
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
  { label: "Event", desc: "Pick your occasion" },
  { label: "Details", desc: "Date, guests & menu" },
  { label: "Service", desc: "Service & hours" },
  { label: "Location", desc: "Address & distance" },
  { label: "Price", desc: "Review & request" },
];

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/* Keep numeric steppers / inputs strictly numeric — strips stray chars on paste. */
const onlyDigits = (v, fallback = "") => {
  const s = String(v ?? "");
  const digits = s.replace(/[^0-9]/g, "");
  if (digits === "") return fallback === "" ? "" : String(fallback);
  return String(parseInt(digits, 10));
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
  const dispatch = useDispatch();
  const { location: siteLocation, error: locError, isLocating } = useSiteLocation();
  // Key of the last GPS fix already applied to the form — autofill fills
  // BLANK fields once per fix and never overwrites what the user typed.
  const [locAppliedKey, setLocAppliedKey] = useState(null);

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

  // GPS autofill (suggestion-only): when a fresh site fix arrives, fill
  // BLANK location fields once per fix. Manual typing always wins — applied
  // fixes are keyed so re-renders never clobber user edits, and a denied or
  // failed detection leaves the fields editable with an inline message.
  useEffect(() => {
    if (!siteLocation) return;
    const key = `${siteLocation.lat ?? ""},${siteLocation.lng ?? ""}@${siteLocation.timestamp || siteLocation.savedAt || siteLocation.label || ""}`;
    if (!key || key === locAppliedKey) return;
    setLocAppliedKey(key);
    setForm((f) => {
      const detectedAddress =
        siteLocation.fullAddress || siteLocation.displayName || siteLocation.exactLine || "";
      const detectedArea =
        siteLocation.area ||
        siteLocation.label ||
        [siteLocation.city, siteLocation.state].filter(Boolean).join(", ") ||
        "";
      const detectedLandmark = siteLocation.street || "";
      return {
        ...f,
        address: f.address.trim() ? f.address : detectedAddress,
        area: f.area.trim() ? f.area : detectedArea,
        landmark: f.landmark.trim() ? f.landmark : detectedLandmark,
      };
    });
  }, [siteLocation, locAppliedKey]);

  const handleDetectLocation = () => {
    setFormError("");
    dispatch(requestPreciseLocation({ forceRefine: true }));
  };

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
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(form.startTime)) return "Start time must be HH:MM (24-hour)";
    // Same-day guard (approximate in the browser's local time; the server
    // enforces the same rule strictly in IST and rejects past times there).
    if (form.eventDate === localTodayStr()) {
      const now = new Date();
      const cur = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      if (form.startTime <= cur) return "That start time has already passed today — please pick a later time";
    }
    const g = Number(form.guestCount);
    if (!Number.isInteger(g) || g < 1 || g > 1000) return "Guest count must be between 1 and 1000";
    if (!form.menu.trim()) return "Please enter your menu — e.g. Puri, Bhaji, Rice, Dal, Salad and Gulab Jamun";
    return "";
  };

  const validateService = () => {
    const d = Number(form.duration);
    if (!Number.isFinite(d) || d < 1 || d > 8) return "Duration must be between 1 and 8 hours";
    const extra = Number(form.extraHours);
    if (!Number.isFinite(extra) || extra < 0 || extra > 12) return "Extra hours must be between 0 and 12";
    const cooks = Number(form.additionalCook);
    if (!Number.isInteger(cooks) || cooks < 0 || cooks > 10) return "Additional cooks must be between 0 and 10";
    // Overnight guard mirrors the backend: the session must end same-day.
    const m = String(form.startTime || "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (m) {
      const startMin = Number(m[1]) * 60 + Number(m[2]);
      if (startMin + d * 60 + extra * 60 > 24 * 60) return "Overnight events are not supported — please shorten the duration";
    }
    return "";
  };

  const validateLocation = () => {
    if (!form.address.trim()) return "Please enter the event address";
    if (!form.area.trim()) return "Please enter the area (e.g. Hadapsar, Pune)";
    const dist = Number(form.distanceKm);
    if (!Number.isFinite(dist) || dist < 0 || dist > 100000) return "Please enter the approximate distance in km (0–100000)";
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
    if (submitting) return; // guard rapid clicks / retries
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
        eventType: String(form.eventType || "").trim(),
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
      const newId = res.data?._id;
      if (!newId) {
        setFormError("Booking was created but the details page ID is missing. Please find it under My Event Bookings.");
        return;
      }
      navigate(`/event-bookings/${newId}`);
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.message || "Booking request failed. Please try again.";
      // Stale event-type pick (renamed/deactivated after Step 1): refresh
      // the catalogue and send the customer back to Step 1 to re-pick.
      if (status === 400 && /event type/i.test(msg)) {
        try {
          const fresh = await API.get("/events");
          if (Array.isArray(fresh.data) && fresh.data.length > 0) setEventTypes(fresh.data);
        } catch {
          // catalogue refresh is best-effort; the message below still guides
        }
        setFormError(`${msg}`);
        setStep(1);
        return;
      }
      // 409 = concurrent update / overlap conflict — the message already says
      // to reload; 401 bounces to login via the axios interceptor.
      setFormError(status === 409 ? `${msg} Please review your details and retry.` : msg);
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

      {step > 2 && (
        <div className="od-livebar" aria-live="polite">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setStep((s) => s - 1)} aria-label="Go back one step">
            <ArrowLeft size={15} aria-hidden="true" /> Go Back
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
          <h2 className="ondemand-section-title">
            <PartyPopper size={17} /> Step 1 — What are you celebrating?
          </h2>
          <p className="ondemand-form-sub">Pick your occasion — CookMitra assigns a suitable cook for you.</p>
          {eventTypes.length === 0 ? (
            <div className="event-pick-empty" role="status">
              No event types are available right now. Please try again in a moment.
            </div>
          ) : (
            <div className="service-pick-grid event-pick-grid" role="radiogroup" aria-label="Event type">
              {eventTypes.map((t) => {
                const name = t.name || t;
                const active = form.eventType === name;
                return (
                  <button
                    type="button"
                    key={t._id || name}
                    role="radio"
                    aria-checked={active}
                    className={`service-pick-card event-pick-card ${active ? "selected" : ""}`}
                    onClick={() => {
                      set("eventType", name);
                      setFormError("");
                    }}
                  >
                    <span className="service-pick-check" aria-hidden="true">
                      {active && <CheckCircle2 size={18} />}
                    </span>
                    <span className="service-pick-icon" aria-hidden="true">{eventIcon(t.icon)}</span>
                    <strong>{name}</strong>
                    <span>{t.description || "Home event"}</span>
                  </button>
                );
              })}
            </div>
          )}
          <p className="event-error-slot" role={formError ? "alert" : undefined}>{formError}</p>
          <div className="od-stickybar">
            <button
              type="button"
              className="btn btn-primary btn-block btn-lg od-cta event-nav-btn"
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
        <div className="ondemand-form-card od-event-details">
          <h2 className="ondemand-section-title"><CalendarDays size={17} /> Step 2 — Event details</h2>
          <p className="ondemand-form-sub">Set the date, guest count and the dishes you'd like cooked.</p>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="event-date">
                <CalendarCheck size={15} aria-hidden="true" /> Event Date *
              </label>
              <input
                id="event-date"
                type="date"
                className="form-control"
                value={form.eventDate}
                min={localTodayStr()}
                onChange={(e) => set("eventDate", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label htmlFor="event-time">
                <Clock3 size={15} aria-hidden="true" /> Start Time *
              </label>
              <input
                id="event-time"
                type="time"
                className="form-control"
                value={form.startTime}
                onChange={(e) => set("startTime", e.target.value)}
              />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="event-guests">
                <Users size={15} aria-hidden="true" /> Number of Guests *
              </label>
              <div className="od-stepper">
                <button type="button" className="od-step-btn" aria-label="Fewer guests" onClick={() => adjustNumber("guestCount", -1, { min: 1, max: 1000 })}>
                  <Minus size={16} />
                </button>
                <input
                  id="event-guests"
                  type="text"
                  inputMode="numeric"
                  className="form-control"
                  value={form.guestCount}
                  onChange={(e) => set("guestCount", onlyDigits(e.target.value, form.guestCount))}
                  aria-label="Number of guests"
                />
                <button type="button" className="od-step-btn" aria-label="More guests" onClick={() => adjustNumber("guestCount", 1, { min: 1, max: 1000 })}>
                  <Plus size={16} />
                </button>
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="event-food-type">
                <UtensilsCrossed size={15} aria-hidden="true" /> Food Type *
              </label>
              <select id="event-food-type" className="form-control" value={form.foodType} onChange={(e) => set("foodType", e.target.value)}>
                {EVENT_FOOD_TYPES.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="event-menu">
              <UtensilsCrossed size={15} aria-hidden="true" /> Menu — dishes you need *
            </label>
            <textarea
              id="event-menu"
              className="form-control"
              rows={3}
              placeholder="e.g. Puri, Bhaji, Rice, Dal, Salad and Gulab Jamun"
              value={form.menu}
              onChange={(e) => set("menu", e.target.value)}
            />
          </div>
          <p className="event-error-slot" role={formError ? "alert" : undefined}>{formError}</p>
          <div className="od-stickybar">
            <div className="event-nav-row">
              <button type="button" className="btn btn-outline event-back-btn" onClick={() => setStep(1)}>
                <ArrowLeft size={16} /> Back
              </button>
              <button type="button" className="btn btn-primary event-nav-btn" onClick={() => nextFrom(validateDetails)}>
                Continue <ArrowRight size={17} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 3 — Service & hours */}
      {step === 3 && (
        <div className="ondemand-form-card">
          <h2 className="ondemand-section-title"><Clock3 size={17} /> Step 3 — Service & hours</h2>
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
                <span className="service-pick-icon" aria-hidden="true">
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
                  onChange={(e) => set("duration", onlyDigits(e.target.value, form.duration))}
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
                  onChange={(e) => set("additionalCook", onlyDigits(e.target.value, form.additionalCook))}
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
                  onChange={(e) => set("extraHours", onlyDigits(e.target.value, form.extraHours))}
                  aria-label="Extra hours"
                />
                <button type="button" className="od-step-btn" aria-label="More extra hours" onClick={() => adjustNumber("extraHours", 1, { min: 0, max: 12 })}>
                  <Plus size={16} />
                </button>
              </div>
            </div>
          </div>
          <p className="event-error-slot" role={formError ? "alert" : undefined}>{formError}</p>
          <div className="od-stickybar">
            <div className="od-summary" aria-live="polite">
              <span>{EVENT_SERVICE_LABEL(form.serviceType)}</span>
              <span>{form.duration || "–"} hr</span>
              <strong className="od-summary-price">{preview ? formatCurrency(preview.totalAmount) : "—"}</strong>
            </div>
            <div className="event-nav-row">
              <button type="button" className="btn btn-outline event-back-btn" onClick={() => setStep(2)}>
                <ArrowLeft size={16} /> Back
              </button>
              <button type="button" className="btn btn-primary event-nav-btn" onClick={() => nextFrom(validateService)}>
                Continue <ArrowRight size={17} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 4 — Location */}
      {step === 4 && (
        <div className="ondemand-form-card">
          <h2 className="ondemand-section-title"><MapPin size={17} /> Step 4 — Event location</h2>
          <div className="form-group">
            <label htmlFor="event-address">
              <MapPin size={15} /> Full Address *
            </label>
            <div className="event-location-row">
              <input
                id="event-address"
                type="text"
                className="form-control"
                placeholder="Flat / house no., street, society"
                value={form.address}
                onChange={(e) => set("address", e.target.value)}
                autoComplete="street-address"
              />
              <button
                type="button"
                className="btn btn-outline"
                onClick={handleDetectLocation}
                disabled={isLocating}
                aria-label={isLocating ? "Detecting your location" : "Detect my location"}
              >
                <LocateFixed size={15} aria-hidden="true" />
                {isLocating ? "Detecting…" : "Detect My Location"}
              </button>
            </div>
            {isLocating && (
              <p className="event-locate-note" role="status">
                <LocateFixed size={14} aria-hidden="true" /> Detecting your location… you can keep typing.
              </p>
            )}
          </div>
          {locError && (
            <div className="event-error-slot" role="alert" style={{ minHeight: 0 }}>
              <AlertCircle size={14} style={{ verticalAlign: "-2px" }} /> {locError} You can still type your address manually.
            </div>
          )}
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
              <label htmlFor="event-distance">
                <MapPin size={15} /> Distance from CookMitra hub (km) *
              </label>
              <input
                id="event-distance"
                type="text"
                inputMode="decimal"
                className="form-control"
                placeholder="e.g. 7"
                value={form.distanceKm}
                onChange={(e) => set("distanceKm", onlyDigits(e.target.value, form.distanceKm))}
              />
              <small className="field-hint">
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
          <p className="event-error-slot" role={formError ? "alert" : undefined}>{formError}</p>
          <div className="od-stickybar">
            <div className="event-nav-row">
              <button type="button" className="btn btn-outline event-back-btn" onClick={() => setStep(3)}>
                <ArrowLeft size={16} /> Back
              </button>
              <button type="button" className="btn btn-primary event-nav-btn" onClick={goToReview}>
                View Price <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 5 — Price & request */}
      {step === 5 && (
        <div className="ondemand-form-card">
          <h2 className="ondemand-section-title"><BadgeIndianRupee size={17} /> Step 5 — Price breakdown</h2>
          {quoting ? (
            <div className="loading-spinner-wrapper">
              <div className="spinner"></div>
              <p>Calculating your price...</p>
            </div>
          ) : shownQuote ? (
            <>
              <ul className="event-price-list">
                <li className="event-price-row">
                  <span>
                    <UtensilsCrossed size={15} aria-hidden="true" />
                    {EVENT_SERVICE_LABEL(form.serviceType)} · {form.duration} hr
                  </span>
                  <strong>{formatCurrency(shownQuote.serviceAmount)}</strong>
                </li>
                <li className="event-price-row">
                  <span>
                    <ChefHat size={15} aria-hidden="true" />
                    Additional Cook × {clampNum(form.additionalCook, 0, 10, 0)}
                  </span>
                  <strong>{formatCurrency(shownQuote.additionalCookAmount)}</strong>
                </li>
                <li className="event-price-row">
                  <span>
                    <Clock3 size={15} aria-hidden="true" />
                    Extra Hours × {form.extraHours || 0}
                  </span>
                  <strong>{formatCurrency(shownQuote.extraHourAmount)}</strong>
                </li>
                <li className={`event-price-row${travelFree ? " is-free" : ""}`}>
                  <span>
                    <MapPin size={15} aria-hidden="true" />
                    Travel · {form.distanceKm || 0} km {travelFree ? "(FREE)" : ""}
                  </span>
                  <strong>{formatCurrency(shownQuote.travelCharge)}</strong>
                </li>
              </ul>
              <p className="event-estimate-note">
                Provisional estimate — an admin verifies the distance before final billing.
              </p>
              <div className="event-total-row">
                <span>
                  <BadgeIndianRupee size={17} aria-hidden="true" /> Total Amount
                </span>
                <strong>
                  {formatCurrency(shownQuote.totalAmount)}
                </strong>
              </div>
              <div className="event-context-box">
                {form.eventType} · {formatDate(form.eventDate)} · {form.startTime} · {form.guestCount} guests
                <br />
                {form.address}, {form.area}
                {form.landmark ? ` (Near ${form.landmark})` : ""}
                <br />
                Menu ({form.foodType}): {form.menu}
              </div>
              {quote?.previewOnly && (
                <p className="event-estimate-note">
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
          <p className="event-error-slot" role={formError ? "alert" : undefined}>{formError}</p>
          <div className="od-stickybar">
            <div className="event-nav-row">
              <button type="button" className="btn btn-outline event-back-btn" onClick={() => setStep(4)}>
                <ArrowLeft size={16} /> Back
              </button>
              <button
                type="button"
                className="btn btn-primary event-nav-btn"
                disabled={quoting || submitting || !shownQuote}
                onClick={handleRequestBooking}
              >
                {submitting ? "Sending request..." : (
                  <>
                    <CheckCircle2 size={17} aria-hidden="true" /> Request Booking · {shownQuote ? formatCurrency(shownQuote.totalAmount) : ""}
                  </>
                )}
              </button>
            </div>
            <p className="od-sticky-note">
              No cook to choose — CookMitra assigns a suitable verified cook after your request.
            </p>
          </div>
          <p className="event-estimate-note" style={{ textAlign: "center", marginTop: "0.75rem", fontSize: "0.88rem" }}>
            <Link to="/dashboard/event-bookings">View my event bookings</Link>
          </p>
        </div>
      )}

      <LoginPromptModal open={showLoginModal} onClose={() => setShowLoginModal(false)} />
    </div>
  );
};

export default EventBooking;
