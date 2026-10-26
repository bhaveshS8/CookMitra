import { useState, useEffect } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { EVENT_SERVICE_LABEL } from "../utils/eventConstants";
import { BadgeIndianRupee, Clock3, IndianRupee, MapPinned, Save, ShieldCheck, Sparkles, Truck } from "lucide-react";

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
    if (saving) return;
    setSaving(true);
    try {
      // Coerce to numbers before sending — reject empty/invalid cells instead
      // of silently saving them as ₹0 (Number("") === 0).
      const servicePrices = {};
      for (const svc of SERVICES) {
        servicePrices[svc] = {};
        for (const dk of Object.keys(DURATION_LABELS)) {
          const raw = pricing?.servicePrices?.[svc]?.[dk];
          if (raw === "" || raw == null) {
            showToast(`Missing price: ${EVENT_SERVICE_LABEL(svc)} / ${DURATION_LABELS[dk]}`, "error");
            setSaving(false);
            return;
          }
          const v = Number(raw);
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
        const raw = pricing?.extraHourPrices?.[svc];
        if (raw === "" || raw == null) {
          showToast(`Missing extra-hour price: ${EVENT_SERVICE_LABEL(svc)}`, "error");
          setSaving(false);
          return;
        }
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0) {
          showToast(`Invalid extra-hour price: ${EVENT_SERVICE_LABEL(svc)}`, "error");
          setSaving(false);
          return;
        }
        extraHourPrices[svc] = Math.round(v);
      }
      if (pricing?.additionalCookPrice === "" || pricing?.additionalCookPrice == null) {
        showToast("Missing additional-cook price", "error");
        setSaving(false);
        return;
      }
      const addCook = Number(pricing.additionalCookPrice);
      if (!Number.isFinite(addCook) || addCook < 0) {
        showToast("Invalid additional-cook price", "error");
        setSaving(false);
        return;
      }
      const travelSlabs = (pricing?.travelSlabs || []).map((s) => ({
        // Empty "up to" on the last row means unlimited — send a large
        // sentinel the backend accepts as the final slab (>= 1000000).
        maxKm: s.maxKm == null || s.maxKm === "" ? 999999999 : Number(s.maxKm),
        charge: Number(s.charge),
      }));
      for (const s of travelSlabs) {
        if (!Number.isFinite(s.maxKm) || !Number.isFinite(s.charge) || s.charge < 0) {
          showToast("Each travel slab needs a valid maxKm and non-negative charge", "error");
          setSaving(false);
          return;
        }
      }
      const res = await API.put("/event-pricing", {
        servicePrices,
        additionalCookPrice: Math.round(addCook),
        extraHourPrices,
        travelSlabs,
      });
      setPricing(res.data);
      showToast("Event pricing updated!", "success");
    } catch (err) {
      // 409 = another admin saved concurrently (optimistic concurrency) —
      // reload so the next edit starts from the latest table.
      if (err.response?.status === 409) {
        showToast(`${err.response?.data?.message || "Conflict"} Reloading latest pricing…`, "error");
        try {
          const fresh = await API.get("/event-pricing");
          setPricing(fresh.data);
        } catch {
          // keep current table on refetch failure
        }
      } else {
        showToast(err.response?.data?.message || "Save failed", "error");
      }
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

  if (!pricing) return <p className="epm-unavailable">Pricing unavailable.</p>;

  return (
    <div className="event-admin epm">
      <header className="epm-hero">
        <span className="epm-hero-icon" aria-hidden="true">
          <BadgeIndianRupee size={22} />
        </span>
        <div className="epm-hero-copy">
          <p className="epm-eyebrow">Pricing control</p>
          <h2 className="epm-title">Event Pricing</h2>
          <p className="epm-sub">
            All prices editable here — the booking flow reads this table, nothing is hard-coded.
          </p>
        </div>
        <ul className="epm-hero-facts">
          <li>
            <ShieldCheck size={15} /> Live in booking flow
          </li>
          <li>
            <IndianRupee size={15} /> Rounded to rupees
          </li>
        </ul>
      </header>

      <section className="epm-section" aria-labelledby="epm-hourly-title">
        <div className="epm-section-head">
          <span className="epm-section-icon" aria-hidden="true">
            <Clock3 size={18} />
          </span>
          <div>
            <h3 id="epm-hourly-title">Hourly Service Prices (₹)</h3>
            <p>Per-event service charge by duration and service type.</p>
          </div>
        </div>

        <div className="epm-table-wrap">
          <table className="epm-table">
            <thead>
              <tr>
                <th scope="col">Duration</th>
                {SERVICES.map((s) => (
                  <th scope="col" key={s}>
                    {EVENT_SERVICE_LABEL(s)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(DURATION_LABELS).map(([dk, label]) => (
                <tr key={dk}>
                  <th scope="row">{label}</th>
                  {SERVICES.map((s) => (
                    <td key={s} data-label={EVENT_SERVICE_LABEL(s)}>
                      <input
                        type="number"
                        min={0}
                        inputMode="numeric"
                        className="form-control epm-input"
                        value={pricing?.servicePrices?.[s]?.[dk] ?? ""}
                        onChange={(e) => setServicePrice(s, dk, e.target.value)}
                        aria-label={`${EVENT_SERVICE_LABEL(s)} price for ${label}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="epm-section" aria-labelledby="epm-extra-title">
        <div className="epm-section-head">
          <span className="epm-section-icon" aria-hidden="true">
            <Sparkles size={18} />
          </span>
          <div>
            <h3 id="epm-extra-title">Additional Charges (₹)</h3>
            <p>Extra cook and overtime rates added on top of the service price.</p>
          </div>
        </div>

        <div className="epm-charge-grid">
          <div className="epm-field epm-field--highlight">
            <label htmlFor="epm-additional-cook">Per Additional Cook</label>
            <input
              id="epm-additional-cook"
              type="number"
              min={0}
              inputMode="numeric"
              className="form-control"
              value={pricing.additionalCookPrice ?? ""}
              onChange={(e) => setPricing((p) => ({ ...p, additionalCookPrice: e.target.value }))}
            />
          </div>
          {SERVICES.map((s) => (
            <div className="epm-field" key={s}>
              <label htmlFor={`epm-extra-${s}`}>
                Extra Hour · {EVENT_SERVICE_LABEL(s)}
              </label>
              <input
                id={`epm-extra-${s}`}
                type="number"
                min={0}
                inputMode="numeric"
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
      </section>

      <section className="epm-section" aria-labelledby="epm-travel-title">
        <div className="epm-section-head">
          <span className="epm-section-icon" aria-hidden="true">
            <Truck size={18} />
          </span>
          <div>
            <h3 id="epm-travel-title">Travel Charges (₹ by distance)</h3>
            <p>Distance slabs checked against the verified cook-to-venue distance.</p>
          </div>
        </div>

        <div className="epm-travel-grid">
          {(pricing.travelSlabs || []).map((s, i) => (
            <div className="epm-travel-card" key={i}>
              <div className="epm-travel-head">
                <MapPinned size={15} />
                <span>Slab {i + 1}</span>
              </div>
              <div className="epm-field">
                <label htmlFor={`epm-slab-km-${i}`}>
                  Up to (km){Number(s.maxKm) > 1000000 ? " — 20+ km slab" : ""}
                </label>
                <input
                  id={`epm-slab-km-${i}`}
                  type="number"
                  min={0}
                  inputMode="numeric"
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
              <div className="epm-field">
                <label htmlFor={`epm-slab-charge-${i}`}>Charge (₹)</label>
                <input
                  id={`epm-slab-charge-${i}`}
                  type="number"
                  min={0}
                  inputMode="numeric"
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
        </div>
      </section>

      <div className="epm-savebar">
        <p className="epm-savebar-note">
          <ShieldCheck size={15} /> Changes apply to new bookings immediately after saving.
        </p>
        <button type="button" className="btn btn-primary epm-save" disabled={saving} onClick={handleSave}>
          <Save size={16} />
          {saving ? "Saving..." : "Save Event Pricing"}
        </button>
      </div>
    </div>
  );
};

export default EventPricingManager;
