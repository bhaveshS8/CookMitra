import React, { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  PartyPopper,
  Search,
  Sparkles,
  UtensilsCrossed,
  XCircle,
} from "lucide-react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { SERVICE_DETAILS, formatDate } from "../utils/constants";

const WINDOW_MS = 5 * 60 * 1000; // 5-minute acceptance window
// Calmed for scale: 4s x 1000 waiting users ~= 250 rps sustained. 8s halves
// that; visibility-change pause below stops background-tab polling entirely.
const POLL_MS = 8000;
const REDIRECT_S = 6;

const FACTS = [
  "Modak gets its name from Sanskrit — “one single blissful taste”. 🥟",
  "A perfect puran poli needs its dough to rest. Patience makes it softer!",
  "Chakli dough is kneaded twice for that signature crispy swirl.",
  "Saffron is the world's priciest spice — 1 kg needs ~150,000 flowers.",
  "Cooks judge “dum” biryani by ear — a soft hiss means it's steaming perfectly.",
  "The largest modak ever steamed in Maharashtra weighed over 40 kg!",
  "Jaggery was called “wholesome sugar” in ancient Indian texts.",
  "Tadka hits its flavour peak at exactly 4 seconds — our chefs count every one.",
];

const SORRY_COPY = {
  expired: {
    title: "Time's up — no response",
    body: "The cook didn't accept within 5 minutes, so we've released your slot. Plenty of other chefs are ready for your date!",
  },
  rejected: {
    title: "Request declined",
    body: "Unfortunately this cook can't take your booking. Let's find another chef who can.",
  },
  cancelled: {
    title: "Request cancelled",
    body: "Your booking request was cancelled and the slot has been released.",
  },
};

// Snapshot of the dead request so "Find another cook" can land straight on
// step 3 (venue + cook list) with the same date/slot, minus the cook who
// didn't respond. CookBooking.jsx consumes this via location.state.
const toLocalDayStr = (d) => {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
};

const buildRetryState = (b) => {
  if (!b) return null;
  const addr = b.addressDetails || {};
  return {
    form: {
      serviceType: b.serviceType,
      date: toLocalDayStr(b.date),
      guests: b.guests != null ? String(b.guests) : "4",
      durationHours: b.durationHours != null ? String(b.durationHours) : "",
      flatNo: addr.flatNo || "",
      society: addr.society || "",
      landmark: addr.landmark || "",
      city: addr.city || "",
      customDishes: (b.selectedItems || []).join(", "),
      notes: b.notes || "",
    },
    selectedSlot:
      b.startTime && b.endTime
        ? { startTime: b.startTime, endTime: b.endTime }
        : null,
    coords:
      b.location?.lat != null && b.location?.lng != null
        ? { lat: b.location.lat, lng: b.location.lng }
        : null,
    excludeCookId:
      (typeof b.cook === "string" ? b.cook : b.cook?._id) || null,
  };
};

