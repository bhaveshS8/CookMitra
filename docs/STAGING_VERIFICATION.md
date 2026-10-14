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
