import { useEffect, useState } from "react";
import { localTodayStr } from "../utils/constants";

// Returns the local calendar day as YYYY-MM-DD and re-renders the caller
// whenever it changes (midnight roll-over). Checked every 30s; the state
// update is a no-op re-render only when the day actually flips, so
// "Today"/"Tomorrow" badges stay correct on long-lived screens even when
// data polling is paused (hidden tab, etc.).
export const useLocalDay = () => {
  const [today, setToday] = useState(localTodayStr());
  useEffect(() => {
    const id = setInterval(() => {
      const t = localTodayStr();
      setToday((prev) => (prev === t ? prev : t));
    }, 30 * 1000);
    return () => clearInterval(id);
  }, []);
  return today;
};