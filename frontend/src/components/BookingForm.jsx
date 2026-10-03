import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import API from "../api/axios";
import { useDispatch, useSelector } from "react-redux";
import { updateUser } from "../store/authSlice";
import { useShowToast, useSiteLocation } from "../store/hooks";
import { AnalyticsEvents, track } from "../utils/analytics";
import { formatCurrency, localTodayStr, slabPriceForDuration, LAUNCH_SLAB_PRICES } from "../utils/constants";
import { saveBookingDraft, loadBookingDraft, clearBookingDraft } from "../utils/bookingDraft";
import CouponApply from "./CouponApply";
import CustomCalendar from "./CustomCalendar";
import CookAvatar from "./CookAvatar";
import {
  Calendar, CalendarDays, Clock, AlertCircle, Navigation,
  History, Copy, Check, ChefHat,
  MapPin, StickyNote, ArrowRight, ChevronLeft,
  BadgePercent, ShieldCheck, Sparkles, Minus, Plus,
  Pencil, MapPinned, Wallet, Timer, Sun,
  Sunset, MoonStar
} from "lucide-react";
import LoginPromptModal from "./LoginPromptModal";

/* ── Time helpers ────────────────────────────────────────────────────── */
const SERVICE_START_MIN = 8 * 60;
const SERVICE_END_MIN = 20 * 60;
const STEP_MINUTES = 30;

const minutesToHM = (mins) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

