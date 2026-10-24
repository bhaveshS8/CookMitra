# CookMitra Events — Final Production Readiness Report

**Date:** 2026-10-23  
**Branch:** `events`  
**HEAD:** `f1e8873`  
**Scope:** Events release gate — deployment configuration, production index/migration plan, Razorpay staging, WhatsApp staging, policy sign-off, and end-to-end staging verification.  
**Verdict:** `READY WITH CONDITIONS`

> This verification was local and read-only with respect to production. No deployment, commit, push, production database access, live Razorpay call, or WhatsApp send was performed. No money moved and no real recipient was messaged.

---

## 1. Executive Summary

The Events code is locally regression-tested and the identified deployment/configuration gaps have been reduced. The release is **not unconditionally ready for production** because the following mandatory external gates remain unverified or unapproved:

1. The production `EventBooking` idempotency index has not been verified or created on the production database.
2. No real Razorpay test-mode order, checkout, webhook delivery, or refund has been run on isolated staging.
3. No real WhatsApp sandbox delivery has been run; Event cook confirmation currently uses free-form text rather than an approved template.
4. Business policy for Event payment, cancellation, and refunds has not been formally signed off.
5. No end-to-end staging run has been completed.

This pass added a safe, read-only-by-default production index migration script with a 28-check isolated test, a policy approval record, and an exact staging E2E procedure. Those artifacts reduce execution risk but do not close the external gates above.

The local code and deployment configuration are suitable to proceed to staging verification, subject to the conditions in section 9.

---

## 2. Evidence Table

| Gate | Result | Evidence | Limits |
|---|---|---|---|
| Backend regression suite | **PASS** | `SUITE_EXIT=0`; output at `C:\Users\jiya\.local\share\opencode\tool-output\tool_1684966ad001G7NQuJxzyRNgC4` | Baseline run before the config-only edits in this report |
| Event concurrency | **PASS** | `ALL CONCURRENCY TESTS PASSED` | Isolated test DB |
| Event security | **PASS** | `ALL EVENT TESTS PASSED` | Automated tests only |
| Event assignment permissions | **PASS** | Suite completed successfully | Automated tests only |
| Event payment | **PASS** | `event-payment.test.js`: `EVENT_PAYMENT_FAILURES=0`; self-starting memory DB; expanded failed/pending, duplicate webhook, reconcile, retry, and currency-mismatch cases | Mocked Razorpay gateway; no real checkout |
| Event WhatsApp | **PASS** | `event-whatsapp.test.js`: `23 passed, 0 failed` | WhatsApp API mocked; no delivery |
| Cross-module scheduling | **PASS** | `CROSS_MODULE_SCHEDULING_FAILURES=0` | Isolated test DB |
| Event statistics | **PASS** | `EVENT_STATS_FAILURES=0` | Isolated test DB |
| Frontend regression | **PASS** | 15 suites / 139 tests passed | No production browser/staging run |
| Frontend lint | **PASS** | Targeted ESLint clean | — |
| Frontend production build | **PASS** | Build completed | Pre-existing `lucide-react` source-map warning |
| Idempotency index behavior | **PASS** | `event-index-migration.test.js`: `28 passed, 0 failed`; exact index, duplicate rejection, empty keys, and idempotent rerun verified | Isolated `MongoMemoryServer` only |
| Migration tooling | **PASS (LOCAL)** | `backend/scripts/migrate-event-booking-indexes.js` dry-runs by default, requires `--target` and explicit `--apply`, refuses system DBs, and never drops/renames/deletes | Production execution still blocked |
| Staging preflight logic | **PASS** | `10 passed, 0 failed`; no secrets in facts | Configuration inspection only; no network calls |
| Deployment configuration audit | **PASS WITH FIXES** | `Jenkinsfile`, `backend/server.js`, `docker-compose.yml`, and `render.yaml` reviewed/updated; both YAML files parsed successfully (41 app environment keys in Compose) | Docker CLI is unavailable locally, so `docker compose config` and runtime startup were not executed |
| Policy approval record | **PREPARED / NOT APPROVED** | `docs/EVENT_POLICY_APPROVAL.md` records implemented behavior and open owner decisions | No owner signature |
| E2E procedure | **PREPARED / NOT EXECUTED** | `docs/EVENT_E2E_STAGING.md` contains exact staging commands, gates, evidence table, and rollback rehearsal | No isolated staging environment |
| Production test-key boot refusal | **PASS** | Production smoke with `REQUIRE_PAYMENTS=true` (and separately with `EVENT_PAYMENTS_REQUIRED=true`) exited `1` with `CONFIG ERROR` when given a test key | Deliberate fail-closed smoke tests; no DB connection |
| Post-change syntax/whitespace | **PASS** | `node --check` on `server.js`, the migration script, and the payment/index tests; `git diff --check` exit `0`; cached check exit `0` | CRLF conversion warnings only |
| Production database index | **NOT VERIFIED / BLOCKED** | Schema and local migration tests pass; safe operator script and dry-run procedure prepared | No production DB access permitted |
| Razorpay isolated staging | **NOT EXECUTED / BLOCKED** | Local mocked tests only | No approved test-mode credentials or environment |
| WhatsApp isolated staging | **NOT EXECUTED / BLOCKED** | Local mocked tests only | No approved sandbox recipient/token; Event template gap |
| Policy sign-off | **NOT APPROVED / BLOCKED** | `docs/EVENT_POLICY_APPROVAL.md` prepared; still unsigned | Requires owner/business approval |
| End-to-end staging smoke | **NOT EXECUTED / BLOCKED** | Exact procedure prepared in `docs/EVENT_E2E_STAGING.md` | Requires isolated staging environment |

