import React, { useState } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { ShieldAlert, CheckCircle2, AlertCircle, Send } from "lucide-react";

// Cook reports an issue about a customer. Filed against a booking (the
// customer is derived server-side from the cook's own booking) so the cook
// never types ids by hand.
// Props: bookingId (required), customerName (optional, shown in the title),
// onSubmitted(complaint) — optional callback after a successful filing.
const CATEGORIES = [
  { value: "behaviour", label: "Rude / uncooperative behaviour" },
  { value: "payment", label: "Payment issue" },
  { value: "address", label: "Wrong / unreachable address" },
  { value: "no_show", label: "Customer not available" },
  { value: "safety", label: "Safety concern" },
  { value: "other", label: "Something else" },
];

const ComplaintForm = ({ bookingId, customerName, onSubmitted }) => {
  const showToast = useShowToast();
  const [category, setCategory] = useState("behaviour");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [filed, setFiled] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const text = message.trim();
    if (text.length < 10) {
      const msg = "Please describe the issue in at least 10 characters";
      setError(msg);
      showToast(msg, "error");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await API.post("/complaints", {
        booking: bookingId,
        category,
        message: text,
      });
      setFiled(res.data);
      setMessage("");
      showToast("Complaint sent — our team will review it.", "success");
      onSubmitted?.(res.data);
    } catch (err) {
      const msg = err.response?.data?.message || "Could not file complaint";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  if (filed) {
    return (
      <div className="bd-banner ok" style={{ marginBottom: 0 }}>
        <CheckCircle2 size={18} />
        <span>
          Complaint filed{customerName ? ` about ${customerName}` : ""} — our team will review it and get back to you.
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit}>
      <div className="cook-field">
        <label htmlFor="complaint-category">What happened?</label>
        <select
          id="complaint-category"
          className="form-control"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          disabled={saving}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="cook-field">
        <label htmlFor="complaint-message">
          Describe the issue{customerName ? ` with ${customerName}` : ""}
        </label>
        <textarea
          id="complaint-message"
          className="form-control"
          rows={4}
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
            setError("");
          }}
          placeholder="What happened, when, and anything the admin should know…"
          disabled={saving}
          maxLength={2000}
        />
      </div>
      {error && (
        <div className="error-alert-banner" style={{ marginBottom: "0.75rem" }}>
          <AlertCircle size={16} /> {error}
        </div>
      )}
      <button type="submit" className="btn btn-primary btn-sm" disabled={saving || message.trim().length < 10}>
        <Send size={15} /> {saving ? "Sending…" : "Send complaint to admin"}
      </button>
      <p className="bd-mini-note" style={{ marginTop: "0.5rem" }}>
        <ShieldAlert size={13} style={{ display: "inline", verticalAlign: "-2px" }} /> Only our admin
        team sees this — never the customer.
      </p>
    </form>
  );
};

export default ComplaintForm;
