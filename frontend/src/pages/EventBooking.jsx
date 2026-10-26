import { useState, useEffect, useMemo, useRef } from "react";
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
  PartyPopper,
  Sunrise,
  Moon,
  Cookie,
  Utensils,
  Shapes,
} from "lucide-react";
import API from "../api/axios";
import { localTomorrowStr, formatTime12, istTodayStr, istNowMinutes } from "../utils/constants";
import {
  formatCurrency,
  EVENT_TYPE_FALLBACK,
  EVENT_SERVICES,
  EVENT_FOOD_TYPES,
  EVENT_SERVICE_LABEL,
  eventTravelSlabHint,
  previewEventPrice,
  sanitizeDecimalInput,
} from "../utils/eventConstants";
import { useShowToast, useSiteLocation } from "../store/hooks";
import { requestPreciseLocation } from "../store/locationSlice";
import LoginPromptModal from "../components/LoginPromptModal";
import CustomCalendar from "../components/CustomCalendar";

// Occasion icons (Step 1 cards). The seeded catalogue uses "calendar" for the
// catch-all "Other" occasion — a neutral shape reads better there than a
// calendar, so "calendar" maps to Shapes.
const EVENT_ICONS = {
  cake: <Cake size={24} />,
  heart: <Heart size={24} />,
  users: <Users size={24} />,
  sparkles: <Sparkles size={24} />,
  calendar: <Shapes size={24} />,
};

const eventIcon = (icon) => EVENT_ICONS[String(icon || "").toLowerCase()] || <PartyPopper size={24} />;

// Subtle icons for each food-type card in Step 2 (display only).
const FOOD_ICONS = {
  Breakfast: <Sunrise size={20} />,
  Lunch: <Utensils size={20} />,
  Dinner: <Moon size={20} />,
  Snacks: <Cookie size={20} />,
  "Full Meal": <UtensilsCrossed size={20} />,
};

const STEPS = [
  { label: "Event", desc: "Pick your occasion" },
  { label: "Details", desc: "Date, guests & menu" },
  { label: "Service", desc: "Service & hours" },
  { label: "Location", desc: "Address & distance" },
  { label: "Price", desc: "Review & request" },
];

// Hourly Start Time slots for Step 2 (6:00 AM – 11:00 PM). Values stay in
// the same "HH:MM" 24-hour format the form state, validators and the
// /event-bookings payload already expect — only the display changes.
const TIME_SLOTS = Array.from({ length: 18 }, (_, i) => `${String(i + 6).padStart(2, "0")}:00`);