The full backend/frontend suites were not rerun after the latest test-harness and documentation edits. Targeted reruns after those edits passed: `staging-preflight` `10/10`, `event-index-migration` `28/28`, `event-whatsapp` `23/23`, and `event-payment` `EVENT_PAYMENT_FAILURES=0`.

---

## 3. Deployment Configuration Audit

### 3.1 Verified

- `Dockerfile`
  - Multi-stage Node 20 Alpine build.
  - Frontend build fails closed when `REACT_APP_API_URL` points at `localhost` or `127.0.0.1`.
  - Runtime uses `NODE_ENV=production`, `TZ=Asia/Kolkata`, `npm ci --omit=dev`, and `CMD ["node", "server.js"]`.
  - `COPY backend/` does not bring in `backend/.env` because `.dockerignore` excludes `**/.env`.
- `.dockerignore`
  - Excludes `node_modules`, `frontend/build`, `**/.env`, `**/.env.*`, uploads, logs, and test files.
- `render.yaml`
  - Builds frontend and backend, serves both from one Node process.
  - `healthCheckPath: /api/ready` correctly waits for MongoDB connectivity.
  - Production secrets are marked `sync: false`.
  - `REQUIRE_PAYMENTS` and `EVENT_PAYMENTS_REQUIRED` remain explicit deployment decisions; both are documented as commented opt-ins rather than silently enabled.
- `.gitignore`
  - Excludes environment files, uploads, build output, and logs.
- `backend/server.js`
  - Production boot fail-closes on missing/placeholder/short `JWT_SECRET`.
  - `/api/health` is liveness only; `/api/ready` returns `503` until MongoDB is connected.
  - `REQUIRE_SMTP=true` fails closed when SMTP host/user is missing.
  - Missing WhatsApp configuration only disables pushes; it does not fail booking flows.
  - `connectDB` retries in the background when `MONGODB_URI` is absent, so `/api/ready` remains the meaningful deployment gate.

### 3.2 Fixes applied in this pass

1. **Jenkins health check corrected**
   - `Jenkinsfile` previously polled `/api/health`, which returns `200` even when MongoDB is disconnected.
   - Changed the post-deploy check to `/api/ready`, matching `render.yaml` and the actual readiness contract.

2. **Production payment gate tightened**
   - `backend/server.js` now treats `REQUIRE_PAYMENTS` and `EVENT_PAYMENTS_REQUIRED` as payment-required flags, accepting `true`, `1`, or `yes`.
   - When payments are required in production, boot now refuses unless:
     - Razorpay is configured,
     - the key starts with `rzp_live_`,
     - `RAZORPAY_KEY_SECRET` is non-placeholder, and
     - `RAZORPAY_WEBHOOK_SECRET` is set.
   - This prevents a production deployment from starting in a “ready” state with `rzp_test_*` keys while taking payments.

3. **Docker Compose environment pass-through completed**
   - Added pass-through for:
     - `REQUIRE_PAYMENTS`
     - `EVENT_PAYMENTS_REQUIRED`
     - `REQUIRE_SMTP`
     - `UPLOAD_DIR`
     - `EVENT_OUTBOX_WORKER`
     - `EXPIRED_BOOKING_SWEEP`
   - Previously these values in the host `.env` were not visible inside the container, which could silently disable the Event payment requirement or ignore upload/worker settings.

