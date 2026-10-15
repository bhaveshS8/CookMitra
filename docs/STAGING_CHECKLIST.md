# Manual Staging Checklist — Release Gate (CookMitra)

**Environment:** isolated staging only (Atlas `cookmitra_staging`-style
DB or equivalent; `NODE_ENV=staging`; `rzp_test_*` keys; WhatsApp
sandbox; `UPLOAD_DIR` ending in `cook-docs`). **No production data,
no production credentials, no real money, no real recipients.**
Prerequisites for every scenario: §0 done, synthetic accounts exist,
evidence log open (record IDs + statuses only — never PII or secrets).

**[AUTO] vs [STAGING] evidence:** automated suites prove code behavior
on synthetic in-memory data; they are NOT staging evidence. A scenario
passes only on observed staging behavior recorded below.

Related: `docs/STAGING_VERIFICATION.md` (procedures), `docs/PRIVACY_DECISIONS.md`
(open retention questions — do not delete docs/records on staging beyond
what the scenario specifies).

---

## §0 Global prerequisites (all scenarios)

- Staging API reachable; `GET /api/health` → 200 `status: ok`;
  `GET /api/ready` → 200 `ready: true` (ready is 503 while DB is down).
- `node backend/staging-preflight.test.js` → 10/10; masked readiness ok.
- `MONGODB_URI="$STAGING_MONGODB_URI" node backend/scripts/check-payout-indexes.js`
  → `ALL CHECKS PASSED` (read-only).
- Accounts: 1 admin (`9000000001`), cooks A/B (`9000000002/3`),
  1 customer (`9000000004`). Tokens labeled ADMIN/COOK/CUSTOMER below.

## S-1 Authentication and authorization matrix

- **Prereqs:** §0. **Roles:** none, CUSTOMER, COOK, ADMIN.
- **Procedure:**
  1. `GET /api/admin/cook-payouts/weekly/pending` no token → expect **401**.
  2. Same with COOK → expect **403**; with CUSTOMER → **403**.
  3. `POST …/payouts/:id/settle-weekly` (valid id, no file) with COOK → **403** (before any file handling).
  4. Same endpoints with ADMIN → **200/400** (never 401/403).
  5. `POST /api/docs/signed-url {doc: <receipt>}` ADMIN → 200; COOK → 403; none → 401.
  6. Suspended-account check: suspend cook B, reuse B's token → **403**; old token after re-login rotation → **401** (`tv` mismatch).
- **Invariants:** no state changes from denied calls; no other cook's data in any 403 body.
- **Evidence:** status code per row + token role used. **Cleanup:** unsuspend B. **Pass:** all rows match.

## S-2 Weekly payout creation and approval

- **Prereqs:** §0; cook A has 2–3 `completed`, paid, OTP-verified bookings in week W (Mon–Sun IST) + 1 `cancelled` + 1 `refundStatus: pending` booking.
- **Procedure:**
  1. `POST /api/admin/cook-payouts/payouts/build {cookId: A, weekStart: "2026-10-05"}` → **201**; assert `bookingCount` = eligible only, `totalPayable` paise-exact, `grossCustomerValue` correct.
  2. Rebuild same week → **200 `alreadyExists`**, same `_id` (no double count).
  3. `GET …/weekly/pending?weekStart=2026-10-05` → 200, 1 record, totals match; adjacent week → 200, 0 records.
  4. `POST …/payouts/:id/approve` → 200 `approved`; second approve → **409**.
  5. `POST …/payouts/:id/hold {reason}` on a second cycle → `held`; approve-from-held → 200 (allowed) — record behavior.
