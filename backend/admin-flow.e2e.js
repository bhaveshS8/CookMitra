// Live end-to-end test of ADMIN functionality against a running server.
// Run: node backend/admin-flow.e2e.js  (server on localhost:5000, seeded via node seeds/seed.js).
// Verifies admin auth/authorization + every admin route: user directory, block/unblock,
// cook approval, admin cook dossier, platform bookings list, accept/reject on behalf of
// a cook, lead management, self-delete guard, and role-based access denial for cooks.
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
const step = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -> ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
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
const cut = (s) => (s ? String(s).slice(0, 90) : "");

(async () => {
  try {
    // 1. Admin login (role=admin)
    const admin = await login("admin@festivecook.com", "admin123");
    step("admin login", Boolean(admin.token), admin.user?.name);
    step("admin logged in with role=admin", String(admin.user?.role).toUpperCase() === "ADMIN", JSON.stringify({ role: admin.user?.role }));

        // 2. User directory (admin only, password-stripped)
    const users = await api("GET", "/auth/users", { token: admin.token });
    step("admin lists users -> 200 array", users.status === 200 && Array.isArray(users.data) && users.data.length >= 4, `${users.status}, ${users.data?.length} users`);
    const adminSelf = (users.data || []).find((u) => u.email === "admin@festivecook.com");
    const neha = (users.data || []).find((u) => u.email === "neha@example.com");
    const sunita = (users.data || []).find((u) => u.email === "sunita@example.com");
    step("user directory contains admin + customer + cook", Boolean(adminSelf && neha && sunita), `${!!adminSelf} ${!!neha} ${!!sunita}`);
    step("password is never returned in user list", !users.data.some((u) => u.password), "no password fields");

    // 3. Admin sees ALL cooks via GET /cooks (incl. the pending Sunita)
    const cooks = await api("GET", "/cooks", { token: admin.token });
    step("admin sees all cooks incl. pending", cooks.status === 200 && Array.isArray(cooks.data) && cooks.data.length >= 2, `${cooks.status}, ${cooks.data?.length} cooks`);
    const sunitaProfile = (cooks.data || []).find((c) => c?.user?.email === "sunita@example.com");
    const priyaProfile = (cooks.data || []).find((c) => c?.user?.email === "priya@example.com");
    step("sunita visible while still pending", sunitaProfile && sunitaProfile.approvalStatus === "pending", sunitaProfile?.approvalStatus);

    // 4. Approve the pending cook
    const approve = await api("PATCH", `/cooks/${sunitaProfile._id}/approval`, { token: admin.token, body: { status: "approved" } });
    step("admin approves pending cook -> 200 approved", approve.status === 200 && approve.data?.approvalStatus === "approved", `${approve.status} ${approve.data?.approvalStatus || cut(approve.data)}`);

        // 5. Block then unblock the cook (immediate effect)
    const block = await api("PATCH", `/auth/users/${sunita._id}/status`, { token: admin.token, body: { status: "suspended" } });
    step("admin blocks cook -> 200", block.status === 200 && block.data?.status === "suspended", `${block.status} ${block.data?.status}`);
    const unblock = await api("PATCH", `/auth/users/${sunita._id}/status`, { token: admin.token, body: { status: "active" } });
    step("admin unblocks cook -> 200 active", unblock.status === 200 && unblock.data?.status === "active", `${unblock.status} ${unblock.data?.status}`);

    // 5b. A blocked account is rejected at login
    await api("PATCH", `/auth/users/${sunita._id}/status`, { token: admin.token, body: { status: "suspended" } });
    const blockedLogin = await api("POST", "/auth/login", { body: { email: "sunita@example.com", password: "password123" } });
    step("blocked cook cannot log in -> 403", blockedLogin.status === 403, `${blockedLogin.status}`);
        await api("PATCH", `/auth/users/${sunita._id}/status`, { token: admin.token, body: { status: "active" } });

        // 6. Cook admin dossier (admin overview)
    const overview = await api("GET", `/cooks/admin-overview/${priyaProfile._id}`, { token: admin.token });
    step("admin cook dossier -> 200", overview.status === 200 && overview.data?.profile && overview.data?.summary, `${overview.status} keys=${Object.keys(overview.data || {}).join(",")}`);

    // 7. Customer books Priya for tomorrow 09:00-11:00
    const cust = await login("neha@example.com", "password123");
    const date = tomorrowStr();
    const avail = await api("GET", `/availability/${priyaProfile.user._id}?date=${date}&durationHours=2`, { token: cust.token });
    const slot = (avail.data || []).find((o) => o.startTime === "09:00");
    step("availability offers 09:00 slot tomorrow", Boolean(slot), slot ? `${slot.startTime}-${slot.endTime}` : "(none)");
    const booking = await api("POST", "/bookings", {
      token: cust.token,
      body: {
        cook: priyaProfile.user._id,
        serviceType: "cook_for_me",
        date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        durationHours: 2,
        address: "Flat 5, Sunshine Apt, Pune",
        addressDetails: { flatNo: "5", society: "Sunshine Apt", landmark: "Near Park", city: "Pune" },
        guests: 2,
        notes: "Less spice, please",
      },
    });
    step("customer booking created -> 201 requested", booking.status === 201 && booking.data?.status === "requested", `${booking.status} ${booking.data?.status || cut(booking.data)}`);
    const bookingId = booking.data._id;

    // 8. Admin sees it in the platform-wide booking list
    const adminBookings = await api("GET", "/bookings", { token: admin.token });
    step("admin sees all bookings incl. new one", adminBookings.status === 200 && (adminBookings.data || []).some((b) => b._id === bookingId), `${adminBookings.status}, ${(adminBookings.data || []).length} bookings`);

    // 9. Admin accepts on behalf of the cook
    const accepted = await api("PATCH", `/bookings/${bookingId}/accept`, { token: admin.token });
    step("admin accepts booking -> 200 accepted", accepted.status === 200 && accepted.data?.status === "accepted", `${accepted.status} ${accepted.data?.status || cut(accepted.data)}`);

        // 10. 2nd booking (12:00) then admin rejects it (requested -> rejected)
    const slot2 = (avail.data || []).find((o) => o.startTime === "12:00");
    const booking2 = await api("POST", "/bookings", {
      token: cust.token,
      body: { cook: priyaProfile.user._id, serviceType: "cook_for_me", date, startTime: slot2.startTime, endTime: slot2.endTime, durationHours: 2, address: "Flat 5, Sunshine Apt, Pune", guests: 2 },
    });
    step("2nd booking created for reject -> 201", booking2.status === 201, `${booking2.status}`);
    const rejected = await api("PATCH", `/bookings/${booking2.data._id}/reject`, { token: admin.token });
    step("admin rejects booking -> 200 rejected", rejected.status === 200 && rejected.data?.status === "rejected", `${rejected.status} ${rejected.data?.status || cut(rejected.data)}`);

    // 11. Leads: public capture -> admin list -> update -> delete
    const lead = await api("POST", "/leads", { body: { name: "Test Lead", whatsapp: "9876543210", location: "Mumbai" } });
    step("public lead capture -> 201", lead.status === 201 && lead.data?.lead, `${lead.status}`);
    const leadId = lead.data.lead._id;
    const leads = await api("GET", "/leads", { token: admin.token });
    step("admin sees lead in enquiries -> 200", leads.status === 200 && (leads.data || []).some((l) => l._id === leadId), `${leads.status}, ${(leads.data || []).length} leads`);
    const leadUpd = await api("PATCH", `/leads/${leadId}`, { token: admin.token, body: { status: "contacted" } });
    step("admin updates lead status -> 200", leadUpd.status === 200 && leadUpd.data?.status === "contacted", `${leadUpd.status} ${leadUpd.data?.status || cut(leadUpd.data)}`);
    const leadDel = await api("DELETE", `/leads/${leadId}`, { token: admin.token });
    step("admin deletes lead -> 200", leadDel.status === 200, `${leadDel.status}`);

        // 12. Admin cannot delete own account (guardrail)
    const selfDel = await api("DELETE", `/auth/users/${adminSelf._id}`, { token: admin.token });
    step("admin cannot delete self -> 400", selfDel.status === 400, `${selfDel.status} ${JSON.stringify(selfDel.data)?.slice(0, 80)}`);

    // 13. Admin delete a cook account (cascade delete)
    const delCook = await api("DELETE", `/auth/users/${sunita._id}`, { token: admin.token });
    step("admin deletes cook account -> 200", delCook.status === 200 && delCook.data, `${delCook.status}`);
        const finalUsers = await api("GET", "/auth/users", { token: admin.token });
    step("admin still authenticated after delete -> 200", finalUsers.status === 200, `${finalUsers.status}`);

    // 14. Non-admin (cook) is denied admin endpoints (authorization works)
    const cook = await login("priya@example.com", "password123");
        const forbidden = await api("GET", "/auth/users", { token: cook.token });
    step("cook cannot list users -> 403", forbidden.status === 403, `${forbidden.status}`);
    const cookOwnProfile = await api("PUT", `/cooks/${priyaProfile._id}`, { token: cook.token, body: { serviceArea: "Pune" } });
    step("cook update own profile -> 200", cookOwnProfile.status === 200, `${cookOwnProfile.status}`);
  } catch (err) {
    console.error("ADMIN E2E ERROR:", err.message || err);
    process.exit(1);
  }
})();