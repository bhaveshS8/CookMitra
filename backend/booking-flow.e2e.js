const BASE = process.env.BASE_URL || "http://localhost:5000/api";
if (!process.env.ALLOW_LIVE_TESTS) {
  console.error(
    `Refusing to run: this e2e script writes test data to ${BASE}. ` +
      `Re-run with ALLOW_LIVE_TESTS=1 to confirm (point BASE_URL at a scratch database).`
  );
  process.exit(1);
}

let failures = 0;
const step = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -> ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
};

const login = async (email, password) => {
  const r = await api("POST", "/auth/login", { body: { email, password } });
  if (r.status !== 200 || !r.data?.token) {
    throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  }
  return r.data;
};

const tomorrowStr = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

(async () => {
  try {
    const cust = await login("neha@example.com", "password123");
    step("customer login", Boolean(cust.token), cust.user?.name);

    const list = await api("GET", "/cooks");
    step("cooks listing loads", list.status === 200 && Array.isArray(list.data) && list.data.length > 0, `${list.status}, ${list.data?.length} cooks`);
    const cookCard = (list.data || []).find((c) => c.approvalStatus === "approved");
    step("an approved cook is listed", Boolean(cookCard), cookCard?.user?.name);

    const profile = await api("GET", `/cooks/${cookCard._id}`);
    step("cook profile loads by profile id", profile.status === 200 && profile.data?.user?._id, profile.data?.user?._id);
    const cookUserId = profile.data.user._id;

    const date = tomorrowStr();
    const avail = await api(
      "GET",
      `/availability/${cookUserId}?date=${date}&durationHours=2`,
      { token: cust.token }
    );
    step(
      "availability start options for tomorrow (2h)",
      avail.status === 200 && Array.isArray(avail.data) && avail.data.length > 0,
      `${avail.status}, options: ${(avail.data || []).map((o) => o.startTime).join(",") || "(none)"}`
    );
    const slot = (avail.data || [])[0];
    step("a start time option exists", Boolean(slot?.startTime && slot?.endTime), slot ? `${slot.startTime}-${slot.endTime}` : "(none)");

    const bookingPayload = {
      cook: cookUserId,
      serviceType: "cook_for_me",
      date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      durationHours: 2,
      address: "H-12, Green Park, Near Metro, Pune",
      addressDetails: { flatNo: "H-12", society: "Green Park", landmark: "Metro", city: "Pune" },
      guests: 4,
      notes: "Medium spice, Jain options please",
      selectedItems: ["Modak", "Chakli"],
    };
    const created = await api("POST", "/bookings", { token: cust.token, body: bookingPayload });
    step(
      "booking request created",
      created.status === 201 && created.data?._id && created.data.status === "requested",
      `${created.status} ${created.data?.status || JSON.stringify(created.data)?.slice(0, 160)}`
    );
    const bookingId = created.data?._id;
    step("request includes WhatsApp link to cook", typeof created.data?.whatsappUrl === "string" && created.data.whatsappUrl.startsWith("https://wa.me/"), String(created.data?.whatsappUrl || "(none)").slice(0, 60));

    const rivalAvail = await api("GET", `/availability/${cookUserId}?date=${date}&durationHours=2`);
    const rivalSeesSlot = (rivalAvail.data || []).some(
      (o) => o.startTime === slot.startTime && o.endTime === slot.endTime
    );
    step("held slot hidden from other customers", rivalAvail.status === 200 && !rivalSeesSlot, rivalSeesSlot ? "STILL VISIBLE" : "hidden");

    const tampered = await api("POST", "/bookings", {
      token: cust.token,
      body: {
        cook: cookUserId, serviceType: "cook_for_me", date,
        startTime: "16:00", endTime: "18:00", durationHours: 2,
        address: "Tamper Lane, Pune", guests: 2,
        customer: "ffffffffffffffffffffffff",
        status: "completed",
        cookArrived: true, hoursCompleted: true,
        cookLocation: { lat: 12.34, lng: 56.78 },
      },
    });
    step(
      "booking create blocks customer/status/lifecycle tamper",
      tampered.status === 201 &&
        String(tampered.data?.customer) === String(cust.user.id) &&
        tampered.data?.status === "requested" &&
        !tampered.data?.cookArrived &&
        !tampered.data?.hoursCompleted &&
        tampered.data?.cookLocation == null,
      `${tampered.status} customerOwn=${String(tampered.data?.customer) === String(cust.user.id)} status=${tampered.data?.status} arrived=${!!tampered.data?.cookArrived}`
    );
    const tamperedId = tampered.data?._id;

    const polled = await api("GET", `/bookings/${bookingId}`, { token: cust.token });
    step("customer can poll booking status", polled.status === 200 && polled.data?.status === "requested", polled.data?.status);


    const cook = await login("priya@example.com", "password123");
    step("cook login", Boolean(cook.token), cook.user?.name);
    const cookBookings = await api("GET", "/bookings/cook", { token: cook.token });
    step(
      "cook sees the incoming request in dashboard",
      cookBookings.status === 200 && (cookBookings.data || []).some((b) => b._id === bookingId),
      `${cookBookings.status}, ${(cookBookings.data || []).length} bookings`
    );
    const accepted = await api("PATCH", `/bookings/${bookingId}/accept`, { token: cook.token });
    step(
      "cook accepts the request",
      accepted.status === 200 && accepted.data?.status === "accepted",
      `${accepted.status} ${accepted.data?.status || JSON.stringify(accepted.data)?.slice(0, 160)}`
    );

    const rejectBook = await api("POST", "/bookings", {
      token: cust.token,
      body: { cook: cookUserId, serviceType: "cook_with_me", date, startTime: "12:00", endTime: "14:00", durationHours: 2, address: "Reject Test, Pune", guests: 2 },
    });
    step("booking for reject/cancel test created -> 201", rejectBook.status === 201, `${rejectBook.status}`);
    const rejectedByCook = await api("PATCH", `/bookings/${rejectBook.data._id}/reject`, { token: cook.token });
    step("cook rejects 2nd booking -> 200 rejected", rejectedByCook.status === 200 && rejectedByCook.data?.status === "rejected", `${rejectedByCook.status} ${rejectedByCook.data?.status || JSON.stringify(rejectedByCook.data)?.slice(0, 100)}`);
    const cancelRejected = await api("PATCH", `/bookings/${rejectBook.data._id}/cancel`, { token: cust.token });
    step("customer cannot cancel a rejected booking -> 400", cancelRejected.status === 400, `${cancelRejected.status}`);

    const paid = await api("PATCH", `/bookings/${bookingId}/pay`, { token: cust.token, body: { method: "upi" } });
    step(
      "customer payment confirms the booking",
      paid.status === 200 && paid.data?.status === "confirmed" && paid.data?.payment?.status === "paid",
      `${paid.status} ${paid.data?.status || JSON.stringify(paid.data)?.slice(0, 160)}`
    );
    step("payment returns cook job-sheet WhatsApp link", typeof paid.data?.cookWhatsappUrl === "string" && paid.data.cookWhatsappUrl.startsWith("https://wa.me/"), String(paid.data?.cookWhatsappUrl || "(none)").slice(0, 60));
    step("payment returns customer confirmation WhatsApp link", typeof paid.data?.customerWhatsappUrl === "string" && paid.data.customerWhatsappUrl.startsWith("https://wa.me/91"), String(paid.data?.customerWhatsappUrl || "(none)").slice(0, 60));

    const details = await api("GET", `/bookings/${bookingId}`, { token: cust.token });
    step(
      "booking details load after payment",
      details.status === 200 && details.data?.status === "confirmed" && details.data?.cook?.name,
      `${details.status} ${details.data?.status}, cook: ${details.data?.cook?.name || "(none)"}`
    );

    const afterAvail = await api("GET", `/availability/${cookUserId}?date=${date}&durationHours=2`);
    const stillOffered = (afterAvail.data || []).some(
      (o) => o.startTime === slot.startTime && o.endTime === slot.endTime
    );
    step("booked slot removed from availability", afterAvail.status === 200 && !stillOffered, stillOffered ? "STILL OFFERED" : "removed");

    console.log(failures === 0 ? "\nBOOKING FLOW: ALL STEPS PASSED" : `\nBOOKING FLOW: ${failures} STEP(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    console.error("E2E ERROR:", err.message || err);
    process.exit(1);
  }
})();
