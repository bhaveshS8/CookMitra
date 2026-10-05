
const DRAFT_KEY = "cm-booking-draft-v1";
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const saveBookingDraft = (draft) => {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: Date.now() }));
  } catch {
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
  }
};

export const safeNextPath = (v) =>
  typeof v === "string" && v.startsWith("/") && !v.startsWith("//") ? v : null;
