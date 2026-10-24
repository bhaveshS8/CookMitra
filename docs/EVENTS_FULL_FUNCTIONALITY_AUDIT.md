# Events Module — Full Functionality Audit

- **Date:** 2026-10-23
- **Repository:** `C:\Users\jiya\Desktop\Events\CookMitra`
- **Branch:** `events`
- **Commit:** `f1e8873`
- **Scope:** Events catalogue, pricing, booking lifecycle, cook assignment, distance verification, payments (mocked), notifications/outbox, customer/admin/cook UI, security boundaries, responsive rendering
- **Database used:** disposable in-memory MongoDB per test run
- **Production data used:** none
- **Source changes made for the audit:** none

## Verdict

**NO-GO for production.** The module is functionally broad and most tested behavior is correct, but two P1 pricing defects and two policy/lifecycle gaps must be fixed before release. Live Razorpay, WhatsApp provider, production indexes, policy approval, and staging E2E also remain unverified external blockers.

### Result summary

| Area | Result |
|---|---|
| API checks | **49 / 49 passed** (5 passed checks record confirmed defects) |
| Browser E2E checks | **13 / 13 passed** |
| Backend Events suites | **9 / 9 executed suites passed** |
| Frontend focused test | **5 / 5 passed** |
| Production build | **exit 0** (source-map warning only) |
| Open defects | **8** — P1: 2, P2: 4, P3: 2 |
| Release gate | **FAIL / NO-GO** |

## Method and isolation

- Tests ran with a preload shim that neutralizes `dotenv.config()`, so `backend/.env` production Atlas credentials were never loaded.
- Each backend run used `MongoMemoryServer`; the server child process received only the in-memory URI and fake JWT/Razorpay values.
- `backend/qa/qa-server-tmp.js` was **not executed** because it targets Atlas and drops a database.
- API and browser harnesses seeded disposable users, cook profiles, event types, and pricing rows.
- Browser E2E launched the real backend and the real production React build under Chromium.
- The checked-in `frontend/build` was temporarily rebuilt with `REACT_APP_API_URL=/api` and test public keys for same-origin browser testing, then the original build was restored. This was necessary because the existing build artifact calls `http://localhost:5000/api`; see EVT-AUD-005.
- No source, route, model, or business-logic file was modified to make a test pass.

## Test evidence

### Backend suites

| Suite | Result |
|---|---|
| `event-security.test.js` | `ALL EVENT TESTS PASSED` |
| `event-whatsapp.test.js` | 23 passed, 0 failed |
| `event-assign-permissions.test.js` | all checks passed |
| `event-stats.test.js` | `EVENT_STATS_FAILURES=0` |
| `cross-module-scheduling.test.js` | `CROSS_MODULE_SCHEDULING_FAILURES=0` |
| `event-concurrency.test.js` | exit 0 |
| `event-index-migration.test.js` | 28 passed, `ALL TESTS PASSED` |
| `event-payment.test.js` | exit 0 (embedded Mongo, mocked Razorpay) |
| `staging-preflight.test.js` | 10 passed, 0 failed |

### Frontend

- `eventConstants.test.js`: 5 passed.
- `npm run build`: exit 0; only `lucide-react` missing source-map warning.
- Browser audit: 13 passed, 0 failed; screenshots captured for booking steps, customer detail/list, mobile detail, admin assignment/verification, and cook detail.
- Console: no application errors. Four `429` responses came from external `https://ipwho.is/` geolocation lookup and were tolerated by the UI.
- Network: no unexpected failed requests; two `realtime/stream` `ERR_ABORTED` entries were expected SSE teardown on navigation.

### API coverage highlights

Passed checks include:

