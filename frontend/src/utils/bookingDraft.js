// Unfinished-booking draft: remembers where a guest was when the login
// wall interrupted them, so post-login they land back in the flow with
// their filled info intact.
//
// Shapes:
//   { kind: "on-demand", form, selectedSlot, coords, couponCode, savedAt }
//   { kind: "cook-profile", cookId, form, coords, savedAt }

const DRAFT_KEY = "cm-booking-draft-v1";
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const saveBookingDraft = (draft) => {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: Date.now() }));
  } catch {
    // Private mode etc. — resume simply won't happen, booking still works.
  }
};

export const loadBookingDraft = () => {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object" || !d.kind || !d.form) return null;
    if (d.savedAt && Date.now() - d.savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    return d;
  } catch {
    return null;
  }
};

export const clearBookingDraft = () => {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
};

// Only same-app relative paths may be used as post-login targets —
// anything else (absolute URLs, //host, non-strings) is rejected so the
// `next` param can never become an open redirect.
export const safeNextPath = (v) =>
  typeof v === "string" && v.startsWith("/") && !v.startsWith("//") ? v : null;
