    // Live end-to-end test of COOK functionality against a running server.
// Run: node backend/cook-flow.e2e.js  (server on localhost:5000, seeded via node seeds/seed.js).
// Covers: own profile, public profile, create-profile guard,
// availability (my slots / set / delete / public), cook bookings dashboard, booking read,
// accept, reject, complete, customer review +
// cook review lists, cook notifications, and role denial (cook cannot author reviews).
const BASE = process.env.BASE_URL || "http://localhost:5000/api";
// Safety: this script CREATES real users/bookings in the target database.
// Refuse to run unless explicitly allowed — use a scratch database.
if (!process.env.ALLOW_LIVE_TESTS) {
  console.error(
    `Refusing to run: this e2e script writes test data to ${BASE}. ` +
      `Re-run with ALLOW_LIVE_TESTS=1 to confirm (point BASE_URL at a scratch database).`
  );
  process.exit(1);
}
let failures = 0;
const step = (label, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -> ${detail}` : ""}`); if (!ok) failures += 1; };
const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
};
const login = async (email, password) => { const r = await api("POST", "/auth/login", { body: { email, password } }); if (r.status !== 200 || !r.data?.token) throw new Error(`login failed for ${email}: ${r.status}`); return r.data; };
const tomorrowStr = () => { const d = new Date(); d.setDate(d.getDate() + 1); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const cut = (s) => (s ? String(s).slice(0, 90) : "");

(async () => {
  try {
    // 1. Cook login (Priya is an approved cook)
    const cook = await login("priya@example.com", "password123");
    step("cook login", Boolean(cook.token), cook.user?.name);
    step("cook logged in with role=cook", String(cook.user?.role).toUpperCase() === "COOK", JSON.stringify({ role: cook.user?.role }));

    // 2. Own profile (GET /cooks/me)
    const me = await api("GET", "/cooks/me", { token: cook.token });
    step("cook own profile -> 200", me.status === 200 && me.data?.user?.email === "priya@example.com", `${me.status} ${me.data?.approvalStatus || ""}`);
    const profileId = me.data._id;

    // 3. Public profile read (GET /cooks/:id accepts CookProfile id or User id).
    // Contact privacy: guests see discovery fields only (name/status) — the
    // cook's email/phone are never public (shared post-accept via bookings).
    const pub = await api("GET", `/cooks/${profileId}`);
    step("public cook profile read -> 200 without contact PII", pub.status === 200 && pub.data?.user?.name === "Priya Patil" && pub.data?.user?.email == null && pub.data?.user?.phone == null, `${pub.status}`);

    // 4. Create-profile guard: profile already exists -> 400
    const createGuard = await api("POST", "/cooks", { token: cook.token, body: { rate: 500, serviceTypes: ["cook_for_me"] } });
    step("cook create duplicate profile -> 400", createGuard.status === 400, `${createGuard.status} ${JSON.stringify(createGuard.data)?.slice(0, 60)}`);
// 4b. Privilege escalation blocked on UPDATE: self-approve / self-rate /
    //     profile-owner reassign / liveLocation via generic editor are ignored.
    const tamperUpdate = await api("PUT", `/cooks/${profileId}`, { token: cook.token, body: { serviceArea: "Pune Outer", approvalStatus: "rejected", rating: { average: 5, count: 42 }, user: "ffffffffffffffffffffffff", liveLocation: { lat: 1.234, lng: 1.234 } } });
    step("self-approve/re-rate/user/liveLocation tamper blocked on update", tamperUpdate.status === 200 && tamperUpdate.data?.approvalStatus === "approved" && tamperUpdate.data?.rating?.count === 0 && String(tamperUpdate.data?.user) === String(cook.user.id) && tamperUpdate.data?.liveLocation == null, `${tamperUpdate.status} approval=${tamperUpdate.data?.approvalStatus} rating=${JSON.stringify(tamperUpdate.data?.rating)} userOwn=${String(tamperUpdate.data?.user) === String(cook.user.id)}`);
    step("legit serviceArea still updates via editor", tamperUpdate.data?.serviceArea === "Pune Outer", tamperUpdate.data?.serviceArea);

    // 4c. Privilege escalation blocked on CREATE: a brand-new cook cannot
    //     self-approve / self-rate / reassign owner in their first profile.
    const fresh = await api("POST", "/auth/register", { body: { name: "Rohit Verma", email: "rohit@example.com", phone: "9000000001", password: "password123", role: "cook" } });
    step("fresh cook registered for create-path test", fresh.status === 201 && Boolean(fresh.data?.token), `${fresh.status}`);
    const freshProfile = await api("POST", "/cooks", { token: fresh.data.token, body: { rate: 400, serviceTypes: ["cook_with_me"], serviceArea: "Mumbai", approvalStatus: "approved", rating: { average: 5, count: 99 }, user: "ffffffffffffffffffffffff" } });
    step("new cook profile created -> 201", freshProfile.status === 201 && freshProfile.data?._id, `${freshProfile.status}`);
    step("self-approve on create ignored (profile starts pending)", freshProfile.data?.approvalStatus === "pending", freshProfile.data?.approvalStatus);
    step("rating/user escalation ignored on create", freshProfile.data?.rating?.count === 0 && String(freshProfile.data?.user) === String(fresh.data.user.id), `rating=${JSON.stringify(freshProfile.data?.rating)} userOwn=${String(freshProfile.data?.user) === String(fresh.data.user.id)}`);

    // 5. Live-location sharing was removed (PATCH /cooks/me/location gone).
    const loc = await api("PATCH", "/cooks/me/location", { token: cook.token, body: { lat: 12.9716, lng: 77.5946, accuracy: 12 } });
    step("cook live-location endpoint removed -> 404", loc.status === 404, `${loc.status}`);

    // 6. Cook views own slots (GET /availability/my)
    const mySlots = await api("GET", "/availability/my", { token: cook.token });
    step("cook own slots -> 200 array (>=21 seeded)", mySlots.status === 200 && Array.isArray(mySlots.data) && mySlots.data.length >= 21, `${mySlots.status}, ${(mySlots.data || []).length} slots`);

        // 7. Public availability (GET /cooks/:id/availability resolves profile OR user id)
    const pubSlots = await api("GET", `/cooks/${profileId}/availability`);
    step("public cook slots -> 200 array (>=21, profile id resolves)", pubSlots.status === 200 && Array.isArray(pubSlots.data) && pubSlots.data.length >= 21, `${pubSlots.status}, ${(pubSlots.data || []).length} slots`);
    const pubSlotsDt = await api("GET", `/cooks/${profileId}/availability?date=${tomorrowStr()}`);
    step("public cook slots for tomorrow -> 3 (timezone-safe date filter)", pubSlotsDt.status === 200 && (pubSlotsDt.data || []).length === 3, `${pubSlotsDt.status}, ${(pubSlotsDt.data || []).length} slots`);

    // 8. Cook SETS a new availability slot (POST /availability)
    const newSlotDate = tomorrowStr();
    const setSlot = await api("POST", "/availability", { token: cook.token, body: { date: newSlotDate, startTime: "20:00", endTime: "22:00" } });
    step("cook sets evening slot -> 201", setSlot.status === 201 && setSlot.data?._id, `${setSlot.status} ${JSON.stringify(setSlot.data)?.slice(0, 70)}`);
    const newSlotId = setSlot.data._id;

    // 9. New slot now appears in own slots (persisted)
    const mySlotsAfter = await api("GET", "/availability/my", { token: cook.token });
    const hasNewSlot = (mySlotsAfter.data || []).some((s) => s.startTime === "20:00" && s.endTime === "22:00");
    step("evening slot persisted in my slots", mySlotsAfter.status === 200 && hasNewSlot, `${mySlotsAfter.status}, ${(mySlotsAfter.data || []).length} slots`);

    // 10. Cook DELETES the slot (DELETE /availability/:id)
    const delSlot = await api("DELETE", `/availability/${newSlotId}`, { token: cook.token });
    step("cook deletes own slot -> 200", delSlot.status === 200, `${delSlot.status} ${JSON.stringify(delSlot.data)?.slice(0, 60)}`);
    const mySlotsFinal = await api("GET", "/availability/my", { token: cook.token });
    const gone = (mySlotsFinal.data || []).every((s) => !(s.startTime === "20:00" && s.endTime === "22:00"));
    step("evening slot gone from my slots", mySlotsFinal.status === 200 && gone, `${mySlotsFinal.status}, ${(mySlotsFinal.data || []).length} slots`);

    // 11. Customer books Priya tomorrow 09:00-11:00
    const cust = await login("neha@example.com", "password123");
    const date = tomorrowStr();
    const avail = await api("GET", `/availability/${cook.user.id}?date=${date}&durationHours=2`, { token: cust.token });
    const slot = (avail.data || []).find((o) => o.startTime === "09:00");
    step("availability offers 09:00 slot tomorrow", Boolean(slot), slot ? `${slot.startTime}-${slot.endTime}` : "(none)");
    const booking = await api("POST", "/bookings", {
      token: cust.token,
      body: {
                cook: cook.user.id,
        serviceType: "cook_for_me",
        date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        durationHours: 2,
        address: "Flat 12B, Lotus Terrace, Delhi",
        addressDetails: { flatNo: "12B", society: "Lotus Terrace", landmark: "Near Metro", city: "Delhi" },
        guests: 3,
        notes: "Early morning prep",
      },
    });
    step("customer books Priya 09:00 -> 201 requested", booking.status === 201 && booking.data?.status === "requested", `${booking.status} ${booking.data?.status || cut(booking.data)}`);
    const bookingId1 = booking.data._id;

    // 12. Cook dashboard: GET /bookings/cook sees the new request
    const cookBookings = await api("GET", "/bookings/cook", { token: cook.token });
    step("cook dashboard shows the request -> 200", cookBookings.status === 200 && (cookBookings.data || []).some((b) => b._id === bookingId1), `${cookBookings.status}, ${(cookBookings.data || []).length} bookings`);

    // 13. Cook reads the booking detail (owner/cook allowed)
    const bookingDetail = await api("GET", `/bookings/${bookingId1}`, { token: cook.token });
    step("cook reads own booking -> 200 requested", bookingDetail.status === 200 && bookingDetail.data?.status === "requested", `${bookingDetail.status} ${bookingDetail.data?.status || cut(bookingDetail.data)}`);

        // 14. Cook accepts the request (own booking, status requested -> accepted)
    const accepted = await api("PATCH", `/bookings/${bookingId1}/accept`, { token: cook.token });
    step("cook accepts booking -> 200 accepted", accepted.status === 200 && accepted.data?.status === "accepted", `${accepted.status} ${accepted.data?.status || cut(accepted.data)}`);
    step("accepted booking has payment deadline", !!accepted.data?.paymentExpiresAt, `${!!accepted.data?.paymentExpiresAt}`);

    // 15-16. Live location tracking was removed: the share + /live endpoints
    // are gone (expect 404s), arrival is manual-only now.
    const share = await api("PATCH", `/bookings/${bookingId1}/cook-location`, { token: cook.token, body: { lat: 28.6139, lng: 77.209, accuracy: 20 } });
    step("cook-location endpoint removed -> 404", share.status === 404, `${share.status}`);
    const tracking = await api("GET", `/bookings/${bookingId1}/live`, { token: cook.token });
    step("live tracking endpoint removed -> 404", tracking.status === 404, `${tracking.status}`);

    // Manual arrival is disabled (loophole closure): the endpoint must refuse
    // with 410 and leave the booking untouched.
    const arrived = await api("PATCH", `/bookings/${bookingId1}/arrived`, { token: cook.token });
    step("manual arrival disabled -> 410", arrived.status === 410, `${arrived.status}`);
    const detail2 = await api("GET", `/bookings/${bookingId1}`, { token: cook.token });
    step("booking details show cookArrived still false", detail2.status === 200 && detail2.data?.cookArrived === false, `${detail2.status} ${detail2.data?.cookArrived}`);

    // 18. 2nd booking (12:00) for the cook to REJECT
    const slot2 = (avail.data || []).find((o) => o.startTime === "12:00");
    const booking2 = await api("POST", "/bookings", { token: cust.token, body: { cook: cook.user.id, serviceType: "cook_for_me", date, startTime: slot2.startTime, endTime: slot2.endTime, durationHours: 2, address: "Flat 12B, Lotus Terrace, Delhi", guests: 2 } });
    step("2nd booking created -> 201", booking2.status === 201, `${booking2.status}`);
    const rejected = await api("PATCH", `/bookings/${booking2.data._id}/reject`, { token: cook.token });
    step("cook rejects booking -> 200 rejected", rejected.status === 200 && rejected.data?.status === "rejected", `${rejected.status} ${rejected.data?.status || cut(rejected.data)}`);

    // 18b. Customer pays (explicit no-money test checkout on the scratch
    // server), then the cook starts the service with the customer's OTP —
    // the real paid -> OTP -> complete journey (unpaid work can never start
    // or complete).
    const paid1 = await api("PATCH", `/bookings/${bookingId1}/pay`, { token: cust.token, body: { method: "upi", testMode: true } });
    step("customer pays (test mode) -> 200 confirmed", paid1.status === 200 && paid1.data?.status === "confirmed", `${paid1.status} ${paid1.data?.status || cut(paid1.data)}`);
    const custDetail = await api("GET", `/bookings/${bookingId1}`, { token: cust.token });
    const otp = custDetail.data?.serviceOtp;
    step("customer can read the service OTP", typeof otp === "string" && otp.length === 4, String(otp || "(none)"));
    const started = await api("PATCH", `/bookings/${bookingId1}/start-service`, { token: cook.token, body: { otp } });
    step("cook starts service with OTP -> 200 in_progress", started.status === 200 && started.data?.status === "in_progress", `${started.status} ${started.data?.status || cut(started.data)}`);

    // 19. Cook completes the paid+started booking (-> completed, review link issued)
    const completed = await api("PATCH", `/bookings/${bookingId1}/complete`, { token: cook.token });
    step("cook completes booking -> 200 completed", completed.status === 200 && completed.data?.status === "completed", `${completed.status} ${completed.data?.status || cut(completed.data)}`);
    step("complete issued reviewWhatsAppUrl + reviewUrl", completed.data?.reviewWhatsappUrl && completed.data?.reviewUrl, `${!!completed.data?.reviewWhatsappUrl} ${!!completed.data?.reviewUrl}`);

    // 20. Customer leaves a review (only on completed bookings)
    const review = await api("POST", "/reviews", { token: cust.token, body: { booking: bookingId1, rating: 5, comment: "Priya was wonderful!" } });
    step("customer review on completed booking -> 201", review.status === 201 && review.data?.rating === 5, `${review.status} ${review.data?.rating}`);

    // 21. Cook reads their received reviews (GET /reviews/cook-me)
    const ownReviews = await api("GET", "/reviews/cook-me", { token: cook.token });
    step("cook sees received reviews -> 200", ownReviews.status === 200 && (ownReviews.data || []).length >= 1, `${ownReviews.status}, ${(ownReviews.data || []).length} reviews`);
    step("review shows the customer name", (ownReviews.data || []).some((r) => r.customer?.name), `${(ownReviews.data || [])[0]?.customer?.name || "(none)"}`);

    // 22. Public reviews endpoint resolves profile id -> user
    const pubReviews = await api("GET", `/reviews/cook/${profileId}`);
    step("public cook reviews -> 200 with the review", pubReviews.status === 200 && (pubReviews.data || []).length >= 1, `${pubReviews.status}, ${(pubReviews.data || []).length} reviews`);

    // 23. Cook notifications endpoint works (auth, role-agnostic)
    const notifications = await api("GET", "/notifications", { token: cook.token });
    step("cook notifications -> 200 array", notifications.status === 200 && Array.isArray(notifications.data), `${notifications.status}, ${(notifications.data || []).length} notifications`);

    // 24. A cook CANNOT author a review (customer-only) -> 403
    const cookReview = await api("POST", "/reviews", { token: cook.token, body: { booking: bookingId1, rating: 4, comment: "oops" } });
    step("cook cannot author a review -> 403", cookReview.status === 403, `${cookReview.status}`);

    console.log(failures === 0 ? "\nCOOK FLOW: ALL STEPS PASSED" : `\nCOOK FLOW: ${failures} STEP(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    console.error("COOK E2E ERROR:", err.message || err);
    process.exit(1);
  }
})();