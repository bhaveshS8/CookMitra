import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  ChefHat,
  Clock3,
  CreditCard,
  Loader2,
  MapPin,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate, formatTime12 } from "../utils/constants";
import { eventTypeLabel, EVENT_SERVICE_LABEL } from "../utils/eventConstants";

let razorpayScriptPromise = null;
const loadRazorpay = () => {
  if (typeof window !== "undefined" && window.Razorpay) return Promise.resolve(true);
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.onload = () => resolve(true);
      script.onerror = () => {
        razorpayScriptPromise = null;
        resolve(false);
      };
      document.body.appendChild(script);
    });
  }
  return razorpayScriptPromise;
};

const EventPayment = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const showToast = useShowToast();
  const [event, setEvent] = useState(null);
  const [phase, setPhase] = useState("loading");
  const [paying, setPaying] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    API.get(`/event-bookings/${id}`)
      .then((res) => {
        if (!aliveRef.current) return;
        const data = res.data;
        setEvent(data);
        if (data.payment?.status === "paid") {
          setPhase("paid");
        } else if (
          data.bookingStatus !== "cook_assigned" ||
          data.distanceVerified !== true ||
          !data.cookId ||
          !(Number(data.totalAmount) > 0)
        ) {
          setPhase("unavailable");
        } else {
          setPhase("ready");
        }
      })
      .catch(() => {
        if (aliveRef.current) setPhase("error");
      });
    return () => {
      aliveRef.current = false;
    };
  }, [id]);

  const payNow = async () => {
    if (paying) return;
    setPaying(true);
    let checkoutOpened = false;
    const releasePayButton = () => {
      if (aliveRef.current) setPaying(false);
    };
    try {
      let order;
      try {
        const res = await API.post(`/event-payments/${id}/order`);
        order = res.data;
      } catch (error) {
        showToast(error.response?.data?.message || "Could not start payment. Please try again.", "error");
        return;
      }

      const loaded = await loadRazorpay();
      if (!loaded || !window.Razorpay) {
        showToast("Couldn't load the payment gateway. Check your connection and retry.", "error");
        return;
      }

      const rzp = new window.Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency || "INR",
        order_id: order.orderId,
        name: "CookMitra Events",
        description: `${eventTypeLabel(event) || "Event"} · ${formatDate(event?.eventDate)}`,
        prefill: {
          name: event?.customerId?.name || "",
          contact: event?.customerId?.phone || "",
          email: event?.customerId?.email || "",
        },
        theme: { color: "#e8590c" },
        handler: async (response) => {
          try {
            const verified = await API.post(`/event-payments/${id}/verify`, {
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });
            if (!aliveRef.current) return;
            if (verified.data?.payment?.status !== "paid") {
              showToast("Payment is still being confirmed. Please refresh in a moment.", "info");
              return;
            }
            setEvent(verified.data);
            setPhase("paid");
            showToast("Payment successful - your event is confirmed!", "success");
            setTimeout(() => {
              if (aliveRef.current) navigate(`/event-bookings/${id}`, { replace: true });
            }, 2500);
          } catch (error) {
            showToast(
              error.response?.data?.message || "Payment verification failed. Please contact support with your payment ID.",
              "error"
            );
          } finally {
            releasePayButton();
          }
        },
        modal: {
          ondismiss: () => {
            if (aliveRef.current) showToast("Payment cancelled - no money was charged.", "info");
            releasePayButton();
          },
        },
      });
      rzp.on("payment.failed", () => {
        showToast("Payment failed - no money was charged. Please try again.", "error");
        releasePayButton();
      });
      rzp.open();
      checkoutOpened = true;
    } finally {
      // Keep the CTA locked while checkout is open; the callbacks above unlock it.
      if (!checkoutOpened) setPaying(false);
    }
  };

  if (phase === "loading") {
    return (
      <div className="booking-flow-page">
        <div className="bf-loader" role="status" aria-label="Loading event payment">
          <div className="spinner" aria-hidden="true" />
          <p>Loading event payment...</p>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="booking-flow-page">
        <div className="bf-card bf-center">
          <XCircle className="bf-sorry-icon" size={56} />
          <h1 className="bf-title">Event booking not found</h1>
          <p className="bf-sub">We couldn't find this event booking.</p>
          <Link className="btn btn-primary bf-btn" to="/dashboard/event-bookings">
            <ArrowLeft size={18} /> Back to my events
          </Link>
        </div>
      </div>
    );
  }

  if (phase === "unavailable") {
    const confirmed = ["confirmed", "in_progress", "completed"].includes(event?.bookingStatus);
    return (
      <div className="booking-flow-page">
        <div className="bf-card bf-center">
          <XCircle className="bf-sorry-icon" size={56} />
          <h1 className="bf-title">
            {confirmed ? "Booking already confirmed" : "Payment is not open yet"}
          </h1>
          <p className="bf-sub">
            {confirmed
              ? "This booking is already confirmed and no online payment is recorded for it, so there is nothing to pay here."
              : event?.bookingStatus === "cancelled"
                ? "This booking was cancelled, so payment is no longer available."
                : "Online payment opens after CookMitra assigns a cook and verifies the final travel and event amount."}
          </p>
          <Link className="btn btn-primary bf-btn" to={`/event-bookings/${id}`}>
            <ArrowLeft size={18} /> View event booking
          </Link>
        </div>
      </div>
    );
  }

  if (phase === "paid") {
    return (
      <div className="booking-flow-page">
        <div className="bf-card bf-center event-pay-success">
          <CheckCircle2 size={52} color="#16a34a" />
          <h1 className="bf-title">Event payment received</h1>
          <p className="bf-sub">
            {formatCurrency(event?.payment?.paidAmount || event?.totalAmount)} paid for{" "}
            {eventTypeLabel(event) || "your event"}. Your booking is confirmed.
          </p>
          <Link className="btn btn-primary bf-btn" to={`/event-bookings/${id}`}>
            View event booking
          </Link>
        </div>
      </div>
    );
  }

  const amount = Number(event?.totalAmount || 0);
  const paymentFailed = event?.payment?.status === "failed";
  const cookName = event?.cookId?.name || "Assigned cook";
  return (
    <div className="booking-flow-page event-pay-page">
      <div className="bf-card event-pay-card">
        <Link to={`/event-bookings/${id}`} className="event-back-link">
          <ArrowLeft size={16} /> Back to event
        </Link>
        <span className="event-pay-eyebrow">
          <ShieldCheck size={13} aria-hidden="true" /> Secure event checkout
        </span>
        <h1 className="bf-title">Pay for your event</h1>
        <p className="bf-sub">
          {eventTypeLabel(event) || "Event"} · {formatDate(event?.eventDate)}
          {event?.startTime ? ` · ${formatTime12(event.startTime)}` : ""}
          {Number(event?.duration) > 0 ? ` · ${event.duration} hr` : ""}
        </p>

        <div className="event-pay-hero">
          <div className="event-pay-hero-copy">
            <span>Amount payable now</span>
            <p>Final amount after cook assignment and travel verification.</p>
          </div>
          <strong className="event-pay-hero-amount">{formatCurrency(amount)}</strong>
        </div>

        {paymentFailed && (
          <div className="event-pay-alert" role="alert">
            <XCircle size={18} />
            <div>
              <strong>Your last payment did not complete</strong>
              <span>No money was recorded as paid. You can safely retry below.</span>
            </div>
          </div>
        )}

        <div className="event-pay-summary">
          <div className="event-pay-summary-head">
            <span>Booking summary</span>
            <span className="event-pay-badge event-pay-badge--blue">Cook assigned</span>
          </div>
          <div className="event-pay-facts">
            <span>
              <ChefHat size={14} /> {cookName}
            </span>
            <span>
              <Clock3 size={14} /> {event?.duration ?? "—"} hr
            </span>
            <span>
              <MapPin size={14} /> {event?.area || event?.address || "Venue shared in booking"}
            </span>
          </div>
          <ul className="event-price-list event-pay-lines">
            <li className="event-price-row">
              <span>{EVENT_SERVICE_LABEL(event?.serviceType) || "Service"}</span>
              <strong>{formatCurrency(event?.serviceAmount)}</strong>
            </li>
            {Number(event?.additionalCookAmount) > 0 && (
              <li className="event-price-row">
                <span>Additional cook</span>
                <strong>{formatCurrency(event.additionalCookAmount)}</strong>
              </li>
            )}
            {Number(event?.extraHourAmount) > 0 && (
              <li className="event-price-row">
                <span>Extra hours</span>
                <strong>{formatCurrency(event.extraHourAmount)}</strong>
              </li>
            )}
            <li className="event-price-row">
              <span>Travel · {event?.distanceKm ?? 0} km (verified)</span>
              <strong>
                {Number(event?.travelCharge) > 0 ? formatCurrency(event.travelCharge) : "FREE"}
              </strong>
            </li>
          </ul>
          <div className="event-pay-total">
            <span>Final event amount</span>
            <strong>{formatCurrency(amount)}</strong>
          </div>
          <p className="event-pay-fullnote">Full amount online · no cash payment at the venue</p>
        </div>

        <p className="event-pay-trust">
          <ShieldCheck size={18} />
          Secure Razorpay checkout. If you cancel before the event starts, a full refund is queued
          for CookMitra admin approval.
        </p>

        <button className="btn btn-primary bf-btn event-pay-submit" onClick={payNow} disabled={paying}>
          {paying ? <Loader2 size={18} className="spin" /> : <CreditCard size={18} />}
          {paying ? "Opening secure checkout..." : `Pay ${formatCurrency(amount)} securely`}
        </button>
      </div>
    </div>
  );
};

export default EventPayment;
