# Event Booking Index Migration

## Purpose

This procedure creates and verifies the Event booking idempotency index:

```text
collection: eventbookings
name:       customerId_1_idempotencyKey_1
key:        { customerId: 1, idempotencyKey: 1 }
unique:     true
partial:    { idempotencyKey: { $gt: "" } }
```

The index enforces one Event booking per customer per non-empty idempotency key. Empty or absent keys are excluded from the index.

The automated test covers the procedure against disposable in-memory databases only:

```bash
cd backend
node event-index-migration.test.js
```

Result on 2026-10-24: **40 passed, 0 failed** (includes the full read-only index inventory).

## Safety Boundaries

- Do not run this against production without an approved change window, verified backup, and the database owner's approval.
- The script is read-only unless `--apply` is supplied.
- `--target` must exactly match the database name in `MONGODB_URI`; a mismatch exits without changes.
- The script never drops, renames, or overwrites an index.
- The script never deletes, merges, or rewrites booking records.
- Do not paste the connection URI into chat, tickets, shell history, or logs. Load it from the deployment secret store.
- Record only the target database name, timestamp, index definition, duplicate counts, and pass/fail result.

## Preconditions

1. An approved backup or provider snapshot of the production database exists and restore has been validated.
2. The migration runs during a low-traffic maintenance window.
3. The MongoDB user has permission to list indexes and, for `--apply`, create one index.
4. MongoDB supports partial indexes (3.2 or later).
5. The application owner accepts that duplicate non-empty keys must be resolved as a business/data decision, not deleted.

## Dry Run

```bash
cd backend
node scripts/migrate-event-booking-indexes.js --target "$EVENT_DATABASE_NAME"
```

`MONGODB_URI` must already point to the intended database. The dry run checks:

- target database matches `--target`;
- existing indexes with the expected name and definition;
- an equivalent index on the same key under a different name;
- duplicate non-empty `(customerId, idempotencyKey)` groups;
- document and non-empty-key counts.

Expected safe results:

- `ALREADY PRESENT`: the exact index exists; no migration is needed.
- `DRY RUN OK` plus `WOULD CREATE`: the index is missing and the duplicate pre-check is clean.
- `FAIL`: stop. Do not use `--apply`.

## Apply

Only after the dry run is clean and the change is approved:

```bash
cd backend
node scripts/migrate-event-booking-indexes.js --target "$EVENT_DATABASE_NAME" --apply
```

The script rechecks duplicates immediately before creating the index, creates it with the exact definition, then re-reads the index list and rechecks duplicates. It exits non-zero if any post-check fails.

## Existing Index Cases

### Exact index already exists

Result: `ALREADY PRESENT`, exit `0`. No write occurs.

### Index with the expected name but a different definition

Result: `FAIL`, exit `1`. The script refuses to drop or overwrite it. Capture its definition and obtain DBA approval before any manual correction.

### Equivalent index under a different name

Result: `FAIL`, exit `1`. Do not create a second equivalent index blindly. Capture the found definition and obtain approval before renaming or dropping anything.

### Duplicate non-empty keys

Result: `FAIL`, exit `1`, no index created. Do not delete financial or booking records to force the build. Resolve the duplicate group as a business/data decision, then rerun the dry run.

### Repeated empty keys

This is allowed. Empty keys are outside the partial index. The test creates multiple empty-key bookings under one customer and confirms the index still builds.

## Post-Migration Verification

The script performs this verification automatically:

1. The index is present with the exact key order, uniqueness, and partial filter.
2. No duplicate non-empty key groups exist.
3. `--apply` reruns report `ALREADY PRESENT`.

Application-level checks on an approved isolated environment:

1. Same customer + same key + same intent returns the existing booking.
2. Same customer + same key + different intent returns `409 IDEMPOTENCY_KEY_REUSED`.
3. A stale quote returns `409 PRICING_CHANGED`.
4. Empty/absent keys still allow separate bookings.
5. Startup logs contain no index-build error after deployment.

## Full Events Index Inventory

Before applying the idempotency migration, inventory every Events collection on the target database. This command is read-only and never creates, drops, or changes an index:

```bash
cd backend
node scripts/audit-event-indexes.js
# JSON evidence:
node scripts/audit-event-indexes.js --json > events-index-audit.json
```

It compares the live indexes against the schema declarations and exits `1` if any required index is missing or has a different definition. `EXTRA (review)` entries are reported but do not mutate anything. `--apply`/`--drop` are explicitly refused.

Schema-declared indexes checked:

| Collection | Required indexes |
|---|---|
| `eventbookings` | `bookingId_1` unique sparse; `customerId_1_idempotencyKey_1` unique partial; `customerId_1_bookingStatus_1`; `cookId_1_bookingStatus_1`; `eventDate_1_bookingStatus_1`; `bookingStatus_1_createdAt_-1`; `cookId_1_eventDate_1_bookingStatus_1`; `payment.razorpayOrderId_1`; `payment.razorpayPaymentId_1` unique partial; `payment.refundStatus_1_payment.refundRequestedAt_1` |
| `eventpricings` | `key_1` unique |
| `eventtypes` | `name_1` unique |
| `eventledgerentries` | `eventBooking_1`; `eventBookingId_1`; `type_1`; `eventBooking_1_createdAt_-1`; `type_1_createdAt_-1`; `paymentId_1_type_1` |
| `eventoutboxes` | `eventKey_1` unique; `status_1_nextRetryAt_1`; `bookingId_1_action_1` |
| `webhookevents` | `key_1` unique; `receivedAt_1` TTL |
| `notifications` | `user_1_read_1`; `eventKey_1_user_1` unique partial; `createdAt_1` TTL |

The isolated test (`event-index-migration.test.js`) creates all declared indexes in `MongoMemoryServer`, runs the inventory, and confirms zero missing/mismatched indexes. This validates the schema and tool, not the production database.

Production result as of 2026-10-24: **NOT VERIFIED / BLOCKED** — no authorized production database access was provided. Run the audit in the approved change window and attach the JSON output before release.

## Backup, Maintenance, and Rollback

- Prefer a provider snapshot. If using `mongodump`, load the URI from a protected config or secret store, encrypt the dump, restrict access, and verify the dump can be restored. Do not put credentials on the command line.
- Create the index during low traffic. A unique index build can consume I/O and can fail if duplicate data appears during the build.
- No data rollback is required for index creation.
- If the index must be removed, obtain incident approval first. It removes duplicate-booking protection. The manual operation is:

```javascript
db.eventbookings.dropIndex("customerId_1_idempotencyKey_1")
```

- Application rollback does not require dropping the index. Redeploy the previous image if needed; the index is backward-compatible with the schema.
- If `createIndex` times out or the connection drops, rerun the dry run. `createIndex` is idempotent when the definition matches. Do not attempt a data repair until the index state is confirmed.

## Startup Behavior

No `autoIndex` or `syncIndexes` override exists in the backend. Mongoose therefore uses its default automatic index behavior, and startup/first-model-use may attempt schema index creation. Do not rely on that as the production migration:

- verify the index explicitly with this script;
- monitor application startup logs for index-build errors;
- ensure the migration is complete before the release depends on the uniqueness guarantee.

`server.js` has a separate cook-payout index startup check (`ensurePayoutIndexes`); there is no equivalent Event startup check.

## Status

Locally tested against disposable MongoDB instances. Production index presence, duplicate cleanliness, and build result remain unverified because production access is not permitted in this pass.
