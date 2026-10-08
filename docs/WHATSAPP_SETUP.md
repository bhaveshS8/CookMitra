# WhatsApp notifications (Meta Cloud API)

Both the **user (customer)** and the **cook** automatically receive WhatsApp
messages for every major booking event:

| Event | Customer | Cook |
|---|---|---|
| New booking request | ✅ request sent | ✅ new request + venue |
| Cook accepts | ✅ pay within 5 min | ✅ (only if admin accepted for them) |
| Cook rejects | ✅ declined (+refund note) | — |
| Payment confirmed | ✅ confirmation + cook contact | ✅ job sheet + venue pin |
| Service starts (OTP) | ✅ session started | ✅ clock running |
| Cooking hours complete | ✅ alarm | ✅ alarm |
| Service completed | ✅ please rate cook | ✅ closed |
| Cancelled | ✅ | ✅ |
| Rescheduled | ✅ old → new slot | ✅ old → new slot |
| Expired (no response / unpaid) | ✅ | ✅ |

In-app notifications are **always** created too — WhatsApp is an extra push.
If WhatsApp is unconfigured or Meta is down, bookings keep working normally
(the failure is logged, never thrown).

## 1. Create the Meta app (one time, ~15 min)

1. Go to <https://developers.facebook.com/apps> → **Create App** → choose
   **Business** type.
2. In the app dashboard → **Add Product** → **WhatsApp** → follow the quick
   setup. Meta gives you:
   - a **test phone number** (free, sends to up to 5 test recipients), and
   - a temporary **access token** (valid ~24h, good for testing only).
3. **Add your own number as a test recipient**: WhatsApp → API Setup →
   **To** → Manage phone number list → add the user + cook test numbers
   (they must accept the invite code on their phone first).

## 2. Test immediately (no code changes)

```bash
# backend/.env
WHATSAPP_ENABLED=true
WHATSAPP_TOKEN=<temporary token from API Setup page>
WHATSAPP_PHONE_NUMBER_ID=<Phone number ID from API Setup page>
```

Restart the backend, then as an **admin** user:

```bash
curl -X POST http://localhost:5000/api/whatsapp/test \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"to":"9876543210","message":"Hello from CookMitra!"}'
```

The phone should receive the message within seconds.

## 3. Go live (production)

1. **Add a real business number**: WhatsApp → API Setup → add your business
   phone number (it must NOT be tied to the regular WhatsApp app — use a
   fresh SIM/eSIM; Meta takes it over).
2. **Permanent token**: Business Settings → System Users → create a system
   user with `whatsapp_business_messaging` permission → **Generate token**
   (never expires). Put it in `WHATSAPP_TOKEN`.
3. **Verify the business + request production access** (Meta review, usually
   1–3 days) so you can message any customer, not just test numbers.
4. **Message templates** (important): Meta only allows *free-form text* in
   two cases —
   - within the **24-hour customer-service window** (user messaged you, or
     you reply to their booking action — this covers request/accept/pay/
     start flows), or
   - via **pre-approved templates** otherwise (reminders like hours-complete
     / review requests sent hours later).
   
   This integration sends plain-text messages (works fully inside the
   24h window). For outside-window reliability, create matching templates in
   **WhatsApp Manager → Message Templates** with the same wording, then the
   sender can be switched to template mode without touching the controllers
   (all copy lives in `backend/utils/whatsapp.js` message builders).

## 4. Environment variables

```bash
WHATSAPP_ENABLED=true
WHATSAPP_TOKEN=<permanent system-user token>
WHATSAPP_PHONE_NUMBER_ID=<live phone number ID>
# optional: WHATSAPP_API_VERSION=v22.0
# Cook request template (optional cold-start path — Meta only delivers
# approved templates outside the 24h window). Canonical names read by
# backend/utils/whatsappApi.js sendCookRequestInteractive(); the _FOR_COOK
# aliases are still honored for existing .env files.
# WHATSAPP_REQUEST_TEMPLATE=cook_booking_request
# WHATSAPP_REQUEST_TEMPLATE_LANG=en
# (legacy aliases: WHATSAPP_REQUEST_TEMPLATE_FOR_COOK,
#  WHATSAPP_TEMPLATE_LANG_COOK_REQUEST)
# NOTE: broadcast fan-out (backend/services/whatsappDispatch.js) intentionally
# sends ONLY the Marathi interactive message and ignores all template vars
# (the approved template's {{n}} bindings render shifted values) — see T16
# in backend/whatsapp-channel.test.js. The template path above applies only
# to the direct-cook helper in utils/whatsappApi.js.
#
# Troubleshooting 401 code 190 "Authentication Error": Meta rejected
# WHATSAPP_TOKEN (expired temporary token, revoked system-user token, or token
# from a different app than WHATSAPP_PHONE_NUMBER_ID). Regenerate the token
# (WhatsApp > API Setup for testing, permanent system-user token for prod),
# keep it on ONE line in backend/.env, and restart. The server log now prints
# this hint inline with the failure.
```