/* "HH:MM" -> minutes since midnight (for past-slot comparisons). */
const timeToMinutes = (hm) => {
  const m = String(hm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

/* "YYYY-MM-DD" +/- whole days -> "YYYY-MM-DD" (date-only maths, no TZ drift). */
const shiftDateStr = (s, days) => {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
};

/* Keep numeric steppers / inputs strictly numeric — strips stray chars on paste. */
const onlyDigits = (v, fallback = "") => {
  const s = String(v ?? "");
  const digits = s.replace(/[^0-9]/g, "");
  if (digits === "") return fallback === "" ? "" : String(fallback);
  return String(parseInt(digits, 10));
};

const BOOKING_ATTEMPT_KEY = "cookmitra:event-booking-attempt";

const newIdempotencyKey = () => {
  const cryptoObj = typeof window !== "undefined" ? window.crypto : null;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
};

const bookingAttemptKey = (signature, memory) => {
  if (memory?.current?.signature === signature && memory.current.key) {
    return memory.current.key;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(BOOKING_ATTEMPT_KEY) || "null");
    if (saved?.signature === signature && saved?.key) {
      if (memory) memory.current = { signature, key: saved.key };
      return saved.key;
    }
  } catch {
    // storage unavailable/corrupt - fall through to a fresh key
  }
  const key = newIdempotencyKey();
  if (memory) memory.current = { signature, key };
  try {
    sessionStorage.setItem(BOOKING_ATTEMPT_KEY, JSON.stringify({ signature, key }));
  } catch {
    // best-effort: the in-memory call still sends the key
  }
  return key;
};

const clearBookingAttemptKey = () => {
  try {
    sessionStorage.removeItem(BOOKING_ATTEMPT_KEY);
  } catch {
    // ignore
  }
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
    customEventType: "",
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
  const idempotencyRef = useRef({ signature: "", key: "" });
  const dispatch = useDispatch();
  const { location: siteLocation, error: locError, isLocating } = useSiteLocation();
  // Key of the last GPS fix already applied to the form — autofill fills
  // BLANK fields once per fix and never overwrites what the user typed.
  const [locAppliedKey, setLocAppliedKey] = useState(null);

  // Live IST clock (minutes since midnight) — re-rendered every 30 s so
  // same-day past slots disappear as time moves forward.
  const [istMinutes, setIstMinutes] = useState(() => istNowMinutes());
  useEffect(() => {
    const id = setInterval(() => setIstMinutes(istNowMinutes()), 30_000);
    return () => clearInterval(id);
  }, []);

  // A slot is past when the selected date is IST-today and its start time
  // is at or before the current IST time.
  const isPastSlot = (slot) => {
    const slotMin = timeToMinutes(slot);
    if (slotMin == null) return false;
    return form.eventDate === istTodayStr() && slotMin <= istMinutes;
  };

  // ---- Preferred Date quick-select (all dates stay "YYYY-MM-DD" strings) ----
  // Two compact chips (Today / Tomorrow) sit above one calendar field; the
  // calendar field is the single place where the chosen date is displayed.
  const istToday = istTodayStr();
  const istTomorrow = shiftDateStr(istToday, 1);

  const pickDate = (d) => {
    if (!d) return;
    set("eventDate", d);
  };

  // Start-time slots in one compact grid: past slots are hidden when the
  // date is IST-today and every configured slot shows for future dates.
  // Re-filtered each render, so switching the date (or the clock moving)
  // refreshes the available slots immediately.
  const visibleTimeSlots = TIME_SLOTS.filter((t) => !isPastSlot(t));

  // When the date becomes today (or time moves on), clear any selected
  // start time that is now in the past so it can't be submitted.
  useEffect(() => {
    const slotMin = timeToMinutes(form.startTime);
    if (slotMin == null) return;
    if (form.eventDate === istTodayStr() && slotMin <= istMinutes) {
      setForm((f) => {
        const m = timeToMinutes(f.startTime);
        return m != null && m <= istMinutes ? { ...f, startTime: "" } : f;
      });
    }
  }, [form.eventDate, form.startTime, istMinutes]);

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
    if (form.eventDate < istTodayStr()) return "That date already passed — please pick today or a future date";
    if (!form.startTime) return "Please choose a start time";
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(form.startTime)) return "Start time must be HH:MM (24-hour)";
    // Same-day guard in IST (matches the server's strict IST check).
    if (form.eventDate === istTodayStr()) {
      const slotMin = timeToMinutes(form.startTime);
      if (slotMin != null && slotMin <= istNowMinutes()) {
        return "That start time has already passed today — please pick a later time";
      }
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
    if (cooks !== 0) return "Additional cooks are not available yet";
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
      const bookingIntent = {
        eventType: String(form.eventType || "").trim(),
        customEventType:
          form.eventType === "Other" ? String(form.customEventType || "").trim() : "",
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
      };
      const attemptSignature = JSON.stringify(bookingIntent);
      const idempotencyKey = bookingAttemptKey(attemptSignature, idempotencyRef);
      const res = await API.post(
        "/event-bookings",
        {
          ...bookingIntent,
          pricingVersion:
            Number.isInteger(Number(quote?.pricingVersion))
              ? Number(quote.pricingVersion)
              : undefined,
        },
        { headers: { "Idempotency-Key": idempotencyKey } }
      );
      showToast("Booking request received! CookMitra will assign a suitable cook.", "success");
      const newId = res.data?._id;
      if (!newId) {
        setFormError("Booking was created but the details page ID is missing. Please find it under My Event Bookings.");
        return;
      }
      idempotencyRef.current = { signature: "", key: "" };
      clearBookingAttemptKey();
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
      if (status === 409 && err.response?.data?.code === "PRICING_CHANGED") {
        const refreshed = err.response.data.quote;
        if (refreshed) setQuote(refreshed);
        setFormError(msg);
        return;
      }
      setFormError(status === 409 ? `${msg} Please review your details and retry.` : msg);
    } finally {
      setSubmitting(false);
    }
  };

  const shownQuote = quote || preview;
  const travelFree = shownQuote && Number(shownQuote.travelCharge) === 0;

  return (
    <div className="ondemand-page od-modern events-page">
      <div className="od-hero od-event-hero">
        <div className="od-hero-text">
          <span className="od-eyebrow">
            <PartyPopper size={12} /> CookMitra Events
          </span>
          <h1 className="od-title">Book a Cook for Your Event</h1>
          <p className="od-sub">
            <Sparkles size={14} aria-hidden="true" />
            <span className="od-sub-text">
              Celebrate your special moments while we take care of the cooking.
            </span>
          </p>
        </div>
      </div>

      <ol className="od-steps-modern od-steps-progress" aria-label="Event booking progress">
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

      {/* STEP 1 — Select event */}
      {step === 1 && (
        <div className="ondemand-form-card">
          <h2 className="ondemand-section-title event-occasion-heading">
            <PartyPopper size={18} aria-hidden="true" /> What are you celebrating?
          </h2>
          <p className="ondemand-form-sub event-occasion-sub">
            Choose your occasion and let CookMitra help you plan the cooking for your special day.
          </p>
          {eventTypes.length === 0 ? (
            <div className="event-pick-empty" role="status">
              No event types are available right now. Please try again in a moment.
            </div>
          ) : (
            <div
              className={`event-pick-grid ${eventTypes.length === 5 ? "event-pick-grid--5" : ""}`}
              role="radiogroup"
              aria-label="Event type"
            >
              {eventTypes.map((t) => {
                const name = t.name || t;
                const active = form.eventType === name;
                return (
                  <button
                    type="button"
                    key={t._id || name}
                    role="radio"
                    aria-checked={active}
                    className={`event-pick-card ${active ? "selected" : ""}`}
                    onClick={() => {
                      set("eventType", name);
                      setFormError("");
                    }}
                  >
                    <span className="event-occasion-icon" aria-hidden="true">{eventIcon(t.icon)}</span>
                    <span className="event-occasion-body">
                      <strong>{name}</strong>
                      <span className="event-occasion-desc">{t.description || "Home event"}</span>
                    </span>
                    <span className="event-occasion-check" aria-hidden="true">
                      {active && <CheckCircle2 size={16} />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {form.eventType === "Other" && (
            <div className="form-group event-other-group">
              <label htmlFor="event-other-name">
                <Shapes size={15} aria-hidden="true" /> What is the occasion?
              </label>
              <input
                id="event-other-name"
                type="text"
                className="form-control"
                value={form.customEventType}
                maxLength={80}
                placeholder="Enter your event name"
                autoComplete="off"
                aria-invalid={formError ? "true" : undefined}
                onChange={(e) => {
                  set("customEventType", e.target.value);
                  if (formError) setFormError("");
                }}
              />
              <p className="od-field-hint">
                <Sparkles size={13} aria-hidden="true" /> Up to 80 characters — for example Housewarming, Naming Ceremony or Baby Shower.
              </p>
            </div>
          )}
          <p className="event-error-slot" role={formError ? "alert" : undefined}>{formError}</p>
          <div className="od-stickybar">
            <button
              type="button"
              className="btn btn-primary btn-block btn-lg od-cta event-nav-btn event-continue-btn"
              onClick={() => {
                if (!form.eventType) {
                  setFormError("Please select your event type");
                  return;
                }
                if (form.eventType === "Other" && !form.customEventType.trim()) {
                  setFormError("Please enter your event name");
                  return;
                }
                setFormError("");
                setStep(2);
              }}
            >
              <span>Continue to Event Details</span>
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/* STEP 2 — Event details */}
      {step === 2 && (
        <div className="ondemand-form-card od-event-details">
          <h2 className="ondemand-section-title"><CalendarDays size={17} /> Event details</h2>
          <p className="ondemand-form-sub">Set the date, guest count and the dishes you'd like cooked.</p>
          <div className="form-group od-date-group">
            <span className="od-field-label">
              <CalendarCheck size={15} aria-hidden="true" /> Preferred Date *
            </span>
            <div className="od-presets od-date-presets" role="group" aria-label="Quick dates">
              <button
                type="button"
                className={`bk-dur-chip ${form.eventDate === istToday ? "active" : ""}`}
                aria-pressed={form.eventDate === istToday}
                onClick={() => pickDate(istToday)}
              >
                Today
              </button>
              <button
                type="button"
                className={`bk-dur-chip ${form.eventDate === istTomorrow ? "active" : ""}`}
                aria-pressed={form.eventDate === istTomorrow}
                onClick={() => pickDate(istTomorrow)}
              >
                Tomorrow
              </button>
            </div>
            <div className="od-date-cal-row">
              <CustomCalendar
                id="event-date"
                value={form.eventDate}
                min={istToday}
                placeholder="Pick another date"
                onChange={pickDate}
              />
            </div>
          </div>

          <div className="form-group od-time-group">
            <span className="od-field-label" id="event-time-label">
              <Clock3 size={15} aria-hidden="true" /> Start Time *
            </span>
            {visibleTimeSlots.length === 0 ? (
              <p className="od-time-empty" role="status">
                All of today's start times have passed — please pick tomorrow or another date.
              </p>
            ) : (
              <div className="od-time-grid" role="radiogroup" aria-labelledby="event-time-label">
                {visibleTimeSlots.map((t) => {
                  const active = form.startTime === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`od-time-slot${active ? " is-selected" : ""}`}
                      onClick={() => set("startTime", t)}
                    >
                      {formatTime12(t)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="form-row od-details-row">
            <div className="form-group">
              <label htmlFor="event-guests">
                <Users size={15} aria-hidden="true" /> Number of Guests *
              </label>
              <div className="od-stepper od-guests-stepper">
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
          </div>

          <div className="form-group od-food-group">
            <span className="od-field-label">
              <UtensilsCrossed size={15} aria-hidden="true" /> Food Type *
            </span>
            <div className="service-pick-grid od-food-grid" role="radiogroup" aria-label="Food type">
              {EVENT_FOOD_TYPES.map((f) => {
                const active = form.foodType === f;
                return (
                  <button
                    type="button"
                    key={f}
                    role="radio"
                    aria-checked={active}
                    className={`service-pick-card od-food-card ${active ? "selected" : ""}`}
                    onClick={() => set("foodType", f)}
                  >
                    <span className="service-pick-check" aria-hidden="true">
                      {active && <CheckCircle2 size={18} />}
                    </span>
                    <span className="service-pick-icon" aria-hidden="true">{FOOD_ICONS[f] || <UtensilsCrossed size={20} />}</span>
                    <strong>{f}</strong>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="form-group od-menu-group">
            <label htmlFor="event-menu">
              <UtensilsCrossed size={15} aria-hidden="true" /> Menu — dishes you need *
            </label>
            <textarea
              id="event-menu"
              className="form-control"
              rows={3}
              placeholder="e.g., Paneer curry, Dal, Rice, Chapati"
              value={form.menu}
              onChange={(e) => set("menu", e.target.value)}
            />
            <p className="od-field-hint">
              <Sparkles size={13} aria-hidden="true" /> List every dish, separated by commas — you can add as many as you like.
            </p>
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
          <h2 className="ondemand-section-title"><Clock3 size={17} /> Service & hours</h2>
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
          <h2 className="ondemand-section-title"><MapPin size={17} /> Event location</h2>
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
                onChange={(e) => set("distanceKm", sanitizeDecimalInput(e.target.value))}
              />
              <small className="field-hint">
                Travel: {eventTravelSlabHint(pricing?.travelSlabs)}
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
          <h2 className="ondemand-section-title"><BadgeIndianRupee size={17} /> Price breakdown</h2>
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