const BookingWaiting = () => {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const showToast = useShowToast();

  const [booking, setBooking] = useState(null);
  const [phase, setPhase] = useState("loading"); // loading | waiting | accepted | sorry | error
  const [sorryReason, setSorryReason] = useState("expired");
  const [now, setNow] = useState(Date.now());
  const [factIdx, setFactIdx] = useState(0);
  const [cancelling, setCancelling] = useState(false);
  const [redirectIn, setRedirectIn] = useState(REDIRECT_S);
  const handledRef = useRef(false);
  const aliveRef = useRef(true);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await API.get(`/bookings/${bookingId}`);
      if (!aliveRef.current || handledRef.current) return;
      const b = res.data;
      setBooking(b);
      const st = b.status;
      const paid = b.payment?.status === "paid";
      if (["confirmed", "in_progress", "completed"].includes(st) || paid) {
        handledRef.current = true;
        navigate(`/bookings/${bookingId}`, { replace: true });
      } else if (st === "accepted") {
        handledRef.current = true;
        setPhase("accepted");
        showToast(`${b.cook?.name || "Your cook"} accepted your request!`, "success");
        setTimeout(() => {
          if (aliveRef.current) navigate(`/bookings/${bookingId}/pay`, { replace: true });
        }, 1800);
      } else if (["rejected", "cancelled", "expired"].includes(st)) {
        handledRef.current = true;
        setSorryReason(st);
        setPhase("sorry");
      } else {
        setPhase("waiting");
      }
    } catch (err) {
      if (!aliveRef.current) return;
      if (err.response?.status === 404) {
        handledRef.current = true;
        setPhase("error");
      }
    }
  }, [bookingId, navigate, showToast]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    // Pause polling while the tab is hidden — background tabs otherwise keep
    // hammering the API for users who switched away mid-wait.
    const startPoll = () => {
      stopPoll();
      pollRef.current = setInterval(() => {
        if (!document.hidden) load();
      }, POLL_MS);
    };
    const stopPoll = () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
    const onVis = () => {
      if (document.hidden) stopPoll();
      else {
        load();
        startPoll();
      }
    };
    startPoll();
    document.addEventListener("visibilitychange", onVis);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const facts = setInterval(() => setFactIdx((i) => (i + 1) % FACTS.length), 5200);
    return () => {
      aliveRef.current = false;
      stopPoll();
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(tick);
      clearInterval(facts);
    };
  }, [load]);

  // Sorry screen auto-redirects back to finding cooks — carrying the
  // booking snapshot so the customer lands on step 3 (pick another cook
  // for the same slot) instead of starting over on step 1.
  useEffect(() => {
    if (phase !== "sorry") return undefined;
    setRedirectIn(REDIRECT_S);
    const iv = setInterval(() => {
      setRedirectIn((s) => {
        if (s <= 1) {
          clearInterval(iv);
          navigate("/cook-on-demand", {
            replace: true,
            state: booking ? { retryFromBooking: buildRetryState(booking) } : undefined,
          });
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [phase, navigate, booking]);

  const cancelNow = async () => {
    if (cancelling || handledRef.current) return;
    setCancelling(true);
    try {
      await API.patch(`/bookings/${bookingId}/cancel`);
      handledRef.current = true;
      setSorryReason("cancelled");
      setPhase("sorry");
      showToast("Request cancelled — the slot has been released.", "info");
    } catch (err) {
      showToast(err.response?.data?.message || "Could not cancel the request", "error");
      setCancelling(false);
    }
  };

  // "Find another cook" — back to step 3 with the same plan/slot, so the
  // customer picks a different chef without re-typing anything.
  const goFindAnotherCook = useCallback(() => {
    navigate("/cook-on-demand", {
      replace: true,
      state: booking ? { retryFromBooking: buildRetryState(booking) } : undefined,
    });
  }, [navigate, booking]);

  // Countdown against the server-set 5-minute acceptance window.
  const createdAtMs = booking?.createdAt ? new Date(booking.createdAt).getTime() : null;
  const expiresAtMs = booking?.requestExpiresAt
    ? new Date(booking.requestExpiresAt).getTime()
    : createdAtMs
      ? createdAtMs + WINDOW_MS
      : null;
  const remainingMs = expiresAtMs ? Math.max(0, expiresAtMs - now) : WINDOW_MS;
  const secondsLeft = Math.ceil(remainingMs / 1000);
  const clockText = `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(
    secondsLeft % 60
  ).padStart(2, "0")}`;
  const progress = Math.max(0, Math.min(1, remainingMs / WINDOW_MS));
  const RING = 2 * Math.PI * 54; // r = 54 in the SVG viewBox
  const service = SERVICE_DETAILS[booking?.serviceType] || {};
  const cookName = booking?.cook?.name || "the cook";

  if (phase === "loading") {
    return (
      <div className="booking-flow-page">
        <div className="bf-loader" role="status" aria-label="Loading booking">
          <div className="spinner" aria-hidden="true" />
          <p>Loading your booking request…</p>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="booking-flow-page">
        <div className="bf-card bf-center">
          <XCircle className="bf-sorry-icon" size={56} />
          <h1 className="bf-title">Booking not found</h1>
          <p className="bf-sub">We couldn't find this request. It may have been removed.</p>
          <button className="btn btn-primary bf-btn" onClick={() => navigate("/cook-on-demand")}>
            <Search size={18} /> Browse cooks
          </button>
        </div>
      </div>
    );
  }

  if (phase === "sorry") {
    const copy = SORRY_COPY[sorryReason] || SORRY_COPY.expired;
    return (
      <div className="booking-flow-page">
        <div className="bf-card bf-center">
          <XCircle className="bf-sorry-icon" size={64} />
          <h1 className="bf-title">{copy.title}</h1>
          <p className="bf-sub">{copy.body}</p>
          <div className="bf-redirect">
            Taking you to available cooks in <b>{redirectIn}s</b>…
          </div>
          <button className="btn btn-primary bf-btn" onClick={goFindAnotherCook}>
            <Search size={18} /> Find another cook now <ArrowRight size={18} />
          </button>
        </div>
      </div>
    );
  }

  if (phase === "accepted") {
    return (
      <div className="booking-flow-page">
        <div className="bf-card bf-center">
          <div className="bf-burst">
            <PartyPopper size={44} />
          </div>
          <h1 className="bf-title">🎉 {cookName} accepted!</h1>
          <p className="bf-sub">Great news — your slot is being held. Taking you to secure payment…</p>
          <CheckCircle2 className="bf-accept-pulse" size={38} />
        </div>
      </div>
    );
  }

  // phase === "waiting"
  return (
    <div className="booking-flow-page">
      <span className="bf-emoji e1" aria-hidden="true">🥟</span>
      <span className="bf-emoji e2" aria-hidden="true">🍛</span>
      <span className="bf-emoji e3" aria-hidden="true">✨</span>
      <span className="bf-emoji e4" aria-hidden="true">🫖</span>

      <div className="bf-card">
        <div className="bf-wait-head">
          <div className="bf-ring-wrap">
            <svg className="bf-ring" viewBox="0 0 120 120" width="132" height="132">
              <circle className="bf-ring-track" cx="60" cy="60" r="54" />
              <circle
                className={`bf-ring-fill${secondsLeft <= 60 ? " warn" : ""}`}
                cx="60"
                cy="60"
                r="54"
                strokeDasharray={RING}
                strokeDashoffset={RING * (1 - progress)}
              />
            </svg>
            <div className="bf-ring-center">
              <Clock size={16} />
              <span className={`bf-ring-time${secondsLeft <= 60 ? " warn" : ""}`}>{clockText}</span>
              <span className="bf-ring-label">left</span>
            </div>
          </div>
          <div className="bf-wait-copy">
            <h1 className="bf-title">
              Waiting for <span className="bf-cook-name">{cookName}</span>
              <span className="bf-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
            </h1>
            <p className="bf-sub">
              Your request was sent successfully. The cook has about 5 minutes to accept — if they
              don't respond in time, the slot is released automatically and we'll help you find
              another chef right away.
            </p>
          </div>
        </div>

        <div className="bf-steps">
          <div className="bf-step done"><CheckCircle2 size={18} /><span>Request sent</span></div>
          <div className="bf-step active"><UtensilsCrossed size={18} /><span>Cook reviewing</span></div>
          <div className="bf-step"><Clock size={18} /><span>Slot confirmed</span></div>
        </div>

        <div className="bf-summary">
          <span className="bf-chip"><UtensilsCrossed size={14} /> {service.label || "Home cooking"}</span>
          <span className="bf-chip">📅 {formatDate(booking?.date)}</span>
          <span className="bf-chip">⏰ {booking?.startTime} – {booking?.endTime}</span>
          {booking?.guests ? <span className="bf-chip">👨‍👩‍👧 {booking.guests} guests</span> : null}
        </div>

        <div className="bf-fact" key={factIdx}>
          <span className="bf-fact-label"><Sparkles size={14} /> Kitchen wisdom while you wait</span>
          <p>{FACTS[factIdx]}</p>
        </div>

        <div className="bf-actions">
          <button className="btn btn-outline bf-btn-ghost" onClick={cancelNow} disabled={cancelling}>
            <XCircle size={16} /> {cancelling ? "Cancelling…" : "Cancel request"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default BookingWaiting;
