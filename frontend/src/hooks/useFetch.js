import { useState, useEffect, useCallback } from "react";
import API from "../api/axios";

export const useFetch = (url) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const response = await API.get(url);
      const payload = response.data;
      // Tolerate the paginated envelope ({data, pagination}) so list screens
      // keep working if ?page/limit is ever sent — today the API returns
      // bare arrays and this is a no-op.
      setData(
        payload && typeof payload === "object" && !Array.isArray(payload) && Array.isArray(payload.data)
          ? payload.data
          : payload
      );
      setError(null);
    } catch (err) {
      // Backend down / timed out: surface a clear message, never hang.
      if (err.code === "ECONNABORTED") {
        setError("Server is taking too long to respond — is the backend running?");
      } else if (!err.response) {
        setError("Cannot reach the server — is the backend running?");
      } else {
        setError(err.response?.data?.message || "An error occurred");
      }
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
};
