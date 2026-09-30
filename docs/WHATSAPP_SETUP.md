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
- Regression test: `backend/whatsapp-api.test.js`
  (`node backend/whatsapp-api.test.js`).

## 6. Costs

Meta's pricing is per 24h conversation (≈ ₹0.35–0.70 utility conversation
in India, 2025 rates; verify current pricing in WhatsApp Manager). Test
numbers are free.

## 7. Cook Accept / Decline from WhatsApp

Yes — the cook can decide **without opening the dashboard**:

1. The booking request arrives as an **interactive message** with
   **Accept ✅** / **Decline ❌** buttons (payloads `accept:<bookingId>` /
   `reject:<bookingId>`). Plain-text replies (`ACCEPT`, `DECLINE`, …)
   work too.
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
   Accept/Decline quick replies, set `WHATSAPP_REQUEST_TEMPLATE` (+`_LANG`);
   the sender tries the template first and falls back to interactive.