Backend logs a `CONFIG NOTICE` at boot when these are missing — that just
means auto-push is off (safe).

## 5. How it is wired

- Copy: `backend/utils/whatsapp.js` (`build*Message` — single source of
  truth for both the Cloud API text and the `wa.me` share links).
- Sender: `backend/utils/whatsappApi.js` (`sendBookingWhatsApp`,
  `notifyWhatsApp` fire-and-forget wrapper, `GET /api/whatsapp/status`,
  `POST /api/whatsapp/test`).
- Hooks: `backend/controllers/bookingController.js` calls
  `notifyWhatsApp(event, booking, …)` after every state change — always
  fire-and-forget, always after the DB write + in-app `Notification.create`,
  so a WhatsApp outage can never fail or double-run a booking.
- Broadcast fan-out: `POST /api/bookings` emits
  `notifyWhatsAppEvent("booking.requested", …)` from
  `backend/services/whatsappDispatch.js`, which sends the Marathi request
  to every cook returned by the same eligibility rules as
  `GET /bookings/cook/requests`, tracking per-cook delivery in
  `Booking.whatsappDispatch` (`sent` only after Meta accepts; `failed`
  stays retryable).
- Shared rules: website and WhatsApp accepts/rejects both execute
  `acceptBookingForCook` / `rejectBookingForCook` in
  `backend/services/bookingAcceptService.js` (same validations, same atomic
  `updateOne({_id, status: "requested", …})` claim, same side effects).
  Marathi copy lives in `backend/utils/whatsappMessages.js`.
- Regression test: `backend/whatsapp-api.test.js`
  (`node backend/whatsapp-api.test.js`).

## 6. Costs

Meta's pricing is per 24h conversation (≈ ₹0.35–0.70 utility conversation
in India, 2025 rates; verify current pricing in WhatsApp Manager). Test
numbers are free.

## 7. Cook Accept / Decline from WhatsApp

Yes — the cook can decide **without opening the dashboard**:

1. The booking request arrives as a **Marathi interactive message** with
   **✅ बुकिंग स्वीकारा** / **❌ नकार द्या** buttons (payloads
   `accept:<bookingId>` / `reject:<bookingId>` — the payload only names
   the booking; the verified sender number decides the cook). Plain-text
   replies (`ACCEPT`, `DECLINE`, …) work too.
2. The tap hits `POST /api/whatsapp/webhook`, which:
   - verifies `X-Hub-Signature-256` over the raw body (fail-closed),
   - matches the sender's number to the assigned cook (no enumeration —
     strangers get silence),
   - requires the booking to still be `requested` inside its 5-minute
     window (expired taps are refused and the customer is notified),
   - flips state with the **same atomic claims** as the dashboard
     endpoints (a dashboard tap racing a WhatsApp tap has exactly one
     winner; the loser is told the current truth),
   - notifies the customer in-app + on WhatsApp, and confirms to the cook.
3. Text without a booking id uses the cook's single pending request, or
   lists the pendings when several exist.
4. If a cook reports not receiving the request: check the server logs for
   `[whatsapp:request]` lines (template/button errors from Meta are logged
   with booking + cook ids), inspect `Booking.whatsappDispatch` for the
   per-cook `sent`/`failed` state, and re-send with
   `POST /api/bookings/:id/notify-cooks` (admin — idempotent: already-`sent`
   cooks are skipped, `failed` ones retried).

### Webhook setup (one time)