4. **Event payment test no longer silently skips**
   - `backend/event-payment.test.js` now starts its own `MongoMemoryServer` by default instead of loading `.env` or skipping when `MONGODB_URI` is absent.
   - External execution requires the explicit `EVENT_PAYMENT_TEST_MONGODB_URI` opt-in, preventing an accidental application/production URI from being used by the test.

### 3.3 Deployment configuration conditions

- Docker was not installed in this environment, so `docker compose config` and container runtime startup could not be run. The Compose file parsed successfully with two independent YAML parsers and all 41 app environment keys were present; still validate it on a Docker host or in CI before deployment.
- `render.yaml` does not set `REQUIRE_PAYMENTS` or `EVENT_PAYMENTS_REQUIRED`; the operator must set the approved values in the Render dashboard.
- Production must set:
  - `MONGODB_URI`
  - `JWT_SECRET`
  - `RAZORPAY_KEY_ID` (`rzp_live_*`)
  - `RAZORPAY_KEY_SECRET`
  - `RAZORPAY_WEBHOOK_SECRET`
  - `REQUIRE_PAYMENTS=true` and/or `EVENT_PAYMENTS_REQUIRED=true` if online payment is mandatory
  - `UPLOAD_DIR` on a persistent volume
  - `FRONTEND_BASE_URL` for emailed links
  - SMTP variables if password reset is live
  - WhatsApp production token, phone number ID, app secret, and verify token if WhatsApp is live
  - `CLIENT_URL` only if frontend and backend are split across origins
- A missing `UPLOAD_DIR` in production is only a warning; without a persistent volume, cook verification documents can be lost on redeploy.

---

## 4. Production Database and Index Migration Plan

### 4.1 Current schema contract

`backend/models/EventBooking.js` defines:

```js
eventBookingSchema.index(
  { customerId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $gt: "" } },
  }
);
```

Expected index name: `customerId_1_idempotencyKey_1`.

The index protects the “one Event booking per customer per idempotency key” invariant. Empty or absent keys are excluded, so older clients are unaffected.

Isolated verification now runs through `backend/event-index-migration.test.js`: `28 passed, 0 failed`. It covers dry-run, clean apply, rerun idempotency, duplicate blocking, empty keys, wrong same-name definition, equivalent alternate-name index, target mismatch, missing target, and missing URI.

### 4.2 Safe migration tool

`backend/scripts/migrate-event-booking-indexes.js` is the preferred check. It is read-only unless `--apply` is passed, requires `--target` to match the URI database exactly, refuses system databases, refuses to guess, blocks conflicting/equivalent indexes, re-checks duplicates during apply, post-verifies the index, and never drops/renames/deletes indexes or documents.

Read-only dry run against the approved production database during the approved window:

```bash
cd backend
MONGODB_URI="<protected connection string>" \
  node scripts/migrate-event-booking-indexes.js --target <exact-database-name>
```

Acceptable results:

```text
PASS existing index definition: ...
ALREADY PRESENT: no migration needed.
```

or

```text
DRY RUN OK: duplicate pre-check is clean and the index is missing.
WOULD CREATE: rerun with --apply during the approved change window.
```

A duplicate, same-name/different-definition, or same-key/different-name result is a stop condition. Do not drop, rename, merge, or delete records to force the index build.

The script is tested locally, not against production. See `docs/EVENT_INDEX_MIGRATION.md` for the full operator procedure, backup/change-window guidance, and rollback.

### 4.3 Manual pre-migration checks

Use these `mongosh` checks as an independent audit. Do not paste the connection URI into logs or tickets.

1. Check for duplicate non-empty keys:

```js
db.eventbookings.aggregate([
  { $match: { idempotencyKey: { $gt: "" } } },
  {
    $group: {
      _id: { customerId: "$customerId", idempotencyKey: "$idempotencyKey" },
      count: { $sum: 1 }
    }
  },
  { $match: { count: { $gt: 1 } } },
  { $project: { _id: 0, customerId: "$_id.customerId", count: 1 } }
])
```

**Required result:** empty array. Do not create the unique index while duplicates exist.

2. Check whether an index with the same key already exists under a different name:

