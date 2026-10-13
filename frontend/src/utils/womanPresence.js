// Pure helpers for the woman-presence verification step.
// Kept free of React/DOM so the logic is unit-testable in isolation.

export const VERIFICATION_QUESTION =
  "Will a woman be present at home throughout the cooking service?";

export const YES_LABEL = "Yes, a woman will be present throughout the service.";
export const NO_LABEL = "No, a woman will not be present throughout the service.";

export const BLOCKED_TITLE = "Booking temporarily unavailable";

export const BLOCKED_BODY =
  "A woman must be present at home throughout the cooking service.\n\n" +
  "Your booking access has been temporarily paused for 1 hour. You can try booking again after the restriction expires.\n\n" +
  "Thank you for understanding. — Cook Mitra";

export const BLOCKED_CODE = "BOOKING_TEMPORARILY_BLOCKED";
export const CONFIRMATION_REQUIRED_CODE = "WOMAN_PRESENCE_CONFIRMATION_REQUIRED";
export const VERIFICATION_UNAVAILABLE_CODE = "BOOKING_VERIFICATION_UNAVAILABLE";

// Remaining whole seconds until a server-provided expiry. The server
// timestamp is the source of truth; the browser clock is only used to
// measure the difference.
export const remainingSecondsUntil = (blockedUntil, nowMs = Date.now()) => {
  const until = new Date(blockedUntil).getTime();
  if (!Number.isFinite(until)) return 0;
  return Math.max(0, Math.ceil((until - nowMs) / 1000));
};

// "59:42" style countdown text.
export const formatCountdown = (totalSeconds) => {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
};

export const isBlockedResponse = (data) =>
  data?.blocked === true || data?.code === BLOCKED_CODE;

// Single submit-gate message shared by every booking form.
//
// An explicit answer (YES or NO) enables the Find Cooks action immediately:
//  - YES proceeds to normal booking creation (server re-verifies; a hidden
//    block still 403s into the notice, so there is no bypass).
//  - NO proceeds to decline-recording: the click POSTs the decline, and
//    only the backend-confirmed block stops the flow. Selecting NO alone
//    records nothing and starts no timer.
// The gate still blocks on a KNOWN restriction or an in-flight decline, and
// unanswered forms stay blocked until explicitly answered.
export const presenceGuardMessage = (wp) => {
  if (!wp) return "Checking booking eligibility — one moment…";
  if (wp.legacy) {
    // Compatibility mode (backend predates verification): no server state
    // exists, so an explicit local YES is the whole gate.
    if (wp.presence !== "yes")
      return "Please answer the presence question above to continue.";
    return null;
  }
  if (wp.blocked)
    return "Booking temporarily unavailable — please wait for the restriction to expire.";
  if (wp.busy) return "Recording your response — one moment…";
  if (wp.presence === "yes" || wp.presence === "no") return null;
  if (wp.status !== "ready") return "Checking booking eligibility — one moment…";
  return "Please answer the presence question above to continue.";
};
