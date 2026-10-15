# Privacy Decisions — Owner Memo (CookMitra, 15 Oct 2026)

Status: **DECISION REQUESTED — do not implement until the owner approves
one option per item.** No verification documents, bank/UPI details, or
financial records were deleted while preparing this memo. Nothing below
is a legal interpretation; periods marked "requires review" need a
qualified legal/accounting opinion before they become policy.

Context: `DELETE /api/auth/users/:id` with `{ anonymize: true }`
(admin-only) implements the approved Option A policy — scrub direct
account identifiers, suspend the account, revoke sessions — while
preserving every financial/audit record (see `adminDeleteUser` in
`backend/controllers/authController.js`, regression coverage in
`backend/admin-delete-guard.test.js` cases 6–10). The three items below
are the retention questions that implementation deliberately left open.

---

## Decision 1 — Retained payout details after anonymization

### What remains (verified in code)

`CookProfile.payoutDetails` (per `backend/models/CookProfile.js`):
`method` (upi/bank), `upiId`, `holderName`, `bankName`,
`accountLast4` (last 4 digits only — full account numbers are never
stored), `ifsc`, `note`, plus the append-only `payoutDetailsHistory`
(previous values with `changedAt`). `Booking.payout.recipient` snapshots
the same fields onto each settled booking. The anonymized `User` row
keeps only a `deleted-<id>@deleted.local` placeholder and no phone.

### What is necessary for outstanding earnings

To settle a pending weekly cycle the admin flow needs a destination:
`method` + (`upiId` OR `accountLast4` + `ifsc` + `holderName`). Without
these, an anonymized cook's accrued-but-unpaid earnings cannot be
disbursed and would strand. `note` and full `payoutDetailsHistory`
are NOT needed for settlement.

### Who can access them today (verified in code)

- Admin-only: payout queue + per-booking settlement
  (`backend/controllers/payoutController.js`), cook admin overview
  (`authorize("admin")`), receipt signed-URL mint/view (owner-or-admin;
  anonymized users fail both: suspended → 403, stale `tv` → 401).
- Owning cook only: `GET /api/cooks/me` (`authorize("cook")`, own
  profile) — unreachable after anonymization (account suspended).
- Public cook listings and booking cards EXCLUDE phone/email/documents/
  `payoutDetails` (asserted in `reschedule-cook.test.js`).

### Options

- **1A — Retain all payout fields until owner-specified purge (recommended).**
  Simplest, keeps every pending payout payable and every settled
  payout reconcilable. Risk: retains `upiId` (a strong identifier)
  indefinitely with no expiry.
- **1B — Minimize after obligations clear:** once a cook has no
  pending/approved/unpaid cycles AND a cooling window has passed, scrub
  `upiId`/`holderName`/`ifsc`/`note`/`payoutDetailsHistory`, keeping only
  `method` + `accountLast4` (enough to prove *a* destination existed,
  not whose). Requires a small purge job + a "fully settled" check.
  Risk: needs the cooling window defined; re-engaging the cook requires
  re-entry of details.
- **1C — Scrub all payout details at anonymization.** Maximum erasure.
  Risk: strands outstanding earnings and destroys reconcilability of
  settled payouts — conflicts with the finance-audit guarantees.
  **Not recommended.**

**Recommendation: 1A now, with 1B scheduled** once the retention period
(Decision 3) is legally reviewed. Privacy-policy wording that matches
1A: *"If you request deletion while bookings, payouts, or refunds are
still attributable to your account, we anonymize your profile (name,
contact details, login) and keep payout destinations and transaction
records for as long as needed for accounting, tax, and dispute
resolution. Payout details are visible only to authorized operations
staff and never in public listings."*

---

## Decision 2 — Verification-document handling on anonymization

### Policy text vs behavior (verified)

- `frontend/src/pages/Legal.jsx` §4: *"Verification documents submitted
  by cooks are stored securely and removed when a cook is deactivated."*
- Current behavior: anonymization sets `status: "suspended"` (which is a
  form of deactivation) but **does not delete** `aadhar_*`/`pan_*` files
  under `UPLOAD_DIR/cook-docs`, nor references in `CookProfile`.
- Access today: `/uploads` requires JWT + owner-or-admin
  (`backend/server.js` `uploadAccess`); signed URLs likewise
  (`backend/routes/docs.js`). An anonymized (suspended) user cannot mint
  or use either, so effective access is admins only.
- Payout impact of deletion: **none** — settlement reads
  `payoutDetails` + receipt evidence, never identity documents, so
  removing files cannot break pending payouts (verified by code
  inspection of both settlement controllers).

### Options

- **2A — Scheduled purge (recommended).** Keep files through a bounded
  post-anonymization window (proposal: until Decision 3 sets the
  period; suggested starting point 180 days for dispute handling —
  requires review), then delete files + clear profile references via a
  logged job, skipping accounts under legal hold. Matches the policy
  sentence while preserving short-term dispute evidence.
- **2B — Delete immediately on anonymization.** Literal reading of the
  policy sentence. Risk: destroys evidence for in-flight disputes or
  chargebacksTouched in the same week.
- **2C — Preserve indefinitely, revoke access.** Keep files with
  admin-only access as today. Risk: contradicts the published
  "removed when deactivated" sentence; indefinite ID-document storage
  is the highest-risk posture of the three.
- Legal-hold carve-out (any option): flagged accounts skip deletion
  until hold release, with the hold itself audited.

**Recommendation: 2A** (bounded window + legal-hold carve-out), with the
policy sentence kept as-is. **Do not delete anything until this is
approved and the job is reviewed.**

---

## Decision 3 — Retention period for anonymized records

### Current behavior (verified)

- **No TTL / no purge** on: `bookings`, `cookpayouts`, `ledgerentries`,
  `cookeventlogs`, `cancellationaudits`, `cookprofiles`, `reviews`,
  `complaints`, `notifications` for financial types.
- **TTL exists** on: general `notifications` (7 days,
  `backend/models/Notification.js`), visit/session collections.
- Uploaded files: never auto-deleted.

### Proposed schedule (periods marked ★ require legal/accounting review)

| Category | Records | Proposal |
|---|---|---|
| Financial | bookings (+payment/payout snapshots), cookpayouts, ledger entries, refund records | Retain ★ (tax/audit statute window; owner to confirm years with CA) |
| Audit | cook event logs, cancellation audits | Retain ★ alongside financial records |
| Operational | availability (already deleted at anonymize), dispatch jobs, visit stats | Existing TTLs; no change |
| Identity docs | aadhar/pan uploads | Decision 2A window, then purge |
| Personal | scrubbed at anonymization (name, contacts, addresses, login) | Immediate (implemented) |

**Recommendation:** adopt the category split now; fill ★ periods only
after legal/accounting review. Do not invent statutory periods here —
none are asserted.

---

## Requested owner actions

1. Approve one option for each decision (recommended: **1A→1B later,
   2A, category split of 3**).
2. Confirm ★ retention periods with legal/accounting.
3. Authorize implementation + policy-text update only after (1)–(2).