```js
db.eventbookings.getIndexes().filter(
  (ix) => JSON.stringify(ix.key) === JSON.stringify({ customerId: 1, idempotencyKey: 1 })
)
```

3. Check the expected index definition:

```js
db.eventbookings.getIndexes().filter(
  (ix) => ix.name === "customerId_1_idempotencyKey_1"
)
```

Expected definition:

```json
{
  "name": "customerId_1_idempotencyKey_1",
  "key": { "customerId": 1, "idempotencyKey": 1 },
  "unique": true,
  "partialFilterExpression": { "idempotencyKey": { "$gt": "" } }
}
```

### 4.4 Creation

If the dry run is clean and the index is absent, apply with the same exact target:

```bash
MONGODB_URI="<protected connection string>" \
  node scripts/migrate-event-booking-indexes.js --target <exact-database-name> --apply
```

Expected: `PASS created index definition: ...`, `PASS post-create duplicate check: clean`, `APPLIED: ...`.

Manual equivalent, only if the approved procedure requires it:

```js
db.eventbookings.createIndex(
  { customerId: 1, idempotencyKey: 1 },
  {
    name: "customerId_1_idempotencyKey_1",
    unique: true,
    partialFilterExpression: { idempotencyKey: { $gt: "" } }
  }
)
```

Operational notes:

- Create during low traffic / an approved maintenance window.
- A unique index build can fail if duplicate data appears during the build.
- If an index with the same key exists under another name, do **not** create a second equivalent index blindly. Capture its definition and obtain approval before renaming or dropping anything.
- Mongoose may attempt schema index creation automatically on startup because `autoIndex` is not disabled. Do not rely on that as the production migration; create the index explicitly and verify it.
- No data backfill is required. Documents with empty/absent `idempotencyKey` remain outside the partial index.

### 4.5 Post-migration verification

1. Rerun the read-only dry run; expect `ALREADY PRESENT: no migration needed.`
2. Confirm duplicates remain zero with the aggregation in section 4.3.
3. Application checks on staging or an approved controlled environment:
   - same customer + same key + same intent returns the existing booking (replay), not a second record;
   - same customer + same key + different intent returns `409 IDEMPOTENCY_KEY_REUSED`;
   - empty/absent keys continue to allow multiple bookings.
4. Check application logs for index-build errors.

### 4.6 Rollback

- No data rollback is required for index creation.
- Dropping the index restores the pre-migration behavior but removes the duplicate-booking protection. Do not drop it without incident approval.
- The migration script never performs a rollback or drop. Any index removal is a separate, approved DBA action.
- If the build fails because of duplicates, stop and resolve the duplicates as a business/data decision. Do not delete financial or booking records just to make the index build pass.

### 4.7 Status

**Not verified on production.** The schema, safe operator script, and isolated 28-check behavior are correct, but production index presence, duplicate cleanliness, and build result remain blocked by the no-production-access restriction.

---

## 5. Razorpay Staging Verification

### 5.1 Local evidence

`backend/event-payment.test.js` passed with:

```text
EVENT_PAYMENT_FAILURES=0
```

The local tests use a mocked gateway and an isolated database. The test no longer loads `.env` or silently skips: it starts its own `MongoMemoryServer` by default, with `EVENT_PAYMENT_TEST_MONGODB_URI` as an explicit opt-in to an external disposable database. They cover order amount calculation, order reuse, signature rejection, capture/paid state, duplicate verification, failed/pending payment rejection, failed-payment webhooks, abandoned-order reuse, duplicate-webhook idempotency and WhatsApp suppression, reconciliation gateway failure, failed-refund retry, amount mismatch, and currency mismatch handling.

`backend/staging-preflight.test.js` passed `10/10`, including refusal of:

- live `rzp_live_*` keys in staging,
- non-`rzp_test_*` keys,
- placeholder credentials,
- production-marked databases,
- production `NODE_ENV`,
- missing or invalid sandbox recipients.

Preflight performs **zero** Razorpay calls.

### 5.2 What has not been verified

- Creating a real order in Razorpay test mode.
- Opening Razorpay Checkout with the returned test key/order.
- A real test-mode payment capture.
- Razorpay webhook delivery to the staging endpoint.
- Webhook replay/idempotency with a real Razorpay signature.
- Admin-approved test-mode refund behavior against the gateway.
- Reconciliation of a failed/pending refund.
- Production live-key checkout.

### 5.3 Required staging run