- Helmet headers, health endpoint, oversized-body `413`.
- Five active event types; server quote `4h + 7km = 1699`.
- Role enforcement: unauthenticated/cook create rejected; admin-only pricing/catalogue/stats; cook cannot self-assign.
- Server-authoritative totals; body cannot inject `owner`, `cookId`, `status`, or totals.
- Idempotent replay and concurrent duplicate submission resulting in exactly one booking.
- “Other” event requires and stores a custom label.
- Past date, overnight event, guest boundary, and unknown event type rejected.
- Stale pricing version returns `409 PRICING_CHANGED`.
- Approved-cook assignment, unapproved-cook rejection, overlap rejection `409`.
- Owner/admin/assigned-cook detail scoping; other customer `403`.
- Distance verification recomputes travel and total.
- Full lifecycle `cook_assigned -> confirmed -> in_progress -> completed`; invalid jumps and post-completion cancellation rejected.
- Customer cancellation idempotency; cookie-auth cancellation same-origin `403`/`200`.
- Query-string status injection rejected; malformed ID returns `404`.
- Deactivated event type cannot be booked.
- Outbox/notification delivery without duplicate `(eventKey, user)` rows; all outbox events `sent`.

## Confirmed defects

### EVT-AUD-001 — P1 — Pricing update saves then returns HTTP 500

- **Location:** `backend/controllers/eventPricingController.js:3-7`, `:241`
- **Cause:** `getPricingTable()` is called but not imported from `utils/eventPricing`.
- **Evidence:** `PUT /api/event-pricing` returned `500` with `"getPricingTable is not defined"` while the new value (`123`) was already persisted.
- **Impact:** Admins see a failure after a successful save; retries can trigger version conflicts. Pricing changes are applied but the API contract is broken.
- **Fix:** Import `getPricingTable` (or return the saved/normalized document directly). Add a regression test asserting `200`, persisted value, and a subsequent quote using the new price.

### EVT-AUD-002 — P1 — Partial pricing edit corrupts the table and blocks bookings

- **Location:** `backend/utils/eventPricing.js:39-65` (`normalizePricing` shallow merge)
- **Evidence:** A partial create left only `cookingOnly.upto2` configured. Quote returned `400 "No price configured for this service and duration"`, and a valid booking was then rejected with the same message.
- **Cause:** `{ ...fallbackService, ...savedService }` replaces a full nested duration map with a partial one.
- **Impact:** A valid admin edit can silently remove prices for other durations/services, breaking quotes and new bookings.
- **Fix:** Deep-merge each service’s duration map, require a complete table on create/update (or explicitly merge with current), validate all service/duration keys, backfill/repair existing documents, and add quote + booking regression tests after partial updates.

### EVT-AUD-003 — P2 — Status PATCH can set `cook_assigned` with no cook

- **Location:** `backend/controllers/eventBookingController.js` (`updateEventBookingStatus`)
- **Evidence:** Admin `PATCH /api/event-bookings/:id/status` with `{ "status": "cook_assigned" }` returned `200`, leaving `cookId: null`.
- **Impact:** Bypasses assignment eligibility and overlap checks; downstream UI and notifications can show an assigned state with no cook.
- **Fix:** Require a valid `cookId` whenever the target is `cook_assigned`, or reject manual transitions to it and require `assign-cook`.

### EVT-AUD-004 — P2 — Paid in-progress cancellation queues no refund

- **Location:** `backend/controllers/eventBookingController.js` (cancellation path); policy in `docs/EVENT_POLICY_APPROVAL.md`
- **Evidence:** Cancelling a `paid` / `in_progress` booking returned `200` with `payment.refundStatus: "none"`.
- **Impact:** Customer funds can be retained with no refund workflow, contrary to the unresolved policy and customer-facing warning.
- **Fix:** Make an explicit policy decision, then either block paid in-progress cancellation or enqueue a refund with an auditable ledger entry. Add a payment/refund test.

### EVT-AUD-005 — P2 — Deployment build artifact targets `localhost:5000`

- **Location:** `frontend/.env`, existing `frontend/build/static/js/main.e9d57d9d.js`
- **Evidence:** The original build contained `http://localhost:5000/api` and the browser renders `connect-src 'self'` CSP. On an isolated port, all API calls failed until the app was rebuilt with `/api`.
- **Impact:** Deploying the current build as-is breaks every API call and authentication in production. It also bakes the live Razorpay public key from the local `.env` into the artifact.
- **Fix:** Rebuild in CI with `REACT_APP_API_URL=/api` (or the production API URL), a test/production-appropriate public key, and add a CI check rejecting `localhost` in shipped JS.

