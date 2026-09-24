import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ChefHat,
  Users,
  GraduationCap,
  HandHelping,
  CalendarCheck,
  MapPin,
  UtensilsCrossed,
  StickyNote,
  LogIn,
  Check,
  CheckCircle2,
  Clock3,
  Building2,
  Landmark,
  Home as HomeIcon,
  MessageCircle,
  History,
  Pencil,
  ArrowRight,
  ArrowLeft,
  Minus,
  Plus,
  ShieldCheck,
  Sparkles,
  BadgePercent,
} from "lucide-react";
import API from "../api/axios";
import { formatCurrency, localTodayStr, localTomorrowStr, slabPriceForDuration, LAUNCH_SLAB_PRICES } from "../utils/constants";
import CouponApply from "../components/CouponApply";
import CustomCalendar from "../components/CustomCalendar";
import CookAvatar from "../components/CookAvatar";
import { useDispatch, useSelector } from "react-redux";
import { updateUser } from "../store/authSlice";
import { useShowToast, useSiteLocation } from "../store/hooks";
import { saveBookingDraft, loadBookingDraft, clearBookingDraft } from "../utils/bookingDraft";

import LoginPromptModal from "../components/LoginPromptModal";

const SERVICE_OPTIONS = [
  { id: "cook_for_me", label: "Cook for Me", desc: "Cook prepares food at your home", icon: <ChefHat size={24} /> },
  { id: "cook_with_me", label: "Cook With Me", desc: "Prepare together, learn as you go", icon: <Users size={24} /> },
  { id: "teach_me", label: "Teach Me", desc: "Hands-on lesson in festive cooking", icon: <GraduationCap size={24} /> },
  { id: "preparation_help", label: "Preparation Help", desc: "Help with chopping, dough, frying", icon: <HandHelping size={24} /> },
];

// One-tap hour presets — the most common booking lengths. Exact values
// (0.5 steps, 1–12) can still be typed in the input below the chips.
const DURATION_QUICK = [1, 2, 3, 4];

// Service day: bookable slots run 08:00–20:00 for every cook (mirrors the
// backend slot engine in backend/utils/slots.js — defense in depth so an
// out-of-hours slot can never be displayed even if the API ever returns one).
const SERVICE_START_MIN = 8 * 60;
const SERVICE_END_MIN = 20 * 60;

const toMinutes = (t) => {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

// "8:00 AM – 11:00 AM" style label for a "HH:MM" slot.
const fmtTime = (t) => {
  const m = toMinutes(t);
  if (m == null) return t;
  let h = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(mm).padStart(2, "0")} ${ap}`;
};

const isSlotInServiceDay = (slot) => {
  const s = toMinutes(slot.startTime);
  const e = toMinutes(slot.endTime);
  return s != null && e != null && s >= SERVICE_START_MIN && e <= SERVICE_END_MIN;
};

// Slots starting at or before "now" are hidden when the selected date is
// today — a customer can never pick a time that already passed.
const isSlotInPast = (dateStr, startTime) => {
  if (dateStr !== localTodayStr()) return false;
  const s = toMinutes(startTime);
  if (s == null) return false;
  const now = new Date();
  return s <= now.getHours() * 60 + now.getMinutes();
};

// Day-part for grouping time slots (Morning / Afternoon / Evening).
const slotPart = (startTime) => {
  const m = toMinutes(startTime);
  if (m == null) return "Slots";
  if (m < 12 * 60) return "Morning";
  if (m < 16 * 60) return "Afternoon";
  return "Evening";
};

// Compact chip label ("9 AM" / "9:30 AM"). The full "9:00 AM – 12:00 PM"
// range stays in the aria-label so screen readers still announce exact times.
const fmtTimeCompact = (t) => {
  const m = toMinutes(t);
  if (m == null) return t;
  let h = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}${mm ? ":" + String(mm).padStart(2, "0") : ""} ${ap}`;
};

// Collapsed view cap: only the first few starts per day-part render until
// the customer taps "Show all N times" — a wall of 20+ identical chips
// slows the pick instead of helping it.
const TOP_SLOTS_COUNT = 6;

// Presentation-only "Recommended" highlight: the start with the most cooks
// free (earliest wins ties). Nothing is pre-selected for the customer.
const pickRecommendedSlot = (options) => {
  if (!options || options.length === 0) return null;
  return options.reduce((best, o) => {
    const d = o.freeCooks - best.freeCooks;
    if (d > 0) return o;
    if (d === 0 && toMinutes(o.startTime) < toMinutes(best.startTime)) return o;
    return best;
  });
};

// Friendly date label for summaries ("Today" / "Tomorrow" / 2026-09-12).
const dateLabel = (dateStr) => {
  if (!dateStr) return "Pick a date";
  if (dateStr === localTodayStr()) return "Today";
  if (dateStr === localTomorrowStr()) return "Tomorrow";
  return dateStr;
};

// Numbered section heading — the form reads as 4 short steps.
const SecTitle = ({ n, icon, children }) => (
  <h3 className="ondemand-section-title">
    <span className="od-sec-num" aria-hidden="true">{n}</span>
    {icon}
    <span>{children}</span>
  </h3>
);