The canonical command-level procedure is `docs/EVENT_E2E_STAGING.md`. It includes exact `curl` requests, expected status codes, webhook replay, refund retry, WhatsApp checks, restart persistence, rollback rehearsal, and an evidence table. The higher-level staging docs remain `docs/STAGING_CHECKLIST.md` and `docs/STAGING_VERIFICATION.md`.

Use:

```text
NODE_ENV=staging
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=<test secret>
RAZORPAY_WEBHOOK_SECRET=<staging webhook secret>
STAGING_MONGODB_URI=<isolated empty staging DB>
```

Then verify:

1. `GET /api/health` → `200 status: ok`.
2. `GET /api/ready` → `200 ready: true`.
3. `node backend/staging-preflight.test.js` → `10 passed, 0 failed`.
4. Create an Event order with test money.
5. Pay via test-mode checkout.
6. Verify the booking becomes `confirmed` and `payment.status=paid`.
7. Replay verification and webhook → no duplicate booking/payment/ledger rows.
8. Reject an invalid signature.
9. Queue and approve a test-mode refund → exactly one ledger row, no real money moved.
10. Reconcile a failed refund → single processed row, no duplicate gateway refund.

**Do not use real customer money, production keys, or production recipients.**

### 5.4 Status

**Not executed.** The release must not claim real Razorpay readiness until the isolated staging run above passes and is recorded with IDs/statuses only.

---

## 6. WhatsApp Staging Verification

### 6.1 Local evidence

- `backend/event-whatsapp.test.js`: `23 passed, 0 failed`.
- Tests are mocked and cover:
  - Marathi confirmation content,
  - event ID, type, date, time, duration, guests, menu, distance, paid amount, and link,
  - missing venue behavior (no fabricated map),
  - approved/active cook requirement,
  - stored cook phone requirement,
  - inactive/unapproved cook skipping,
  - send failure resolving without throwing.
- Inbound webhook security is implemented:
  - GET verification uses `WHATSAPP_WEBHOOK_VERIFY_TOKEN` or alias `WHATSAPP_VERIFY_TOKEN`.
  - POST verification uses HMAC-SHA256 with `WHATSAPP_APP_SECRET` and timing-safe comparison.
  - Missing/invalid signature returns `401`.
- `whatsappApi.js` includes `sendTemplateMessage` for approved templates, but Event cook confirmation currently uses `sendWhatsAppText` (free-form text).

### 6.2 Material gap: Event confirmation is free-form

`backend/utils/eventWhatsApp.js` calls:

```js
whatsappApi.sendWhatsAppText(contact.phone, body)
```

Meta only reliably delivers free-form text inside the 24-hour customer-service window. A cook who has not messaged the business recently may not receive the Event confirmation outside that window.

The Event WhatsApp send is fire-and-forget after payment, so a Meta failure cannot fail or delay payment verification. However, the cook may not receive the confirmation.

### 6.3 Required staging run

On an isolated staging environment and Meta test app:

1. Set `WHATSAPP_ENABLED=true`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, and the verify token.
2. Set exactly one opted-in `WHATSAPP_TEST_RECIPIENT`.
3. Confirm `GET /api/whatsapp/status`.
4. Send a test message only to the opted-in number.
5. Complete a test Event payment and confirm the cook confirmation delivery.
6. Test one send outside the 24-hour window.
7. Verify webhook verification and a replayed status callback produce no duplicate records.
8. Confirm no sends go to non-opted-in numbers.

### 6.4 Decision required

Choose one:

- **A. Approved template (recommended for reliability):** approve a Marathi/English Event confirmation template, add configuration and template sending for Event confirmations, then verify outside-window delivery.
- **B. Accept best-effort free text:** document that Event cook confirmation is only reliable inside the 24-hour window; keep the in-app notification and booking link as fallback.

### 6.5 Status

**Not executed.** No WhatsApp message was sent during this verification. Event confirmation outside-window delivery is unverified.

---

## 7. Policy Decisions Required

The code currently implements the following behavior. These are **not** approvals of the business policy. A signature-ready decision record with checkboxes and approval fields is in `docs/EVENT_POLICY_APPROVAL.md`; it is intentionally marked **NOT APPROVED** until the owner signs it.

