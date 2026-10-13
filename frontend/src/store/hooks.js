import { useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import { showToast } from "./toastSlice";

export const useShowToast = () => {
  const dispatch = useDispatch();
  return useCallback(
    (message, type, duration) => dispatch(showToast(message, type, duration)),
    [dispatch]
  );
};

export const useAuthUser = () => useSelector((s) => s.auth.user);
export const useAuthLoading = () => useSelector((s) => s.auth.loading);

export const useSiteLocation = () => {
  const location = useSelector((s) => s.location.location);
  const status = useSelector((s) => s.location.status);
  const error = useSelector((s) => s.location.error);
  return { location, status, error, isLocating: status === "locating" };
};
