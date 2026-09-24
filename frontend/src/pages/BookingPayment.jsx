import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  ChefHat,
  Clock,
  CreditCard,
  Landmark,
  MapPin,
  MessageCircle,
  Search,
  ShieldCheck,
  Smartphone,
  Users,
  UtensilsCrossed,
  Wallet,
  XCircle,
} from "lucide-react";
import API from "../api/axios";
import { useSelector } from "react-redux";
import { useShowToast } from "../store/hooks";
import { AnalyticsEvents, track } from "../utils/analytics";
import { SERVICE_DETAILS, formatCurrency, formatDate, formatTimeRange12 } from "../utils/constants";

const WINDOW_MS = 5 * 60 * 1000; // 5-minute payment window
// Explicit test payments (no real money) are offered only when the gateway
// is unconfigured AND the build opts in (REACT_APP_ALLOW_TEST_PAYMENTS=true)
// or is running on the CRA dev server. Production builds (NODE_ENV=
// "production") never auto-enable: they show an honest error instead.
const TEST_PAY_ENABLED =
  process.env.REACT_APP_ALLOW_TEST_PAYMENTS === "true" ||
  process.env.NODE_ENV === "development";
// Calmed for scale (see BookingWaiting): 8s halves sustained poll rps.
const POLL_MS = 8000;
const REDIRECT_S = 6;
// Circumference of the countdown ring (SVG r=54).
const RING = 2 * Math.PI * 54;

const METHODS = [
  { id: "upi", label: "UPI", desc: "GPay · PhonePe · Paytm", icon: Smartphone, tag: "Recommended" },
  { id: "card", label: "Card", desc: "Credit / Debit", icon: CreditCard },
  { id: "netbanking", label: "Net Banking", desc: "All major banks", icon: Landmark },
  { id: "wallet", label: "Wallet", desc: "Paytm · Amazon Pay", icon: Wallet },
];

// Razorpay Checkout method keys hidden for each choice, so the gateway opens
// focused on the method the customer picked (best-effort — unknown keys are
// ignored by Checkout).
const HIDE_METHODS = {
  upi: ["card", "netbanking", "wallet", "emi", "paylater", "cardless_emi"],
  card: ["upi", "netbanking", "wallet", "emi", "paylater", "cardless_emi"],
  netbanking: ["upi", "card", "wallet", "emi", "paylater", "cardless_emi"],
  wallet: ["upi", "card", "netbanking", "emi", "paylater", "cardless_emi"],
};

// Load Razorpay Checkout.js once (cached promise). False when offline/blocked.
let razorpayScriptPromise = null;
const loadRazorpay = () => {
  if (typeof window !== "undefined" && window.Razorpay) return Promise.resolve(true);
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://checkout.razorpay.com/v1/checkout.js";
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => {
        razorpayScriptPromise = null;
        resolve(false);
      };
      document.body.appendChild(s);
    });
  }
  return razorpayScriptPromise;
};