1. In your Meta app → WhatsApp → Configuration → **Webhook**:
   - Callback URL: `https://<your-domain>/api/whatsapp/webhook`
   - Verify token: any long random string → put it in
     `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and restart first.
   - Subscribe to the **`messages`** field.
2. Copy the **App Secret** (app dashboard → Settings → Basic) into
   `WHATSAPP_APP_SECRET` — without it every inbound call is refused.
3. Test: tap Decline on a test request, or reply `ACCEPT` — the booking
   flips in the dashboard and the customer is notified.
4. Cold starts (cook never messaged the business number): Meta only
   delivers **approved templates** outside the 24h window. Create a
   `cook_booking_request` Utility template with the same wording plus
   Accept/Decline quick replies, set `WHATSAPP_REQUEST_TEMPLATE` (+
   `WHATSAPP_REQUEST_TEMPLATE_LANG`, or the legacy aliases
   `WHATSAPP_REQUEST_TEMPLATE_FOR_COOK` / `WHATSAPP_TEMPLATE_LANG_COOK_REQUEST`);
   the direct-cook sender tries the template first and falls back to interactive.
   (Broadcast fan-out stays interactive-only by design — see section 4 note.)

## 8. Dispatch reliability (durable outbox)

Booking-request fan-out no longer depends on an unawaited background task.
`createBooking` persists a `DispatchJob` (`backend/models/DispatchJob.js`,
unique per booking) **before** returning 201, and an in-process worker
(`backend/services/bookingDispatchJobs.js`) claims due jobs atomically, so
restarts, deploys, and multi-instance/cluster setups cannot silently lose
or double-process dispatch work.

- **Every exit is recorded**: each job ends `completed`, `skipped`, or
  `failed` with a machine-readable `reason` (`dispatched`,
  `partially_dispatched`, `whatsapp_disabled`, `no_eligible_cooks`,
  `booking_not_requested`, `booking_expired`, `cook_already_assigned`,
  `no_valid_recipients`, `meta_api_error`, `network_timeout`,
  `database_error`, `unexpected_error`, `booking_missing`,
  `dispatch_inflight`) plus a one-line `[whatsapp:dispatch]
  booking=<id> job=<id> stage=<stage> reason=<reason>` server log (no phone
  numbers or message bodies are ever logged).
- **Full recipient set, no caps**: the fan-out iterates the complete
  eligible-cook list — no query limit, slicing, or first-N cutoff anywhere
  in the pipeline. Before sending, a `pending` dispatch record is created
  for every intended recipient, and the job stores a counts-only
  `diagnostics` summary (`examined`, per-reason exclusions, `attempted`,
  `skipped`, `noPhone`) plus a `summary` server log line, so "why did only
  N qualify?" is answerable from the admin endpoint alone.
- **Retries**: transient Meta/network failures retry with bounded
  exponential backoff (+jitter, honoring Meta's `Retry-After` on 429)
  while the 5-minute request window is open; permanent errors
  (bad token/code 190, invalid numbers) terminate visibly instead of
  looping. No-eligible-cook outcomes re-evaluate a few times inside the
  window, then stop.
- **No duplicates**: per-recipient `sent` entries in
  `Booking.whatsappDispatch` (with Meta message ids) are skipped by every
  retry path, including the manual admin re-notify
  (`POST /api/bookings/:id/notify-cooks`, unchanged behavior).
  Semantics are at-least-once: a crash between Meta accepting a message
  and MongoDB persisting the id can produce one duplicate on recovery.
- **Monitoring**: as admin, `GET /api/bookings/dispatch-jobs?status=failed`
  (also `pending`/`retrying`/`skipped`/`completed`, `bookingId`, `limit`,
  `skip`) lists sanitized jobs with attempts and timestamps.
- **Config** (`backend/.env`): `WHATSAPP_DISPATCH_POLL_MS` (default
  10000), `WHATSAPP_DISPATCH_MAX_ATTEMPTS` (default 5),
  `WHATSAPP_DISPATCH_LEASE_MS` (default 60000),
  `WHATSAPP_DISPATCH_WORKER=false` disables the in-process worker on
  API-only instances (jobs are still persisted).
- **Safe deploy**: no separate worker process is required; each instance
  runs the loop and atomic claims prevent overlap. Deploy any time —
  pending jobs (including ones orphaned mid-send) are recovered on boot
  via lease expiry plus a backfill sweep for `requested` bookings that
  somehow have no job.
- **Verify**: create a test booking, then check the job
  (`GET /api/bookings/dispatch-jobs?bookingId=<id>`) — expect `completed`
  / `dispatched` with `sentCount` matching the eligible cooks, and matching
  `wamid.*` entries in `Booking.whatsappDispatch`.
- **Delivery truth (Meta accepted ≠ received)**: a `sent` entry only means
  Meta accepted the message. The webhook also processes Meta `statuses`
  callbacks and advances each entry's `deliveryStatus`
  (`sent → delivered → read`, or `failed` with the upstream code, e.g.
  `131026` recipient-not-on-WhatsApp) monotonically — duplicates and
  out-of-order receipts can never regress it. Unknown message ids are
  ignored. When a cook reports non-receipt, inspect the entry: no
  `deliveryStatus` means Meta never confirmed handset delivery (check spam,
  blocked list, phone offline); `failed` names the upstream reason;
  `delivered`/`read` means the phone got it and the cook didn't act in
  time. `POST /api/bookings/:id/notify-cooks` (admin) now returns
  `deliveryStatus` per recipient too.
- **Tests**: `node backend/whatsapp-dispatch-jobs.test.js` (40 checks:
  persistence, worker, recovery, retries, skips, dedup, concurrency,
  backfill, admin listing, manual-retry record, 3/5/12-cook full-set
  dispatch, exclusion diagnostics, single-failure continuation, uncapped
  inbound pending list, and a static no-cap guard).
