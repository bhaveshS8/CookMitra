import { useCallback, useEffect, useRef, useState } from "react";
import API from "../api/axios";
import { remainingSecondsUntil } from "./womanPresence";

// Client-side bound for the eligibility check: the backend answers in ~ms
// when healthy (5s server bound), so anything slower is a stall — surface
// retry instead of an endless spinner. Submit stays blocked until resolved
// (fail-closed); only the waiting experience changes, never the rule.
export const STATUS_TIMEOUT_MS = 8000;
// Bound for the decline-recording POST behind the Find Cooks click. On
// timeout/failure the status endpoint is re-read before concluding, so a
// decline that landed server-side is never reported as missing.
export const DECLINE_TIMEOUT_MS = 10000;

// Owns the woman-presence verification state for one booking form:
// explicit answer (unselected by default), server restriction, countdown
// clock, and in-flight guards. The backend is authoritative — this hook
// never unlocks booking on a browser timer alone.
export const useWomanPresence = (user, onRequireLogin) => {
  const [presence, setPresence] = useState(null); // null | "yes" | "no"
  const [restriction, setRestriction] = useState(null); // { blockedUntil } | null
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [busy, setBusy] = useState(false); // decline POST in flight
  const [error, setError] = useState("");
  // Compatibility mode: the backend predates the verification endpoints
  // (HTTP 404), so no server lockout exists to enforce. The question then
  // degrades to an explicit local YES requirement — server state is never
  // fabricated (no fake restriction, no fake countdown).
  const [legacy, setLegacy] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const isCustomer = user?.role === "customer";
  // StrictMode-safe mount flag: dev double-invokes effects (mount ->
  // cleanup -> re-run), so the flag must be re-armed on every effect run.
  // The old shape (armed once at init, cleared on cleanup) stayed false
  // forever after the StrictMode remount, silently short-circuiting every
  // submitDecline into { ok:false } with no network request at all.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Synchronous in-flight guard: React state updates are async, so two
  // rapid clicks in the same tick would both see busy=false. The ref flips
  // immediately, guaranteeing exactly one decline POST per selection.
  const declineInFlight = useRef(false);

  const fetchStatus = useCallback(async () => {
    // Guests have no server restriction to restore; the question gates them
    // locally and login is required before any booking request is sent.
    if (!isCustomer) {
      if (mounted.current) {
        setRestriction(null);
        setStatus("ready");
      }
      return;
    }
    if (mounted.current) {
      setStatus("loading");
      setError("");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    try {
      const res = await API.get("/bookings/verification/status", {
        signal: controller.signal,
      });
      if (!mounted.current) return;
      if (res.data?.blocked && res.data?.blockedUntil) {
        setRestriction({ blockedUntil: res.data.blockedUntil });
      } else {
        setRestriction(null);
      }
      setStatus("ready");
    } catch (e) {
      if (!mounted.current) return;
      if (e?.response?.status === 404) {
        // Deployment skew: this backend has no verification endpoints, so
        // there is no server lockout to restore. Enter compatibility mode
        // (explicit local YES) instead of bricking every booking.
        setLegacy(true);
        setRestriction(null);
        setStatus("ready");
        try {
          // eslint-disable-next-line no-console
          console.warn(
            "[woman-presence] verification endpoints missing (404) — compatibility mode until the backend is deployed."
          );
        } catch {
        }
        return;
      }
      const timedOut =
        controller.signal.aborted ||
        e?.code === "ERR_CANCELED" ||
        e?.name === "CanceledError";
      setError(
        timedOut
          ? "Eligibility check timed out. Please retry — booking stays paused until this resolves."
          : "Could not check booking eligibility. Please retry."
      );
      setStatus("error");
    } finally {
      clearTimeout(timer);
    }
  }, [isCustomer]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // 1-second countdown ticks (display only — no endpoint calls per tick).
  useEffect(() => {
    if (!restriction?.blockedUntil) return undefined;
    setNowTick(Date.now());
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [restriction?.blockedUntil]);

  const remaining = restriction
    ? remainingSecondsUntil(restriction.blockedUntil, nowTick)
    : 0;

  // At expiry: revalidate server-side, then require a fresh explicit answer.
  const expired = Boolean(restriction?.blockedUntil) && remaining <= 0;
  useEffect(() => {
    if (!expired) return undefined;
    let cancelled = false;
    (async () => {
      await fetchStatus();
      if (!cancelled && mounted.current) setPresence(null);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expired]);

  // Records the explicit NO behind the Find Cooks click. Selecting NO alone
  // NEVER calls this — the one-hour timer starts only here, when the
  // backend successfully persists the decline. Resolves
  // { ok:true, blockedUntil } or { ok:false, ... } (busy / loginRequired /
  // message). Single-flight: concurrent clicks share one POST and never
  // extend the expiry (the server also preserves active windows).
  const submitDecline = useCallback(async () => {
    if (!isCustomer) {
      onRequireLogin?.();
      return { ok: false, loginRequired: true };
    }
    if (restriction) {
      return { ok: true, blockedUntil: restriction.blockedUntil, already: true };
    }
    if (legacy) {
      // Compatibility mode has nowhere to record a decline — require YES.
      const msg = "Booking requires an explicit YES confirmation to proceed.";
      if (mounted.current) setError(msg);
      return { ok: false, message: msg };
    }
    if (busy || declineInFlight.current) return { ok: false, busy: true };
    declineInFlight.current = true;
    if (mounted.current) {
      setBusy(true);
      setError("");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DECLINE_TIMEOUT_MS);
    try {
      const res = await API.post("/bookings/verification/decline", {}, { signal: controller.signal });
      if (!mounted.current) return { ok: false, unmounted: true };
      if (res.data?.blockedUntil) {
        setRestriction({ blockedUntil: res.data.blockedUntil });
        setStatus("ready");
        return { ok: true, blockedUntil: res.data.blockedUntil };
      }
      // No expiry in the response — reconcile via the authoritative status.
      const st = await API.get("/bookings/verification/status");
      if (!mounted.current) return { ok: false, unmounted: true };
      if (st.data?.blocked && st.data?.blockedUntil) {
        setRestriction({ blockedUntil: st.data.blockedUntil });
        setStatus("ready");
        return { ok: true, blockedUntil: st.data.blockedUntil };
      }
      throw new Error("decline not confirmed by the server");
    } catch (e) {
      if (!mounted.current) return { ok: false, unmounted: true };
      if (e?.response?.data?.blockedUntil) {
        setRestriction({ blockedUntil: e.response.data.blockedUntil });
        setStatus("ready");
        return { ok: true, blockedUntil: e.response.data.blockedUntil };
      }
      if (e?.response?.status === 404) {
        // Backend predates the decline endpoint too — same compatibility
        // mode as the status check (explicit local YES, no fabricated block).
        const msg = "Booking requires an explicit YES confirmation to proceed.";
        setLegacy(true);
        setRestriction(null);
        setStatus("ready");
        setError(msg);
        return { ok: false, message: msg };
      }
      // Failure/timeout: revalidate BEFORE concluding — the decline may
      // have landed despite the error. Never assume it did not.
      try {
        const st = await API.get("/bookings/verification/status");
        if (st.data?.blocked && st.data?.blockedUntil) {
          if (mounted.current) {
            setRestriction({ blockedUntil: st.data.blockedUntil });
            setStatus("ready");
          }
          return { ok: true, blockedUntil: st.data.blockedUntil };
        }
      } catch {
      }
      if (!mounted.current) return { ok: false, unmounted: true };
      // Surface the specific cause: backend messages are user-safe by
      // design (e.g. 503 "could not record…", 403 role/account issues),
      // while a missing response means network/timeout. One generic line
      // for everything hides exactly what needs fixing.
      const serverMsg =
        typeof e?.response?.data?.message === "string" ? e.response.data.message.trim() : "";
      const status = e?.response?.status;
      try {
        // eslint-disable-next-line no-console
        console.warn(
          "[woman-presence] decline not recorded:",
          status ? `http-${status}` : e?.code || e?.message || "network-error"
        );
      } catch {
      }
      const msg = serverMsg
        ? serverMsg.slice(0, 220)
        : !e?.response
          ? "No response from the server. Please check your connection and retry — booking stays paused until this resolves."
          : "Could not record your response. Please try again — booking stays paused until this resolves.";
      setError(msg);
      return { ok: false, message: msg, status };
    } finally {
      clearTimeout(timer);
      declineInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [restriction, legacy, busy, isCustomer, onRequireLogin]);

  const selectYes = useCallback(() => {
    if (busy || restriction) return;
    setPresence("yes");
    setError("");
  }, [busy, restriction]);

  const selectNo = useCallback(() => {
    if (busy || restriction) return;
    // Selecting NO alone records nothing and starts no timer. The
    // restriction begins only when Find Cooks is clicked and the backend
    // confirms (submitDecline). Switching back to YES before that leaves
    // the normal flow untouched.
    setPresence("no");
    setError("");
  }, [busy, restriction]);

  // Sync a server-reported block (e.g. 403 from POST /bookings) into the UI.
  const applyServerBlock = useCallback((blockedUntil) => {
    if (blockedUntil && mounted.current) {
      setRestriction({ blockedUntil });
      setStatus("ready");
    }
  }, []);

  return {
    presence,
    restriction,
    status,
    busy,
    error,
    remaining,
    blocked: Boolean(restriction),
    legacy,
    selectYes,
    selectNo,
    submitDecline,
    retryStatus: fetchStatus,
    applyServerBlock,
  };
};
