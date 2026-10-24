# Staging Verification (prep only, no live calls)

Live verification is NOT complete until the section-4 checklist passes
on isolated staging. Nothing here calls Razorpay, sends WhatsApp, or
writes to any database.

## 1. Staging database (isolated, empty)

Separate Atlas project/cluster (or separate local mongod) for staging
only. Suggested db `cookmitra_staging` (name must contain `staging` or
`test`; preflight refuses others). Dedicated user, read/write on that
DB only, URL-encode the password.

Export ONLY as STAGING_MONGODB_URI. NEVER reuse production MONGODB_URI:
must differ, must not contain prod markers (festivecook/prod/live), DB
must start EMPTY. Verify via verifyStagingDbEmpty; expect {empty:true}.

## 2. Razorpay staging (fail-closed rzp_test_* only)

Out-of-band test-mode keys: RAZORPAY_KEY_ID starting rzp_test_,
RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET (staging webhook).
NODE_ENV=staging (never production). Preflight refuses live keys,
non-test prefixes, placeholders, missing secret, production NODE_ENV.
Zero gateway calls in preflight.


## 3. WhatsApp sandbox (no sends in preflight)

Per docs/WHATSAPP_SETUP.md on a Meta test app: test Phone Number ID
(API Setup) as WHATSAPP_PHONE_NUMBER_ID; temporary (~24h) or staging
system-user token as WHATSAPP_TOKEN; add ONE customer + ONE cook test
number under API Setup > To (accept invite; cap 5); export the single
allowed number as WHATSAPP_TEST_RECIPIENT (alias WHATSAPP_SANDBOX_TO,
10-digit Indian mobile). Templates: in-window free text covers
request/accept/pay/start; outside-window needs approved
WHATSAPP_REQUEST_TEMPLATE (default cook_booking_request) + LANG
(default en) verified in WhatsApp Manager. Confirm via admin
GET /api/whatsapp/status, then POST /api/whatsapp/test ONLY to the
opted-in test number. Never message real users.


## 4. Runner checklist (staging-only, repeatable)

Step 0 preflight: `node backend/staging-preflight.test.js` (10 checks)
plus masked `checkStagingReadiness(process.env)`; require ok:true.
Steps (empty staging DB, test money/numbers): (1) refund idempotency
approve-once processed + rf id + one ledger row, retry 400 no second
call; (2) reconcile failed->processed via POST reconcile, redelivery
single row; (3) cook cancel same-doc requested/cook null/fresh window/
ignoredBy/payment kept/no refund; (4) replacement accept website +
WhatsApp, paid->confirmed no extra charge; (5) duplicate accept 409s,
single winner; (6) webhook redelivery 200 no dup rows. Record PASS/FAIL
+ IDs. Live verification counts ONLY when all six pass on staging.

---

# Weekly Cook Payout — Staging Verification (sections 5–16)

Covers the Monday–Sunday (IST) weekly cook payout workflow: pending /
completed tabs by earning week, receipt-evidence settlement, duplicate +
concurrent settlement safety, refund interplay, and cook-side earnings.
All steps run against the **isolated staging DB from section 1** with
**test bookings and test money only**. Never trigger real payments,
real payouts, or real refunds in production for testing.

Conventions below: **[AUTO]** = runnable automated test with an
expected result; **[MANUAL]** = human staging check with pass criteria.

## 5. Required staging environment configuration [MANUAL]

Set these in the staging shell only (never commit them):

| Variable | Value in staging |
|---|---|
| `NODE_ENV` | `staging` (never `production`) |
| `STAGING_MONGODB_URI` | isolated staging cluster, db name contains `staging` or `test` |
| `MONGODB_URI` | must NOT equal `STAGING_MONGODB_URI`; never production |
| `JWT_SECRET` | long random staging-only secret (≥32 chars, not a placeholder) |
| `TZ` | `Asia/Kolkata` (booking math is IST-anchored) |
| `UPLOAD_DIR` | persistent staging volume ending in `cook-docs` (server refuses other names) |
| `RAZORPAY_KEY_ID` | `rzp_test_*` only; live keys refused by preflight |
| `WHATSAPP_*` | sandbox values per section 3 |

