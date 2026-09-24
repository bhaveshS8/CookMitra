import { useEffect, useState } from "react";
import API from "../api/axios";

// Signed document URLs (P0-2). Private docs (aadhar_*/pan_*) are served via
// short-lived single-purpose tokens minted by POST /api/docs/signed-url
// (Authorization header — the session JWT never goes in a URL). Public
// profile photos (photo_*) stay bare.
const cache = new Map(); // storedPath -> { url, exp }
const CACHE_MS = 4 * 60 * 1000;

export const isPrivateDocPath = (url) => {
  if (!url || /^https?:\/\//i.test(url)) return false;
  if (!url.startsWith("/uploads")) return false;
  const base = String(url).split("/").pop().split("?")[0];
  return /^(aadhar_|pan_)/i.test(base);
};

export const resolvePublicFileUrl = (url) => {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return url;
};

export const requestSignedDocUrl = async (storedPath) => {
  if (!storedPath) return "";
  if (!isPrivateDocPath(storedPath)) return storedPath;
  const now = Date.now();
  const hit = cache.get(storedPath);
  if (hit && hit.exp > now + 30 * 1000) return hit.url;
  const res = await API.post("/docs/signed-url", { doc: storedPath });
  const url = res.data?.url || "";
  const expiresAt = res.data?.expiresAt ? Date.parse(res.data.expiresAt) : now + CACHE_MS;
  if (url) cache.set(storedPath, { url, exp: Math.min(expiresAt, now + CACHE_MS) });
  return url;
};

export const useSignedDocUrl = (storedPath) => {
  const [url, setUrl] = useState(() =>
    storedPath && !isPrivateDocPath(storedPath) ? storedPath : ""
  );
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(() => isPrivateDocPath(storedPath));
  useEffect(() => {
    let alive = true;
    if (!storedPath) {
      setUrl("");
      setError("");
      setLoading(false);
      return undefined;
    }
    if (!isPrivateDocPath(storedPath)) {
      setUrl(storedPath);
      setError("");
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    setError("");
    requestSignedDocUrl(storedPath)
      .then((u) => {
        if (!alive) return;
        if (!u) setError("Document link unavailable — please refresh.");
        setUrl(u || "");
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setError(
          err.response?.data?.message || "Authentication required to view this document"
        );
        setUrl("");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [storedPath]);
  return { url, loading, error };
};
