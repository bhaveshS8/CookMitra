import { useEffect, useState } from "react";
import { localTodayStr } from "../utils/constants";

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