**[AUTO]** `node backend/staging-preflight.test.js` → `10 passed, 0 failed`.

## 6. Database and replica-set prerequisites [MANUAL + AUTO]

- Payout settlement uses multi-document transactions **when the
  deployment is a replica set**, and falls back to status-guarded
  conditional updates on standalone MongoDB (see
  `withFinancialTransaction` in `backend/controllers/adminWeeklyPayoutController.js`
  and `backend/controllers/adminCookEarningsController.js`). Either way,
  concurrent settlements race on ONE atomic document update — exactly
  one wins — but only a replica set gives true all-or-nothing rollback
  across `cookpayouts` + `bookings`.
- Staging Atlas is a replica set by default (all tiers, including the
  free M0): confirm with
  `db.hello().setName` (non-empty) via `mongosh "$STAGING_MONGODB_URI"`.
- Local `docker compose --profile local-mongo` runs a **standalone**
  mongod: fine for smoke tests, but transaction rollback CANNOT be
  verified there — use section 11 instead.
- **[AUTO]** index checklist (read-only):
  `MONGODB_URI="$STAGING_MONGODB_URI" node backend/scripts/check-payout-indexes.js`
  → expect `ALL CHECKS PASSED` (8 unique indexes, zero duplicate
  `paymentReference`, no diverged/ambiguous/audit-gap cycles).
- Local replica-set transactions without Docker: the repo's
  declared `mongodb-memory-server` devDependency starts an in-memory
  replica set (`MongoMemoryReplSet.create({ replSet: { count: 1 } })`;
  first run downloads a mongod binary, later runs reuse the cache).
  Verified 2026-10-15: commit path settles 200 with all bookings flipped
  in one transaction; a forced booking-write failure mid-transaction
  returns 500 with the cycle still pending/approved, zero bookings
  flipped, zero `payout_paid` audits, and the orphan receipt deleted.
  See section 11.

## 7. Safe test data preparation [MANUAL]

1. Seed ONE staging admin, TWO staging cooks, ONE staging customer
   (test phone numbers only, e.g. `900000000x`).
2. Create 2–3 `completed` bookings for cook A inside ONE business week
   (e.g. Mon 2026-10-05 → Sun 2026-10-11 IST), `payment.status: paid`,
   `testMode` unset/false, `refundStatus: none`, `hoursCompleted: true`,
   arrival + OTP timestamps present. Keep one `cancelled` booking and
   one `refundStatus: pending` booking for the same cook to prove they
   are excluded from payout totals.
3. Build the cycle once:
   `POST /api/admin/cook-payouts/payouts/build { cookId, weekStart: "2026-10-05" }`
   → `201`, `bookingCount` equals eligible only, totals paise-exact.
   Rebuilding the same week must return the same cycle
   (`alreadyExists`, no double count).
   Build weeks SEQUENTIALLY (each week before the next week's bookings
   complete): a build claims every currently-unclaimed eligible booking
   into the requested week, so building late sweeps backlog into one
   cycle. Settlement itself never moves a booking across weeks.
4. Record booking IDs + cycle IDs for the checklist log.

## 8. Admin authorization checks [AUTO + MANUAL]

- **[AUTO]** covered by `backend/weekly-payout.test.js` access-control
  block (anonymous → 401, cook → 403 on read + settle).
- **[MANUAL]** on staging: repeat with real tokens — no-token `GET
  …/weekly/pending` → 401; cook-token read + settle → 403; admin →
  200. Cook-role requests must never reveal other cooks' payouts.
- Receipt URLs: `POST /api/docs/signed-url { doc: receiptUrl }` as admin
  → 200 + short-lived view URL; as cook → 403; anonymous → 401. Direct
  `/uploads/cook-docs/payout_*` fetches require the same JWT/role gate
  (cook filenames are `payout_<adminId>_…`, so cooks are never owners).

## 9. Weekly payout review and approval workflow [MANUAL]