const BookingPayment = () => {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const showToast = useShowToast();
  const user = useSelector((s) => s.auth.user);

  const [booking, setBooking] = useState(null);
  const [phase, setPhase] = useState("loading"); // loading | pay | processing | success | expired | error
  const [method, setMethod] = useState("upi");
  const [now, setNow] = useState(Date.now());
  const [redirectIn, setRedirectIn] = useState(REDIRECT_S);
  const [cookWaUrl, setCookWaUrl] = useState(null);
  const [selfWaUrl, setSelfWaUrl] = useState(null);
  // True when the order endpoint answered 503 (gateway unconfigured). The UI
  // then offers an EXPLICIT test-payment button (dev builds only) instead of
  // silently entering test mode — a 503 is never payment success (P1-7).
  const [gatewayDown, setGatewayDown] = useState(false);
  const handledRef = useRef(false);
  const aliveRef = useRef(true);
  const pollRef = useRef(null);
  // True once Razorpay reports a successful payment (Checkout also fires
  // `ondismiss` when it closes after success — this tells the two apart).
  const completedRef = useRef(false);
  // Set when payment.failed already toasted, so the following ondismiss
  // doesn't pile a misleading "cancelled" message on top.
  const failedSilentDismissRef = useRef(false);

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
        setPhase("success");
        setTimeout(() => {
          if (aliveRef.current) navigate(`/bookings/${bookingId}`, { replace: true });
        }, 1800);
      } else if (["expired", "cancelled", "rejected"].includes(st)) {
        handledRef.current = true;
        setPhase("expired");
      } else if (st === "requested") {
        // Cook never accepted (or the window lapsed) — back to waiting.
        handledRef.current = true;
        navigate(`/bookings/${bookingId}/wait`, { replace: true });
      } else {
        // Don't clobber an in-flight payment with the idle phase.
        setPhase((p) => (p === "processing" ? p : "pay"));
      }
    } catch (err) {
      if (!aliveRef.current) return;
      if (err.response?.status === 404) {
        handledRef.current = true;
        setPhase("error");
      }
    }
  }, [bookingId, navigate]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    // Pause polling while the tab is hidden (see BookingWaiting).
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
    return () => {
      aliveRef.current = false;
      stopPoll();
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(tick);
    };
  }, [load]);

  // Expired screen auto-redirects back to finding cooks
  useEffect(() => {
    if (phase !== "expired") return undefined;
    setRedirectIn(REDIRECT_S);
    const iv = setInterval(() => {
      setRedirectIn((s) => {
        if (s <= 1) {
          clearInterval(iv);
          navigate("/cook-on-demand", { replace: true });
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [phase, navigate]);

  // Real Razorpay flow: create a gateway order for this booking's window,
  // collect the payment in Checkout (UPI/cards per the chosen method), then
  // confirm with the verified signature. Nothing is ever marked paid without
  // gateway verification, and nothing auto-opens WhatsApp — the success
  // screen offers optional share buttons instead.
  // Synchronous double-tap guard (F-03): React state lags a render, so two
  // rapid taps both pass a `phase === "processing"` check and mint two
  // gateway orders. The ref flips in the same tick — the loser returns
  // before any network call. The backend in-flight mint guard is the
  // second layer; this is UX protection, not security.
  const payingRef = useRef(false);
  const payNow = async () => {
    if (payingRef.current || phase === "processing") return;
    payingRef.current = true;
    try {
      await payNowInner();
    } finally {
      payingRef.current = false;
    }
  };
  const payNowInner = async () => {
    if (phase === "processing") return;
    setPhase("processing");
    completedRef.current = false;
    failedSilentDismissRef.current = false;
    try {
      // Refuse to start when the window is nearly gone — money captured after
      // expiry can't attach to a live booking.
      const msLeft = expiresAtMsForPay();
      if (msLeft != null && msLeft < 30000) {
        setPhase("pay");
        showToast("Payment window almost over — please rebook to get a fresh window.", "error");
        return;
      }
      // 1) Gateway order (honest errors only — never a fake confirmation).
      const cookId = booking?.cook?._id || booking?.cook;
      let order;
      try {
        const res = await API.post("/payments/order", {
          cook: cookId,
          date: booking?.date,
          startTime: booking?.startTime,
          endTime: booking?.endTime,
          durationHours: booking?.durationHours,
          bookingId,
        });
        order = res.data;
      } catch (err) {
        if (err.response?.status === 503) {
          // Gateway unconfigured (no Razorpay keys). NEVER silently enter
          // test mode (P1-7): a 503 is infrastructure failure, not payment
          // success. Offer an explicit, clearly-labelled test payment ONLY
          // when the build opts in via REACT_APP_ALLOW_TEST_PAYMENTS=true
          // (dev/staging); production builds show an honest error instead.
          handledRef.current = false;
          setPhase("pay");
          if (TEST_PAY_ENABLED) {
            setGatewayDown(true);
            showToast(
              "Payment gateway is not configured — you may record an explicit TEST payment (no real money).",
              "error"
            );
          } else {
            setGatewayDown(false);
            showToast(
              "Online payment is temporarily unavailable. Please try again later — no money was charged.",
              "error"
            );
          }
          return;
        }
        setPhase("pay");
        showToast(
          err.response?.data?.message || "Could not start payment. Please try again.",
          "error"
        );
        return;
      }
      // 2) Fully-discounted session: server confirms at no cost — no gateway.
      if (order?.free || order?.amountPaise === 0 || Number(order?.amountPaise || 0) <= 0) {
        const res = await API.patch(`/bookings/${bookingId}/pay`, { method, payment: null });
        completedRef.current = true;
        setBooking((prev) => ({ ...(prev || {}), ...(res.data || {}) }));
        setCookWaUrl(res.data?.cookWhatsappUrl || null);
        setSelfWaUrl(res.data?.customerWhatsappUrl || null);
        setPhase("success");
        track(AnalyticsEvents.PAYMENT_SUCCESS, {
          booking_id: String(bookingId || ""),
          amount: 0,
          method: "discount",
        });
        showToast("Discount covered the full fee — booking confirmed!", "success");
        setTimeout(() => {
          if (aliveRef.current) navigate(`/bookings/${bookingId}`, { replace: true });
        }, 6000);
        return;
      }
      // 3) Razorpay Checkout.
      const loaded = await loadRazorpay();
      if (!loaded || !window.Razorpay) {
        setPhase("pay");
        showToast("Couldn't load the payment gateway. Check your connection and retry.", "error");
        return;
      }
      // Pause polling auto-redirects while Checkout is open.
      handledRef.current = true;
      const rzp = new window.Razorpay({
        key: order.keyId,
        amount: order.amountPaise,
        currency: order.currency || "INR",
        order_id: order.orderId,
        name: "CookMitra",
        description: `Cook booking ${formatDate(booking?.date)} ${formatTimeRange12(booking?.startTime, booking?.endTime, "-")}`,
        prefill: { contact: user?.phone || "", email: user?.email || "" },
        theme: { color: "#e8590c" },
        ...(HIDE_METHODS[method]
          ? { config: { display: { hide: HIDE_METHODS[method].map((m) => ({ method: m })) } } }
          : {}),
        handler: async (resp) => {
          try {
            const res = await API.patch(`/bookings/${bookingId}/pay`, {
              method,
              payment: {
                razorpayOrderId: resp.razorpay_order_id,
                razorpayPaymentId: resp.razorpay_payment_id,
                razorpaySignature: resp.razorpay_signature,
              },
            });
            completedRef.current = true;
            setBooking((prev) => ({ ...(prev || {}), ...(res.data || {}) }));
            setCookWaUrl(res.data?.cookWhatsappUrl || null);
            setSelfWaUrl(res.data?.customerWhatsappUrl || null);
            setPhase("success");
            track(AnalyticsEvents.PAYMENT_SUCCESS, {
              booking_id: String(bookingId || ""),
              amount: Number(booking?.amount) || 0,
              method,
            });
            showToast("Payment successful — booking confirmed!", "success");
            // Linger so the customer can use the WhatsApp share buttons.
            setTimeout(() => {
              if (aliveRef.current) navigate(`/bookings/${bookingId}`, { replace: true });
            }, 6000);
          } catch (err) {
            completedRef.current = false;
            if (err.response?.status === 410) {
              // Server freed the slot — the window closed mid-payment.
              setPhase("expired");
              showToast(err.response?.data?.message || "Payment window expired — slot released.", "error");
            } else if (err.response?.status === 409) {
              // Slot taken by another booking, or a duplicate confirm raced.
              // If the server kept this booking paid, treat as success.
              if (err.response?.data?.alreadyPaid || err.response?.data?.status === "confirmed") {
                completedRef.current = true;
                setBooking((prev) => ({ ...(prev || {}), ...(err.response?.data || {}) }));
                setPhase("success");
                showToast("Payment already recorded — booking confirmed!", "success");
              } else {
                handledRef.current = false;
                setPhase("pay");
                showToast(err.response?.data?.message || "This slot was just taken — please pick another time.", "error");
              }
            } else {
              handledRef.current = false;
              setPhase("pay");
              showToast(err.response?.data?.message || "Payment verification failed — please try again.", "error");
            }
          }
        },
        modal: {
          ondismiss: () => {
            // Fires on manual close AND after success/failure — only a plain
            // manual close counts here.
            if (completedRef.current) return;
            if (failedSilentDismissRef.current) {
              failedSilentDismissRef.current = false;
              return;
            }
            handledRef.current = false;
            setPhase("pay");
            showToast("Payment cancelled — your slot is still held until the timer ends.", "info");
          },
        },
      });
      rzp.on("payment.failed", () => {
        if (completedRef.current) return;
        failedSilentDismissRef.current = true;
        handledRef.current = false;
        setPhase("pay");
        showToast("Payment failed — no money was charged. Please try again.", "error");
      });
      rzp.open();
    } catch (err) {
      handledRef.current = false;
      setPhase("pay");
      showToast(err.response?.data?.message || "Payment failed — please try again.", "error");
    }
  };

  // Dev-only simulated payment (NO real money). Only reachable when the
  // gateway is unconfigured, and only accepted by servers explicitly opted
  // in via ALLOW_TEST_PAYMENTS=true.
  const confirmTestPayment = async () => {
    if (payingRef.current) return;
    payingRef.current = true;
    try {
      const res = await API.patch(`/bookings/${bookingId}/pay`, { method, testMode: true });
      completedRef.current = true;
      handledRef.current = true;
      setBooking((prev) => ({ ...(prev || {}), ...(res.data || {}) }));
      setCookWaUrl(res.data?.cookWhatsappUrl || null);
      setSelfWaUrl(res.data?.customerWhatsappUrl || null);
      setPhase("success");
      showToast("Test payment recorded — booking confirmed! (No real money moved.)", "success");
      setTimeout(() => {
        if (aliveRef.current) navigate(`/bookings/${bookingId}`, { replace: true });
      }, 6000);
    } catch (err) {
      if (err.response?.status === 410) {
        setPhase("expired");
        showToast(err.response?.data?.message || "Payment window expired — slot released.", "error");
      } else {
        setPhase("pay");
        showToast(err.response?.data?.message || "Test payment failed — please try again.", "error");
      }
    } finally {
      payingRef.current = false;
    }
  };

  // Milliseconds left in the payment window (null when unknown).
  const expiresAtMsForPay = () => {
    const acceptedEntry = (booking?.statusHistory || []).find((s) => s.status === "accepted");
    const acceptedMs = acceptedEntry?.timestamp ? new Date(acceptedEntry.timestamp).getTime() : null;
    const exp = booking?.paymentExpiresAt
      ? new Date(booking.paymentExpiresAt).getTime()
      : acceptedMs
        ? acceptedMs + WINDOW_MS
        : null;
    return exp ? Math.max(0, exp - Date.now()) : null;
  };

  // Countdown against the server-set 5-minute payment window.
  const acceptedEntry = (booking?.statusHistory || []).find((s) => s.status === "accepted");
  const acceptedMs = acceptedEntry?.timestamp ? new Date(acceptedEntry.timestamp).getTime() : null;
  const expiresAtMs = booking?.paymentExpiresAt
    ? new Date(booking.paymentExpiresAt).getTime()
    : acceptedMs
      ? acceptedMs + WINDOW_MS
      : null;
  const remainingMs = expiresAtMs ? Math.max(0, expiresAtMs - now) : WINDOW_MS;
  const secondsLeft = Math.ceil(remainingMs / 1000);
  const clockText = `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(
    secondsLeft % 60
  ).padStart(2, "0")}`;
  const progress = Math.max(0, Math.min(1, remainingMs / WINDOW_MS));
  const service = SERVICE_DETAILS[booking?.serviceType] || {};
  const cookName = booking?.cook?.name || "your cook";

  if (phase === "loading") {
    return (
      <div className="booking-flow-page">
        <div className="bf-loader" role="status" aria-label="Loading booking">
          <div className="spinner" aria-hidden="true" />
          <p>Loading your payment…</p>
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
          <p className="bf-sub">We couldn't find this booking. It may have been removed.</p>
          <button className="btn btn-primary bf-btn" onClick={() => navigate("/cook-on-demand")}>
            <Search size={18} /> Browse cooks
          </button>
        </div>
      </div>
    );
  }

  if (phase === "expired") {
    return (
      <div className="booking-flow-page">
        <div className="bf-card bf-center">
          <XCircle className="bf-sorry-icon" size={64} />
          <h1 className="bf-title">Payment window expired</h1>
          <p className="bf-sub">
            The 5-minute window closed, so {cookName}'s slot has been released for other customers.
            No money was charged.
          </p>
          <div className="bf-redirect">
            Taking you to available cooks in <b>{redirectIn}s</b>…
          </div>
          <button className="btn btn-primary bf-btn" onClick={() => navigate("/cook-on-demand", { replace: true })}>
            <Search size={18} /> Find a cook again <ArrowRight size={18} />
          </button>
        </div>
      </div>
    );
  }

  // phases "pay" and "processing" render below
  if (phase === "success") {
    return (
      <div className="booking-flow-page">
        <div className="bf-card bf-center">
          <div className="bf-burst">
            <CheckCircle2 size={52} />
          </div>
          <h1 className="bf-title">Booking confirmed! 🎉</h1>
          <p className="bf-sub">{cookName} will arrive as scheduled. Redirecting to your booking…</p>
          {booking?.payment?.testMode && (
            <span className="badge badge-amber" style={{ marginTop: "0.5rem" }}>
              Test payment — no real money moved
            </span>
          )}
          {(cookWaUrl || selfWaUrl) && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
                marginTop: "0.75rem",
                width: "100%",
                maxWidth: 360,
              }}
            >
              <p className="bf-sub" style={{ margin: 0 }}>
                One tap to share over WhatsApp:
              </p>
              {cookWaUrl && (
                <a href={cookWaUrl} target="_blank" rel="noreferrer" className="btn btn-success bf-btn">
                  <MessageCircle size={18} /> Send details to cook
                </a>
              )}
              {selfWaUrl && (
                <a href={selfWaUrl} target="_blank" rel="noreferrer" className="btn btn-outline bf-btn">
                  <MessageCircle size={18} /> Send confirmation to my WhatsApp
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const items = Array.isArray(booking?.selectedItems) ? booking.selectedItems : [];
  const amount = Number(booking?.amount || 0);
  const lowTime = secondsLeft <= 60;

  return (
    <div className="booking-flow-page">
      <div className="bf-card bf-pay-card">
        <div className="bf-wait-head">
          <div className="bf-ring-wrap small">
            <svg className="bf-ring" viewBox="0 0 120 120" width="104" height="104">
              <circle className="bf-ring-track" cx="60" cy="60" r="54" />
              <circle
                className={`bf-ring-fill${lowTime ? " warn" : ""}`}
                cx="60"
                cy="60"
                r="54"
                strokeDasharray={RING}
                strokeDashoffset={RING * (1 - progress)}
              />
            </svg>
            <div className="bf-ring-center">
              <Clock size={14} />
              <span className={`bf-ring-time${lowTime ? " warn" : ""}`}>{clockText}</span>
              <span className="bf-ring-label">to pay</span>
            </div>
          </div>
          <div className="bf-wait-copy">
            <h1 className="bf-title">Confirm your booking</h1>
            <p className="bf-sub">
              <ChefHat size={15} /> <b>{cookName}</b> accepted your request and is holding this slot
              only for the next {clockText}. Complete payment to lock it in.
            </p>
          </div>
        </div>

        <div className="bf-grid">
          <div className="bf-grid-main">
            <div className="bf-summary">
              <span className="bf-chip"><UtensilsCrossed size={14} /> {service.label || "Home cooking"}</span>
              <span className="bf-chip">📅 {formatDate(booking?.date)}</span>
              <span className="bf-chip">⏰ {formatTimeRange12(booking?.startTime, booking?.endTime)}</span>
              {booking?.guests ? <span className="bf-chip"><Users size={14} /> {booking.guests} guests</span> : null}
            </div>

            {booking?.address ? (
              <div className="bf-address"><MapPin size={15} /> {booking.address}</div>
            ) : null}

            <h3 className="bf-section-title">Choose payment method</h3>
            <div className="bf-methods">
              {METHODS.map((m) => {
                const Icon = m.icon;
                const active = method === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`bf-method${active ? " selected" : ""}`}
                    onClick={() => setMethod(m.id)}
                  >
                    <Icon size={20} />
                    <span className="bf-method-name">{m.label}</span>
                    <span className="bf-method-desc">{m.desc}</span>
                    {m.tag ? <span className="bf-method-tag">{m.tag}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>

          <aside className="bf-grid-side">
            <div className="bf-amount-box">
              <span className="bf-amount-label">Amount payable</span>
              {Number(booking?.slabPrice) > 0 ? (
                <div className="price-rows" style={{ width: "100%", textAlign: "left", marginBottom: "0.4rem" }}>
                  <div className="price-row">
                    <span>Service Price · {booking?.durationHours} hr{Number(booking?.durationHours) === 1 ? "" : "s"}</span>
                    <span>{formatCurrency(booking.slabPrice)}</span>
                  </div>
                  {booking?.couponCode ? (
                    <div className="price-row discount">
                      <span>Coupon {booking.couponCode}</span>
                      <span>−{formatCurrency(booking.discount)}</span>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <span className="bf-amount">{formatCurrency(amount)}</span>
              {items.length ? <span className="bf-amount-note">{items.join(" • ")}</span> : null}
            </div>
            <button
              className="btn btn-primary bf-pay-btn"
              onClick={payNow}
              disabled={phase === "processing"}
              aria-busy={phase === "processing"}
            >
              {phase === "processing" ? "Starting payment…" : `Pay ${formatCurrency(amount)} & Confirm`}
            </button>
            {gatewayDown && TEST_PAY_ENABLED ? (
              <div className="bf-testmode" role="alert" style={{ marginTop: "0.75rem", padding: "0.75rem", border: "2px dashed #e8590c", borderRadius: "8px" }}>
                <strong>TEST MODE — no real money will move.</strong>
                <p style={{ margin: "0.25rem 0 0.5rem" }}>
                  The payment gateway is not configured on this build. Recording a test
                  payment confirms the booking for testing only; it will be flagged for
                  admin review and excluded from real payouts/refunds.
                </p>
                <button className="btn btn-outline bf-btn" onClick={confirmTestPayment}>
                  Record explicit TEST payment (no charge)
                </button>
              </div>
            ) : null}
            <p className="bf-consent">
              By paying you agree to our <Link to="/terms">Terms</Link> and{" "}
              <Link to="/refunds">Refund Policy</Link>. Payments are processed
              securely by Razorpay.
            </p>
            <div className="bf-secure"><ShieldCheck size={14} /> 256-bit encrypted • Instant confirmation</div>
            {lowTime ? <div className="bf-low-time">Hurry — the slot releases automatically at 00:00!</div> : null}
          </aside>
        </div>
      </div>

      {phase === "processing" && (
        <div className="bf-processing" role="alert">
          <div className="bf-pan"><span className="bf-pan-handle" /></div>
          <p>Processing payment<span className="bf-dots"><i>.</i><i>.</i><i>.</i></span></p>
        </div>
      )}
    </div>
  );
};

export default BookingPayment;