const CookBooking = () => {
  const user = useSelector((s) => s.auth.user);
  const showToast = useShowToast();
  const { location: siteLocation } = useSiteLocation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // Deep links (Home services, Footer) may preselect the service via
  // ?serviceType= — fall back to the default for anything unknown.
  const initialService = (() => {
    const q = searchParams.get("serviceType");
    return SERVICE_OPTIONS.some((s) => s.id === q) ? q : "cook_for_me";
  })();

  const [step, setStep] = useState(1);

  // Every step change opens at the top of the page.
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }, [step]);
  // Start each step at the top of the page.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [step]);
  const [form, setForm] = useState({
    serviceType: initialService,
    date: localTomorrowStr(),
    flatNo: "",
    society: "",
    landmark: "",
    city: "",
    guests: "4",
    durationHours: "3",
    customDishes: "",
    notes: "",
  });
  const [formError, setFormError] = useState("");
  const [matches, setMatches] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [bookingLoading, setBookingLoading] = useState(null);
  const [locMsg, setLocMsg] = useState("");
  const [coords, setCoords] = useState(null);
  const [copied, setCopied] = useState(false);
  const [savedLocations, setSavedLocations] = useState([]);
  const [savedIdx, setSavedIdx] = useState("");
  const autoFilled = useRef(false);
  const venueErrorRef = useRef(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const scrollToVenueError = () =>
    requestAnimationFrame(() =>
      venueErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
    );
  // Step 2 (time slots): one entry per distinct start–end time with the
  // number of cooks free at it. Step 3 (cook) shows cooks free at the slot
  // the customer picked in step 2.
  const [slotOptions, setSlotOptions] = useState([]);
  const [selectedSlot, setSelectedSlot] = useState(null);
  // "Show all N times" expander for the step-2 slot lists (collapse default).
  const [showAllSlots, setShowAllSlots] = useState(false);
  const [coupon, setCoupon] = useState(null);
  // Coupon code carried across the login wall / dead-request retry —
  // re-validated live by CouponApply on mount, never trusted blindly.
  const [couponRestore, setCouponRestore] = useState(null);
  // Shorter session lengths the server confirmed free when the requested
  // hours fit nowhere — rendered as one-tap retry chips.
  const [slotSuggestions, setSlotSuggestions] = useState([]);
  // Start with the most cooks free — flagged "Recommended" in step 2.
  const recommendedSlot = useMemo(() => pickRecommendedSlot(slotOptions), [slotOptions]);
  // Cooks offering the chosen service (0 = none exist, vs slots just full).
  const [totalCooksFound, setTotalCooksFound] = useState(null);

  // Header-detected place (GPS / IP / manual) pre-fills address fields when
  // they are still empty — typed or previously-saved input always wins.
  useEffect(() => {
    if (!siteLocation?.city && !siteLocation?.area && !siteLocation?.state) return;
    // Logged-in customers: hold off until the profile address (which wins the
    // auto-fill priority) has loaded — otherwise a brief race lets the
    // detected location fill fields the profile address should own.
    if (user?.role === "customer" && user?.address === undefined) return;
    setForm((f) => {
      if (f.flatNo || f.society || f.landmark || f.city) return f;
      return {
        ...f,
        city: f.city.trim() ? f.city : siteLocation.city || "",
        society: f.society.trim() ? f.society : siteLocation.area || "",
        landmark: f.landmark.trim() ? f.landmark : siteLocation.street || siteLocation.area || "",
      };
    });
    if (Number.isFinite(siteLocation?.lat) && Number.isFinite(siteLocation?.lng)) {
      setCoords((c) => c || { lat: siteLocation.lat, lng: siteLocation.lng });
    }
  }, [siteLocation?.city, siteLocation?.area, siteLocation?.state, siteLocation?.street, siteLocation?.lat, siteLocation?.lng, user?.role, user?.address]);

  /* ── Profile address (locked summary card + Edit button) ── */
  const profileAddress = String(user?.address || "").trim();
  const [addrEditing, setAddrEditing] = useState(false);
  // Summary shown while locked: the composed form address (profile/saved/
  // detected fill), falling back to the raw profile string.
  const addrSummary =
    [form.flatNo, form.society, form.landmark ? `Near ${form.landmark}` : "", form.city]
      .map((p) => String(p || "").trim())
      .filter(Boolean)
      .join(", ") || profileAddress;

  // The stored user (localStorage from an older login) can lack the address
  // key — refresh it from /auth/me so the profile address can claim priority
  // and the locked summary can be decided.
  const dispatch = useDispatch();
  useEffect(() => {
    if (user?.role !== "customer" || user?.address !== undefined) return;
    let cancelled = false;
    API.get("/auth/me")
      .then((res) => { if (!cancelled) dispatch(updateUser({ name: res.data?.name, phone: res.data?.phone, address: res.data?.address ?? "" })); })
      .catch(() => { if (!cancelled) dispatch(updateUser({ address: "" })); });
    return () => { cancelled = true; };
  }, [user?.role, user?.address, dispatch]);

  // Previous locations of this customer for one-tap reuse (customers only).
  useEffect(() => {
    if (user?.role !== "customer") return;
    let cancelled = false;
    API.get("/bookings/my/locations")
      .then((res) => {
        if (!cancelled) setSavedLocations(res.data || []);
      })
      .catch(() => {
        if (!cancelled) setSavedLocations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.role]);

  const applySavedLocation = (idx) => {
    const saved = savedLocations[Number(idx)];
    if (!saved) return;
    const d = saved.addressDetails || {};
    // Explicit pick always replaces the auto-filled address block (header
    // detection or a previously applied entry) — the saved entry is
    // authoritative. Entries without structured details fall back to parsing
    // their address string.
    const parts = String(saved.address || "").split(",").map((p) => p.trim()).filter(Boolean);
    const src = Object.keys(d).length > 0
      ? d
      : parts.length === 1
        ? { society: parts[0] }
        : parts.length === 2
          ? { flatNo: parts[0], society: parts[1] }
          : { flatNo: parts[0], society: parts.slice(1, -1).join(", "), city: parts[parts.length - 1] };
    setForm((f) => ({
      ...f,
      flatNo: src.flatNo || "",
      society: src.society || "",
      landmark: src.landmark || "",
      city: src.city || "",
    }));
    setSavedIdx(String(idx));
    if (saved.location?.lat != null) {
      setCoords({ lat: saved.location.lat, lng: saved.location.lng });
      setLocMsg("Previous location applied with its saved map pin");
    } else {
      // Drop any stale pin from the auto-detected location — it would
      // point at the wrong place for this address.
      setCoords(null);
      setLocMsg("Previous location applied — verify the address below for precise navigation");
    }
  };

  // Auto-fill priority: profile address > most recent previous booking
  // (an explicit pick from the dropdown above always wins once made).
  useEffect(() => {
    if (autoFilled.current) return;
    // Wait for the customer's profile to settle (address key resolved) so the
    // profile address can claim priority over saved bookings.
    if (user?.role === "customer" && user?.address === undefined) return;
    autoFilled.current = true;
    const fill = (src) =>
      setForm((f) => {
        if (f.flatNo || f.society || f.landmark || f.city) return f;
        return {
          ...f,
          flatNo: src.flatNo || "",
          society: src.society || "",
          landmark: src.landmark || "",
          city: src.city || "",
        };
      });
    const profileAddr = String(user?.address || "").trim();
    if (profileAddr) {
      // Split "Flat 402, Sunshine Society, Baner, Pune" into the form fields,
      // same heuristic as applySavedLocation for unstructured addresses.
      const parts = profileAddr.split(",").map((p) => p.trim()).filter(Boolean);
      fill(
        parts.length === 1
          ? { society: parts[0] }
          : parts.length === 2
            ? { flatNo: parts[0], society: parts[1] }
            : { flatNo: parts[0], society: parts.slice(1, -1).join(", "), city: parts[parts.length - 1] }
      );
      return;
    }
    if (savedLocations.length === 0) return;
    fill(savedLocations[0].addressDetails || {});
    setSavedIdx("0");
    if (savedLocations[0].location?.lat != null) {
      setCoords({ lat: savedLocations[0].location.lat, lng: savedLocations[0].location.lng });
    }
  }, [savedLocations, user?.role, user?.address]);

  const mapsLink = coords
    ? `https://www.google.com/maps?q=${coords.lat},${coords.lng}`
    : "";

  const serviceLabel =
    (SERVICE_OPTIONS.find((s) => s.id === form.serviceType) || {}).label || "Cook service";

  // Launch slab pricing (server recomputes it — display + preview only).
  const slab = slabPriceForDuration(Number(form.durationHours));
  const couponDiscount = slab != null && coupon ? Math.min(coupon.discount, slab) : 0;
  const finalPayable = slab != null ? Math.max(0, slab - couponDiscount) : 0;

  // Returning from login with an unfinished booking: restore the filled
  // form + pin, re-check live availability, and land where they left off —
  // step 3 when the picked slot is still free, else step 2 with fresh
  // slots. Runs once; stale drafts (>2h) are dropped silently.
  const resumedDraft = useRef(false);
  useEffect(() => {
    if (resumedDraft.current || !user) return;
    const d = loadBookingDraft();
    if (!d || d.kind !== "on-demand" || !d.form) return;
    if (!d.savedAt || Date.now() - d.savedAt > 2 * 3600 * 1000) {
      clearBookingDraft();
      return;
    }
    resumedDraft.current = true;
    autoFilled.current = true;
    setForm((f) => ({ ...f, ...d.form }));
    if (d.coords?.lat != null) setCoords(d.coords);
    if (d.couponCode) setCouponRestore(d.couponCode);
    setSearching(true);
    (async () => {
      try {
        const r = await runSlotSearch({
          serviceType: d.form.serviceType,
          date: d.form.date,
          durationHours: d.form.durationHours,
        });
        setMatches(r.available);
        setSlotOptions(r.options);
        setSlotSuggestions(r.suggestions);
        setTotalCooksFound(r.totalCooks);
        setSearched(true);
        const stillFree =
          d.selectedSlot &&
          r.options.some(
            (o) =>
              o.startTime === d.selectedSlot.startTime &&
              o.endTime === d.selectedSlot.endTime
          );
        if (stillFree) {
          setSelectedSlot(d.selectedSlot);
          setStep(3);
          showToast("Welcome back — your booking is restored. Just tap Book.", "success");
        } else {
          setSelectedSlot(null);
          setStep(2);
          showToast("Welcome back — pick a time to continue your booking.", "success");
        }
        clearBookingDraft();
      } catch {
        setStep(1);
        showToast("Welcome back — your details were restored. Tap See Time Slots.", "info");
      } finally {
        setSearching(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const handleCopyLink = async () => {
    if (!mapsLink) return;
    try {
      await navigator.clipboard.writeText(mapsLink);
    } catch {
      const input = document.getElementById("maps-link-input");
      if (input) {
        input.select();
        document.execCommand("copy");
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm({ ...form, [name]: value });
    // Clear this field's error as soon as the user fixes it.
    if (fieldErrors[name]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  // Stepper helper for duration / guests: snaps to `step`, clamps to
  // [min, max]. Empty or invalid input restarts from min so −/+ always work.
  const adjustNumber = (name, delta, { min, max, step }) => {
    setForm((f) => {
      const cur = Number(f[name]);
      const base = Number.isFinite(cur) ? cur : min;
      const next = Math.min(max, Math.max(min, Math.round((base + delta) / step) * step));
      return { ...f, [name]: String(Number(next.toFixed(2))) };
    });
  };

  const parseDishes = () =>
    form.customDishes
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);

  // Step 1 → 2 validates only the plan (service is always set, date /
  // hours / guests drive availability). Venue + menu are validated at
  // booking time on step 3, so nobody types an address for a dead date.
  const validatePlan = (durationOverride) => {
    if (!form.date) return "Please choose a date for your session";
    if (form.date < localTodayStr()) return "That date already passed — please pick today or a future date";
    const guests = Number(form.guests);
    if (!form.guests || !Number.isInteger(guests) || guests < 1 || guests > 500)
      return "Number of people must be between 1 and 500";
    const dh = durationOverride ?? form.durationHours;
    const hours = Number(dh);
    if (!dh || !Number.isInteger(hours) || hours < 1 || hours > 4)
      return "Please choose 1, 2, 3 or 4 hours";
    return "";
  };

  // Per-field venue errors: one message per invalid input so each error
  // renders directly below its field. Empty object = valid.
  const validateVenue = () => {
    const errs = {};
    if (!form.flatNo.trim()) errs.flatNo = "Please enter your flat / house number";
    if (!form.society.trim()) errs.society = "Please enter your society / building / street";
    if (!form.city.trim()) errs.city = "Please enter your city / area";
    if (parseDishes().length === 0)
      errs.customDishes = "Please mention the dishes you need (comma separated)";
    return errs;
  };
  const [fieldErrors, setFieldErrors] = useState({});
  const fieldRefs = useRef({});
  // Show the first invalid field: expand the collapsed address editor when
  // the locked profile summary is showing, then scroll to and focus it.
  const focusFirstFieldError = (errs) => {
    const order = ["flatNo", "society", "city", "customDishes"];
    const first = order.find((k) => errs[k]);
    if (!first) return;
    setAddrEditing(true);
    requestAnimationFrame(() => {
      const el = fieldRefs.current[first];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.focus({ preventScroll: true });
      }
    });
  };

  const buildAddress = () =>
    `${form.flatNo.trim()}, ${form.society.trim()}${
      form.landmark.trim() ? `, Near ${form.landmark.trim()}` : ""
    }, ${form.city.trim()}`;

  const buildSelectedItems = () => parseDishes();

  // Distinct start–end times across cooks with a free-cook count each,
  // sorted earliest first. Backend already sizes slots to the selected
  // service hours; this only aggregates them for step 2.
  const aggregateSlots = (cooksWithSlots) => {
    const map = new Map();
    cooksWithSlots.forEach((c) => {
      (c.slots || []).forEach((s) => {
        const key = `${s.startTime}-${s.endTime}`;
        if (!map.has(key)) {
          map.set(key, { startTime: s.startTime, endTime: s.endTime, freeCooks: 0 });
        }
        map.get(key).freeCooks += 1;
      });
    });
    return [...map.values()].sort(
      (a, b) => toMinutes(a.startTime) - toMinutes(b.startTime)
    );
  };

  // Shared slot search — ONE batched request (GET /availability/search)
  // replaces the old N+1 fan-out (1 × cooks list + N × per-cook
  // availability). Same slot math, server-side, so a search spike costs
  // ~3 DB round trips instead of ~3 per cook. Falls back to the fan-out
  // only if the batched endpoint is unreachable (stale backend).
  const runSlotSearch = async ({ serviceType, date, durationHours }) => {
    void serviceType;
    try {
      const r = await API.get("/availability/search", {
        params: { date, durationHours, suggest: 1 },
      });
      const withSlots = Array.isArray(r.data?.cooks) ? r.data.cooks : [];
      const usable = withSlots.map((c) => ({
        ...c,
        slots: (c.slots || []).filter(
          (s) => isSlotInServiceDay(s) && !isSlotInPast(date, s.startTime)
        ),
      }));
      const available = usable.filter((c) => c.slots.length > 0);
      const suggestions = Array.isArray(r.data?.suggestions)
        ? r.data.suggestions.filter((s) => Number.isFinite(Number(s))).map(Number).sort((a, b) => b - a).slice(0, 3)
        : [];
      return {
        available,
        options: aggregateSlots(available),
        suggestions,
        totalCooks: Number.isFinite(Number(r.data?.totalCooks)) ? Number(r.data.totalCooks) : withSlots.length,
        failedCooks: 0,
      };
    } catch {
      return runSlotSearchLegacy({ serviceType, date, durationHours });
    }
  };

  // Legacy per-cook fan-out — fallback only (see runSlotSearch above).
  const runSlotSearchLegacy = async ({ serviceType, date, durationHours }) => {
    const cooksRes = await API.get(
      `/cooks${serviceType ? `?serviceType=${encodeURIComponent(serviceType)}` : ""}`
    );
    const rawCooks = cooksRes.data;
    const cooks = Array.isArray(rawCooks) ? rawCooks : rawCooks?.cooks || rawCooks?.data || [];
    const suggested = new Set();
    let failedCooks = 0;
    const withSlots = await Promise.all(
      cooks.map(async (cook) => {
        // Cooks list populates `user` as an object, but be tolerant of
        // string refs or a bare profile id so one shape change can't wipe
        // every slot result to [].
        const cookId =
          cook?.user?._id ||
          (typeof cook?.user === "string" ? cook.user : null) ||
          cook?._id;
        if (!cookId) {
          failedCooks += 1;
          return { ...cook, slots: [] };
        }
        try {
          // Start-time options sized to the entered service hours.
          // suggest=1 asks the server to also name shorter sessions that
          // DO fit, so an empty result becomes a one-tap retry.
          const slotsRes = await API.get(
            `/availability/${cookId}?date=${encodeURIComponent(date)}&durationHours=${encodeURIComponent(durationHours)}&suggest=1`
          );
          const payload = slotsRes.data;
          const list = Array.isArray(payload) ? payload : payload?.slots || [];
          if (!Array.isArray(payload) && Array.isArray(payload?.suggestions)) {
            payload.suggestions.forEach((s) => {
              if (Number.isFinite(Number(s))) suggested.add(Number(s));
            });
          }
          return { ...cook, slots: list };
        } catch {
          failedCooks += 1;
          return { ...cook, slots: [] };
        }
      })
    );
    // Service-day + past-time guard (backend enforces the same, this keeps
    // the UI honest even with a stale cache or clock skew).
    const usable = withSlots.map((c) => ({
      ...c,
      slots: (c.slots || []).filter(
        (s) => isSlotInServiceDay(s) && !isSlotInPast(date, s.startTime)
      ),
    }));
    const available = usable.filter((c) => c.slots.length > 0);
    return {
      available,
      options: aggregateSlots(available),
      suggestions: [...suggested].sort((a, b) => b - a).slice(0, 3),
      totalCooks: cooks.length,
      failedCooks,
    };
  };

  // Step 1 → 2: validate the plan, then search. `durationOverride` lets a
  // suggestion chip retry with shorter hours without waiting for state.
  const handleSeeSlots = async (e, durationOverride) => {
    e?.preventDefault?.();
    const err = validatePlan(durationOverride);
    if (err) return setFormError(err);
    const effDuration = durationOverride ?? form.durationHours;
    setFormError("");
    setSearching(true);
    setSearched(false);
    setSlotSuggestions([]);
    try {
      const { available, options, suggestions, totalCooks, failedCooks } = await runSlotSearch({
        serviceType: form.serviceType,
        date: form.date,
        durationHours: effDuration,
      });
      // Every per-cook request failed (backend down / network) — that's a
      // load error, not "no slots". Stay on step 1 with an error instead of
      // landing on an empty step 2 with a misleading toast.
      if (totalCooks > 0 && failedCooks >= totalCooks) {
        throw new Error("Could not load time slots. Try again.");
      }
      setMatches(available);
      setSlotOptions(options);
      setSlotSuggestions(suggestions);
      setTotalCooksFound(totalCooks);
      setSelectedSlot(null);
      setShowAllSlots(false);
      setSearched(true);
      setStep(2);
      if (available.length === 0) {
        showToast(
          totalCooks === 0
            ? "No cooks offer this service yet — try another service"
            : suggestions.length > 0
              ? `No ${effDuration}-hour slots that day — shorter sessions are free below`
              : "No free slots on this date — try another date or duration",
          "info"
        );
      }
    } catch (err) {
      setFormError(err.response?.data?.message || "Could not load time slots. Try again.");
    } finally {
      setSearching(false);
    }
  };

  // Retry after a dead request (cook never responded / declined): the waiting
  // screen navigates here with the dead booking's plan + slot. Restore the
  // form, re-check live availability, drop the unresponsive cook from the
  // list, and land straight on step 3 so the customer picks another chef
  // without re-typing anything. Runs once per navigation state.
  const retryHandled = useRef(false);
  useEffect(() => {
    const retry = location.state?.retryFromBooking;
    if (!retry || retryHandled.current) return;
    retryHandled.current = true;
    // Clear the navigation state so back/forward doesn't re-apply it.
    try {
      window.history.replaceState({}, "");
    } catch {
      // ignore
    }
    if (!retry.form?.date || !retry.form?.serviceType || !retry.selectedSlot) {
      return;
    }
    autoFilled.current = true;
    setForm((f) => ({ ...f, ...retry.form }));
    if (retry.coords?.lat != null) setCoords(retry.coords);
    if (retry.couponCode) setCouponRestore(retry.couponCode);
    setSearching(true);
    (async () => {
      try {
        const r = await runSlotSearch({
          serviceType: retry.form.serviceType,
          date: retry.form.date,
          durationHours: retry.form.durationHours,
        });
        // The cook who didn't respond shouldn't be offered again for this retry.
        const filtered = retry.excludeCookId
          ? r.available.filter((c) => {
              const id =
                c?.user?._id ||
                (typeof c?.user === "string" ? c.user : null) ||
                c?._id;
              return String(id || "") !== String(retry.excludeCookId);
            })
          : r.available;
        setMatches(filtered);
        setSlotOptions(aggregateSlots(filtered));
        setSlotSuggestions(r.suggestions);
        setTotalCooksFound(r.totalCooks);
        setSearched(true);
        const stillFree = (aggregateSlots(filtered)).some(
          (o) =>
            o.startTime === retry.selectedSlot.startTime &&
            o.endTime === retry.selectedSlot.endTime
        );
        if (stillFree && filtered.length > 0) {
          setSelectedSlot(retry.selectedSlot);
          setStep(3);
          showToast("The last cook didn't respond — pick another chef for the same slot.", "info");
        } else {
          setSelectedSlot(null);
          setStep(2);
          showToast("Pick a time again — that slot just filled up.", "info");
        }
      } catch {
        setStep(1);
        showToast("Your details were restored — tap See Time Slots to continue.", "info");
      } finally {
        setSearching(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One-tap retry from a suggestion chip: adopt the shorter hours, then
  // re-run the search immediately with the adopted value.
  const retryWithDuration = (h) => {
    const v = String(h);
    setForm((f) => ({ ...f, durationHours: v }));
    handleSeeSlots(null, v);
  };

  // Step 2 → 3: a time slot must be picked before cooks are shown.
  const handleChooseCook = async () => {
    if (!selectedSlot) {
      setFormError("Please pick a time slot first");
      return;
    }
    setFormError("");
    // Re-verify the picked slot is still free before showing cooks: a slot
    // listed in step 2 can fill up while the customer is picking (another
    // customer books the same hours). Drop cooks busy during the exact
    // [startTime, endTime] so step 3 shows only cooks free for those hours.
    setSearching(true);
    try {
      const verify = await API.get("/cooks", {
        params: {
          serviceType: form.serviceType,
          date: form.date,
          durationHours: form.durationHours,
          startTime: selectedSlot.startTime,
          endTime: selectedSlot.endTime,
        },
      });
      const fresh = Array.isArray(verify.data) ? verify.data : verify.data?.cooks || verify.data?.data || [];
      const freshIds = new Set(
        fresh.map((c) => String(c?.user?._id || (typeof c?.user === "string" ? c.user : null) || c?._id || ""))
      );
      const stillFree = matches.filter((c) => {
        const id = String(
          c?.user?._id || (typeof c?.user === "string" ? c.user : null) || c?._id || ""
        );
        if (!freshIds.has(id)) return false;
        return (c.slots || []).some(
          (s) => s.startTime === selectedSlot.startTime && s.endTime === selectedSlot.endTime
        );
      });
      setMatches(stillFree);
      setSlotOptions(aggregateSlots(stillFree));
      if (stillFree.length === 0) {
        setFormError("That slot just filled up — please pick another time.");
        setStep(2);
        return;
      }
    } catch {
      // Verification is best-effort: on network failure keep the step-2 list
      // (the server re-checks the exact window at booking creation).
    } finally {
      setSearching(false);
    }
    setStep(3);
  };

  // Cooks free at the step-2 slot, each carrying its matching slot object
  // for one-tap booking.
  // Slots built by aggregateSlots ({ startTime, endTime, freeCooks }) carry
  // no _id — key the per-card "Booking…" state by cook + slot time so only
  // the tapped card disables (keying by slot._id is always undefined, which
  // makes `undefined === undefined` true for EVERY card).
  const bookingKey = (cook, slot) => {
    const cookId =
      cook?.user?._id || (typeof cook?.user === "string" ? cook.user : null) || cook?._id || "";
    return `${cookId}_${slot?.startTime || ""}_${slot?.endTime || ""}`;
  };
  // Idempotency keys per booking attempt: retries (double-click, network
  // retry) reuse the same key so the server returns the original hold
  // instead of minting a duplicate. A new slot/cook gets a fresh key.
  const clientKeysRef = useRef(new Map());
  const clientKeyFor = (key) => {
    let k = clientKeysRef.current.get(key);
    if (!k) {
      try {
        k = (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : `ck_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      } catch {
        k = `ck_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      }
      clientKeysRef.current.set(key, k);
    }
    return k;
  };
  const cooksForSlot = selectedSlot
    ? matches
        .map((c) => ({
          ...c,
          slot: (c.slots || []).find(
            (s) =>
              s.startTime === selectedSlot.startTime &&
              s.endTime === selectedSlot.endTime
          ),
        }))
        .filter((c) => c.slot)
    : [];

  const handleBook = async (cook, slot) => {
    if (!user) {
      // Remember the unfinished booking across the login wall — form,
      // picked slot, pin and coupon code all come back after sign-in.
      saveBookingDraft({ kind: "on-demand", form, selectedSlot, coords, couponCode: coupon?.code || "" });
      setShowLoginModal(true);
      return;
    }
    if (user.role !== "customer") {
      showToast("Only customer accounts can make bookings", "error");
      return;
    }
    const venueErrs = validateVenue();
    if (Object.keys(venueErrs).length > 0) {
      setFieldErrors(venueErrs);
      setFormError("");
      focusFirstFieldError(venueErrs);
      return;
    }
    setFieldErrors({});
    setFormError("");
    setBookingLoading(bookingKey(cook, slot));
    try {
      // Last-second availability check: the slot card was rendered from the
      // step-2 search, but another customer may have booked this cook for the
      // same hours since. Re-verify the exact [startTime, endTime] is still
      // free so a busy cook can never be booked from a stale card.
      const cookIdForCheck =
        cook?.user?._id || (typeof cook?.user === "string" ? cook.user : null) || cook?._id;
      try {
        const chk = await API.get(`/availability/${encodeURIComponent(cookIdForCheck)}`, {
          params: { date: form.date, startTime: slot.startTime, endTime: slot.endTime },
        });
        if (chk?.data && typeof chk.data === "object" && "free" in chk.data && chk.data.free !== true) {
          setFormError(chk.data.reason || "This cook just got booked for those hours — please pick another cook or time.");
          // Refresh the cook list so the busy cook disappears immediately.
          try {
            const verify = await API.get("/cooks", {
              params: {
                serviceType: form.serviceType,
                date: form.date,
                durationHours: form.durationHours,
                startTime: selectedSlot.startTime,
                endTime: selectedSlot.endTime,
              },
            });
            const fresh = Array.isArray(verify.data) ? verify.data : verify.data?.cooks || verify.data?.data || [];
            const freshIds = new Set(
              fresh.map((c) => String(c?.user?._id || (typeof c?.user === "string" ? c.user : null) || c?._id || ""))
            );
            const stillFree = matches.filter((c) => {
              const id = String(c?.user?._id || (typeof c?.user === "string" ? c.user : null) || c?._id || "");
              if (!freshIds.has(id)) return false;
              return (c.slots || []).some(
                (s) => s.startTime === selectedSlot.startTime && s.endTime === selectedSlot.endTime
              );
            });
            setMatches(stillFree);
            setSlotOptions(aggregateSlots(stillFree));
          } catch {
            // ignore — the error above already explains the state
          }
          return;
        }
      } catch (chkErr) {
        // A 4xx here means the slot is invalid/gone — surface it. Network
        // failures fall through to the booking attempt (server re-checks).
        if (chkErr?.response?.status >= 400 && chkErr?.response?.status < 500) {
          setFormError(chkErr.response?.data?.message || "That slot is no longer free — please pick another time.");
          return;
        }
      }
      // No online payment — create the booking request directly, then take
      // the customer back to the available-cooks listing. Priced from the
      // launch slab (server recomputes + enforces it).
      const hours = Number(form.durationHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 4 || slab == null) {
        setFormError("Please choose 1, 2, 3 or 4 hours");
        scrollToVenueError();
        return;
      }
      const payload = {
        cook: cook?.user?._id || (typeof cook?.user === "string" ? cook.user : null) || cook?._id,
        serviceType: form.serviceType,
        date: form.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        address: buildAddress(),
        addressDetails: {
          flatNo: form.flatNo.trim(),
          society: form.society.trim(),
          landmark: form.landmark.trim(),
          city: form.city.trim(),
        },
        guests: Number(form.guests),
        durationHours: hours,
        notes: form.notes.trim(),
        selectedItems: buildSelectedItems(),
        couponCode: coupon?.code || "",
        amount: finalPayable,
      };
      if (coords) payload.location = coords;
      payload.clientKey = clientKeyFor(`${form.date}_${slot.startTime}_${slot.endTime}_${payload.cook}`);
      const res = await API.post("/bookings", payload);
      // Idempotent retry: the server returns the original hold with
      // alreadyExists instead of a duplicate — treat it as success.
      clearBookingDraft();
      showToast("Booking request sent! Your slot is held for 5 minutes while the cook decides.", "success");
      // Live waiting screen while the cook decides (5-minute window).
      navigate(`/bookings/${res.data?._id}/wait`);
    } catch (err) {
      showToast(err.response?.data?.message || err.message || "Booking failed", "error");
    } finally {
      setBookingLoading(null);
    }
  };

  const steps = [
    { label: "Plan", desc: "Service, date & hours" },
    { label: "Time Slot", desc: "Pick when" },
    { label: "Venue & Cook", desc: "Address & book" },
  ];

  return (
    <div className={`ondemand-page od-modern od-step-${step}`}>
      <div className="od-hero">
        <div className="od-hero-text">
          <span className="od-eyebrow">
            <Sparkles size={12} /> Instant booking
          </span>
          <h1 className="od-title">Book a Cook</h1>
          <p className="od-sub">
            <ShieldCheck size={13} />
            <span className="od-sub-text">
              Verified home cooks · Same launch price for all
            </span>
          </p>
        </div>
        {slab != null && (
          <div className="od-hero-price" aria-live="polite">
            <span>{form.durationHours || "–"} hr{Number(form.durationHours) === 1 ? "" : "s"}</span>
            <strong>{formatCurrency(finalPayable)}</strong>
          </div>
        )}
      </div>

      <ol className="od-steps-modern" aria-label="Booking progress">
        {steps.map((s, i) => {
          const n = i + 1;
          const state = step > n ? "done" : step === n ? "active" : "";
          return (
            <li
              key={s.label}
              className={`od-step-item ${state}`}
              aria-current={step === n ? "step" : undefined}
            >
              <span className="od-step-num" aria-hidden="true">
                {step > n ? <Check size={13} /> : n}
              </span>
              <span className="od-step-text">
                <span className="od-step-name">{s.label}</span>
                <span className="od-step-desc">{s.desc}</span>
              </span>
              {i < steps.length - 1 && <span className="od-step-link" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>

      {/* Live recap once planning starts */}
      {(step > 1 || selectedSlot) && (
        <div className="od-livebar" aria-live="polite">
          {step > 1 && (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => setStep(step - 1)}
            >
              <ArrowLeft size={15} /> Go Back
            </button>
          )}
          <span className="od-livechip">{serviceLabel}</span>
          <span className="od-livechip">{dateLabel(form.date)}</span>
          <span className="od-livechip">{form.durationHours || "–"} hr · {form.guests || "–"} guests</span>
          {selectedSlot && (
            <span className="od-livechip od-livechip-strong">
              {fmtTime(selectedSlot.startTime)} – {fmtTime(selectedSlot.endTime)}
            </span>
          )}
          {slab != null && <span className="od-livechip od-livechip-price">{formatCurrency(slab)}</span>}
        </div>
      )}

      {step === 1 && (
        <form onSubmit={handleSeeSlots} className="ondemand-form-card">
          <h3>Step 1 — Plan your session</h3>
          <SecTitle n="01" icon={<ChefHat size={15} />}>Which service do you need?</SecTitle>
          <p className="ondemand-form-sub">Same launch price for every service — pick what fits today.</p>
          <div className="service-pick-grid">
            {SERVICE_OPTIONS.map((s) => (
              <button
                type="button"
                key={s.id}
                className={`service-pick-card ${form.serviceType === s.id ? "selected" : ""}`}
                onClick={() => setForm({ ...form, serviceType: s.id })}
              >
                <span className="service-pick-check" aria-hidden="true">
                  {form.serviceType === s.id && <CheckCircle2 size={18} />}
                </span>
                <span className="service-pick-icon">{s.icon}</span>
                <strong>{s.label}</strong>
                <span>{s.desc}</span>
              </button>
            ))}
          </div>

          <SecTitle n="02" icon={<CalendarCheck size={15} />}>When and for how many?</SecTitle>

          <div className="form-row">
            <div className="form-group">
              <label>
                <CalendarCheck size={15} /> Preferred Date
              </label>
              <div className="od-date-pick-row">
                <div className="od-presets" role="group" aria-label="Quick dates">
                  <button
                    type="button"
                    className={`bk-dur-chip ${form.date === localTodayStr() ? "active" : ""}`}
                    onClick={() => setForm({ ...form, date: localTodayStr() })}
                  >
                    Today
                  </button>
                  <button
                    type="button"
                    className={`bk-dur-chip ${form.date === localTomorrowStr() ? "active" : ""}`}
                    onClick={() => setForm({ ...form, date: localTomorrowStr() })}
                  >
                    Tomorrow
                  </button>
                </div>
                <CustomCalendar
                  id="cookbooking-date"
                  value={form.date}
                  min={localTodayStr()}
                  onChange={(d) => setForm({ ...form, date: d })}
                />
              </div>
            </div>
            <div className="form-group">
              <label>
                <Users size={15} /> Cook for how many people? *
              </label>
              <div className="od-stepper">
                <button
                  type="button"
                  className="od-step-btn"
                  aria-label="Fewer people"
                  onClick={() => adjustNumber("guests", -1, { min: 1, max: 500, step: 1 })}
                >
                  <Minus size={16} />
                </button>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  name="guests"
                  className="form-control"
                  value={form.guests}
                  onChange={handleChange}
                  min={1}
                  max={500}
                  required
                  aria-label="Number of people"
                />
                <button
                  type="button"
                  className="od-step-btn"
                  aria-label="More people"
                  onClick={() => adjustNumber("guests", 1, { min: 1, max: 500, step: 1 })}
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>
          </div>

          <SecTitle n="03" icon={<Clock3 size={15} />}>How long do you need the cook?</SecTitle>

          <div className="form-row">
            <div className="form-group">
              <div className="bk-price-strip" aria-label="Launch pricing">
                <span className="bk-price-badge">
                  <BadgePercent size={13} /> Launch pricing · flat for every cook
                </span>
                <div className="bk-price-cells">
                  {DURATION_QUICK.map((h) => {
                    const active = Number(form.durationHours) === h;
                    return (
                      <button
                        key={h}
                        type="button"
                        aria-pressed={active}
                        className={`bk-price-cell ${active ? "active" : ""}`}
                        onClick={() => setForm({ ...form, durationHours: String(h) })}
                        title={`Select ${h} hour${h > 1 ? "s" : ""}`}
                      >
                        <span>{h} hr{h > 1 ? "s" : ""}</span>
                        <strong>{formatCurrency(LAUNCH_SLAB_PRICES[h])}</strong>
                      </button>
                    );
                  })}
                </div>
                <span className="bk-price-note">Flat rate · same for every cook &amp; service · no payment now</span>
              </div>
            </div>
          </div>

          {formError && <div className="error-message">{formError}</div>}

          <div className="od-stickybar">
            <div className="od-summary" aria-live="polite">
              <span>{serviceLabel}</span>
              <span>{dateLabel(form.date)}</span>
              <span>{form.durationHours || "–"} hr · {form.guests || "–"} guests</span>
              <strong className="od-summary-price">{slab != null ? formatCurrency(slab) : "—"}</strong>
            </div>
            <button type="submit" className="btn btn-primary btn-block btn-lg od-cta" disabled={searching}>
              {searching ? "Finding free cooks..." : (
                <>
                  <Clock3 size={17} /> See Time Slots <ArrowRight size={17} />
                </>
              )}
            </button>
            <p className="od-sticky-note">Free to check · no address needed yet · no payment now</p>
          </div>
        </form>
      )}

      {step === 2 && (
        <div className="ondemand-form-card">
          <h3>Step 2 — Pick a time slot</h3>
          {searched && slotOptions.length === 0 && (
            <div className="no-data">
              <p>
                {totalCooksFound === 0
                  ? "No cooks offer this service yet — try another service."
                  : slotSuggestions.length > 0
                    ? `No ${form.durationHours}-hour slots on this date — but shorter sessions are free.`
                    : "No free slots on this date — try another date or duration."}
              </p>
              {slotSuggestions.length > 0 && (
                <div className="od-suggest-row" role="group" aria-label="Durations with free slots">
                  {slotSuggestions.map((h) => (
                    <button
                      key={h}
                      type="button"
                      className="bk-dur-chip"
                      onClick={() => retryWithDuration(h)}
                    >
                      Try {h} hr{h === 1 ? "" : "s"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {slotOptions.length > 0 && (
            <>
              <div role="radiogroup" aria-label="Available time slots">
                {["Morning", "Afternoon", "Evening"]
                  .map((part) => ({
                    part,
                    slots: slotOptions.filter((o) => slotPart(o.startTime) === part),
                  }))
                  .filter((g) => g.slots.length > 0)
                  .map((g) => {
                    // Collapsed groups show only the first few starts; a slot
                    // picked while expanded stays visible after collapsing.
                    const isSelected = (o) =>
                      !!selectedSlot &&
                      o.startTime === selectedSlot.startTime &&
                      o.endTime === selectedSlot.endTime;
                    let visibleSlots = g.slots;
                    if (!showAllSlots && g.slots.length > TOP_SLOTS_COUNT) {
                      const head = g.slots.slice(0, TOP_SLOTS_COUNT);
                      if (selectedSlot && g.slots.some(isSelected) && !head.some(isSelected)) {
                        visibleSlots = [...head, g.slots.find(isSelected)];
                      } else {
                        visibleSlots = head;
                      }
                    }
                    return (
                      <div key={g.part} className="od-slot-group">
                        <p className="od-slot-group-title">
                          <Clock3 size={13} /> {g.part}
                          <span> · {g.slots.length} slot{g.slots.length > 1 ? "s" : ""}</span>
                        </p>
                        <div className="slot-list slot-list-pick">
                          {visibleSlots.map((o) => {
                            const active = isSelected(o);
                            const recommended =
                              !!recommendedSlot &&
                              recommendedSlot.startTime === o.startTime &&
                              recommendedSlot.endTime === o.endTime;
                            return (
                              <button
                                key={`${o.startTime}-${o.endTime}`}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                aria-label={`${recommended ? "Recommended. " : ""}${fmtTime(o.startTime)} to ${fmtTime(o.endTime)}, ${o.freeCooks} ${o.freeCooks === 1 ? "cook" : "cooks"} free`}
                                className={`slot-chip slot-chip-pick ${active ? "selected" : ""} ${recommended ? "recommended" : ""}`}
                                onClick={() => {
                                  setSelectedSlot({ startTime: o.startTime, endTime: o.endTime });
                                  setFormError("");
                                }}
                              >
                                {recommended && <span className="slot-chip-rec">★ Recommended</span>}
                                <span className="slot-chip-main">{fmtTimeCompact(o.startTime)}</span>
                                <span className="slot-chip-end">to {fmtTimeCompact(o.endTime)}</span>
                                <span className="slot-chip-cooks">
                                  {o.freeCooks} {o.freeCooks === 1 ? "cook" : "cooks"} free
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
              </div>
              {slotOptions.length > TOP_SLOTS_COUNT && (
                <button
                  type="button"
                  className="slot-toggle-btn"
                  aria-expanded={showAllSlots}
                  onClick={() => setShowAllSlots((v) => !v)}
                >
                  {showAllSlots ? "Show fewer times" : `Show all ${slotOptions.length} times`}
                </button>
              )}
            </>
          )}

          {formError && <div className="error-message">{formError}</div>}

          <div className="od-stickybar">
            <div className="od-summary" aria-live="polite">
              {selectedSlot ? (
                <>
                  <span>{fmtTime(selectedSlot.startTime)} – {fmtTime(selectedSlot.endTime)}</span>
                  <strong className="od-summary-price">{slab != null ? formatCurrency(slab) : "—"}</strong>
                </>
              ) : (
                <span className="od-missing">Tap a time slot above to continue</span>
              )}
            </div>
            <button
              type="button"
              className="btn btn-primary btn-block btn-lg od-cta"
              disabled={!selectedSlot || searching}
              onClick={handleChooseCook}
            >
              {searching ? "Checking live availability…" : <>Choose Cook <ArrowRight size={17} /></>}
            </button>
          </div>
        </div>
      )}

      {step === 3 && selectedSlot && (
        <div>
          <h3>Step 3 — Venue &amp; Cook</h3>
          <div className="ondemand-form-card od-venue-card">
            <SecTitle n="04" icon={<MapPin size={15} />}>Where should the cook come?</SecTitle>
            <div className="ondemand-locate-box">
              {savedLocations.length > 0 && (
                <div className="form-group">
                  <label>
                    <History size={15} /> Use previous location
                  </label>
                  <select
                    className="form-control"
                    value={savedIdx}
                    onChange={(e) => applySavedLocation(e.target.value)}
                  >
                    <option value="">Select from your past bookings...</option>
                    {savedLocations.map((s, i) => (
                      <option key={i} value={i}>
                        {s.address}{s.timesUsed > 1 ? ` (used ${s.timesUsed}x)` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {locMsg && (
                <p className="loc-msg warn">
                  {locMsg}
                </p>
              )}
              {coords && (
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label htmlFor="maps-link-input">
                    <MapPin size={15} /> Google Maps link of your location
                  </label>
                  <div className="maps-link-group">
                    <input
                      id="maps-link-input"
                      type="text"
                      className="form-control"
                      value={mapsLink}
                      readOnly
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={handleCopyLink}
                    >
                      {copied ? (
                        <>
                          <Check size={15} /> Copied
                        </>
                      ) : (
                        "Copy"
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
            {profileAddress && !addrEditing ? (
              <div className="bk-profile-addr">
                <MapPin size={16} />
                <div className="bk-profile-addr-text">
                  <strong>Using your profile address</strong>
                  <span>{addrSummary}</span>
                </div>
                <button
                  type="button"
                  className="bk-recap-edit"
                  onClick={() => setAddrEditing(true)}
                  aria-label="Edit address"
                >
                  <Pencil size={12} /> Edit
                </button>
              </div>
            ) : (
            <>
            <div className="form-row">
              <div className="form-group">
                <label>
                  <HomeIcon size={15} /> Flat / House No. *
                </label>
                <input
                  type="text"
                  name="flatNo"
                  className="form-control"
                  value={form.flatNo}
                  onChange={handleChange}
                  placeholder="e.g. Flat 402, Wing B"
                  required
                  ref={(el) => { fieldRefs.current.flatNo = el; }}
                  aria-invalid={Boolean(fieldErrors.flatNo)}
                />
                {fieldErrors.flatNo && <p className="field-error" role="alert">{fieldErrors.flatNo}</p>}
              </div>
              <div className="form-group">
                <label>
                  <Building2 size={15} /> Society / Building / Street *
                </label>
                <input
                  type="text"
                  name="society"
                  className="form-control"
                  value={form.society}
                  onChange={handleChange}
                  placeholder="e.g. Sunshine Society, MG Road"
                  required
                  ref={(el) => { fieldRefs.current.society = el; }}
                  aria-invalid={Boolean(fieldErrors.society)}
                />
                {fieldErrors.society && <p className="field-error" role="alert">{fieldErrors.society}</p>}
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>
                  <Landmark size={15} /> Landmark <small>(optional)</small>
                </label>
                <input
                  type="text"
                  name="landmark"
                  className="form-control"
                  value={form.landmark}
                  onChange={handleChange}
                  placeholder="e.g. Near City Mall"
                />
              </div>
              <div className="form-group">
                <label>
                  <MapPin size={15} /> City / Area *
                </label>
                <input
                  type="text"
                  name="city"
                  className="form-control"
                  value={form.city}
                  onChange={handleChange}
                  placeholder="e.g. Pune"
                  required
                  ref={(el) => { fieldRefs.current.city = el; }}
                  aria-invalid={Boolean(fieldErrors.city)}
                />
                {fieldErrors.city && <p className="field-error" role="alert">{fieldErrors.city}</p>}
              </div>
            </div>
            </>
            )}

            <SecTitle n="05" icon={<UtensilsCrossed size={15} />}>What dishes do you need? *</SecTitle>
            <div className="form-group">
              <label>Dishes <small>(comma separated)</small></label>
                <input
                  type="text"
                  name="customDishes"
                  className="form-control"
                  value={form.customDishes}
                  onChange={handleChange}
                  placeholder="e.g. Puran Poli, Shankarpali, Modak"
                  required
                  ref={(el) => { fieldRefs.current.customDishes = el; }}
                  aria-invalid={Boolean(fieldErrors.customDishes)}
                />
                {fieldErrors.customDishes && <p className="field-error" role="alert">{fieldErrors.customDishes}</p>}
              </div>

            <div className="form-group">
              <label>
                <StickyNote size={15} /> Notes <small>(optional)</small>
              </label>
              <textarea
                name="notes"
                className="form-control"
                value={form.notes}
                onChange={handleChange}
                placeholder="Spice level, dietary needs..."
                rows={3}
              />
            </div>

            <SecTitle n="06" icon={<BadgePercent size={15} />}>Price &amp; coupon</SecTitle>
            <div className="price-rows">
              <div className="price-row">
                <span>Service Price · {form.durationHours} hr{Number(form.durationHours) === 1 ? "" : "s"}</span>
                <span>{slab != null ? formatCurrency(slab) : "—"}</span>
              </div>
              {coupon && (
                <div className="price-row discount">
                  <span>Coupon {coupon.code}</span>
                  <span>−{formatCurrency(couponDiscount)}</span>
                </div>
              )}
              <div className="price-row total">
                <span>Final Amount</span>
                <strong>{slab != null ? formatCurrency(finalPayable) : "—"}</strong>
              </div>
            </div>
            {slab != null && (
              <CouponApply
                amount={slab}
                serviceType={form.serviceType}
                onApplied={setCoupon}
                initialCode={couponRestore}
              />
            )}

            {user?.phone && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem", color: "var(--slate-600)", background: "var(--slate-50)", borderRadius: "var(--radius-md)", padding: "0.6rem 0.9rem" }}>
                <MessageCircle size={15} style={{ color: "var(--accent-emerald)", flexShrink: 0 }} />
                <span>Booking on mobile <strong>+91 {user.phone}</strong> — shared with the cook for coordination.</span>
              </div>
            )}

            {formError && <div ref={venueErrorRef} className="error-message">{formError}</div>}
          </div>
          <div className="match-results-head">
            <h3 className="match-count-title">
              {cooksForSlot.length > 0
                ? `${cooksForSlot.length} cook${cooksForSlot.length > 1 ? "s" : ""} free ${fmtTime(selectedSlot.startTime)} – ${fmtTime(selectedSlot.endTime)} on ${form.date}`
                : `No cooks free ${fmtTime(selectedSlot.startTime)} – ${fmtTime(selectedSlot.endTime)} on ${form.date}`}
            </h3>
          </div>
          {cooksForSlot.length === 0 && (
            <div className="no-data">
              <p>That slot just filled up — pick another time.</p>
              <button className="btn btn-outline btn-sm" onClick={() => setStep(2)}>
                ← Back to slots
              </button>
            </div>
          )}
          <div className="bookings-list">
            {cooksForSlot.map((cook) => {
              const fee = finalPayable;
              return (
                <div key={cook._id} className="match-card">
                  <div className="match-card-top">
                    <div className="match-avatar">
                      <CookAvatar
                        photoUrl={cook.photoUrl}
                        name={cook.user?.name}
                        loading="lazy"
                      />
                    </div>
                    <div className="match-id">
                      <h3>{cook.user?.name}</h3>
                      <p className="match-meta">
                        {cook.serviceArea} • {cook.experienceYears} yrs exp • ★{" "}
                        {cook.rating?.average?.toFixed(1) || "New"} ({cook.rating?.count || 0} reviews)
                      </p>
                    </div>
                    <span className="match-rate" title={`Launch price · ${form.durationHours} hr`}>
                      {slab != null ? formatCurrency(slab) : `₹${cook.rate}/hr`}
                    </span>
                  </div>
                  <div className="tags">
                    {cook.specialties?.slice(0, 4).map((s, i) => (
                      <span key={i} className="tag">{s}</span>
                    ))}
                  </div>
                  <div className="od-bookbox">
                    <div className="od-bookslot">
                      <span className="od-bookslot-time">
                        <Clock3 size={15} /> {fmtTime(cook.slot.startTime)} – {fmtTime(cook.slot.endTime)}
                      </span>
                      <span className="od-bookfee">{formatCurrency(fee)} total</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary btn-block btn-lg od-bookbtn"
                      disabled={bookingLoading === bookingKey(cook, cook.slot)}
                      onClick={() => handleBook(cook, cook.slot)}
                      title={`Book ${cook.user?.name || "this cook"} for ${formatCurrency(fee)}`}
                    >
                      {bookingLoading === bookingKey(cook, cook.slot)
                        ? <span className="bk-submit-loading">Booking…</span>
                        : <>Book {(cook.user?.name || "Cook").split(" ")[0]} <ArrowRight size={17} /></>}
                    </button>
                  </div>
                  {!user && (
                    <p className="field-hint">
                      <LogIn size={13} /> Login as a customer to book this slot
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <LoginPromptModal
        open={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        returnTo={`/cook-on-demand${initialService !== "cook_for_me" ? `?serviceType=${initialService}` : ""}`}
      />
    </div>
  );
};

export default CookBooking;
