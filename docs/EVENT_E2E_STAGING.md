# Event End-to-End Staging Test

**Status: NOT EXECUTED.** No isolated staging environment, approved Razorpay test credentials, or sandbox WhatsApp recipient was available in this pass. This document is the exact procedure to run when they are.

## Evidence Classes

Do not mix these up:

| Class | What it proves | Current evidence |
|---|---|---|
| Local unit/controller tests | Code behavior with mocked gateway/WhatsApp and disposable DB | `event-payment.test.js`, `event-whatsapp.test.js`, `event-index-migration.test.js`, Event security/concurrency suites |
| Local integration test | Real MongoDB + mocked external providers | `event-payment.test.js` |
| Real staging test | Real isolated API, real test-mode Razorpay, real Meta sandbox | **Not executed** |
| Production smoke | Approved real production controls | **Not executed** |

Local tests do not prove Razorpay checkout, webhook delivery, Meta delivery, DNS/TLS, hosting, or production data behavior.

## Prerequisites

- Isolated staging API URL in `STAGING_BASE_URL` (absolute `https://` host; not localhost, not production).
- Isolated empty staging database; never production.
- `NODE_ENV=staging`.
- Staging-only `JWT_SECRET` (32+ random chars; 64+ recommended). Never reuse the production secret.
- `RAZORPAY_KEY_ID=rzp_test_...`, matching `RAZORPAY_KEY_SECRET`, and a staging `RAZORPAY_WEBHOOK_SECRET`.
- `WHATSAPP_ENABLED=true`, staging `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, and `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (legacy alias `WHATSAPP_VERIFY_TOKEN` is accepted).
- `CLIENT_URL` set to the staging hostname (not localhost), so booking links in notifications do not leak a local address.
- Exactly one opted-in sandbox WhatsApp recipient. Never a real customer.
- Synthetic accounts: admin, approved active cook, customer.
- `EVENT_PAYMENTS_REQUIRED=true` for the paid path.
- A verified backup is not required for staging, but do not point this at production.

Register these exact staging webhook URLs with the providers:

```text
Razorpay: https://<staging-api-host>/api/payments/webhook
WhatsApp: https://<staging-api-host>/api/whatsapp/webhook
```

`CLIENT_URL` is also the CORS allowlist origin. In staging, keep it equal to the frontend origin and do not use a wildcard. The API requires credentials, so an incorrect origin will break login, booking, and admin calls.

## 1. Health and Configuration

```bash
curl -fsS "$STAGING_BASE_URL/api/health"
curl -fsS "$STAGING_BASE_URL/api/ready"
```

Expected: health `200` with status `ok`; ready `200` with `ready: true`. A ready `503` while the DB is down is correct, not a pass.

```bash
cd backend
node staging-preflight.test.js
node utils/stagingPreflight.js          # checks the CURRENT staging env; prints facts only, no secrets
node event-index-migration.test.js
node event-payment.test.js
```

Expected: preflight tests `23 passed, 0 failed`; live preflight `"ok": true`; index test `40 passed, 0 failed`; Event payment `EVENT_PAYMENT_FAILURES=0`. These are local checks, not staging evidence. The payment test has a mocked gateway and starts its own `MongoMemoryServer` by default; it does not load `.env`. Set `EVENT_PAYMENT_TEST_MONGODB_URI` only to an explicit disposable database.

Read-only staging index checks:

```bash
cd backend
MONGODB_URI="$STAGING_MONGODB_URI" node scripts/audit-event-indexes.js
MONGODB_URI="$STAGING_MONGODB_URI" node scripts/migrate-event-booking-indexes.js --target "$STAGING_DB_NAME"
```

Expected: audit `AUDIT OK` for all seven Events collections, then `ALREADY PRESENT` or `DRY RUN OK` / `WOULD CREATE` for the idempotency index. Never use `--apply` on production. If staging needs the index, use `--apply` only after approval and a clean duplicate pre-check.