1. Open Admin → Pending Payouts, pick the seeded week via the date
   picker. Pass criteria: header shows `Earning week 5 Oct – 11 Oct
   (Monday–Sunday, IST)`, totals = sum of eligible only, cook count
   correct, records show cook + eligible bookings + gross/net +
   settled/remaining.
2. Switch the picker to an adjacent week: zero records, zero totals
   (no leakage across weeks).
3. Pending → Completed tab flip: settled cycles leave Pending and
   appear under Completed **for the same earning week** (grouped by
   earning week, never re-bucketed by settlement timestamp). Settle a
   cycle today, then query next week's Completed tab: still empty.
4. Optional hold path: `POST …/payouts/:id/hold { reason }` → `held`;
   settling a `held` cycle → 409. Approve path: `POST …/payouts/:id/approve`.

## 10. Receipt upload, storage, preview, and access-control checks [AUTO + MANUAL]

Rules: exactly one file, field name `receipt`, JPG/PNG/WEBP only
(content-sniffed, spoofed extensions rejected), **≤ 5 MB**, mandatory.
Stored as `payout_<adminId>_<ts>_<rand>.<ext>` under the auth-gated
upload dir; preview only via signed URLs.

- **[AUTO]** `backend/weekly-payout.test.js` proof-validation block:
  missing → 400 `RECEIPT_REQUIRED`; wrong MIME → 400; spoofed content
  → 400 `INVALID_FILE_CONTENT`; >5 MB → 400 `RECEIPT_TOO_LARGE`; bad
  method → 400; unknown cycle → 404 **and the uploaded file is deleted**;
  failed attempts leave the balance pending.
- **[MANUAL]** on staging: upload a 6 MB PNG → 400 `RECEIPT_TOO_LARGE`;
  a `.txt` renamed to `.png` → 400; settle without a file → 400. Open
  Completed → View receipt → secure preview loads; `Open original`
  works for the admin session and expires within minutes.

## 11. Duplicate and concurrent settlement checks [AUTO + MANUAL]

- **[AUTO]** `backend/weekly-payout.test.js`: idempotent replay with a
  fresh receipt → 200 `alreadySettled: true`, single `payout_paid`
  audit, no second payment; same transaction ID on another cycle →
  409; 6 concurrent settles → exactly one real win, single audit,
  loser uploads cleaned (one receipt file kept).
- **[AUTO]** `backend/payout-weekly-guards.test.js` (hermetic, no DB):
  weekly-paid / cycle-claimed bookings are rejected on the legacy
  per-booking rail with 409 and zero writes.
- **[AUTO]** replica-set rollback (needs `mongodb-memory-server`,
  offline-safe after the first binary download): start
  `MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine:
  "wiredTiger" } })`, run a settle through the real route stack, then
  force a booking-write failure mid-transaction — expect HTTP 500 (no
  false success), cycle still pending/approved, zero bookings flipped,
  orphan receipt deleted, zero `payout_paid` audits. Commit-path
  control: normal settle → 200 with all bookings flipped in one
  transaction.
- **[MANUAL]** on staging: fire two settles for the same cycle at once
  (two admin sessions) → one succeeds, the other reports
  already-settled/409 after refresh; only one `payout_paid` audit row
  and one receipt file exist.

## 12. Refund verification [AUTO + MANUAL]

- **[AUTO]** `refund-request` / `refund-hardening` /
  `refund-deep-audit` / `cancellation-refund` / `finance-audit` suites:
  approve-once idempotency, no duplicate gateway calls, settled-payout
  refunds require explicit `clawback`, ledger parity.
- Cross-rail rule (enforced in `backend/utils/finance.js` +
  `backend/controllers/payoutController.js`): a booking paid through a
  weekly cycle (`payoutInfo.payoutStatus: paid`) can NEVER be settled
  again on the legacy per-booking rail (409 `PAYOUT_ALREADY_SETTLED_WEEKLY`),
  and its refund can only be approved with `clawback: true` — otherwise
  the cook keeps the payout AND the customer is refunded (double
  spend). **[AUTO]** covered by `payout-weekly-guards.test.js`.
