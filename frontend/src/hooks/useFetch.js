import { useState, useEffect, useCallback, useRef } from "react";
import API, { getStoredToken } from "../api/axios";

const CACHE_LIMIT = 80;
const responseCache = new Map();

const cacheKeyFor = (url) => `${getStoredToken() || "anon"}::${url}`;

const cacheGet = (url) => {
  if (!url) return undefined;
  const key = cacheKeyFor(url);
  if (!responseCache.has(key)) return undefined;
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

export const clearFetchCache = () => responseCache.clear();

export const useFetch = (url) => {
  const seedRef = useRef(null);
  if (seedRef.current === null) {
    seedRef.current = { value: cacheGet(url) };
  }
  const hasSeed = seedRef.current.value !== undefined;

  const [data, setData] = useState(hasSeed ? seedRef.current.value : null);
  const [loading, setLoading] = useState(Boolean(url) && !hasSeed);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const seqRef = useRef(0);
  const abortRef = useRef(null);
  const mountedRef = useRef(true);
  const hasDataRef = useRef(hasSeed);
  const lastUrlRef = useRef(url);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      try {
        abortRef.current?.abort();
      } catch {
      }
    };
  }, []);

  const fetchData = useCallback(async () => {
    if (!url) {
      try {
        abortRef.current?.abort();
      } catch {
      }
      if (!mountedRef.current) return;
      setData(null);
      setLoading(false);
      setRefreshing(false);
      setError(null);
      hasDataRef.current = false;
      return;
    }
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
    try {
      abortRef.current?.abort();
    } catch {
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    const isCurrent = () => mountedRef.current && seqRef.current === seq;
    try {
      if (isCurrent()) {
        if (!hasDataRef.current) {
          setLoading(true);
        }
        setRefreshing(true);
      }
      const response = await API.get(url, { signal: controller.signal });
      if (!isCurrent()) return;
      const payload = response.data;
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
      if (err?.code === "ERR_CANCELED" || err?.name === "CanceledError" || err?.name === "AbortError") {
        return;
      }
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
