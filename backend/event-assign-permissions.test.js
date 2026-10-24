// COOKMITRA EVENTS admin cook-assignment permission tests (offline-safe, no DB).
// Run: node backend/event-assign-permissions.test.js — exits non-zero on failure.
//
// Proves the assignment permission flow end to end WITHOUT a database:
//  1. authorize("admin") runtime behaviour: customer/cook/anonymous → 403,
//     admin → next(). The actual middleware that gates every mutation route.
//  2. Route wiring: assign-cook / status / verify-distance / list carry
//     auth + authorize("admin"); creation stays customer-only.
//  3. Controller defense-in-depth: assignCook itself rejects non-admin
//     callers (403) even if it is ever reached without the route middleware,
//     and enforces status precondition, cook id validity, eligibility,
//     atomic version claim, and customer+cook notification of the assign.
//  4. Frontend: the assign endpoint is referenced ONLY by admin surfaces
//     (queue component rendered solely from the admin-gated dashboard route,
//     details-page panel gated on role === "admin").
//  5. Notification openability: outbox delivery stamps the booking link,
//     the Notification schema accepts it, and both the notifications page
//     and the popup use n.link as the click target.
// Admin happy path, concurrency races and live notification counts are
// covered by event-concurrency.test.js (real database).

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { authorize } = require("./middleware/auth");
const Notification = require("./models/Notification");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`);
  if (!ok) failures++;
};

const read = (p) => fs.readFileSync(path.join(__dirname, p), "utf8");
const sliceBetween = (src, start, end) => {
  const s = src.indexOf(start);
  if (s < 0) return "";
  const e = src.indexOf(end, s + start.length);
  return src.slice(s, e < 0 ? src.length : e);
};

// ── 1. authorize("admin") runtime gate ───────────────────────────────────────
const runAuthorize = (role) => {
  let status = null;
  let nextCalled = false;
  const req = role === undefined ? {} : { user: { id: "u1", role } };
  const res = {
    status(c) {
      status = c;
      return this;
    },
    json() {
      return this;
    },
  };
  authorize("admin")(req, res, () => {
    nextCalled = true;
  });
  return { status, nextCalled };
};

const cust = runAuthorize("customer");
check("customer role → 403, no next()", cust.status === 403 && !cust.nextCalled, JSON.stringify(cust));
const cook = runAuthorize("cook");
check("cook role → 403, no next()", cook.status === 403 && !cook.nextCalled, JSON.stringify(cook));
const custUpper = runAuthorize("CUSTOMER");
check("uppercase CUSTOMER → 403 (roles compared case-insensitively)", custUpper.status === 403 && !custUpper.nextCalled, JSON.stringify(custUpper));
const anon = runAuthorize(undefined);
check("no user → 403", anon.status === 403 && !anon.nextCalled, JSON.stringify(anon));
const adm = runAuthorize("admin");
check("admin role → next(), no 403", adm.nextCalled && adm.status === null, JSON.stringify(adm));
const admUpper = runAuthorize("ADMIN");
check("uppercase ADMIN → next()", admUpper.nextCalled && admUpper.status === null, JSON.stringify(admUpper));

// ── 2. Route wiring (routes/eventBookings.js) ────────────────────────────────
const routes = read("routes/eventBookings.js");
check("auth middleware imported with authorize", /const \{ auth, authorize \} = require\("\.\.\/middleware\/auth"\)/.test(routes));
check("assign-cook route is auth + authorize(admin)", /"\/:id\/assign-cook",\s*auth,\s*authorize\("admin"\)/.test(routes));
check("status route is auth + authorize(admin)", /"\/:id\/status",\s*auth,\s*authorize\("admin"\)/.test(routes));
check("verify-distance route is auth + authorize(admin)", /"\/:id\/verify-distance",\s*auth,\s*authorize\("admin"\)/.test(routes));
check("booking list is admin-only", /router\.get\("\/", auth, authorize\("admin"\)/.test(routes));
check("creation restricted to customers (not cooks/admins)", /router\.post\(\s*"\/",\s*auth,\s*authorize\("customer"\)/.test(routes));
check("assign-cook validates cookId as Mongo id", /"\/:id\/assign-cook"[\s\S]{0,220}?isMongoId/.test(routes));

// ── 3. Controller defense-in-depth + assignment invariants ───────────────────
const ctrl = read("controllers/eventBookingController.js");
const assignSrc = sliceBetween(ctrl, "exports.assignCook = async", "exports.updateEventBookingStatus");
check("assignCook source located", assignSrc.length > 1000, `len=${assignSrc.length}`);
check(
  "assignCook rejects non-admin callers directly (403)",
  /String\(req\.user\?\.role \|\| ""\)\.toUpperCase\(\) !== "ADMIN"/.test(assignSrc) &&
    /status\(403\)\.json\(\{ message: "Not authorized for this action" \}\)/.test(assignSrc)
);
check(
  "assignCook limited to pending/cook_assigned",
  /\["pending", "cook_assigned"\]\.includes\(booking\.bookingStatus\)/.test(assignSrc)
);
check("assignCook validates cook id", /isValidObjectId\(cookId\)/.test(assignSrc));
check("assignCook re-validates cook eligibility server-side", /checkCookEligible\(cookId\)/.test(assignSrc));
check("assignCook claims atomically (version + expected status)", /expectedVersion: prevVersion/.test(assignSrc) && /expectedStatuses: \["pending", "cook_assigned"\]/.test(assignSrc));
check("assignCook 409s on concurrent conflict", /status\(409\)/.test(assignSrc));
check("assignCook sets status cook_assigned with admin history", /bookingStatus: "cook_assigned"/.test(assignSrc) && /Cook assigned by admin/.test(assignSrc));
check("assignCook notifies customer + cook", /event_cook_assigned/.test(assignSrc) && /event_assignment/.test(assignSrc));

const createSrc = sliceBetween(ctrl, "exports.createEventBooking = async", "exports.getMyEventBookings");
check("new booking notifies active admins", /role: "ADMIN", status: "active"/.test(createSrc) && /event_booking_request/.test(createSrc));
check("admin notice asks for cook assignment", /please assign a cook/.test(createSrc));

// ── 4. Frontend: assign UI exists only on admin surfaces ─────────────────────
const fe = (p) => fs.readFileSync(path.join(__dirname, "../frontend/src", p), "utf8");
const details = fe("pages/EventBookingDetails.jsx");
check("details page computes isAdmin from role", /isAdmin = user\?\.role === "admin"/.test(details));
check("details page gates assign panel behind assignable (admin + pending/cook_assigned)", /assignable = isAdmin && \["pending", "cook_assigned"\]\.includes\(status\)/.test(details));
check("details page assign call lives behind the gated panel", /\{assignable &&\s*\(assigning \?/.test(details) && /assign-cook/.test(details));

const queue = fe("components/EventBookingAdmin.jsx");
check("admin queue offers assign + reassign", /assign-cook/.test(queue) && /Reassign cook/i.test(queue));
check("admin queue handles 409 conflicts with refetch", /err\.response\?\.status === 409/.test(queue));

const dash = fe("pages/AdminDashboard.jsx");
check("queue component imported only by AdminDashboard", /<EventBookingAdmin/.test(dash));

const app = fe("App.js");
check("AdminDashboard route is admin-only", /path="\/admin"[\s\S]{0,240}?roles=\{\["admin"\]\}/.test(app));
check("booking details route open to admin (from notification link)", /path="\/event-bookings\/:id"[\s\S]{0,200}?roles=\{\["customer", "cook", "admin"\]\}/.test(app));

const callers = [];
const walk = (dir) => {
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (/\.(js|jsx)$/.test(f) && fs.readFileSync(full, "utf8").includes("/assign-cook")) {
      // "/assign-cook" (with slash) = the event-bookings API endpoint, not
      // unrelated DOM ids like "brm-assign-cook" in the on-demand modal.
      callers.push(path.relative(path.join(__dirname, "../frontend/src"), full).split(path.sep).join("/"));
    }
  }
};
walk(path.join(__dirname, "../frontend/src"));
const expectedCallers = ["components/EventBookingAdmin.jsx", "pages/EventBookingDetails.jsx"];
check(
  "assign endpoint referenced ONLY by admin surfaces",
  JSON.stringify(callers.sort()) === JSON.stringify(expectedCallers),
  JSON.stringify(callers.sort())
);

// ── 5. Notification openability (admin opens pending booking from notice) ────
const outbox = read("utils/eventOutbox.js");
check("outbox delivery stamps booking link on notices", /const link = fresh\.bookingId \? `\/event-bookings\/\$\{fresh\.bookingId\}` : ""/.test(outbox));
check("stamped link persisted with the notification", /link, eventKey: fresh\.eventKey/.test(outbox));

const linkDoc = new Notification({
  user: new mongoose.Types.ObjectId(),
  type: "event_booking_request",
  message: "New event booking EVT-TEST: Birthday on 2026-11-01 — please assign a cook.",
  link: "/event-bookings/64f000000000000000000000",
});
check("booking link validates against Notification schema", !linkDoc.validateSync(), String((linkDoc.validateSync() || {}).message));
const extDoc = new Notification({
  user: new mongoose.Types.ObjectId(),
  type: "event_booking_request",
  message: "x",
  link: "https://evil.example/x",
});
check("external/absolute link rejected by schema", !!extDoc.validateSync());

const notifPage = fe("pages/Notifications.jsx");
for (const t of ["event_booking_request", "event_cook_assigned", "event_assignment", "event_status", "event_cancelled"]) {
  check(`TYPE_META has label for ${t}`, new RegExp(`\\b${t}: \\{ label:`).test(notifPage));
}
check("notifications page uses n.link as click target", /if \(typeof n\.link === "string"/.test(notifPage));
const popup = fe("components/NotificationPopup.jsx");
check("popup prefers n.link for navigation", /if \(n\?\.link\) return n\.link;/.test(popup));

// ── Summary ──────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll admin cook-assignment permission checks passed");
