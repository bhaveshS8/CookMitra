# Event Payment, Cancellation, and WhatsApp Policy Approval

**Status: NOT APPROVED.** This document records implemented behavior and the decisions the business owner must explicitly approve. Code inspection is not approval. Do not use this document as evidence of customer-facing policy.

Owner: ____________________  
Approval date: ____________________  
Approved release/environment: ____________________

## 1. Payment Requirement

**Implemented behavior**

- Event payment is required for confirmation only when `EVENT_PAYMENTS_REQUIRED` is truthy (`true`, `1`, or `yes`), or when unset and `REQUIRE_PAYMENTS` is truthy.
- When required, an Event cannot move to `confirmed` unless `payment.status` is `paid`.
- Payment opens only after an admin assigns a cook, verifies the travel distance, and the server-computed total is greater than zero.
- Online checkout uses the server-computed total; the customer cannot submit an arbitrary amount.
- Production startup can refuse to boot when payments are required but Razorpay is not configured with a live `rzp_live_*` key and webhook secret.

**Owner decision required**

- [ ] Full online payment is mandatory before Event confirmation.
- [ ] Events may be confirmed without payment under a documented exception.
- [ ] Who may approve an unpaid exception, and how is it audited?

## 2. Cancellation Before Service Start

**Implemented behavior**

- A customer or admin may cancel a live Event before it reaches `in_progress`.
- If a captured payment exists, cancellation queues a full refund with `refundStatus: pending`.
- The customer sees that the full refund is awaiting admin approval.
- Refunds are not automatic; an admin must approve them.
- Completed events cannot be cancelled.

**Owner decision required**

- [ ] Confirm the full-refund rule for cancellation before start.
- [ ] Define the approval SLA and who may approve refunds.
- [ ] Confirm whether gateway fees are absorbed by CookMitra or deducted. Current behavior refunds the full captured amount.
- [ ] Approve the customer cancellation message and support escalation path.

## 3. Cancellation After Service Start

**Implemented behavior**

- A paid Event already `in_progress` cannot be cancelled through the self-service/admin cancellation endpoint until this policy is approved. The API returns HTTP `409` with code `REFUND_POLICY_UNRESOLVED`; the UI hides the cancel action.
- No automatic refund, partial refund, or “no refund” outcome is asserted for post-start cancellation.
- The captured payment remains recorded.
- Completed events cannot be cancelled.

**Owner decision required**

- [ ] Confirm the post-start cancellation rule: no refund, partial refund, or full refund.
- [ ] Define the partial-refund or goodwill-refund process, if any.
- [ ] Define who investigates and approves a post-start exception.
- [ ] Approve the customer-facing explanation, support path, and message shown when cancellation is blocked.

## 4. Refund Execution and Partial Refunds

**Implemented behavior**

- Event refunds are full-payment oriented.
- Admin approval claims the refund, attempts the gateway refund, and records the result.
- Test-mode payments are refunded as `TEST_MODE` with no real money movement.
- Gateway-pending refunds remain `processing` and can be reconciled.
- Gateway failures become `failed` and can be retried.
- Refund approval is idempotent; an already processed refund is not sent again.

**Owner decision required**

- [ ] Confirm full-only refunds for Events.
- [ ] Confirm whether partial refunds are required. Current code and UI do not present them.
- [ ] Confirm refund timing and customer communication.
- [ ] Confirm the procedure when the gateway is unavailable or a refund is stuck in `processing`.
- [ ] Confirm test-mode payments are never enabled for real customers.

## 5. WhatsApp Event Confirmation

**Implemented behavior**

- After the first successful Event payment capture, the assigned cook receives a free-form WhatsApp message with the Event details and dashboard link.
- Sending is fire-and-forget after payment is committed. A Meta outage cannot fail or delay payment confirmation.
- The send is skipped when the cook is missing, inactive, unapproved, or has no stored phone.
- Duplicate verification or webhook calls do not resend the confirmation.
- The message is currently free-form text, not an approved Meta template. Delivery outside the 24-hour customer-service window is unverified.
- There is no Event-specific WhatsApp retry worker. The in-app notification remains available as fallback.

**Owner decision required**

- [ ] **Option A (recommended):** approve an Event confirmation template, configure it, and test outside-window delivery.
- [ ] **Option B:** accept best-effort free-form text, with in-app notification as the fallback, and document the delivery limitation.
- [ ] Confirm which cook contact number is the supported WhatsApp number.
- [ ] Confirm the approved language and content.

## 6. Privacy and Retention

Event financial and booking records must not be deleted or rewritten to satisfy a refund, reconciliation, or index migration. Retention questions remain open in `docs/PRIVACY_DECISIONS.md`.

**Owner/legal decision required**

- [ ] Approve the retention period for Event bookings, payment records, refund records, and audit history.
- [ ] Confirm the privacy-policy wording for Event data.
- [ ] Confirm the process for a deletion request that conflicts with financial-record retention.

## 7. Approval Record

The owner must record one explicit decision per section. Until then:

- policy gate status is **NOT APPROVED**;
- the release is not policy-ready;
- this file must not be cited as customer-facing policy.

## 8. Technical Review Record

**2026-10-24 — engineering review only; no approval granted.**

- Rechecked implemented behavior against `event-payment.test.js`, `event-whatsapp.test.js`, and the browser E2E run.
- Confirmed the open decisions above are still accurate: full-only refunds, refund timing/communication, gateway-stuck handling, test-mode restriction, WhatsApp template/delivery window, and retention remain owner decisions.
- Confirmed the code intentionally fails closed for payment configuration, rejected webhooks, and unverified distance.
- No owner, legal, or business sign-off was received. All decision checkboxes remain unchecked and the policy gate remains **NOT APPROVED**.
