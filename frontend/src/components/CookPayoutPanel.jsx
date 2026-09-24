import React, { useState } from "react";
import API from "../api/axios";
import { useFetch } from "../hooks/useFetch";
import { useShowToast } from "../store/hooks";
import { formatCurrency, formatDate } from "../utils/constants";
import { Wallet, IndianRupee, Save, Clock3, CheckCircle2 } from "lucide-react";

// Cook-facing payouts: where the 75% should be sent (UPI id / bank last-4)
// and a live statement of what has been settled vs is still pending. The
// actual transfer happens offline; this panel keeps both sides honest.
const CookPayoutPanel = () => {
  const showToast = useShowToast();
  const { data, loading, refetch } = useFetch("/payouts/statement/me");
  const details = data?.payoutDetails || {};
  const [form, setForm] = useState({
    method: details.method || "",
    upiId: details.upiId || "",
    holderName: details.holderName || "",
    bankName: details.bankName || "",
    accountLast4: details.accountLast4 || "",
    ifsc: details.ifsc || "",
    note: details.note || "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  const handleSave = async (e) => {
    e.preventDefault();
    const f = form;
    if (!["upi", "bank"].includes(f.method)) {
      showToast("Choose UPI or bank transfer first", "error");
      return;
    }
    // Client-side mirror of the server format rules (the server re-validates;
    // this just fails fast with a clear message).
    if (f.method === "upi" && !/^[\w.-]{2,256}@[a-zA-Z]{2,64}$/.test(f.upiId.trim())) {
      showToast("Enter a valid UPI id (name@bank)", "error");
      return;
    }
    if (f.method === "upi" && !f.upiId.trim()) {
      showToast("Enter your UPI id", "error");
      return;
    }
    if (f.method === "bank" && (!f.accountLast4.trim() || !/^\d{4}$/.test(f.accountLast4.trim()))) {
      showToast("Enter the last 4 digits of your account number", "error");
      return;
    }
    if (f.method === "bank" && !/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(f.ifsc.trim())) {
      showToast("Enter a valid 11-character IFSC code", "error");
      return;
    }
    if (f.method === "bank" && !f.holderName.trim()) {
      showToast("Enter the account holder name", "error");
      return;
    }
    setSaving(true);
    try {
      await API.put("/cooks/me", { payoutDetails: { ...f, accountLast4: f.accountLast4.trim().slice(-4) } });
      showToast("Payout details saved — our team settles to these.", "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Could not save payout details", "error");
    } finally {
      setSaving(false);
    }
  };

  const st = data?.statement;
  return (
    <div className="cook-card cook-spaced-top">
      <h3 style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
        <Wallet size={18} /> My payouts
      </h3>
      {loading ? (
        <p className="cook-loading-text">Loading your payouts…</p>
      ) : (
        <>
          {st && (
            <div className="cook-stats-row" style={{ display: "flex", flexWrap: "wrap", gap: "1rem", marginBottom: "1rem" }}>
              <div className="cook-stat">
                <span className="cook-stat-label">Total earned (75%)</span>
                <strong>{formatCurrency(st.earnings)}</strong>
              </div>
              <div className="cook-stat">
                <span className="cook-stat-label"><CheckCircle2 size={12} /> Settled</span>
                <strong>{formatCurrency(st.settled)}</strong>
              </div>
              <div className="cook-stat">
                <span className="cook-stat-label"><Clock3 size={12} /> Pending ({st.pendingCount})</span>
                <strong>{formatCurrency(st.pending)}</strong>
              </div>
            </div>
          )}
          {data?.payouts?.length > 0 && (
            <div style={{ marginBottom: "1rem" }}>
              {data.payouts.slice(0, 5).map((p) => (
                <p key={p._id} className="bd-mini-note" style={{ margin: "0.2rem 0", overflowWrap: "anywhere" }}>
                  <IndianRupee size={11} style={{ display: "inline", verticalAlign: "-2px" }} />{" "}
                  {formatCurrency(p.amount)} sent {p.settledAt ? formatDate(p.settledAt) : ""} · Ref {p.reference}
                </p>
              ))}
            </div>
          )}
          <form onSubmit={handleSave}>
            <div className="cook-field">
              <label>Where should we send your 75% share?</label>
              <select className="form-control" value={form.method} onChange={set("method")}>
                <option value="">Choose…</option>
                <option value="upi">UPI</option>
                <option value="bank">Bank transfer</option>
              </select>
            </div>
            {form.method === "upi" && (
              <div className="cook-field">
                <label htmlFor="payout-upi">UPI id</label>
                <input id="payout-upi" className="form-control" value={form.upiId} onChange={set("upiId")} placeholder="name@upi" />
              </div>
            )}
            {form.method === "bank" && (
              <>
                <div className="cook-field">
                  <label htmlFor="payout-holder">Account holder name</label>
                  <input id="payout-holder" className="form-control" value={form.holderName} onChange={set("holderName")} />
                </div>
                <div className="cook-field">
                  <label htmlFor="payout-bank">Bank name</label>
                  <input id="payout-bank" className="form-control" value={form.bankName} onChange={set("bankName")} />
                </div>
                <div className="cook-field">
                  <label htmlFor="payout-last4">Account last 4 digits (only these are stored)</label>
                  <input id="payout-last4" className="form-control" maxLength={4} inputMode="numeric" value={form.accountLast4} onChange={set("accountLast4")} />
                </div>
                <div className="cook-field">
                  <label htmlFor="payout-ifsc">IFSC code</label>
                  <input id="payout-ifsc" className="form-control" value={form.ifsc} onChange={set("ifsc")} />
                </div>
              </>
            )}
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
              <Save size={15} /> {saving ? "Saving…" : "Save payout details"}
            </button>
          </form>
        </>
      )}
    </div>
  );
};

export default CookPayoutPanel;