const hmToMinutes = (t) => {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const fmtHour12 = (t) => {
  const m = hmToMinutes(t);
  if (m == null) return t;
  let h = Math.floor(m / 60);
  const mm = m % 60;
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${String(mm).padStart(2, "0")} ${ap}`;
};

const fmtDateShort = (d) => {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
};

const fmtDateDay = (d) => {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-IN", { weekday: "short" });
};

const fmtDateNum = (d) => {
  const dt = new Date(d + "T00:00:00");
  return dt.getDate();
};

const fmtDateMonth = (d) => {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString("en-IN", { month: "short" });
};

const isToday = (d) => d === localTodayStr();

const defaultStartTime = () => {
  const n = new Date();
  const rounded = Math.ceil((n.getHours() * 60 + n.getMinutes()) / STEP_MINUTES) * STEP_MINUTES;
  if (rounded < SERVICE_START_MIN || rounded > SERVICE_END_MIN) return "08:00";
  return minutesToHM(rounded);
};

const nextNDays = (n) => {
  const days = [];
  for (let i = 0; i < n; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    days.push(`${y}-${mo}-${da}`);
  }
  return days;
};

/* ── Config ──────────────────────────────────────────────────────────── */
// Direct cook booking: the customer books THIS cook for a home-cooking
// session. No service picker — every cook offers home cooking at the same
// flat launch price. Kept as a constant default for the API payload
// (backend `serviceType` is still required).
const DEFAULT_SERVICE_TYPE = "cook_for_me";

const DURATION_OPTIONS = [1, 2, 3, 4];
const DURATION_MIN = 1;
const DURATION_MAX = 4;

/* ── Component ───────────────────────────────────────────────────────── */
const BookingForm = ({ cookId, cookUserId, cookName, cookPhotoUrl, onSubmit }) => {
  const showToast = useShowToast();
  const user = useSelector((s) => s.auth.user);
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const [formData, setFormData] = useState(() => ({
    serviceType: DEFAULT_SERVICE_TYPE,
    date: localTodayStr(),
    startTime: defaultStartTime(),
    durationHours: "1",
    flatNo: "",
    society: "",
    landmark: "",
    city: "",
    guests: "",
    notes: "",
  }));
  const [step, setStep] = useState(0);

  // Every step change opens at the top of the page.
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  }, [step]);

  // Start each step at the top of the page.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [step]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [slotBusyError, setSlotBusyError] = useState("");
  const [checkingSlot, setCheckingSlot] = useState(false);
  const [coords, setCoords] = useState(null);
  const [locMsg, setLocMsg] = useState("");
  const [resolvedCookUserId, setResolvedCookUserId] = useState(cookUserId || null);
  const [savedLocations, setSavedLocations] = useState([]);
  const [savedIdx, setSavedIdx] = useState("");
  const autoFilled = useRef(false);
  // Set when the customer explicitly picks a previous place from the saved
  // dropdown — that choice owns the map pin (its own saved pin, or none), so
  // the detected-location effect must never override it afterwards.
  const explicitPlacePick = useRef(false);
  const errorRef = useRef(null);
  const [copiedPin, setCopiedPin] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const { location: siteLocation } = useSiteLocation();

  /* ── Resolve cook user id ── */
  useEffect(() => {
    if (cookUserId) { setResolvedCookUserId(cookUserId); return; }
    if (!cookId) return;
    let cancelled = false;
    API.get(`/cooks/${cookId}`)
      .then((res) => {
        if (cancelled) return;
        const profile = res.data || {};
        setResolvedCookUserId((prev) => prev || profile?.user?._id || cookId);
      })
      .catch(() => { if (!cancelled) setResolvedCookUserId(cookId); });
    return () => { cancelled = true; };
  }, [cookId, cookUserId]);

  const minDateStr = localTodayStr();

  const [coupon, setCoupon] = useState(null);

  const hoursValid =
    formData.durationHours !== "" &&
    Number.isInteger(Number(formData.durationHours)) &&
    Number(formData.durationHours) >= DURATION_MIN &&
    Number(formData.durationHours) <= DURATION_MAX;



  /* ── Derived time values ── */


  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  

/* ── Estimate ── */
  const nowHM = (() => {
    const n = new Date();
    return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
  })();

  /* ── Hour selector (instead of time slots) ──
     UI shows hour numbers 08–20; backend uses 30-min grid.
     Selecting "9" sets startTime to "09:00". */
  const hourOptions = [];
  for (let h = 8; h <= 20; h++) {
    hourOptions.push(`${h}:00`);
  }
  /* Keep user's current selection visible even if changed */
  if (formData.startTime && !hourOptions.includes(formData.startTime)) {
    hourOptions.unshift(formData.startTime);
  }

  // Launch slab pricing: one flat price per whole-hour session (the server
  // recomputes it — this is display + coupon preview only).
  const slab = slabPriceForDuration(Number(formData.durationHours));
  const discount = slab != null && coupon ? Math.min(coupon.discount, slab) : 0;
  const finalAmount = slab != null ? Math.max(0, slab - discount) : 0;

  // Derived end time based on start time and duration (service hours limits)
  const derivedEndTime = (() => {
    if (!formData.startTime || !hoursValid) return "";
    const startMin = hmToMinutes(formData.startTime);
    const durMin = Math.round(Number(formData.durationHours) * 60);
    const endMin = startMin + durMin;
    if (endMin > SERVICE_END_MIN) return ""; // exceeds service day
    return minutesToHM(endMin);
  })();

  const endsAfterServiceDay = derivedEndTime && hmToMinutes(derivedEndTime) > SERVICE_END_MIN;
  const startInPast = isToday(formData.date) && formData.startTime && hmToMinutes(formData.startTime) < hmToMinutes(nowHM);

  const serviceLabel = cookName ? `Booking ${String(cookName).split(" ")[0]}` : "Home cooking session";
  const scheduleSummary = [
    formData.date ? fmtDateShort(formData.date) : null,
    hoursValid ? `${formData.durationHours} hr${Number(formData.durationHours) === 1 ? "" : "s"}` : null,
    formData.startTime ? `${fmtHour12(formData.startTime)}${derivedEndTime ? ` → ${fmtHour12(derivedEndTime)}` : ""}` : null,
  ].filter(Boolean).join(" · ");

  const goNext = () => {
    if (step === 0) {
      if (!formData.date) { setError("Please choose a date"); scrollToError(); return; }
      if (formData.date < minDateStr) { setError("That date already passed — please pick today or a future date"); scrollToError(); return; }
      if (!hoursValid) { setError("Please choose 1, 2, 3 or 4 hours"); scrollToError(); return; }
      if (!formData.startTime) { setError("Select a start time"); scrollToError(); return; }
      if (!derivedEndTime) { setError("That start + duration ends after 8 PM — pick an earlier start"); scrollToError(); return; }
      if (startInPast) { setError("That time already passed today — pick a later start"); scrollToError(); return; }
      // A re-verified busy slot must not advance — pick another time.
      if (slotBusyError) { setError(slotBusyError); scrollToError(); return; }
      if (checkingSlot) { setError("Checking live availability — one moment…"); scrollToError(); return; }
    }
    setError("");
    setStep(step + 1);
  };

  // Live per-cook check for the picked slot: the hour grid is static, but
  // another customer may have booked this cook for the same hours since the
  // page loaded. Re-verify the exact [startTime, endTime] is still free before
  // enabling "Send Request", so a busy cook can never be booked from a stale
  // card. Runs only on step 0 where the slot is picked.
  useEffect(() => {
    setSlotBusyError("");
    if (step !== 0 || !hoursValid || !formData.startTime || !derivedEndTime || !formData.date) return;
    const target = resolvedCookUserId || cookUserId || null;
    if (!target) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setCheckingSlot(true);
      try {
        const chk = await API.get(`/availability/${encodeURIComponent(target)}`, {
          params: { date: formData.date, startTime: formData.startTime, endTime: derivedEndTime },
        });
        if (cancelled) return;
        if (chk?.data && typeof chk.data === "object" && "free" in chk.data) {
          if (chk.data.free !== true) {
            setSlotBusyError(chk.data.reason || "This cook just got booked for those hours — please pick another time.");
          }
        } else {
          // Legacy array shape fallback: confirm the picked start survives.
          const list = Array.isArray(chk?.data?.slots) ? chk.data.slots : chk?.data || [];
          if (Array.isArray(list)) {
            const ok = list.some(
              (o) => String(o.startTime) === String(formData.startTime) && String(o.endTime) === String(derivedEndTime)
            );
            if (!ok) setSlotBusyError("This cook just got booked for those hours — please pick another time.");
          }
        }
      } catch (err) {
        if (cancelled) return;
        // A 4xx means the slot is invalid/gone — surface it. Network failures
        // leave the flow enabled (the server re-checks at creation).
        if (err?.response?.status >= 400 && err?.response?.status < 500) {
          setSlotBusyError(err.response?.data?.message || "That slot is no longer free — please pick another time.");
        }
      } finally {
        if (!cancelled) setCheckingSlot(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [step, hoursValid, formData.startTime, derivedEndTime, formData.date, formData.durationHours, resolvedCookUserId, cookUserId]);

  /* ── Map pin ── */
  const pinMapsUrl = coords?.lat != null && coords?.lng != null
    ? `https://www.google.com/maps?q=${coords.lat},${coords.lng}` : null;

  const handleCopyPin = async () => {
    if (!pinMapsUrl) return;
    try { await navigator.clipboard.writeText(pinMapsUrl); } catch {
      const el = document.createElement("textarea");
      el.value = pinMapsUrl; document.body.appendChild(el);
      el.select(); document.execCommand("copy"); document.body.removeChild(el);
    }
    setCopiedPin(true); setTimeout(() => setCopiedPin(false), 2000);
  };

  /* ── Address builder ── */
  const buildAddress = () =>
    `${formData.flatNo.trim()}, ${formData.society.trim()}${
      formData.landmark.trim() ? `, Near ${formData.landmark.trim()}` : ""
    }${formData.city.trim() ? `, ${formData.city.trim()}` : ""}`;

  /* ── Profile address (locked summary card + Edit button) ── */
  const profileAddress = String(user?.address || "").trim();
  const [addrEditing, setAddrEditing] = useState(false);
  // Summary shown while locked: the composed form address (profile/saved/
  // detected fill), falling back to the raw profile string.
  const addrSummary =
    [formData.flatNo, formData.society, formData.landmark ? `Near ${formData.landmark}` : "", formData.city]
      .map((p) => String(p || "").trim())
      .filter(Boolean)
      .join(", ") || profileAddress;

  /* ── Saved locations ── */
  const [savedLoaded, setSavedLoaded] = useState(false);
  useEffect(() => {
    if (user?.role !== "customer") { setSavedLoaded(true); return; }
    let cancelled = false;
    API.get("/bookings/my/locations")
      .then((res) => { if (!cancelled) { setSavedLocations(res.data || []); setSavedLoaded(true); } })
      .catch(() => { if (!cancelled) { setSavedLocations([]); setSavedLoaded(true); } });
    return () => { cancelled = true; };
  }, [user?.role]);

  useEffect(() => {
    if (user?.role !== "customer" || user?.address !== undefined) return;
    let cancelled = false;
    API.get("/auth/me")
      .then((res) => { if (!cancelled) dispatch(updateUser({ name: res.data?.name, phone: res.data?.phone, address: res.data?.address ?? "" })); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user?.role, user?.address, dispatch]);

  const applySavedLocation = (idx) => {
    const saved = savedLocations[Number(idx)];
    if (!saved) return;
    explicitPlacePick.current = true;
    const d = saved.addressDetails || {};
    // Explicit pick always replaces the auto-filled address block (GPS guesses
    // or a previously applied entry) — the saved address is authoritative.
    // Entries without structured details (older bookings) fall back to parsing
    // their address string, same heuristic as the profile-address fill below.
    const parts = String(saved.address || "").split(",").map((p) => p.trim()).filter(Boolean);
    const src = Object.keys(d).length > 0
      ? d
      : parts.length === 1
        ? { society: parts[0] }
        : parts.length === 2
          ? { flatNo: parts[0], society: parts[1] }
          : { flatNo: parts[0], society: parts.slice(1, -1).join(", "), city: parts[parts.length - 1] };
    setFormData((prev) => ({
      ...prev,
      flatNo: src.flatNo || "",
      society: src.society || "",
      landmark: src.landmark || "",
      city: src.city || "",
    }));
    setSavedIdx(String(idx));
    if (saved.location?.lat != null) {
      setCoords({ lat: saved.location.lat, lng: saved.location.lng });
      setLocMsg("Previous location applied with saved pin.");
    } else {
      // Drop any stale detected pin — it would point at the wrong place
      // for this address.
      setCoords(null);
      setLocMsg("Previous location applied — verify the address below.");
    }
  };

  // Auto-fill priority: profile address > most recent saved booking >
  // (next effect) browser-detected location. A profile address also starts
  // the form in "locked" mode (summary card + Edit button). An explicit pick
  // from the saved-places dropdown always wins once made.
  useEffect(() => {
    if (autoFilled.current || user?.role !== "customer") return;
    const fill = (src) =>
      setFormData((prev) => {
        if (prev.flatNo || prev.society || prev.landmark || prev.city) return prev;
        return {
          ...prev,
          flatNo: src.flatNo || "",
          society: src.society || "",
          landmark: src.landmark || "",
          city: src.city || "",
        };
      });
    const profileAddr = String(user?.address || "").trim();
    if (profileAddr) {
      // The profile address is top priority and never waits for the saved-
      // locations fetch: while it waited, the detected-location effect could
      // claim the fields first and the profile address would never fill.
      autoFilled.current = true;
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
    // No profile address: wait for /auth/me (address key) and the saved list
    // before letting the detected-location effect take the fields, so a past
    // booking can still outrank detection.
    if (user?.address === undefined || !savedLoaded) return;
    if (savedLocations.length > 0) {
      autoFilled.current = true;
      fill(savedLocations[0].addressDetails || {});
      setSavedIdx("0");
      if (savedLocations[0].location?.lat != null) {
        setCoords({ lat: savedLocations[0].location.lat, lng: savedLocations[0].location.lng });
      }
    }
  }, [savedLocations, savedLoaded, user?.role, user?.address]);

  // Detected location → Google Maps pin for the cook (+ address auto-fill).
  //
  // Pin: a detected place that carries real coordinates is attached to the
  // booking (payload.location) so it reaches the cook as a tappable Google
  // Maps link — even when the address fields themselves were filled from the
  // profile address or a previous booking. The saved-places dropdown is the
  // only override: an explicit pick carries its own pin (or clears the pin
  // when that saved entry has none).
  //
  // Address text: typed, saved, or profile input always wins; the detected
  // place only fills empty fields, and never from a stale (>12 h) stored fix.
  useEffect(() => {
    const hasFix =
      Number.isFinite(siteLocation?.lat) && Number.isFinite(siteLocation?.lng);
    // Reverse-geocoding can fail while the GPS fix itself is valid — the pin
    // must still go through (coordinates are all the cook's navigation needs).
    if (!hasFix && !siteLocation?.city && !siteLocation?.area && !siteLocation?.state) return;
    // Pin first: a detected fix with real coordinates is attached for the
    // cook's navigation even while profile/saved address sources settle.
    if (hasFix && !explicitPlacePick.current) {
      setCoords((c) => c || { lat: siteLocation.lat, lng: siteLocation.lng });
    }
    if (!siteLocation?.city && !siteLocation?.area && !siteLocation?.state) return;
    // Saved pins older than 12 h are not reused as today's venue: the header
    // pill still shows them, but the form waits for a fresh detect or for the
    // customer to type the address (last week's address is usually wrong).
    // Fresh fixes carry a `timestamp`/`savedAt` of just now, so they pass.
    const stamp = Number(siteLocation?.savedAt || siteLocation?.timestamp || 0);
    if (stamp && Date.now() - stamp > 12 * 60 * 60 * 1000) return;
    // Address fields are owned by the profile address, else by the most
    // recent saved booking (previous effect). Detection only fills what is
    // left: guests right away, customers once both sources had their chance
    // and neither exists.
    if (autoFilled.current) return;
    if (user?.role === "customer") {
      const profileAddr = String(user?.address || "").trim();
      if (profileAddr || savedLocations.length > 0 || user?.address === undefined || !savedLoaded) return;
    }
    autoFilled.current = true;
    setFormData((prev) => {
      if (prev.flatNo || prev.society || prev.landmark || prev.city) return prev;
      // Door-level line (house + street) fills "Flat / House no." when the fix
      // really carried a house number — a bare road/area name belongs in the
      // society/landmark fields, never in the flat field.
      const exact = siteLocation.hasHouseNumber ? (siteLocation.exactLine || "").trim() : "";
      return {
        ...prev,
        flatNo: exact || prev.flatNo,
        city: prev.city.trim() ? prev.city : siteLocation.city || "",
        society: prev.society.trim() ? prev.society : siteLocation.area || siteLocation.street || "",
        landmark: prev.landmark.trim() ? prev.landmark : siteLocation.street || siteLocation.area || "",
      };
    });
  }, [siteLocation?.city, siteLocation?.area, siteLocation?.state, siteLocation?.street, siteLocation?.exactLine, siteLocation?.hasHouseNumber, siteLocation?.timestamp, siteLocation?.savedAt, siteLocation?.lat, siteLocation?.lng, user?.role, user?.address, savedLoaded, savedLocations]);

  // Returning from login with an unfinished booking for THIS cook: restore
  // the filled fields + pin and land back on the confirm step. Runs once;
  // another cook's draft or a stale one is left alone.
  const resumedDraft = useRef(false);
  useEffect(() => {
    if (resumedDraft.current || !user) return;
    const d = loadBookingDraft();
    if (!d || d.kind !== "cook-profile" || !d.form) return;
    if (cookId && d.cookId && String(d.cookId) !== String(cookId)) return;
    if (!d.savedAt || Date.now() - d.savedAt > 2 * 3600 * 1000) {
      clearBookingDraft();
      return;
    }
    resumedDraft.current = true;
    autoFilled.current = true;
    setFormData((prev) => ({ ...prev, ...d.form }));
    if (d.coords?.lat != null) setCoords(d.coords);
    setStep(1);
    showToast("Welcome back — your booking details were restored. Just tap Find Cook.", "success");
    clearBookingDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, cookId]);

  /* ── Submit (Find-Cook broadcast) ── */
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!user) {
      // Remember the unfinished booking across the login wall.
      saveBookingDraft({ kind: "cook-profile", cookId: cookId ?? resolvedCookUserId, form: formData, coords });
      setShowLoginModal(true);
      return;
    }
    if (user.role !== "customer") {
      setError("Only customers can book"); scrollToError(); return;
    }
    const fail = (msg) => { setError(msg); scrollToError(); };
    if (!formData.date) { fail("Please choose a date"); return; }
    if (formData.date < minDateStr) { fail("That date already passed — please pick today or a future date"); return; }
    const serviceHours = Number(formData.durationHours);
    if (!formData.durationHours || !Number.isInteger(serviceHours) || serviceHours < DURATION_MIN || serviceHours > DURATION_MAX) {
      fail("Please choose 1, 2, 3 or 4 hours"); return;
    }
    if (!formData.startTime || !derivedEndTime) { fail("Pick a start time"); return; }
    if (endsAfterServiceDay) { fail("Must end by 8 PM"); return; }
    if (startInPast) { fail("Time passed — pick later"); return; }
    // Block submit on a re-verified busy slot (the check runs on step 0, but
    // the slot can fill while the customer types the address on step 1).
    if (slotBusyError) { fail(slotBusyError); return; }
    if (checkingSlot) { fail("Checking live availability — one moment…"); return; }

    if (!formData.flatNo.trim()) { fail("Enter flat / house number"); return; }
    if (!formData.society.trim()) { fail("Enter society / street"); return; }
    if (!formData.city.trim()) { fail("Enter city / area"); return; }
    if (formData.guests !== "" && (!Number.isInteger(Number(formData.guests)) || Number(formData.guests) < 1 || Number(formData.guests) > 500)) {
      fail("Guests must be between 1 and 500"); return;
    }

    setSubmitting(true); setError("");
    try {
      const selectedItems = formData.notes.split(/[,;]+/).map((d) => d.trim()).filter(Boolean);
      // Find-Cook: never send a cook id — the server always creates
      // cook = null and the first atomic accept wins. (A slot found on this
      // profile page is a hint, not a reservation.)
      const payload = {
        serviceType: DEFAULT_SERVICE_TYPE,
        date: formData.date,
        startTime: formData.startTime,
        endTime: derivedEndTime,
        address: buildAddress(),
        addressDetails: {
          flatNo: formData.flatNo.trim(),
          society: formData.society.trim(),
          landmark: formData.landmark.trim(),
          city: formData.city.trim(),
        },
        notes: formData.notes,
        selectedItems,
        guests: formData.guests === "" ? undefined : Number(formData.guests),
        durationHours: serviceHours,
        couponCode: coupon?.code || "",
      };
      if (coords) payload.location = coords;
      const res = await API.post("/bookings", payload);
      clearBookingDraft();
      track(AnalyticsEvents.BOOKING_REQUESTED, {
        booking_id: String(res.data?._id || ""),
        service_type: DEFAULT_SERVICE_TYPE,
        duration_hours: serviceHours,
        amount: Number(finalAmount) || 0,
        ...(coupon?.code ? { coupon_code: coupon.code } : {}),
      });
      showToast("Finding a cook for you — we're contacting available cooks now.", "success", 7000);
      onSubmit?.(res.data);
      navigate(`/bookings/${res.data._id}/wait`);
    } catch (err) {
      const msg = err.response?.data?.message || err.message || "Booking failed.";
      fail(msg); showToast(msg, "error");
      // Removed undefined refreshSlots call
    } finally {
      setSubmitting(false);
    }
  };

  const scrollToError = () => requestAnimationFrame(() => errorRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));

  /* ── Date carousel ── */
  const dateDays = nextNDays(7);
  const STEP_TITLES = ["Schedule", "Confirm"];
  const STEP_DESCS = ["When should we come?", "Where & review"];

  /* ════════════════════════════════════════════════════════════════════ */
  const cookFirst = cookName ? String(cookName).split(" ")[0] : null;
  const cookInitial = cookFirst ? cookFirst[0].toUpperCase() : "C";
  const progressPct = ((step + 1) / STEP_TITLES.length) * 100;

  const groupHours = (list) => {
    const groups = [
      { key: "morning", label: "Morning", hint: "8 am – 12 pm", icon: Sun },
      { key: "afternoon", label: "Afternoon", hint: "12 – 4 pm", icon: Sunset },
      { key: "evening", label: "Evening", hint: "4 – 8 pm", icon: MoonStar },
    ];
    const byKey = { morning: [], afternoon: [], evening: [] };
    list.forEach((t) => {
      const mins = hmToMinutes(t);
      if (mins == null) { byKey.morning.push(t); return; }
      const h = Math.floor(mins / 60);
      if (h < 12) byKey.morning.push(t);
      else if (h < 16) byKey.afternoon.push(t);
      else byKey.evening.push(t);
    });
    return groups.map((g) => ({ ...g, times: byKey[g.key] })).filter((g) => g.times.length > 0);
  };
  const hourGroups = groupHours(hourOptions);

  const savingFor = (h) => {
    const price = LAUNCH_SLAB_PRICES[h];
    if (price == null || h <= 1) return 0;
    return Math.max(0, LAUNCH_SLAB_PRICES[1] * h - price);
  };

  const setGuests = (v) => {
    const n = v === "" ? "" : Math.max(1, Math.min(500, Number(v) || 1));
    setFormData((p) => ({ ...p, guests: n === "" ? "" : String(Math.round(n)) }));
  };

  return (
  <div className={`bk bk-modern bk-v2 bk-step-${step}`}>
   <div className="bk-shell">

    {/* Header — cook identity + trust + live price */}
    <div className="bk-head">
      <div className="bk-head-main">
        <span className="bk-avatar" aria-hidden="true">
          <CookAvatar photoUrl={cookPhotoUrl} name={cookName} alt="" fallback={cookInitial} />
        </span>
        <div className="bk-head-text">
          <span className="bk-eyebrow">
            <Sparkles size={12} /> Instant booking · replies in ~5 min
          </span>
          <h2 className="bk-title">{cookFirst ? `Book ${cookFirst}` : "Book your cook"}</h2>
          <p className="bk-sub">
            <span className="bk-trust"><ShieldCheck size={13} /> Verified</span>
            <span className="bk-dot" aria-hidden="true" />
            <span>No payment now</span>
          </p>
        </div>
      </div>
      <div className="bk-head-price" aria-live="polite">
        {slab != null && hoursValid ? (
          <>
            <span className="bk-head-price-label">{formData.durationHours} hr{Number(formData.durationHours) === 1 ? "" : "s"} · all-in</span>
            <strong>{formatCurrency(finalAmount)}</strong>
            {discount > 0 && <em className="bk-head-save">You save {formatCurrency(discount)}</em>}
          </>
        ) : (
          <>
            <span className="bk-head-price-label">Starting at</span>
            <strong>{formatCurrency(LAUNCH_SLAB_PRICES[1])}</strong>
            <em className="bk-head-save">Flat launch pricing</em>
          </>
        )}
      </div>
    </div>

    {/* Error alert */}
    {error && (
      <div ref={errorRef} className="bk-error" role="alert">
        <span className="bk-error-icon"><AlertCircle size={15} /></span>
        <span>{error}</span>
      </div>
    )}

    {/* Step progress — clickable to go back, with progress bar */}
    <div className="bk-progress-wrap">
      <ol className="bk-steps-modern" aria-label="Booking progress">
        {STEP_TITLES.map((title, i) => {
          const done = i < step;
          const active = i === step;
          const clickable = i < step;
          return (
            <li
              key={title}
              className={`bk-step-item ${done ? "done" : active ? "active" : ""} ${clickable ? "clickable" : ""}`}
              aria-current={active ? "step" : undefined}
            >
              <button
                type="button"
                className="bk-step-btn"
                onClick={() => clickable && setStep(i)}
                disabled={!clickable}
                aria-label={clickable ? `Go back to ${title}` : `${title}, step ${i + 1}`}
              >
                <span className="bk-step-num" aria-hidden="true">
                  {done ? <Check size={13} /> : i + 1}
                </span>
                <span className="bk-step-text">
                  <span className="bk-step-name">{title}</span>
                  <span className="bk-step-desc">{STEP_DESCS[i]}</span>
                </span>
              </button>
              {i < STEP_TITLES.length - 1 && <span className="bk-step-link" aria-hidden="true"><span className="bk-step-fill" style={{ width: done ? "100%" : "0%" }} /></span>}
            </li>
          );
        })}
      </ol>
      <div className="bk-progress-bar" aria-hidden="true"><span style={{ width: `${progressPct}%` }} /></div>
    </div>

    {/* Live recap once anything is picked */}
    {(step > 0 && (scheduleSummary || serviceLabel)) && (
      <div className="bk-livebar" aria-live="polite">
        <span className="bk-livechip"><ChefHat size={12} /> {serviceLabel}</span>
        {scheduleSummary && <span className="bk-livechip bk-livechip-strong"><Timer size={12} /> {scheduleSummary}</span>}
        {slab != null && hoursValid && <span className="bk-livechip bk-livechip-price"><Wallet size={12} /> {formatCurrency(finalAmount)}</span>}
      </div>
    )}

    <form onSubmit={handleSubmit} aria-busy={submitting}>
      <div className="bk-step" key={step}>
      {step === 0 && (
          <>
            {/* Date */}
            <div className="bk-card">
              <div className="bk-card-head-row">
                <div className="bk-card-label">
                  <span className="bk-label-icon bk-tint-blue"><CalendarDays size={15} /></span>
                  <span>Which date?</span>
                </div>
                <span className="bk-card-count">Step 1 of 2</span>
              </div>
            <div className="bk-date-grid" role="group" aria-label="Pick a date">
              {dateDays.map((d) => {
                const active = formData.date === d;
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={active}
                    className={`bk-date-cell ${active ? "active" : ""} ${isToday(d) ? "today" : ""}`}
                    onClick={() => setFormData((p) => ({ ...p, date: d }))}
                    title={fmtDateShort(d)}
                  >
                    <span className="bk-date-day">{isToday(d) ? "Today" : fmtDateDay(d)}</span>
                    <span className="bk-date-num">{fmtDateNum(d)}</span>
                    <span className="bk-date-mon">{fmtDateMonth(d)}</span>
                    {active && <span className="bk-date-tick" aria-hidden="true"><Check size={11} /></span>}
                  </button>
                );
              })}
            </div>
            <div className="bk-date-manual">
              <span className="bk-manual-icon"><Calendar size={14} /></span>
              <span className="bk-manual-text">Need a later date?</span>
              <CustomCalendar
                value={formData.date}
                min={minDateStr}
                onChange={(d) => setFormData((p) => ({ ...p, date: d }))}
              />
            </div>
          </div>

          {/* Duration — priced cards */}
          <div className="bk-card">
            <div className="bk-card-head-row">
              <div className="bk-card-label">
                <span className="bk-label-icon bk-tint-amber"><Clock size={15} /></span>
                <span>How long do you need?</span>
              </div>
              {derivedEndTime && formData.startTime && (
                <span className="bk-ends-chip">Ends {fmtHour12(derivedEndTime)}</span>
              )}
            </div>
            <div className="bk-price-strip" aria-label="Launch pricing">
              <span className="bk-price-badge">
                <BadgePercent size={13} /> Launch pricing · save on longer sessions
              </span>
              <div className="bk-price-cells" role="radiogroup" aria-label="Choose duration">
                {DURATION_OPTIONS.map((h) => {
                  const active = Number(formData.durationHours) === h;
                  const save = savingFor(h);
                  const perHr = Math.round(LAUNCH_SLAB_PRICES[h] / h);
                  return (
                    <button
                      key={h}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      className={`bk-price-cell ${active ? "active" : ""}`}
                      onClick={() => setFormData((p) => ({ ...p, durationHours: String(h) }))}
                      title={`Select ${h} hour${h !== 1 ? "s" : ""} for ${formatCurrency(LAUNCH_SLAB_PRICES[h])}`}
                    >
                      {save > 0 && <span className="bk-save-flag">Save ₹{save}</span>}
                      <span className="bk-price-hrs">{h} hr{h !== 1 ? "s" : ""}</span>
                      <strong>{formatCurrency(LAUNCH_SLAB_PRICES[h])}</strong>
                      <span className="bk-price-per">₹{perHr}/hr</span>
                      <span className="bk-price-check" aria-hidden="true"><Check size={12} /></span>
                    </button>
                  );
                })}
              </div>
              <span className="bk-price-note">Flat rate · same for every cook &amp; service · no payment now</span>
            </div>
          </div>

          {/* Start time — grouped, no sideways scroll */}
          <div className="bk-card">
            <div className="bk-card-head-row">
              <div className="bk-card-label">
                <span className="bk-label-icon bk-tint-green"><Timer size={15} /></span>
                <span>What start time?</span>
              </div>
              {formData.startTime && derivedEndTime && (
                <span className="bk-ends-chip bk-ends-strong">{fmtHour12(formData.startTime)} → {fmtHour12(derivedEndTime)}</span>
              )}
            </div>
            <p className="bk-card-hint">Service hours 8:00 am – 8:00 pm · we show your end time automatically.</p>
            <div className={`bk-checking ${checkingSlot ? "on" : ""}`} aria-live="polite">
              <span className="bk-pulse-dot" aria-hidden="true" />
              {checkingSlot ? "Checking live availability…" : slotBusyError ? "Needs attention" : formData.startTime ? "Slot looks free — we re-check at send" : "Pick a start time below"}
            </div>
            {slotBusyError && (
              <div className="bk-slot-error" role="alert"><AlertCircle size={14} /> {slotBusyError}</div>
            )}
            <div className="bk-time-groups">
              {hourGroups.map((g) => {
                const GIcon = g.icon;
                return (
                  <div key={g.key} className="bk-time-group">
                    <div className="bk-time-group-head">
                      <GIcon size={13} />
                      <span>{g.label}</span>
                      <em>{g.hint}</em>
                    </div>
                    <div className="bk-hour-grid" role="group" aria-label={`${g.label} start times`}>
                      {g.times.map((t) => {
                        const active = formData.startTime === t;
                        return (
                          <button
                            key={t}
                            type="button"
                            aria-pressed={active}
                            className={`bk-hour-btn ${active ? "active" : ""}`}
                            onClick={() => {
                              setFormData((p) => ({ ...p, startTime: t }));
                              track(AnalyticsEvents.SLOT_SELECTED, {
                                date: formData.date,
                                start_time: t,
                                duration_hours: Number(formData.durationHours) || null,
                                ...(cookId ? { cook_id: String(cookId) } : {}),
                              });
                            }}
                          >
                            {fmtHour12(t)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ── Step 1: Address, Details & Pay summary ── */}
      {step === 1 && (
        <>
          {/* Recap */}
          <div className="bk-card bk-recap">
            <div className="bk-card-head-row">
              <div className="bk-card-label">
                <span className="bk-label-icon bk-tint-green"><Check size={15} /></span>
                <span>Your booking</span>
              </div>
              <span className="bk-card-count">Step 2 of 2 · almost done</span>
            </div>
            <div className="bk-recap-rows">
              <div className="bk-recap-row">
                <span className="bk-recap-icon"><ChefHat size={14} /></span>
                <span className="bk-recap-text">{serviceLabel}{formData.date ? ` · ${fmtDateShort(formData.date)}` : ""}</span>
                <button type="button" className="bk-recap-edit" onClick={() => setStep(0)}><Pencil size={12} /> Edit</button>
              </div>
              <div className="bk-recap-row">
                <span className="bk-recap-icon"><Clock size={14} /></span>
                <span className="bk-recap-text">
                  {hoursValid ? `${formData.durationHours} hr${Number(formData.durationHours) === 1 ? "" : "s"}` : "Duration"}
                  {slab != null && hoursValid ? ` · ${formatCurrency(slab)}` : ""}
                  {formData.startTime ? ` · ${fmtHour12(formData.startTime)}${derivedEndTime ? ` → ${fmtHour12(derivedEndTime)}` : ""}` : ""}
                </span>
                <button type="button" className="bk-recap-edit" onClick={() => setStep(0)}><Pencil size={12} /> Edit</button>
              </div>
            </div>
          </div>

          {/* Address */}
          <div className="bk-card">
            <div className="bk-card-head-row">
              <div className="bk-card-label">
                <span className="bk-label-icon bk-tint-amber"><MapPin size={15} /></span>
                <span>Where should the cook come?</span>
              </div>
            </div>
            {savedLocations.length > 0 && (
              <label className="bk-saved-wrap" htmlFor="bk-saved-select">
                <History size={15} />
                <span className="bk-saved-label">Saved places</span>
                <select
                  id="bk-saved-select"
                  className="bk-saved-select"
                  value={savedIdx}
                  onChange={(e) => applySavedLocation(e.target.value)}
                >
                  <option value="">Use previous location…</option>
                  {savedLocations.map((s, i) => (
                    <option key={i} value={i}>
                      {s.address}{s.timesUsed > 1 ? ` (×${s.timesUsed})` : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
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
            <div className="bk-field-grid">
              <div className="bk-field">
                <label htmlFor="bk-flat">Flat / House no. *</label>
                <input
                  id="bk-flat"
                  type="text"
                  name="flatNo"
                  className="bk-addr-input"
                  placeholder="e.g. A-402, Sunshine Apartments"
                  value={formData.flatNo}
                  onChange={handleChange}
                  autoComplete="street-address"
                  required
                />
              </div>
              <div className="bk-field">
                <label htmlFor="bk-society">Society / Street *</label>
                <input
                  id="bk-society"
                  type="text"
                  name="society"
                  className="bk-addr-input"
                  placeholder="e.g. MG Road, Koregaon Park"
                  value={formData.society}
                  onChange={handleChange}
                  autoComplete="address-line2"
                  required
                />
              </div>
              <div className="bk-field">
                <label htmlFor="bk-city">City / Area *</label>
                <input
                  id="bk-city"
                  type="text"
                  name="city"
                  className="bk-addr-input"
                  placeholder="e.g. Pune"
                  value={formData.city}
                  onChange={handleChange}
                  autoComplete="address-level2"
                  required
                />
              </div>
              <div className="bk-field">
                <label htmlFor="bk-landmark">Landmark <span className="bk-opt">(optional)</span></label>
                <input
                  id="bk-landmark"
                  type="text"
                  name="landmark"
                  className="bk-addr-input"
                  placeholder="e.g. Near City Mall"
                  value={formData.landmark}
                  onChange={handleChange}
                />
              </div>
            </div>
            )}
            {/* Map pin status */}
            <div className={`bk-pin-card ${pinMapsUrl ? "has-pin" : ""}`}>
              <span className="bk-pin-avatar"><MapPinned size={15} /></span>
              <span className="bk-pin-text">
                {pinMapsUrl ? (locMsg || "Map pin attached — cook can navigate straight to you.") : "No map pin yet — your typed address is enough, pin helps the cook."}
              </span>
              {pinMapsUrl && (
                <span className="bk-pin-actions">
                  <button type="button" className="bk-pin-icon" onClick={handleCopyPin} title="Copy map link">
                    {copiedPin ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <a href={pinMapsUrl} target="_blank" rel="noreferrer" className="bk-pin-icon" title="Open in Google Maps">
                    <Navigation size={14} />
                  </a>
                </span>
              )}
            </div>
          </div>

          {/* Details */}
          <div className="bk-card">
            <div className="bk-card-head-row">
              <div className="bk-card-label">
                <span className="bk-label-icon bk-tint-blue"><StickyNote size={15} /></span>
                <span>Party & food details</span>
              </div>
            </div>
            <div className="bk-field">
              <label htmlFor="bk-guests">How many guests?</label>
              <div className="bk-stepper">
                <button type="button" className="bk-stepper-btn" onClick={() => setGuests(formData.guests === "" ? 1 : Number(formData.guests) - 1)} aria-label="Fewer guests" disabled={formData.guests !== "" && Number(formData.guests) <= 1}><Minus size={15} /></button>
                <input
                  id="bk-guests"
                  type="number"
                  name="guests"
                  className="bk-addr-input bk-stepper-input"
                  placeholder="e.g. 10"
                  min={1}
                  max={500}
                  value={formData.guests ?? ""}
                  onChange={handleChange}
                />
                <button type="button" className="bk-stepper-btn" onClick={() => setGuests(formData.guests === "" ? 2 : Number(formData.guests) + 1)} aria-label="More guests"><Plus size={15} /></button>
              </div>
              <span className="bk-field-hint">Helps the cook plan quantities. Leave blank if unsure.</span>
            </div>
            <div className="bk-field">
              <label htmlFor="bk-notes">Dishes, diet & spice <span className="bk-opt">(optional)</span></label>
              <textarea
                id="bk-notes"
                name="notes"
                className="bk-notes"
                rows={3}
                maxLength={500}
                placeholder="e.g. Paneer butter masala + jeera rice for 8, less spicy, one Jain meal…"
                value={formData.notes}
                onChange={handleChange}
              />
              <span className="bk-field-hint bk-count">{(formData.notes || "").length}/500</span>
            </div>
          </div>

          {/* Price + coupon + submit */}
          <div className="bk-card bk-pay-card">
            <div className="bk-card-head-row">
              <div className="bk-card-label">
                <span className="bk-label-icon bk-tint-green"><Wallet size={15} /></span>
                <span>Price summary</span>
              </div>
              <span className="bk-pay-note">Pay after cook accepts</span>
            </div>
            {slab != null && (
              <div className="bk-foot-estimate">
                <div className="price-rows" style={{ flex: 1 }}>
                  <div className="price-row">
                    <span>Service · {formData.durationHours} hr{Number(formData.durationHours) === 1 ? "" : "s"} · {serviceLabel}</span>
                    <span>{formatCurrency(slab)}</span>
                  </div>
                  {coupon && (
                    <div className="price-row discount">
                      <span>Coupon {coupon.code} applied</span>
                      <span>−{formatCurrency(discount)}</span>
                    </div>
                  )}
                  <div className="price-row total">
                    <span>To pay after acceptance</span>
                    <strong>{formatCurrency(finalAmount)}</strong>
                  </div>
                </div>
              </div>
            )}
            {slab != null && (
              <CouponApply
                amount={slab}
                serviceType={DEFAULT_SERVICE_TYPE}
                onApplied={setCoupon}
              />
            )}
            <button type="submit" className="bk-submit bk-submit-inline" disabled={submitting}>
              {submitting ? (
                <span className="bk-submit-loading"><span className="bk-spinner" aria-hidden="true" /> Sending…</span>
              ) : (
                <>
                  Send booking request · {slab != null ? formatCurrency(finalAmount) : ""}
                  <ArrowRight size={16} />
                </>
              )}
            </button>
            <p className="bk-foot-note"><ShieldCheck size={12} /> No payment now — we contact free cooks for your slot and the first to accept gets your booking. Free cancellation while waiting.</p>
          </div>
        </>
      )}
      </div>

      {/* Sticky action bar — one thumb-friendly place for Back / Continue / Send */}
      <div className="bk-stickybar">
        <div className="bk-sticky-summary" aria-live="polite">
          <span className="bk-sticky-text">
            {step === 0 ? (scheduleSummary || "Pick date, length & time") : `Pay ${slab != null ? formatCurrency(finalAmount) : "—"} after acceptance`}
          </span>
          <strong className="bk-sticky-price">{slab != null && hoursValid ? formatCurrency(finalAmount) : slab != null ? formatCurrency(slab) : "₹—"}</strong>
        </div>
        <div className="bk-sticky-actions">
          {step > 0 && (
            <button type="button" className="bk-back-btn" onClick={() => { setError(""); setStep(step - 1); }} disabled={submitting}>
              <ChevronLeft size={16} /> Back
            </button>
          )}
          {step === 0 && (
            <button
              type="button"
              className="bk-next-btn"
              onClick={goNext}
              disabled={submitting || checkingSlot || Boolean(slotBusyError)}
            >
              Continue <ArrowRight size={16} />
            </button>
          )}
          {step === 1 && (
            <button type="submit" className="bk-next-btn bk-send-btn" disabled={submitting || checkingSlot || Boolean(slotBusyError)}>
              {submitting ? "Finding…" : (<>Find Cook <ArrowRight size={16} /></>)}
            </button>
          )}
        </div>
        {step === 0 && derivedEndTime && (
          <p className="bk-sticky-sub">{formData.date ? fmtDateShort(formData.date) : ""}{formData.date ? " · " : ""}{formData.startTime ? fmtHour12(formData.startTime) : ""}{derivedEndTime ? ` → ${fmtHour12(derivedEndTime)}` : ""} · {formData.durationHours || "?"} hr{Number(formData.durationHours) === 1 ? "" : "s"}</p>
        )}
      </div>
    </form>
   </div>

    <LoginPromptModal
      open={showLoginModal}
      onClose={() => setShowLoginModal(false)}
      returnTo={cookId ? `/cooks/${cookId}` : null}
    />
  </div>
);
};

export default BookingForm;