| Topic | Current behavior | Required owner decision |
|---|---|---|
| Event payment requirement | Events inherit `REQUIRE_PAYMENTS` unless `EVENT_PAYMENTS_REQUIRED` is set. The Event UI says the full amount is paid online. | Is full online payment mandatory before confirmation? If yes, set `EVENT_PAYMENTS_REQUIRED=true` in production. |
| Cancellation before start | A paid Event cancelled before `in_progress` queues a **full** refund for admin approval. | Confirm full refund, approval SLA, gateway-fee treatment, and customer messaging. |
| Cancellation after start | Once `in_progress`, cancellation keeps the payment and does not auto-refund. | Confirm no-refund/partial-refund policy and the support escalation path. |
| Refund execution | Admin approves a pending refund; gateway refund is attempted; retries are idempotent. | Confirm who can approve, refund timing, and what happens if the gateway is unavailable. |
| Partial refunds | Event refund flow is full-payment oriented. | Confirm whether partial refunds are required; current UI/code does not present them. |
| Test-mode refunds | Test payments are marked `testMode`; test refunds use `TEST_MODE` and move no real money. | Confirm test-mode transactions are never enabled for real customers. |
| WhatsApp confirmation | Payment confirmation to the cook is free-form text. | Approve template option A or accept best-effort option B from section 6.4. |
| Privacy/retention | See `docs/PRIVACY_DECISIONS.md`; some retention questions remain open. | Legal/owner review before deletion jobs or policy text changes. |

**Policy status: NOT APPROVED.** The release must not claim policy readiness until the owner records these decisions.

---

## 8. End-to-End Staging Smoke Test

Run only on isolated staging with test money, test accounts, and sandbox WhatsApp numbers. The canonical copy-paste procedure, including expected responses and an evidence table, is `docs/EVENT_E2E_STAGING.md`.

### 8.0 Preconditions

- Empty staging database with `staging`/`test` marker.
- `NODE_ENV=staging`.
- `rzp_test_*` keys and staging webhook secret.
- WhatsApp sandbox credentials and one opted-in recipient.
- `UPLOAD_DIR` ending in `cook-docs`.
- `node backend/staging-preflight.test.js` → `10/10`.
- `GET /api/health` → `200`; `GET /api/ready` → `200 ready:true`.
- `node backend/event-index-migration.test.js` -> `28 passed, 0 failed`.
- Read-only index script dry run returns `ALREADY PRESENT` or `DRY RUN OK`.

### 8.1 Booking idempotency

1. Create an Event booking with an idempotency key.
2. Repeat the same request → same booking, no duplicate.
3. Repeat with the same key and different intent → `409 IDEMPOTENCY_KEY_REUSED`.
4. Submit a stale quote → `409 PRICING_CHANGED`.
5. Confirm empty keys still allow separate bookings.

### 8.2 Payment

1. Admin assigns a cook and sets/verifies the final amount and distance.
2. Customer creates an Event payment order.
3. Confirm amount in paise, currency, and test key.
4. Retry order creation → existing order reused.
5. Complete test-mode checkout.
6. Verify booking is `confirmed`, payment is `paid`, and ledger has one payment row.
7. Replay verification → no second capture, booking, or ledger row.
8. Verify cook WhatsApp confirmation (if enabled) and check no duplicate send.

### 8.3 Webhook

1. Send a valid Razorpay webhook → `200`.
2. Replay the same webhook → `200`, no duplicate rows.
3. Send an invalid signature → rejected.
4. Send an amount-mismatched capture → refund queued, no `paid` state.

### 8.4 Cancellation and refund

1. Cancel a paid Event before start → `cancelled`, `refundStatus=pending`, one ledger request row.
2. Admin approves refund → processing/processed as appropriate; retry → no second gateway refund.
3. Cancel after `in_progress` → confirm current no-automatic-refund behavior and record it.
4. Verify customer/admin notifications and status history.

### 8.5 Deployment smoke

1. Deploy candidate to isolated staging.
2. Poll `/api/health` and `/api/ready`.
3. Restart the service; confirm uploads persist and bookings/payments remain intact.
4. Rehearse rollback to the previous image/tag.
5. Confirm financial records and pending refunds are unchanged by rollback.

### 8.6 Evidence to retain

Record only IDs, status codes, amounts, and pass/fail. Do not record PII, tokens, full phone numbers, or secrets. The evidence table is in `docs/EVENT_E2E_STAGING.md`.

### 8.7 Status

**Not executed.** No isolated staging environment was available. Local controller-level tests do not substitute for this gate.

---

