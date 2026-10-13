import React, { useEffect, useState } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";

const CookAvailabilityToggle = ({ availabilityStatus, onChanged }) => {
  const showToast = useShowToast();
  const [status, setStatus] = useState(availabilityStatus);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStatus(availabilityStatus);
  }, [availabilityStatus]);

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
