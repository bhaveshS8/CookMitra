import React from "react";
import { useDispatch, useSelector } from "react-redux";
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from "lucide-react";
import { removeToast } from "../store/toastSlice";

const getIcon = (type) => {
  switch (type) {
    case "success":
      return <CheckCircle2 className="toast-icon success" size={20} />;
    case "error":
      return <AlertCircle className="toast-icon error" size={20} />;
    case "warning":
      return <AlertTriangle className="toast-icon warning" size={20} />;
    default:
      return <Info className="toast-icon info" size={20} />;
  }
};

const Toasts = () => {
  const toasts = useSelector((s) => s.toast.toasts);
  const dispatch = useDispatch();

  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast-item toast-${toast.type}`}>
          <div className="toast-content">
            {getIcon(toast.type)}
            <span className="toast-message">{toast.message}</span>
          </div>
          <button
            onClick={() => dispatch(removeToast(toast.id))}
            className="toast-close-btn"
            aria-label="Close notification"
          >
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
};

export default Toasts;
