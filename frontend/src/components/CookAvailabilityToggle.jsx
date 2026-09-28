import React, { useEffect, useState } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";

// Cook-level on/off switch. When the cook goes "unavailable" they are hidden
// from all booking until they toggle back to "available" OR the next day begins
// (the backend auto-resets it, so the button also reflects that reset).
const CookAvailabilityToggle = ({ availabilityStatus, onChanged }) => {
  const showToast = useShowToast();
  const [status, setStatus] = useState(availabilityStatus);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStatus(availabilityStatus);
  }, [availabilityStatus]);

  // If the backend auto-reset the cook (new day), surface it so the UI badge
  // never shows a stale "unavailable".
  useEffect(() => {
    if (availabilityStatus === "available" && status === "unavailable") {
      setStatus("available");
    }
  }, [availabilityStatus, status]);

  const isAvailable = status === "available";

  const handleToggle = async () => {
    const next = isAvailable ? "unavailable" : "available";
    setBusy(true);
    try {
      await API.patch("/cooks/me/availability", { status: next });
      setStatus(next);
      showToast(
        next === "unavailable"
          ? "You are now unavailable — customers can't book you until you switch back or a new day starts."
          : "You are now available for bookings.",
        next === "unavailable" ? "info" : "success"
      );
      onChanged?.(next);
    } catch (err) {
      showToast(err.response?.data?.message || "Could not update availability", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className={`cook-avail ${isAvailable ? "on" : "off"}`}
      onClick={handleToggle}
      disabled={busy}
      aria-pressed={isAvailable}
      aria-live="polite"
    >
      <span className="cook-avail-dot" aria-hidden="true" />
      {busy ? "Saving..." : isAvailable ? "Available" : "Unavailable"}
    </button>
  );
};

export default CookAvailabilityToggle;