## 2. Authentication

Obtain staging tokens through the normal login flow. Store them only in shell variables/vault; do not paste them into evidence.

```bash
ADMIN_TOKEN=...
COOK_TOKEN=...
CUSTOMER_TOKEN=...
```

## 3. Create the Event

Use a unique idempotency key.

```bash
IDEMPOTENCY_KEY="stg-event-$(date +%s)"
curl -fsS -X POST "$STAGING_BASE_URL/api/event-bookings" \
  -H "Authorization: Bearer $CUSTOMER_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{
    "eventType": "Birthday",
    "eventDate": "2026-12-20",
    "startTime": "18:00",
    "duration": 2,
    "guestCount": 20,
    "address": "Synthetic staging address",
    "area": "Staging Area",
    "landmark": "Staging Landmark",
    "menu": "Synthetic test menu",
    "serviceType": "preparation_cooking",
    "distanceKm": 5
  }'
```

Record only the Event `_id` and `bookingId`.

Repeat the same request with the same key and payload: expect the same Event, no duplicate.

Repeat with the same key but a different payload: expect `409 IDEMPOTENCY_KEY_REUSED`.

Repeat with no key twice: expect separate bookings (empty-key path).

## 4. Admin Assignment and Final Amount

```bash
curl -fsS -X POST "$STAGING_BASE_URL/api/event-bookings/$EVENT_ID/assign-cook" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cookId":"'"$STAGING_COOK_ID"'"}'

curl -fsS -X PATCH "$STAGING_BASE_URL/api/event-bookings/$EVENT_ID/verify-distance" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"distanceKm":5}'
```

Expected: `bookingStatus: cook_assigned`, `distanceVerified: true`, server-computed `totalAmount` greater than zero.

Attempt admin confirmation without payment while `EVENT_PAYMENTS_REQUIRED=true`: expect `400 EVENT_PAYMENT_REQUIRED`.

## 5. Razorpay Test-Mode Payment

Create the order:

```bash
curl -fsS -X POST "$STAGING_BASE_URL/api/event-payments/$EVENT_ID/order" \
  -H "Authorization: Bearer $CUSTOMER_TOKEN"
```

Expected: `orderId`, `amount` in paise matching `totalAmount * 100`, `currency: INR`, and an `rzp_test_*` key.

Open Razorpay Checkout with that test order and key. Use Razorpay's documented test payment method. Do not use a real card or real money.

After checkout, verify server-side:

```bash
curl -fsS -X POST "$STAGING_BASE_URL/api/event-payments/$EVENT_ID/verify" \
  -H "Authorization: Bearer $CUSTOMER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "razorpay_order_id": "...",
    "razorpay_payment_id": "...",
    "razorpay_signature": "..."
  }'
```

Expected: Event `bookingStatus: confirmed`, `payment.status: paid`, `payment.paidAmount` equal to the server total, and one `event_payment.confirmed` ledger row.

Send an invalid signature: expect `400`, no paid state, no ledger row.

Replay the same valid verification: expect no duplicate ledger row and no duplicate cook WhatsApp.

## 6. Webhook

In the Razorpay test dashboard, configure the staging webhook URL for `payment.captured` and use the staging webhook secret. Either let Razorpay deliver it or use the dashboard's resend function.

Expected:

- A valid signature records the payment exactly once.
- A duplicate delivery returns a duplicate/idempotent response and does not duplicate the ledger, booking state, or notification.
- An invalid signature is rejected and changes nothing.
- A `payment.failed` event is ignored safely; the Event remains unpaid and can be retried.
- A captured amount that does not match the server total is not confirmed and is queued for an admin-approved refund.

Record the Razorpay order/payment/refund IDs and statuses only.

## 7. Refund

Cancel the paid Event before service start:

```bash
curl -fsS -X POST "$STAGING_BASE_URL/api/event-bookings/$EVENT_ID/cancel" \
  -H "Authorization: Bearer $CUSTOMER_TOKEN"
```