## 9. Blockers and Conditions

### Release blockers

1. **Production index not verified.** Use `backend/scripts/migrate-event-booking-indexes.js` to dry-run, then create/verify `customerId_1_idempotencyKey_1` only after a clean duplicate pre-check and explicit approval.
2. **Razorpay staging not executed.** Run the test-mode order/checkout/webhook/refund flow on isolated staging using `docs/EVENT_E2E_STAGING.md`.
3. **WhatsApp staging not executed.** Approve and test the Event confirmation path and webhook signatures; decide template vs best-effort free text.
4. **Policy not signed off.** `docs/EVENT_POLICY_APPROVAL.md` is prepared but unsigned. Payment, cancellation, refund, and WhatsApp decisions require owner approval.
5. **End-to-end staging not executed.** The `docs/EVENT_E2E_STAGING.md` procedure must pass before unrestricted production release.

### Deployment conditions

- Set live `rzp_live_*` keys and `RAZORPAY_WEBHOOK_SECRET`; never use test keys with live payments.
- Set `EVENT_PAYMENTS_REQUIRED=true` if online Event payment is mandatory; ensure the value reaches the container/host (the Compose pass-through was fixed).
- Set `REQUIRE_PAYMENTS=true` if all payments are mandatory.
- Configure a persistent `UPLOAD_DIR`; otherwise verification documents can be lost.
- Set `FRONTEND_BASE_URL` and SMTP values for live reset links.
- Set WhatsApp production token, phone number ID, app secret, and verify token; approve the template decision if option A is chosen.
- Run `node backend/event-index-migration.test.js` in CI/local; expect `28 passed, 0 failed`.
- Validate the Compose file with `docker compose config` and start the stack on a Docker host or CI; Docker was unavailable locally, though YAML parsing passed.
- Confirm Jenkins/render deployment uses `/api/ready`; both now point at the readiness endpoint.
- Confirm the production frontend build does not bake in `localhost` or test-only values.

### Explicitly out of scope / not performed

- No deployment, commit, push, merge, rebase, or branch switch.
- No production database connection, index creation, or migration.
- No live Razorpay order, payment, refund, or webhook.
- No WhatsApp message to any real or sandbox recipient.
- No real money movement.
- No production secrets printed, copied, or committed.

---

## 10. Deployment Checklist

### Before deployment

- [ ] Owner signs `docs/EVENT_POLICY_APPROVAL.md`; do not treat the prepared record as approval.
- [ ] `node backend/event-index-migration.test.js` passes `28/28`.
- [ ] Production index dry run is clean; duplicates are zero.
- [ ] `customerId_1_idempotencyKey_1` is present, unique, and partial on the correct fields.
- [ ] `docs/EVENT_E2E_STAGING.md` has been executed on isolated staging with complete evidence.
- [ ] Live Razorpay keys are configured and begin with `rzp_live_`.
- [ ] `RAZORPAY_WEBHOOK_SECRET` is configured and the production webhook URL is registered.
- [ ] `REQUIRE_PAYMENTS` and/or `EVENT_PAYMENTS_REQUIRED` are set to the approved values.
- [ ] `JWT_SECRET` is long, random, and not a placeholder.
- [ ] `MONGODB_URI` targets the production database.
- [ ] `UPLOAD_DIR` points at a persistent volume.
- [ ] SMTP variables and `FRONTEND_BASE_URL` are configured if password reset is live.
- [ ] WhatsApp production credentials and the approved template decision are in place.
- [ ] `CLIENT_URL` is set only for split-origin hosting.
- [ ] `docker compose config` / host deployment validation passes.
- [ ] CI runs the backend/frontend suites, `staging-preflight.test.js`, and `event-index-migration.test.js`.
- [ ] Jenkins health check uses `/api/ready`.

### After deployment

- [ ] `GET /api/health` → `200`.
- [ ] `GET /api/ready` → `200 ready:true`.
- [ ] Production index verified again.
- [ ] No `CONFIG ERROR` or test-key warning in production logs.
- [ ] Controlled Event booking/payment smoke test approved by the owner.
- [ ] Webhook receives a valid event and rejects an invalid signature.
- [ ] Refund approval path verified with an approved test method.
- [ ] WhatsApp confirmation delivered to the approved recipient, or degraded-mode decision recorded.
- [ ] Uploads persist across a restart.
- [ ] Rollback target and procedure are available.

### Rollback

