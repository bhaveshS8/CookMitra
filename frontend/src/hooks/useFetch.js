import { useState, useEffect, useCallback, useRef } from "react";
import API from "../api/axios";

export const useFetch = (url) => {
  const [data, setData] = useState(null);
  // `loading`    — true only on the very first fetch (no data in hand yet).
  //                Consumers can gate "Loading…" spinners on this without
  //                hiding already-rendered data on every background poll.
  // `refreshing` — true on every re-fetch (including background polls).
  //                Use for a subtle "syncing" indicator if desired; the list
  //                stays visible, so the UI never flashes blank.
  const [loading, setLoading] = useState(Boolean(url));
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
  const hasDataRef = useRef(false);

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
