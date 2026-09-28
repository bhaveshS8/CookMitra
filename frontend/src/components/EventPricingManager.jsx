import { useState, useEffect } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { EVENT_SERVICE_LABEL } from "../utils/eventConstants";

const DURATION_LABELS = {
  upto2: "Up to 2 Hours",
  slot_2_3: "2–3 Hours",
  slot_3_4: "3–4 Hours",
  slot_4_5: "4–5 Hours",
  slot_5_6: "5–6 Hours",
  slot_6_7: "6–7 Hours",
  slot_7_8: "7–8 Hours",
};

const SERVICES = ["cooking_only", "preparation_cooking", "cooking_serving"];

// Admin: edit every event price (§16) — hourly service prices, additional
// cook price, extra-hour prices, travel slabs. Never hard-coded.
const EventPricingManager = () => {
  const showToast = useShowToast();
  const [pricing, setPricing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    API.get("/event-pricing")
      .then((res) => {
        if (!cancelled) setPricing(res.data);
      })
      .catch(() => {
        if (!cancelled) showToast("Could not load event pricing", "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  const setServicePrice = (svc, dk, value) => {
    setPricing((p) => ({
      ...p,
      servicePrices: { ...p.servicePrices, [svc]: { ...p.servicePrices?.[svc], [dk]: value } },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Coerce to numbers before sending.
      const servicePrices = {};
      for (const svc of SERVICES) {
        servicePrices[svc] = {};
        for (const dk of Object.keys(DURATION_LABELS)) {
          const v = Number(pricing?.servicePrices?.[svc]?.[dk]);
          if (!Number.isFinite(v) || v < 0) {
            showToast(`Invalid price: ${EVENT_SERVICE_LABEL(svc)} / ${DURATION_LABELS[dk]}`, "error");
            setSaving(false);
            return;
          }
          servicePrices[svc][dk] = Math.round(v);
        }
      }
      const extraHourPrices = {};
      for (const svc of SERVICES) {
        const v = Number(pricing?.extraHourPrices?.[svc]);
        if (!Number.isFinite(v) || v < 0) {
          showToast(`Invalid extra-hour price: ${EVENT_SERVICE_LABEL(svc)}`, "error");
          setSaving(false);
          return;
        }
        extraHourPrices[svc] = Math.round(v);
      }
      const travelSlabs = (pricing?.travelSlabs || []).map((s) => ({
        maxKm: s.maxKm == null || s.maxKm === "" ? 999999 : Number(s.maxKm),
        charge: Number(s.charge),
      }));
      const res = await API.put("/event-pricing", {
        servicePrices,
        additionalCookPrice: Number(pricing.additionalCookPrice),
        extraHourPrices,
        travelSlabs,
      });
      setPricing(res.data);
      showToast("Event pricing updated!", "success");
    } catch (err) {
      showToast(err.response?.data?.message || "Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="loading-spinner-wrapper">
        <div className="spinner"></div>
        <p>Loading event pricing...</p>
      </div>
    );
  }

  if (!pricing) return <p style={{ color: "var(--slate-500)" }}>Pricing unavailable.</p>;

  return (
    <div className="event-admin">
      <h2 style={{ fontSize: "1.4rem", marginBottom: "0.4rem" }}>Event Pricing</h2>
      <p style={{ color: "var(--slate-600)", margin: "0 0 1.25rem", fontSize: "0.92rem" }}>
        All prices editable here — the booking flow reads this table, nothing is hard-coded.
      </p>

      <h3 style={{ fontSize: "1.05rem" }}>Hourly Service Prices (₹)</h3>
      <div style={{ overflowX: "auto", marginBottom: "1.25rem" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem", background: "#fff", borderRadius: 10, overflow: "hidden", border: "1px solid var(--border-subtle)" }}>
          <thead style={{ background: "var(--slate-50)" }}>
            <tr>
              <th style={{ padding: "0.7rem", textAlign: "left" }}>Duration</th>
              {SERVICES.map((s) => (
                <th key={s} style={{ padding: "0.7rem", textAlign: "left" }}>{EVENT_SERVICE_LABEL(s)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(DURATION_LABELS).map(([dk, label]) => (
              <tr key={dk} style={{ borderTop: "1px solid var(--slate-100)" }}>
                <td style={{ padding: "0.6rem", fontWeight: 700 }}>{label}</td>
                {SERVICES.map((s) => (
                  <td key={s} style={{ padding: "0.4rem" }}>
                    <input
                      type="number"
                      min={0}
                      className="form-control"
                      style={{ maxWidth: 120 }}
                      value={pricing?.servicePrices?.[s]?.[dk] ?? ""}
                      onChange={(e) => setServicePrice(s, dk, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: "1.05rem" }}>Additional Charges (₹)</h3>
      <div className="form-row" style={{ maxWidth: 720 }}>
        <div className="form-group">
          <label>Per Additional Cook</label>
          <input
            type="number"
            min={0}
            className="form-control"
            value={pricing.additionalCookPrice ?? ""}
            onChange={(e) => setPricing((p) => ({ ...p, additionalCookPrice: e.target.value }))}
          />
        </div>
        {SERVICES.map((s) => (
          <div className="form-group" key={s}>
            <label>Extra Hour · {EVENT_SERVICE_LABEL(s)}</label>
            <input
              type="number"
              min={0}
              className="form-control"
              value={pricing?.extraHourPrices?.[s] ?? ""}
              onChange={(e) =>
                setPricing((p) => ({
                  ...p,
                  extraHourPrices: { ...p.extraHourPrices, [s]: e.target.value },
                }))
              }
            />
          </div>
        ))}
      </div>

      <h3 style={{ fontSize: "1.05rem", marginTop: "1rem" }}>Travel Charges (₹ by distance)</h3>
      {(pricing.travelSlabs || []).map((s, i) => (
        <div className="form-row" key={i} style={{ maxWidth: 520 }}>
          <div className="form-group">
            <label>Up to (km){Number(s.maxKm) > 1000000 ? " — 20+ km slab" : ""}</label>
            <input
              type="number"
              min={0}
              className="form-control"
              value={Number(s.maxKm) > 1000000 ? "" : s.maxKm}
              placeholder="∞ (last slab)"
              onChange={(e) => {
                const v = e.target.value === "" ? 999999999 : Number(e.target.value);
                setPricing((p) => {
                  const slabs = [...(p.travelSlabs || [])];
                  slabs[i] = { ...slabs[i], maxKm: v };
                  return { ...p, travelSlabs: slabs };
                });
              }}
            />
          </div>
          <div className="form-group">
            <label>Charge (₹)</label>
            <input
              type="number"
              min={0}
              className="form-control"
              value={s.charge}
              onChange={(e) => {
                const v = e.target.value;
                setPricing((p) => {
                  const slabs = [...(p.travelSlabs || [])];
                  slabs[i] = { ...slabs[i], charge: v };
                  return { ...p, travelSlabs: slabs };
                });
              }}
            />
          </div>
        </div>
      ))}

      <button className="btn btn-primary" disabled={saving} onClick={handleSave} style={{ marginTop: "1rem" }}>
        {saving ? "Saving..." : "Save Event Pricing"}
      </button>
    </div>
  );
};

export default EventPricingManager;