### EVT-AUD-006 — P2 — Pricing reads fall back to launch defaults on DB errors

- **Location:** `backend/utils/eventPricing.js:71-89`
- **Behavior:** Any `findOne` failure is swallowed and `normalizePricing(null)` returns launch defaults with version `0`.
- **Impact:** During a DB outage, quotes can silently use stale/default prices and return version `0`; a customer could book at a price that was never configured.
- **Recommendation:** Fail closed for booking/payment (`503 PRICING_UNAVAILABLE`) or label the quote as provisional, emit an alert/metric, and add a fault-injection test.

### EVT-AUD-007 — P3 — Idempotency fingerprint is case-sensitive

- **Location:** Events booking idempotency handling
- **Behavior:** The same key with a payload differing only by letter case produces `409 IDEMPOTENCY_KEY_REUSED` instead of replaying the original request.
- **Impact:** Low; a false conflict for semantically identical retries.
- **Recommendation:** Normalize fingerprints (trim, lowercase canonical fields) before hashing. Add a replay test.

### EVT-AUD-008 — P3 — External geolocation dependency returns `429`

- **Evidence:** Browser audit observed four `429` responses from `https://ipwho.is/`; the booking flow still worked.
- **Impact:** Approximate-location bootstrap can fail under rate limits; third-party IP disclosure is a privacy consideration.
- **Recommendation:** Make the lookup optional/non-blocking (already effectively is), cache failures, and document the external dependency and privacy impact.

## Release gate

**FAIL — NO-GO.**

Required before release:

1. Fix EVT-AUD-001 and EVT-AUD-002; rerun API quote/booking/update checks.
2. Fix EVT-AUD-003; enforce assignment through the eligibility-checked path.
3. Resolve EVT-AUD-004 policy and implement refund/block behavior.
4. Fix EVT-AUD-005 so the deployed build uses the production same-origin API.
5. Decide EVT-AUD-006 fallback behavior and add fault-injection coverage.
6. Complete external verification: Razorpay staging payment/refund/webhook, WhatsApp sandbox/template delivery, production index verification, policy approval, staging E2E.

## External blockers (not fixed by code)

- No real Razorpay staging keys/webhooks or refund verification.
- No WhatsApp sandbox/template delivery verification.
- Production index state not verified.
- `docs/EVENT_POLICY_APPROVAL.md` remains `NOT APPROVED`.
- No staging E2E run against the real deployment.
- `docs/EVENT_E2E_STAGING.md` procedure not executed in this audit.

## Evidence locations

