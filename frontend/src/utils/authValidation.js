const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Strip an optional Indian country/trunk prefix so "+91 98765 43210",
// "919876543210" and "09876543210" all validate as the same 10-digit core.
export const getPhoneCore = (v) => {
  let digits = String(v || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
};

export const normalizeEmail = (v) => String(v || "").trim().toLowerCase();

export const normalizePhone = (v) => {
  const core = getPhoneCore(v);
  // Store the 10-digit core when valid; otherwise keep the trimmed input
  // so validation (not normalization) surfaces the problem.
  if (/^[6-9]\d{9}$/.test(core)) return core;
  return String(v || "").trim();
};

export const validateEmail = (v) => {
  const email = normalizeEmail(v);
  if (!email) return "Email is required";
  if (email.length > 254) return "Email is too long";
  if (!EMAIL_RE.test(email)) return "Enter a valid email address";
  return "";
};

export const validatePhone = (v) => {
  const s = String(v || "").trim();
  if (!s) return "Mobile number is required";
  const core = getPhoneCore(s);
  if (core.length !== 10) return "Mobile number must be exactly 10 digits";
  if (!/^[6-9]\d{9}$/.test(core)) return "Enter a valid 10-digit mobile number";
  return "";
};

export const validateName = (v) => {
  const s = String(v || "").trim();
  if (!s) return "Full name is required";
  if (s.length < 2) return "Name must be at least 2 characters";
  if (s.length > 80) return "Name must be under 80 characters";
  return "";
};

export const validatePassword = (v, { allowEmpty = false } = {}) => {
  const s = String(v || "");
  if (!s) return allowEmpty ? "" : "Password is required";
  if (s.length < 8) return "Password must be at least 8 characters";
  if (s.length > 128) return "Password must be under 128 characters";
  return "";
};

// 0–4 score for the strength meter (length + variety). An 8-char minimum
// passes; this only guides users toward stronger passwords.
export const passwordStrength = (v) => {
  const s = String(v || "");
  let score = 0;
  if (s.length >= 8) score += 1;
  if (s.length >= 10) score += 1;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score += 1;
  if (/\d/.test(s)) score += 1;
  if (/[^A-Za-z0-9]/.test(s)) score += 1;
  return Math.min(score, 4);
};

export const strengthLabel = (score) => ["Too weak", "Weak", "Fair", "Good", "Strong"][score] || "";

// Map axios errors to friendly, actionable form messages.
export const authErrorMessage = (err, fallback) => {
  const status = err?.response?.status;
  const serverMsg = err?.response?.data?.message;
  if (status === 429)
    return "Too many attempts — please wait a few minutes and try again.";
  if (status === 403 && /blocked by an administrator/i.test(serverMsg || ""))
    return serverMsg;
  if (status === 401) return serverMsg || "Invalid email or password. Please try again.";
  // Duplicate email on registration — normalize legacy ("Email already
  // registered") and current wording to one clear message.
  if (/already\s+(registered|exists)/i.test(serverMsg || ""))
    return "Email already exists, please enter another email";
  if (serverMsg) return serverMsg;
  if (err?.code === "ECONNABORTED") return "Request timed out — check your connection and retry.";
  if (err?.message === "Network Error") return "Cannot reach the server — check your connection.";
  return fallback;
};

// Surface express-validator `errors[]` as { field: message } for per-field UI.
// Also handles single-field duplicate responses like
// { field: "email", message: "...", code: "EMAIL_EXISTS" }.
export const fieldErrorsFromResponse = (err) => {
  const data = err?.response?.data;
  const list = data?.errors;
  const out = {};
  if (Array.isArray(list)) {
    for (const e of list) {
      const field = e?.path || e?.param;
      if (field && !out[field]) out[field] = e?.msg;
    }
  }
  if (!Object.keys(out).length && data?.field && data?.message) {
    out[data.field] = data.message;
  }
  return out;
};
