const toLocalDayStr = (d) => {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
};

export const buildRetryState = (b) => {
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
    couponCode: b.couponCode || "",
  };
};