- API results: `C:\Users\jiya\AppData\Local\Temp\opencode\events-audit\api-results.json`
- Browser results: `C:\Users\jiya\AppData\Local\Temp\opencode\events-audit\browser-results.json`
- Screenshots: `C:\Users\jiya\AppData\Local\Temp\opencode\events-audit\shots\`
- Isolated runner: `run-isolated.js`, `no-dotenv.js`, `api-audit.js`, `browser-audit.js`
- Prior readiness reports: `EVENTS_FINAL_PRODUCTION_READINESS_REPORT.md`, `EVENTS_PRODUCTION_READINESS_REMEDIATION_REPORT.md`

---

## Remediation follow-up - 2026-10-24

**The original audit above is preserved unchanged. All eight code findings are now remediated and re-verified locally. Production release remains NO-GO pending the external blockers listed below.**

### Verification rerun (2026-10-24, isolated in-memory MongoDB)

| Gate | Result |
|---|---|
| API audit | **49 / 49 PASS** |
| Browser E2E (customer/admin/cook) | **14 / 14 PASS** (added UI-014 for paid in-progress cancellation) |
| Admin pricing browser E2E (new) | **6 / 6 PASS** (UI-020..UI-025) |
| Full backend `npm test` | **exit 0** with a disposable in-memory URI; **no isolated-DB skips** |
| Frontend Jest | **16 / 16 suites, 143 / 143 tests PASS** |
| ESLint (Events UI + geolocation) | **exit 0** |
| Production build | **exit 0**; postbuild artifact guard PASS |
| Build artifact scan | no localhost API URL and no `rzp_live_` / `rzp_test_` literal in shipped JS |
| Staging preflight logic | **16 / 16 PASS** (new WhatsApp app secret, verify token, `CLIENT_URL` checks) |
| Events index inventory | **40 / 40 PASS**; all 7 Events collections inspected against an isolated DB, no drift |
| Payment webhook negatives | **PASS** — missing/invalid signature, non-raw body, malformed JSON, missing secret all rejected; booking unchanged; no dedupe row |

### Finding status

| ID | Severity | Status | Remediation | Evidence |
|---|---|---|---|---|
| EVT-AUD-001 | P1 | **FIXED** | Pricing update no longer calls the undefined helper; returns the normalized saved table. | API-041/042/043 PASS; regression "successful pricing update returns 200 and persists". |
| EVT-AUD-002 | P1 | **FIXED** | Deep-merge + full-table validation; legacy partial documents are repaired on save. | API-042/043 PASS; regression tests for legacy partial normalisation, quote, repair, and booking. |
| EVT-AUD-003 | P2 | **FIXED** | Manual status transition to `cook_assigned` is rejected with `USE_ASSIGN_ENDPOINT`; assignment must use the eligibility/overlap-checked endpoint. | Regression "manual cook_assigned status is rejected" PASS. |
| EVT-AUD-004 | P2 | **FIXED** | Paid in-progress cancellation is blocked with `REFUND_POLICY_UNRESOLVED`; paid pre-start cancellation queues a full refund. | API-038 PASS; browser UI-014 PASS; refund regression PASS. |
| EVT-AUD-005 | P2 | **FIXED** | `.env.production` pins `REACT_APP_API_URL=/api`; CI postbuild guard rejects a localhost API URL. Guard matches the API shape (`localhost:port/api`) so benign third-party fallbacks are not false positives. | `npm run build` exit 0; guard "Build artifact check passed"; bundle scan found no localhost API URL and no Razorpay key literal. |
| EVT-AUD-006 | P2 | **FIXED** | Pricing reads fail closed with `503 PRICING_UNAVAILABLE`; snapshots, quotes, and booking creation propagate the outage and recover when the DB returns. | Regression fault-injection tests PASS (`pricing snapshot exposes DB outage as 503`, `quote propagates pricing outage as 503`, `booking is not created during pricing outage`, `pricing recovers after DB returns`). |
| EVT-AUD-007 | P3 | **FIXED** | Idempotency fingerprint normalizes string values (trim + lowercase) before hashing. | Regression "case-only retry replays the original booking" PASS (`201/200`). |
| EVT-AUD-008 | P3 | **FIXED** | IP geolocation caches successful results for 6 hours and failures for 5 minutes; lookup remains optional/non-blocking. | `geolocation.ip.test.js` 4/4 PASS; privacy appendix added to `docs/PRIVACY_DECISIONS.md`. External `ipwho.is` 429s remain tolerated. |

### Residual blockers (unchanged, not code-fixable here)

- Real Razorpay staging payment / refund / webhook verification not executed.
- Real WhatsApp sandbox/template delivery not executed.
- Production MongoDB index state not verified.
- `docs/EVENT_POLICY_APPROVAL.md` remains **NOT APPROVED** (including the paid in-progress cancellation policy).
- Staging E2E procedure not executed against a deployed environment.
- The working tree is uncommitted and a merge is in progress; nothing was deployed.

### Current release decision

**NO-GO for production.** Local code and regression gates pass, but the production gate still FAILS on external verification and policy sign-off. Do not deploy based on this follow-up alone.

### Follow-up evidence locations

- Release gate: `EVENTS_RELEASE_GATE_2026-10-24.md`
- API: `C:\Users\jiya\AppData\Local\Temp\opencode\events-audit\api-results.json`
- Browser: `C:\Users\jiya\AppData\Local\Temp\opencode\events-audit\browser-results.json`
- Read-only index audit: `backend/scripts/audit-event-indexes.js`
- Admin pricing browser audit: `C:\Users\jiya\AppData\Local\Temp\opencode\events-audit\pricing-browser-audit.js`
- Screenshots: `C:\Users\jiya\AppData\Local\Temp\opencode\events-audit\shots\`
- Logs: `%TEMP%\opencode\audit2-*.log`