Expected: `bookingStatus: cancelled`, `payment.refundStatus: pending`, `refundAmount` equal to the paid amount.

View the queue and approve:

```bash
curl -fsS "$STAGING_BASE_URL/api/event-payments/admin/refunds?status=pending" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -fsS -X POST "$STAGING_BASE_URL/api/event-payments/admin/refunds/$EVENT_ID/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"note":"staging test refund"}'
```

Expected: exactly one gateway refund, `refundStatus: processed` (or `processing` if Razorpay is pending), and one processed or failed ledger row as appropriate. Approving again must not call the gateway twice.

If Razorpay leaves the refund pending, wait for reconciliation or call:

```bash
curl -fsS -X POST "$STAGING_BASE_URL/api/event-payments/admin/refunds/$EVENT_ID/reconcile" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Expected: one processed ledger row, no duplicate gateway refund.

## 8. WhatsApp

Check status:

```bash
curl -fsS "$STAGING_BASE_URL/api/whatsapp/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Send only to the single opted-in sandbox recipient:

```bash
curl -fsS -X POST "$STAGING_BASE_URL/api/whatsapp/test" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"to":"'"$STAGING_WHATSAPP_RECIPIENT"'","message":"CookMitra staging test"}'
```

Complete a test Event payment and confirm the assigned cook receives the Event confirmation. Verify:

- the message contains the correct Event ID, date/time, menu, venue, amount, and link;
- no message goes to a non-opted-in number;
- a duplicate payment verification/webhook does not resend the confirmation;
- a Meta failure does not fail or delay payment confirmation;
- outside the 24-hour window, record whether free-form delivery succeeded. Current code uses free-form text, not an approved template.

## 9. Restart and Rollback Rehearsal

1. Restart the staging service.
2. Confirm health/ready again.
3. Confirm the Event, payment, refund, ledger, and notification records are unchanged.
4. Confirm uploads persist if the test used an upload.
5. Redeploy the previous staging image/tag and confirm financial records are unchanged.

Do not delete or rewrite payment, refund, ledger, or audit records to make a check pass.

## 10. Evidence Template

Record:

| Check | Expected | Actual | Evidence |
|---|---|---|---|
| Health | 200 ok | | |
| Ready | 200 ready | | |
| Event create | 201 | | |
| Idempotent replay | same Event | | |
| Same key, different intent | 409 | | |
| Assign cook | 200 | | |
| Verify distance | 200 | | |
| Unpaid confirmation gate | 400 | | |
| Order amount/key | exact / `rzp_test_*` | | |
| Checkout capture | paid | | |
| Invalid signature | 400 | | |
| Webhook replay | idempotent | | |
| Amount mismatch | refund queued | | |
| Refund approval | processed/processing | | |
| Refund replay | no second gateway call | | |
| WhatsApp delivery | approved recipient only | | |
| Restart persistence | unchanged | | |
| Rollback | unchanged | | |

Store only status codes, IDs, amounts, counts, and pass/fail. Do not store PII, full phone numbers, tokens, webhook secrets, or card data.

## 11. Current Status

**Not executed.** The release must not claim real staging or production Razorpay/WhatsApp readiness until this procedure passes on isolated staging and the evidence table is complete.

**2026-10-24 execution attempt:** the process environment contained none of `STAGING_BASE_URL`, `STAGING_MONGODB_URI`, `MONGODB_URI`, `CLIENT_URL`, `JWT_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `EVENT_PAYMENTS_REQUIRED`, `REQUIRE_PAYMENTS`, or the required `WHATSAPP_*` values. `backend/.env` exists but was not loaded or used; it has no `STAGING_*` keys. No staging URL or approved credentials were supplied. No network call, payment, message, or staging database write was attempted. Status remains **NOT EXECUTED / BLOCKED BY ACCESS**.
