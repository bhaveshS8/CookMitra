# Cook Payout — Production Verification Procedure (READ-ONLY)

All commands below are **read-only**. Nothing here creates indexes, deletes
data, rewrites snapshots, or repairs payout cycles. Any change needs a
separate, explicitly approved step.

## 0. Prerequisites

- `mongosh` installed, plus Node 18+ for the checklist script.
- An operator-supplied MongoDB connection string. **Never paste production
  credentials into chat, tickets, or logs.** Export it only in the shell:
  `export MONGODB_URI='mongodb+srv://<user>:<password>@<cluster>/<db>?retryWrites=true&w=majority'`
- The checklist script never prints credentials (it masks `user:****@` and
  `password=****`). It exits `0` only when every check passes, `1` on any
  failed check, `2` when `MONGODB_URI` is missing.

## 1. Automated checklist (preferred)

From `backend/`:

```sh
MONGODB_URI="$MONGODB_URI" node scripts/check-payout-indexes.js
```

What it verifies (all read-only via `getIndexes()`, `countDocuments()`,
aggregations):

1. Server version supports partial indexes (>= 3.2); prints replica-set
   vs standalone (standalone ⇒ transaction fallback applies to payout
   transitions).
2. All **8 required unique indexes** exist with exact key, `unique: true`,
   and exact partial filter:
   - `cookpayouts.uniq_cookpayout_payref` `{ paymentReference: 1 }`
     partial `{ paymentReference: { $exists: true, $gt: "" } }`
   - `cookpayouts.uniq_cookpayout_ref` `{ payoutRef: 1 }` (plain unique)
   - `cookpayouts.uniq_cookpayout_idem` `{ idempotencyKey: 1 }`
     partial `{ idempotencyKey: { $exists: true, $gt: "" } }`
   - `bookings.uniq_payout_reference` `{ "payout.reference": 1 }` + partial
   - `bookings.uniq_payout_reference_key` `{ "payout.referenceKey": 1 }` + partial
   - `bookings.uniq_refund_reference_key` `{ "payment.refundReferenceKey": 1 }` + partial
   - `bookings.uniq_booking_clientKey` `{ clientKey: 1 }` + partial
   - `bookings.uniq_payment_razorpayPaymentId` `{ "payment.razorpayPaymentId": 1 }` + partial
   (Lead, incentive, and referral collections were removed with those
   programs; their old indexes may linger in the database harmlessly —
   the checklist no longer requires them. Historical rows are preserved.)
3. **Zero duplicate non-empty `paymentReference`** values in `cookpayouts`.
4. **No paid cycle with unsynchronized bookings** (each paid cycle's
   `bookings[]` must all read `payoutInfo.payoutStatus: "paid"`).
5. **No ambiguous paid cycles** (`status: "paid"` with empty/missing
   `paymentReference` — each needs out-of-band transfer verification, then
   `POST /api/admin/cook-payouts/payouts/:id/reference`, then
   `POST /api/admin/cook-payouts/payouts/:id/sync-bookings`).
6. **Every paid cycle has a `payout_paid` audit** in `cookeventlogs`.

## 2. Manual equivalents (when the script cannot run)

```sh
mongosh "$MONGODB_URI" --quiet --eval '
db.version();
db.adminCommand({ getParameter: 1, featureCompatibilityVersion: 1 });
'
# Inspect the payment-reference index definition exactly:
mongosh "$MONGODB_URI" --quiet --eval '
JSON.stringify(db.cookpayouts.getIndexes().filter(i => i.name === "uniq_cookpayout_payref"), null, 2);
'
# Duplicate scan (must return [] — never delete/rewrite duplicates to
# "fix" it; investigate each pair with Finance first):
mongosh "$MONGODB_URI" --quiet --eval '
db.cookpayouts.aggregate([
  { $match: { paymentReference: { $exists: true, $ne: "" } } },
  { $group: { _id: "$paymentReference", n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } }
]).toArray();
'
# Paid-vs-bookings divergence scan:
mongosh "$MONGODB_URI" --quiet --eval '
db.cookpayouts.find({ status: "paid" }, { payoutRef: 1, bookings: 1 }).forEach(c => {
  const n = db.bookings.countDocuments({ _id: { $in: c.bookings || [] }, "payoutInfo.payoutStatus": { $ne: "paid" } });
  if (n > 0) print("DIVERGED " + c.payoutRef + ": " + n + " unsynced");
});
'
```

## 3. Before creating the proposed payment-reference index

The proposed index is `{ paymentReference: 1 }`, `unique: true`, partial
filter `{ paymentReference: { $exists: true, $gt: "" } }` (schema:
`backend/models/CookPayout.js`, name `uniq_cookpayout_payref`).
Preconditions, in order:

1. Confirm the schema definition above is the deployed one.
2. Confirm server version from step 2 (partial indexes need MongoDB ≥ 3.2).
3. Run the duplicate scan — it must be clean (`[]`).
4. Create with the exact name so the checklist recognises it:
   `db.cookpayouts.createIndex({ paymentReference: 1 }, { unique: true,
   partialFilterExpression: { paymentReference: { $exists: true, $gt: "" } },
   name: "uniq_cookpayout_payref" })`
5. Re-run the checklist; expect `ALL CHECKS PASSED`.

## 4. Uncertain-payment recovery (manual-disbursement model)

Transfers happen out-of-band; the admin records the external UPI/bank
reference. `status: "paid"` **alone is not proof of transfer** — proof is
`status: "paid"` **plus** a non-empty, unique `paymentReference` **plus** a
`payout_paid` audit event.

- If a pay request fails mid-write (cycle `paid`, bookings still
  `approved`, no `payout_paid` audit): do **not** re-POST `pay` (it 409s by
  design and never moves money). Verify the transfer out-of-band; if it
  completed, `POST …/sync-bookings` converges bookings and backfills the
  single missing `payout_paid` audit. If the transfer did **not** complete,
  escalate to Finance — never auto-reverse a paid cycle.
- If a paid cycle has no reference (ambiguous): `sync-bookings` refuses
  with `409 PAYMENT_EVIDENCE_MISSING` and touches nothing. Verify the
  transfer, then `POST …/reference` (audited, never overwrites), then sync.