- **Build sequentially** (each week before next week's bookings complete): a build claims all unclaimed eligible bookings into the requested week.
- **Evidence:** cycle IDs, counts, totals. **Cleanup:** none (cycles persist by design). **Pass:** all statuses + arithmetic exact.

## S-3 Receipt upload limits, signed URLs, access restrictions

- **Prereqs:** §0; approved cycle from S-2 (use a fresh cycle per attempt).
- **Procedure (each → expected):** no file → **400 `RECEIPT_REQUIRED`**; `.txt` as `receipt` → **400**; real bytes renamed `.png` → **400 `INVALID_FILE_CONTENT`**; 6 MB PNG → **400 `RECEIPT_TOO_LARGE`**; `paymentMethod: cheque` → **400**; unknown cycle id → **404 + uploaded file removed** (list upload dir before/after).
- Settle valid (UPI ref `UTR-STG-<n>`, ≤5 MB PNG) → **200 `paid`**, `receiptUrl` like `/uploads/cook-docs/payout_<admin>_…png`.
- `Completed` tab → View receipt → preview loads; Open-original URL expires within minutes (re-request needed).
- Direct `GET <receiptUrl>` with ADMIN JWT → 200; COOK JWT → **403**; none → **401**.
- **Invariants:** failed attempts leave cycle pending + totals unchanged; exactly one file per success.
- **Evidence:** codes per row, file listing counts. **Pass:** all rows match; no orphan files.

## S-4 Concurrent settlement and duplicate-payment prevention

- **Prereqs:** §0; two approved cycles (C1, C2) + one fresh cycle (C3).
- **Procedure:**
  1. Settle C1 (ref R1) → 200. Re-settle C1 with new file/ref → 200 **`alreadySettled: true`**, same `settledAmount`; `CookEventLog(D)` shows exactly one `payout_paid` for C1.
  2. Settle C2 with ref R1 → **409** (`DUPLICATE_PAYOUT_REFERENCE`).
  3. Fire 2 settles for C3 simultaneously (two admin sessions, refs R3a/R3b) → one 200, other 200-`alreadySettled`/409 after refresh; exactly one `payout_paid` audit; exactly one new receipt file.
  4. Legacy rail: `POST /api/payouts/<C1-booking-id>/settle {reference}` → **409** (`PAYOUT_ALREADY_SETTLED_WEEKLY`); booking's legacy `payout.status` stays `pending`.
- **Evidence:** audit counts (`event: payout_paid`, `refId`), receipt file count, booking states. **Pass:** single payment per cycle, no double-pay on either rail.

## S-5 Refund clawback after weekly settlement

- **Prereqs:** §0; settled cycle C1 (test money only); one booking with `refundStatus: pending`.
- **Procedure:**
  1. `POST /api/refunds/<weekly-paid-booking>/approve {}` (no clawback) → **400** (settled-payout guard).
  2. Same with `{clawback: true}` → proceeds; history note records clawback; cook notified of recovery.
  3. Legacy-settled booking refund without clawback → 400 (control row).
- **Invariants:** exactly one ledger row per approval; no second gateway call on retry (idempotent approve → 400/409, single `refundId`).
- **Evidence:** codes, ledger counts, `refundId`. **Never use real customer money.** **Pass:** guard blocks, clawback path audited.

## S-6 Cook earnings dashboard and historical totals

- **Prereqs:** §0; cook A login; settled + pending weeks present.
- **Procedure:**
  1. Cook → Earnings: `thisWeek` matches service-date (IST) bucketing; settled rows `paid`; pending rows pending; lifetime = paid + pending.
  2. `GET /api/cook/payouts` → own cycles newest-first; `GET /api/cook/payouts/:id` other cook's id → **404**.
  3. After a new settlement: `payout_paid` notification links `/cook/earnings`; rows flip to paid without changing weeks.
- **Pass:** numbers reconcile with S-2/S-4 cycles to the paise; no cross-cook leakage.

## S-7 WhatsApp sandbox delivery and callback handling

- **Prereqs:** §0 + Meta test app (§3 of verification doc); exactly one opted-in `WHATSAPP_TEST_RECIPIENT`; approved template outside 24h window.
- **Procedure:**
  1. `GET /api/whatsapp/status` (admin) → configured + sandbox.
  2. `POST /api/whatsapp/test` → ONLY the opted-in number; confirm Marathi job sheet (address + map link) on cook side.
  3. Booking request → accept (web + simulated WhatsApp accept) → paid→confirmed, no extra charge on replacement accepts; duplicate accept → **409**, single winner.
  4. Redeliver a `statuses` callback → 200, no duplicate rows.
- **Invariants:** zero sends to non-opted-in numbers (check dispatch logs). **Pass:** delivery + idempotency observed; sandbox numbers only.

## S-8 Deployment health checks and rollback rehearsal

- **Prereqs:** staging deploy pipeline access (Render dashboard / compose host).
- **Procedure:**
  1. Deploy candidate; poll `GET /api/health` (ok) and `GET /api/ready` (ready:true; 503 while DB down is correct behavior).
  2. Re-run §§S-1/S-4/S-5 smoke subset; log PASS/FAIL + IDs.
  3. Restart container/instance; confirm uploads persist (`UPLOAD_DIR` mount) and receipts still preview.
  4. Rollback rehearsal: redeploy previous image/tag (Render: prior deploy → Rollback; compose: previous tag + `up -d`); re-hit health/ready; confirm paid cycles/receipts/audits intact and pending balances unchanged.
- **Never delete/rewrite** `paymentReference`, receipt files, or audit rows to "fix" a failure — investigate with Finance (`docs/PAYOUT_PRODUCTION_CHECKS.md`).
- **Pass:** healthy gates, persistent uploads, intact financial records post-rollback.