- Redeploy the previous image/tag.
- Confirm `/api/health` and `/api/ready`.
- Do not delete or rewrite payment, refund, payout, ledger, or audit records to “fix” a failed check.
- If the new index must be removed, obtain incident approval first; removal reduces duplicate-booking protection.

---

## 11. Files Reviewed or Changed

### Changed in this pass

- `Jenkinsfile` - health check changed from `/api/health` to `/api/ready`.
- `backend/server.js` - production payment gate requires live keys and honors both payment flags.
- `docker-compose.yml` - forwards payment/SMTP/upload/worker policy variables into the container.
- `render.yaml` - documents `EVENT_PAYMENTS_REQUIRED` and `REQUIRE_PAYMENTS` as explicit opt-ins.
- `backend/services/eventPaymentService.js` - truthful refund-queue failure message.
- `backend/event-payment.test.js` - expanded Razorpay edge coverage; no longer loads `.env`; self-starts `MongoMemoryServer` unless `EVENT_PAYMENT_TEST_MONGODB_URI` is explicitly set.
- `backend/scripts/migrate-event-booking-indexes.js` - safe Event index dry-run/apply tool.
- `backend/event-index-migration.test.js` - 28-check `MongoMemoryServer` migration test.
- `backend/package.json` - test chain includes the migration test.
- `docs/EVENT_INDEX_MIGRATION.md` - migration operator procedure.
- `docs/EVENT_POLICY_APPROVAL.md` - unsigned policy decision record.
- `docs/EVENT_E2E_STAGING.md` - exact staging E2E procedure and evidence table.
- `EVENTS_FINAL_PRODUCTION_READINESS_REPORT.md` - this report.

### Reviewed

- `backend/models/EventBooking.js`
- `backend/controllers/eventBookingController.js`
- `backend/controllers/eventPaymentController.js`
- `backend/services/eventPaymentService.js`
- `backend/controllers/paymentController.js`
- `backend/controllers/whatsappController.js`
- `backend/routes/whatsapp.js`
- `backend/routes/eventPayments.js`
- `backend/utils/eventWhatsApp.js`
- `backend/utils/whatsappApi.js`
- `backend/utils/stagingPreflight.js`
- `backend/staging-preflight.test.js`
- `backend/event-payment.test.js`
- `backend/event-whatsapp.test.js`
- `backend/event-index-migration.test.js`
- `backend/scripts/migrate-event-booking-indexes.js`
- `backend/config/razorpay.js`
- `backend/config/db.js`
- `backend/server.js`
- `docs/STAGING_CHECKLIST.md`
- `docs/STAGING_VERIFICATION.md`
- `docs/EVENT_INDEX_MIGRATION.md`
- `docs/EVENT_POLICY_APPROVAL.md`
- `docs/EVENT_E2E_STAGING.md`
- `docs/WHATSAPP_SETUP.md`
- `docs/PRIVACY_DECISIONS.md`
- `Dockerfile`
- `.dockerignore`
- `.gitignore`
- `docker-compose.yml`
- `render.yaml`
- `Jenkinsfile`
- `backend/.env.example`
- `EVENTS_PRODUCTION_READINESS_REMEDIATION_REPORT.md`

### Verification commands used

```text
node backend/staging-preflight.test.js
node backend/event-index-migration.test.js
node backend/event-whatsapp.test.js
node backend/event-payment.test.js
node --check backend/server.js
node -e "const Y=require('./frontend/node_modules/yaml'); for (const f of ['docker-compose.yml','render.yaml']) Y.parse(require('fs').readFileSync(f,'utf8'));"
git diff --check
git diff --cached --check
```

Latest local results: `staging-preflight` `10/10`; `event-index-migration` `28 passed, 0 failed`; `event-whatsapp` `23 passed, 0 failed`; `event-payment` `EVENT_PAYMENT_FAILURES=0`; both deployment YAML files parsed, with 41 app environment keys in Compose.

---

## 12. Final Verdict

### `READY WITH CONDITIONS`

The local implementation, test coverage, idempotency index definition, safe migration tooling, policy decision record, exact E2E procedure, and deployment configuration are in good shape for a controlled release. The release is not unconditionally production-ready because production index verification, isolated Razorpay staging, isolated WhatsApp staging, policy approval, and the end-to-end staging run remain outstanding.

Do not deploy to unrestricted production until the conditions in sections 9 and 10 are closed and recorded.
