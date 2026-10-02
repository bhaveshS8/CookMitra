import { useState, useEffect, useCallback, useRef } from "react";
import API, { getStoredToken } from "../api/axios";

// ---------------------------------------------------------------------------
// Session-scoped response cache (stale-while-revalidate).
//
// Dashboard tabs mount and unmount constantly (an admin switching between
// Platform Bookings / Cook Approvals / User Directory, or leaving the page and
// coming back). Without a cache every remount starts blank and flashes the
// first-load "Loading…" spinner for data we fetched seconds ago. Mirroring each
// successful response here lets a remount paint the last known list instantly
// and then revalidate in the background — the booking cards never blink away.
//
// Keys are namespaced by the auth token as well as the URL, so switching
// accounts (or logging out) can never surface one user's cached rows to
// another. It is small, LRU-evicted and in-memory only (cleared on reload).
// ---------------------------------------------------------------------------
const CACHE_LIMIT = 80;
const responseCache = new Map();

const cacheKeyFor = (url) => `${getStoredToken() || "anon"}::${url}`;

const cacheGet = (url) => {
  if (!url) return undefined;
  const key = cacheKeyFor(url);
  if (!responseCache.has(key)) return undefined;
  // Bump recency so hot URLs survive eviction.
  const value = responseCache.get(key);
  responseCache.delete(key);
  responseCache.set(key, value);
  return value;
};

const cacheSet = (url, value) => {
  if (!url) return;
  const key = cacheKeyFor(url);
  if (responseCache.has(key)) responseCache.delete(key);
  responseCache.set(key, value);
  while (responseCache.size > CACHE_LIMIT) {
    responseCache.delete(responseCache.keys().next().value);
  }
};

// Exposed for logout / role-switch flows that want a hard reset.
export const clearFetchCache = () => responseCache.clear();

export const useFetch = (url) => {
  // Seed the very first render from the session cache so a remount paints the
  // list we already had (no "Loading…" flash) and then revalidates quietly.
  // The sentinel object makes "resolved, but no cache entry" distinguishable
  // from "not resolved yet", so the lookup runs exactly once.
  const seedRef = useRef(null);
  if (seedRef.current === null) {
    seedRef.current = { value: cacheGet(url) };
  }
  const hasSeed = seedRef.current.value !== undefined;

  const [data, setData] = useState(hasSeed ? seedRef.current.value : null);
  // `loading`    — true only on the very first fetch (no data in hand yet).
  //                Consumers can gate "Loading…" spinners on this without
  //                hiding already-rendered data on every background poll.
  // `refreshing` — true on every re-fetch (including background polls).
  //                Use for a subtle "syncing" indicator if desired; the list
  //                stays visible, so the UI never flashes blank.
  const [loading, setLoading] = useState(Boolean(url) && !hasSeed);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // Monotonic request id: only the latest request may write state, so a
  // slow earlier response (e.g. range 7 → 90 → 30) can never overwrite
  // newer data. The AbortController cancels the in-flight HTTP request for
  // the same reason (and on unmount, avoiding set-state-after-unmount).
  const seqRef = useRef(0);
  const abortRef = useRef(null);
  const mountedRef = useRef(true);
  // Track whether we have ever received data so we can distinguish a first
  // load from a background refresh.
  const hasDataRef = useRef(hasSeed);
  // The URL this instance is currently showing, so a changed url can swap in
  // its own cached rows instead of briefly flashing the previous url's data.
  const lastUrlRef = useRef(url);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try {
        abortRef.current?.abort();
      } catch {
        // ignore
      }
    };
  }, []);

  const fetchData = useCallback(async () => {
    // A null url means "do not fetch" — used by tabbed consoles that only
    // load the list for the visible tab. Returns empty state, never an error.
    if (!url) {
      try {
        abortRef.current?.abort();
      } catch {
        // ignore
      }
      if (!mountedRef.current) return;
      setData(null);
      setLoading(false);
      setRefreshing(false);
      setError(null);
      hasDataRef.current = false;
      return;
    }
    // The URL changed within this hook instance (e.g. a filter/range switch):
    // paint that URL's cached rows at once (if we have any) and drop the
    // previous URL's data, so a stale list never shows under a new key.
    if (lastUrlRef.current !== url) {
      lastUrlRef.current = url;
      const cached = cacheGet(url);
      hasDataRef.current = cached !== undefined;
      if (mountedRef.current) {
        setData(cached !== undefined ? cached : null);
        setLoading(cached === undefined);
        setError(null);
      }
    }
    // Cancel any in-flight request (rapid range changes, double-clicked
    // Refresh) so only one request is ever outstanding per hook.
    try {
      abortRef.current?.abort();
    } catch {
      // ignore
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    const isCurrent = () => mountedRef.current && seqRef.current === seq;
    try {
      if (isCurrent()) {
        // First fetch: show the full loading state (no data to display yet).
        // Subsequent fetches: only set refreshing so the existing list stays
        // visible — this is the stale-while-revalidate behaviour.
        if (!hasDataRef.current) {
          setLoading(true);
        }
        setRefreshing(true);
      }
      const response = await API.get(url, { signal: controller.signal });
      if (!isCurrent()) return;
      const payload = response.data;
      // Tolerate the paginated envelope ({data, pagination}) so list screens
      // keep working if ?page/limit is ever sent — today the API returns
      // bare arrays and this is a no-op.
      const normalized =
        payload && typeof payload === "object" && !Array.isArray(payload) && Array.isArray(payload.data)
          ? payload.data
          : payload;
      setData(normalized);
      cacheSet(url, normalized);
      hasDataRef.current = true;
      setError(null);
    } catch (err) {
      if (!isCurrent()) return;
      // Superseded by a newer request — not an error, stay silent.
      if (err?.code === "ERR_CANCELED" || err?.name === "CanceledError" || err?.name === "AbortError") {
        return;
      }
      // Backend down / timed out: surface a clear message, never hang.
      if (err.code === "ECONNABORTED") {
        setError("Server is taking too long to respond — is the backend running?");
      } else if (!err.response) {
        setError("Cannot reach the server — is the backend running?");
      } else {
        setError(err.response?.data?.message || "An error occurred");
      }
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [url]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, refreshing, error, refetch: fetchData };
};