- **[MANUAL]** on staging with test money only: approve a refund for a
  weekly-paid booking WITHOUT clawback → 400; WITH clawback → proceeds
  with the clawback note. Never approve/settle refunds for real
  customer money as a "test".

## 13. Cook dashboard and earnings verification [MANUAL]

1. Log in as the seeded cook → Earnings: `thisWeek` buckets by
   immutable **service date (IST)**, settled rows read `paid`, unsettled
   eligible rows read pending; lifetime = paid + pending.
2. After admin settles the cycle: cook sees a `payout_paid`
   notification linking to `/cook/earnings`, and the rows flip to paid
   without changing weeks.
3. `GET /api/cook/payouts` lists the cook's own cycles newest-first;
   `GET /api/cook/payouts/:id` shows only the owning cook's cycle.

## 14. WhatsApp delivery and booking regression checks [AUTO + MANUAL]

- **[AUTO]** `npm test` includes `whatsapp-channel`, `whatsapp-inbound`,
  `whatsapp-dispatch-jobs`, `whatsapp-api`, `pay-whatsapp`,
  `whatsapp-marathi-cook`, plus `replacement-dispatch-reset`,
  `cook-cancel-admin-notify`, `admin-assign-jobsheet` suites.
- **[MANUAL]** on staging sandbox only (section 3): trigger a booking
  request → cook receives the Marathi job sheet with address + map
  link; accept → customer notified, no extra charge on replacement
  accepts; duplicate accept → 409 single winner. Send ONLY to the
  opted-in `WHATSAPP_TEST_RECIPIENT`.

## 15. Relevant automated test commands [AUTO]

From `backend/` (requires Node ≥ 18; `npm ci` installs
`mongodb-memory-server` as a declared devDependency — the first
in-memory run downloads a mongod binary, later runs reuse the cache):

```sh
npm test            # full backend chain incl. weekly-payout (45 checks),
                    # payout-weekly-guards (11), finance-audit (116),
                    # refund + whatsapp suites. Must end 0 failures.
```

Focused runs (same directory):

```sh
node weekly-payout.test.js        # earning-week tabs + receipt settlement
node payout-weekly-guards.test.js # cross-rail double-spend guards (no DB)
node payout-settle.test.js        # legacy per-booking rail
node finance-audit.test.js        # adversarial finance state machine
node payout-index-check.test.js   # read-only production-index checklist
node refund-request.test.js refund-hardening.test.js refund-deep-audit.test.js
node check-tests-present.js       # fail-closed guard (refuses green on missing suites)
```

From `frontend/` (requires `npm install` once):

```sh
CI=true npx react-scripts test --watchAll=false --testPathPattern "AdminWeeklyPayouts|BookingRequestModal.replacement"
```

There is intentionally NO single root `npm test`: backend (plain
`node` scripts) and frontend (`react-scripts`/jest) have different
runners and environments. Jenkins deploys only; it does not run tests.

## 16. Deployment verification and rollback precautions [MANUAL]

1. Deploy to staging; hit `GET /api/health` (`status: ok`) and
   `GET /api/ready` (`ready: true`).
2. Re-run sections 4 + 11 + 12 against staging; log PASS/FAIL + IDs.
3. Confirm `docs` uploads volume persisted across a container restart
   (`UPLOAD_DIR` mount, section 5).
4. Rollback: this release migrates NO schemas destructively (new
   `CookPayout` fields default safely; new indexes are additive). To
   roll back, redeploy the previous image — paid cycles stay `paid`
   with their receipts; pending balances are untouched. NEVER delete
   or rewrite `paymentReference`, receipt files, or audit rows to
   "fix" a verification failure — investigate each pair with Finance
   (see `docs/PAYOUT_PRODUCTION_CHECKS.md`, read-only recovery).
5. Production is OUT OF SCOPE for verification clicks: no real
   payouts, receipts, refunds, or WhatsApp sends. Production checks
   are read-only (`backend/scripts/check-payout-indexes.js`).
