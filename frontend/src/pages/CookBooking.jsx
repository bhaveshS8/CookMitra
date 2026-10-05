import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import {
  Users,
  CalendarCheck,
  MapPin,
  UtensilsCrossed,
  StickyNote,
  LogIn,
  Check,
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
import { useDispatch, useSelector } from "react-redux";
import { updateUser } from "../store/authSlice";
import { useShowToast, useSiteLocation } from "../store/hooks";
import { saveBookingDraft, loadBookingDraft, clearBookingDraft } from "../utils/bookingDraft";

import LoginPromptModal from "../components/LoginPromptModal";

const DEFAULT_SERVICE_TYPE = "cook_for_me";

const DURATION_QUICK = [1, 2, 3, 4];

const SERVICE_START_MIN = 8 * 60;
const SERVICE_END_MIN = 20 * 60;

const toMinutes = (t) => {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

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

const isSlotInPast = (dateStr, startTime, now = new Date()) => {
  if (dateStr !== localTodayStr()) return false;
  const s = toMinutes(startTime);
  if (s == null) return false;
  return s <= now.getHours() * 60 + now.getMinutes();
};

const slotPart = (startTime) => {
  const m = toMinutes(startTime);
  if (m == null) return "Slots";
  if (m < 12 * 60) return "Morning";
  if (m < 16 * 60) return "Afternoon";
  return "Evening";
};

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

const pickRecommendedSlot = (options) => {
  if (!options || options.length === 0) return null;
  return options.reduce((best, o) => {
    const d = o.freeCooks - best.freeCooks;
    if (d > 0) return o;
    if (d === 0 && toMinutes(o.startTime) < toMinutes(best.startTime)) return o;
    return best;
  });
};

const dateLabel = (dateStr) => {
  if (!dateStr) return "Pick a date";
  if (dateStr === localTodayStr()) return "Today";
  if (dateStr === localTomorrowStr()) return "Tomorrow";
  return dateStr;
};

const SecTitle = ({ icon, children }) => (
  <h3 className="ondemand-section-title">
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

  const [step, setStep] = useState(1);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }, [step]);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [step]);
  const [form, setForm] = useState({
    serviceType: DEFAULT_SERVICE_TYPE,
    date: localTodayStr(),
    flatNo: "",
    society: "",
    landmark: "",
    city: "",
    guests: "4",
    durationHours: "1",
    customDishes: "",
    notes: "",
  });
  const [formError, setFormError] = useState("");
  const [matches, setMatches] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [findingCook, setFindingCook] = useState(false);
  const [locMsg, setLocMsg] = useState("");
  const [coords, setCoords] = useState(null);
  const [copied, setCopied] = useState(false);
  const [savedLocations, setSavedLocations] = useState([]);
  const [savedLoaded, setSavedLoaded] = useState(false);
  const [savedIdx, setSavedIdx] = useState("");
  const autoFilled = useRef(false);
  const explicitPlacePick = useRef(false);
  const venueErrorRef = useRef(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const scrollToVenueError = () =>
    requestAnimationFrame(() =>
      venueErrorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })
    );
  const [slotOptions, setSlotOptions] = useState([]);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [coupon, setCoupon] = useState(null);
  const [couponRestore, setCouponRestore] = useState(null);
  const [slotSuggestions, setSlotSuggestions] = useState([]);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (form.date !== localTodayStr()) return undefined;
    setNowTick(Date.now());
    const id = setInterval(() => setNowTick(Date.now()), 30000);
    const onWake = () => {
      if (!document.hidden) setNowTick(Date.now());
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
    };
  }, [form.date]);

  const visibleSlotOptions = useMemo(() => {
    const now = new Date(nowTick);
    return slotOptions.filter((o) => !isSlotInPast(form.date, o.startTime, now));
  }, [slotOptions, form.date, nowTick]);

  const recommendedSlot = useMemo(() => pickRecommendedSlot(visibleSlotOptions), [visibleSlotOptions]);
  const [totalCooksFound, setTotalCooksFound] = useState(null);

  useEffect(() => {
    const hasFix =
      Number.isFinite(siteLocation?.lat) && Number.isFinite(siteLocation?.lng);
    if (!hasFix && !siteLocation?.city && !siteLocation?.area && !siteLocation?.state) return;
    if (hasFix && !explicitPlacePick.current) {
      setCoords((c) => c || { lat: siteLocation.lat, lng: siteLocation.lng });
    }
    if (!siteLocation?.city && !siteLocation?.area && !siteLocation?.state) return;
    const stamp = Number(siteLocation?.savedAt || siteLocation?.timestamp || 0);
    if (stamp && Date.now() - stamp > 12 * 60 * 60 * 1000) return;
    if (autoFilled.current) return;
    if (user?.role === "customer") {
      const profileAddr = String(user?.address || "").trim();
      if (profileAddr || savedLocations.length > 0 || user?.address === undefined || !savedLoaded) return;
    }
    autoFilled.current = true;
    setForm((f) => {
      if (f.flatNo || f.society || f.landmark || f.city) return f;
      const exact = siteLocation.hasHouseNumber ? (siteLocation.exactLine || "").trim() : "";
      return {
        ...f,
        flatNo: exact || f.flatNo,
        city: f.city.trim() ? f.city : siteLocation.city || "",
        society: f.society.trim() ? f.society : siteLocation.area || "",
        landmark: f.landmark.trim() ? f.landmark : siteLocation.street || siteLocation.area || "",
      };
    });
  }, [siteLocation?.city, siteLocation?.area, siteLocation?.state, siteLocation?.street, siteLocation?.exactLine, siteLocation?.hasHouseNumber, siteLocation?.timestamp, siteLocation?.savedAt, siteLocation?.lat, siteLocation?.lng, user?.role, user?.address, savedLoaded, savedLocations]);

  const profileAddress = String(user?.address || "").trim();
  const [addrEditing, setAddrEditing] = useState(false);
  const addrSummary =
    [form.flatNo, form.society, form.landmark ? `Near ${form.landmark}` : "", form.city]
      .map((p) => String(p || "").trim())
      .filter(Boolean)
      .join(", ") || profileAddress;

  const dispatch = useDispatch();
  useEffect(() => {
    if (user?.role !== "customer" || user?.address !== undefined) return;
    let cancelled = false;
    API.get("/auth/me")
      .then((res) => { if (!cancelled) dispatch(updateUser({ name: res.data?.name, phone: res.data?.phone, address: res.data?.address ?? "" })); })
      .catch(() => { if (!cancelled) dispatch(updateUser({ address: "" })); });
    return () => { cancelled = true; };
  }, [user?.role, user?.address, dispatch]);

  useEffect(() => {
    if (user?.role !== "customer") { setSavedLoaded(true); return; }
    let cancelled = false;
    API.get("/bookings/my/locations")
      .then((res) => {
        if (!cancelled) { setSavedLocations(res.data || []); setSavedLoaded(true); }
      })
      .catch(() => {
        if (!cancelled) { setSavedLocations([]); setSavedLoaded(true); }
      });
    return () => {
      cancelled = true;
    };
  }, [user?.role]);

  const applySavedLocation = (idx) => {
    const saved = savedLocations[Number(idx)];
    if (!saved) return;
    explicitPlacePick.current = true;
    const d = saved.addressDetails || {};
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
      setCoords(null);
      setLocMsg("Previous location applied — verify the address below for precise navigation");
    }
  };

  useEffect(() => {
    if (autoFilled.current || user?.role !== "customer") return;
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
      autoFilled.current = true;
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
    if (user?.address === undefined || !savedLoaded) return;
    if (savedLocations.length === 0) return;
    autoFilled.current = true;
    fill(savedLocations[0].addressDetails || {});
    setSavedIdx("0");
    if (savedLocations[0].location?.lat != null) {
      setCoords({ lat: savedLocations[0].location.lat, lng: savedLocations[0].location.lng });
    }
  }, [savedLocations, savedLoaded, user?.role, user?.address]);

  const mapsLink = coords
    ? `https://www.google.com/maps?q=${coords.lat},${coords.lng}`
    : "";

  const serviceLabel = "Home cooking session";

  const slab = slabPriceForDuration(Number(form.durationHours));
  const couponDiscount = slab != null && coupon ? Math.min(coupon.discount, slab) : 0;
  const finalPayable = slab != null ? Math.max(0, slab - couponDiscount) : 0;

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
    setForm((f) => ({ ...f, ...d.form, serviceType: DEFAULT_SERVICE_TYPE }));
    if (d.coords?.lat != null) setCoords(d.coords);
    if (d.couponCode) setCouponRestore(d.couponCode);
    setSearching(true);
    (async () => {
      try {
        const r = await runSlotSearch({
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
          showToast("Welcome back — your booking is restored. Just tap Find Cook.", "success");
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
    if (fieldErrors[name]) {
      setFieldErrors((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

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
    [
      form.flatNo.trim(),
      form.society.trim(),
      form.landmark.trim() ? `Near ${form.landmark.trim()}` : "",
      form.city.trim(),
    ]
      .filter(Boolean)
      .join(", ");
  const hasVenue =
    form.flatNo.trim() || form.society.trim() || form.city.trim();
  const reviewDishes = parseDishes();
  const scrollToVenue = () => {
    setAddrEditing(true);
    requestAnimationFrame(() =>
      document
        .querySelector(".od-venue-card")
        ?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
  };
  const focusDishes = () => {
    scrollToVenue();
    requestAnimationFrame(() => fieldRefs.current.customDishes?.focus());
  };

  const buildSelectedItems = () => parseDishes();

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

  const runSlotSearch = async ({ date, durationHours }) => {
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
      return runSlotSearchLegacy({ date, durationHours });
    }
  };

  const runSlotSearchLegacy = async ({ date, durationHours }) => {
    const cooksRes = await API.get("/cooks");
    const rawCooks = cooksRes.data;
    const cooks = Array.isArray(rawCooks) ? rawCooks : rawCooks?.cooks || rawCooks?.data || [];
    const suggested = new Set();
    let failedCooks = 0;
    const withSlots = await Promise.all(
      cooks.map(async (cook) => {
        const cookId =
          cook?.user?._id ||
          (typeof cook?.user === "string" ? cook.user : null) ||
          cook?._id;
        if (!cookId) {
          failedCooks += 1;
          return { ...cook, slots: [] };
        }
        try {
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
        date: form.date,
        durationHours: effDuration,
      });
      if (totalCooks > 0 && failedCooks >= totalCooks) {
        throw new Error("Could not load time slots. Try again.");
      }
      setMatches(available);
      setSlotOptions(options);
      setSlotSuggestions(suggestions);
      setTotalCooksFound(totalCooks);
      setSelectedSlot(null);
      setSearched(true);
      setStep(2);
      if (available.length === 0) {
        showToast(
          totalCooks === 0
            ? "No cooks available yet — please try another date"
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

  const retryHandled = useRef(false);
  useEffect(() => {
    const retry = location.state?.retryFromBooking;
    if (!retry || retryHandled.current) return;
    retryHandled.current = true;
    try {
      window.history.replaceState({}, "");
    } catch {
    }
    if (!retry.form?.date || !retry.selectedSlot) {
      return;
    }
    autoFilled.current = true;
    setForm((f) => ({ ...f, ...retry.form, serviceType: DEFAULT_SERVICE_TYPE }));
    if (retry.coords?.lat != null) setCoords(retry.coords);
    if (retry.couponCode) setCouponRestore(retry.couponCode);
    setSearching(true);
    (async () => {
      try {
        const r = await runSlotSearch({
          date: retry.form.date,
          durationHours: retry.form.durationHours,
        });
        setMatches(r.available);
        setSlotOptions(aggregateSlots(r.available));
        setSlotSuggestions(r.suggestions);
        setTotalCooksFound(r.totalCooks);
        setSearched(true);
        const stillFree = (aggregateSlots(r.available)).some(
          (o) =>
            o.startTime === retry.selectedSlot.startTime &&
            o.endTime === retry.selectedSlot.endTime
        );
        if (stillFree && r.available.length > 0) {
          setSelectedSlot(retry.selectedSlot);
          setStep(3);
          showToast("No cook accepted last time — review your booking and tap Find Cook to try again.", "info");
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

  const retryWithDuration = (h) => {
    const v = String(h);
    setForm((f) => ({ ...f, durationHours: v }));
    handleSeeSlots(null, v);
  };

  const handleContinueToSummary = async () => {
    if (!selectedSlot) {
      setFormError("Please pick a time slot first");
      return;
    }
    setFormError("");
    setSearching(true);
    try {
      const verify = await API.get("/cooks", {
        params: {
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
    } finally {
      setSearching(false);
    }
    setStep(3);
  };

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

  const handleFindCook = async () => {
    if (findingCook) return;
    if (!user) {
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
    setFindingCook(true);
    try {
      const hours = Number(form.durationHours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 4 || slab == null) {
        setFormError("Please choose 1, 2, 3 or 4 hours");
        scrollToVenueError();
        return;
      }
      if (!selectedSlot?.startTime || !selectedSlot?.endTime) {
        setFormError("Please pick a time slot first");
        setStep(2);
        return;
      }
      const payload = {
        serviceType: DEFAULT_SERVICE_TYPE,
        date: form.date,
        startTime: selectedSlot.startTime,
        endTime: selectedSlot.endTime,
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
      };
      if (coords) payload.location = coords;
      payload.clientKey = clientKeyFor(`${form.date}_${selectedSlot.startTime}_${selectedSlot.endTime}`);
      const res = await API.post("/bookings", payload);
      clearBookingDraft();
      showToast("Finding a cook for you — we're contacting available cooks now.", "success");
      navigate(`/bookings/${res.data?._id}/wait`);
    } catch (err) {
      const msg = err.response?.data?.message || err.message || "Booking failed";
      if (err.response?.status === 409) {
        setFormError(`${msg} Please pick another time.`);
      } else {
        showToast(msg, "error");
      }
    } finally {
      setFindingCook(false);
    }
  };

  const steps = [
    { label: "Plan", desc: "Date & hours" },
    { label: "Time Slot", desc: "Pick when" },
    { label: "Venue & Confirm", desc: "Address & find cook" },
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

      {step > 1 && (
        <div className="od-gobar">
          <button
            type="button"
            className="od-goback"
            aria-label={`Go back to step ${step - 1} of ${steps.length}: ${steps[step - 2].label}`}
            onClick={() => { setFormError(""); setStep(step - 1); window.scrollTo({ top: 0, behavior: "smooth" }); }}
          >
            <ArrowLeft size={16} aria-hidden="true" /> Go Back
          </button>
        </div>
      )}

      {step === 1 && (
        <form onSubmit={handleSeeSlots} className="ondemand-form-card">
          <h3>Plan your session</h3>
          <p className="ondemand-form-sub">Same launch price for every cook — pick a date and duration.</p>

          <SecTitle icon={<CalendarCheck size={15} />}>When and for how many?</SecTitle>

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

          <SecTitle icon={<Clock3 size={15} />}>How long do you need the cook?</SecTitle>

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
                <span className="bk-price-note">Flat rate · same for every cook · no payment now</span>
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
          <h3>Pick a time slot</h3>
          {searched && visibleSlotOptions.length === 0 && (
            <div className="no-data">
              <p>
                {totalCooksFound === 0
                  ? "No cooks available yet — please try another date."
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
          {visibleSlotOptions.length > 0 && (
            <div role="radiogroup" aria-label="Available time slots">
              {["Morning", "Afternoon", "Evening"]
                .map((part) => ({
                  part,
                  slots: visibleSlotOptions.filter((o) => slotPart(o.startTime) === part),
                }))
                .filter((g) => g.slots.length > 0)
                .map((g) => {
                  const isSelected = (o) =>
                    !!selectedSlot &&
                    o.startTime === selectedSlot.startTime &&
                    o.endTime === selectedSlot.endTime;
                  return (
                    <div key={g.part} className="od-slot-group">
                      <p className="od-slot-group-title">
                        <Clock3 size={13} /> {g.part}
                        <span> · {g.slots.length} slot{g.slots.length > 1 ? "s" : ""}</span>
                      </p>
                      <div className="slot-list slot-list-pick">
                        {g.slots.map((o) => {
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
              onClick={handleContinueToSummary}
            >
              {searching ? "Checking live availability…" : <>Continue <ArrowRight size={17} /></>}
            </button>
          </div>
        </div>
      )}

      {step === 3 && selectedSlot && (
        <div>
          <h3>Venue &amp; Confirm</h3>
          <div className="ondemand-form-card od-venue-card">
            <SecTitle icon={<MapPin size={15} />}>Where should the cook come?</SecTitle>
            <div className="ondemand-locate-box">
              {savedLocations.length > 0 && (
                <div className="form-group od-saved-group">
                  <label htmlFor="od-saved-select">
                    <History size={15} /> Use previous location
                  </label>
                  <div className="od-saved-wrap">
                  <select
                    id="od-saved-select"
                    className="form-control od-saved-select"
                    value={savedIdx}
                    onChange={(e) => applySavedLocation(e.target.value)}
                    aria-label="Use a location from your past bookings"
                    title={savedIdx !== "" && savedLocations[Number(savedIdx)] ? savedLocations[Number(savedIdx)].address : undefined}
                  >
                    <option value="">Select from your past bookings...</option>
                    {savedLocations.map((s, i) => {
                      const suffix = s.timesUsed > 1 ? ` (used ${s.timesUsed}x)` : "";
                      const label = s.address.length > 48 ? `${s.address.slice(0, 48)}…${suffix}` : `${s.address}${suffix}`;
                      return (
                        <option key={i} value={i} title={`${s.address}${suffix}`}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                  </div>
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

            <SecTitle icon={<UtensilsCrossed size={15} />}>What dishes do you need? *</SecTitle>
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

            <SecTitle icon={<BadgePercent size={15} />}>Price &amp; coupon</SecTitle>
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
                serviceType={DEFAULT_SERVICE_TYPE}
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
          <div className="ondemand-form-card od-summary-card">
            <SecTitle icon={<CalendarCheck size={15} />}>Review your booking</SecTitle>
            <p className="od-review-sub">Check the details — one tap finds your cook. No payment now.</p>
            <dl className="od-review-list">
              <div className="od-review-row">
                <dt>
                  <span className="od-review-ic" aria-hidden="true"><CalendarCheck size={14} /></span>
                  Schedule
                </dt>
                <dd>
                  <strong>{dateLabel(form.date)}{form.date ? ` · ${form.date}` : ""}</strong>
                  <span>{fmtTime(selectedSlot.startTime)} – {fmtTime(selectedSlot.endTime)} · {form.durationHours} hr{Number(form.durationHours) === 1 ? "" : "s"} · {form.guests || "–"} guest{Number(form.guests) === 1 ? "" : "s"}</span>
                  <span className="od-review-meta">{serviceLabel}</span>
                </dd>
                <dd className="od-review-edit">
                  <button type="button" className="bk-recap-edit" onClick={() => setStep(1)} aria-label="Edit date, duration or guests">
                    <Pencil size={12} /> Edit
                  </button>
                </dd>
              </div>
              <div className="od-review-row">
                <dt>
                  <span className="od-review-ic" aria-hidden="true"><MapPin size={14} /></span>
                  Venue
                </dt>
                <dd>
                  {hasVenue ? (
                    <strong className="od-review-addr">{buildAddress() || "—"}</strong>
                  ) : (
                    <strong className="od-review-missing">Add your address above</strong>
                  )}
                  {coords && (
                    <a className="od-review-link" href={mapsLink} target="_blank" rel="noreferrer">
                      <MapPin size={12} /> Open map pin
                    </a>
                  )}
                </dd>
                <dd className="od-review-edit">
                  <button type="button" className="bk-recap-edit" onClick={scrollToVenue} aria-label="Edit venue address">
                    <Pencil size={12} /> Edit
                  </button>
                </dd>
              </div>
              <div className="od-review-row">
                <dt>
                  <span className="od-review-ic" aria-hidden="true"><UtensilsCrossed size={14} /></span>
                  Dishes
                </dt>
                <dd>
                  {reviewDishes.length > 0 ? (
                    <span className="od-dish-chips">
                      {reviewDishes.map((d) => (
                        <span key={d} className="od-dish-chip">{d}</span>
                      ))}
                    </span>
                  ) : (
                    <strong className="od-review-missing">Add dishes above</strong>
                  )}
                  {form.notes.trim() && (
                    <span className="od-review-note">
                      <StickyNote size={12} /> {form.notes.trim()}
                    </span>
                  )}
                </dd>
                <dd className="od-review-edit">
                  <button type="button" className="bk-recap-edit" onClick={focusDishes} aria-label="Edit dishes">
                    <Pencil size={12} /> Edit
                  </button>
                </dd>
              </div>
            </dl>
            <div className="od-review-total" aria-live="polite">
              <div className="od-review-total-row">
                <span>To pay after cook accepts</span>
                <strong>{slab != null ? formatCurrency(finalPayable) : "—"}</strong>
              </div>
              <div className="od-review-total-sub">
                <span>{slab != null ? formatCurrency(slab) : "—"} · {form.durationHours} hr{Number(form.durationHours) === 1 ? "" : "s"}</span>
                {coupon && <span className="od-review-coupon">Coupon {coupon.code} −{formatCurrency(couponDiscount)}</span>}
              </div>
            </div>
            <p className="od-review-notice">
              <ShieldCheck size={13} /> {cooksForSlot.length > 0
                ? `${cooksForSlot.length} verified cook${cooksForSlot.length > 1 ? "s" : ""} free at this time — the first to accept gets your booking.`
                : "We'll contact verified cooks free at this time — the first to accept gets your booking."}
            </p>
            <p className="od-review-notice">
              Free cancellation while waiting for a cook. Paid bookings follow our{" "}
              <Link to="/customer-cancellation-refund-policy">Cancellation & Refund Policy</Link>.
            </p>
            {!user && (
              <p className="od-review-notice od-review-notice-login">
                <LogIn size={13} /> Login as a customer to find a cook for this slot
              </p>
            )}
            <div className="od-stickybar">
              <div className="od-summary" aria-live="polite">
                <span>{fmtTime(selectedSlot.startTime)} – {fmtTime(selectedSlot.endTime)}</span>
                <strong className="od-summary-price">{slab != null ? formatCurrency(finalPayable) : "—"}</strong>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-block btn-lg od-cta"
                disabled={findingCook}
                onClick={handleFindCook}
              >
                {findingCook ? (
                  <span className="bk-submit-loading">Finding a cook…</span>
                ) : (
                  <>Find Cook <ArrowRight size={17} /></>
                )}
              </button>
              <p className="od-sticky-note">One tap · no payment now · free to cancel while waiting</p>
            </div>
          </div>
        </div>
      )}

      <LoginPromptModal
        open={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        returnTo="/cook-on-demand"
      />
    </div>
  );
};

export default CookBooking;
