// CouponModal — admin create/edit form for promo coupons.
// Reuses the modal + form styling used by AddCookModal.
import React, { useEffect, useState } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { Tag, X, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";

const toDateInputValue = (d) =>
  d ? new Date(d).toISOString().slice(0, 10) : "";
const numberOrNull = (v) => (v === "" || v == null ? null : Number(v));
const numberOrZero = (v) => (v === "" || v == null ? 0 : Number(v));

const SERVICE_IDS = ["cook_for_me", "cook_with_me", "teach_me", "preparation_help"];

const blankForm = () => ({
  code: "",
  description: "",
  discountType: "flat",
  percent: "",
  flatAmount: "",
  maxDiscount: "",
  minOrder: "0",
  usageLimit: "",
  perUserLimit: "1",
  firstBookingOnly: false,
  applicableServices: "",
  validFrom: "",
  validTo: "",
  active: true,
});

const formFromCoupon = (coupon) => ({
  code: coupon.code || "",
  description: coupon.description || "",
  discountType: coupon.discountType || "percent",
  percent: coupon.percent != null ? String(coupon.percent) : "",
  flatAmount: coupon.flatAmount != null ? String(coupon.flatAmount) : "",
  maxDiscount: coupon.maxDiscount != null ? String(coupon.maxDiscount) : "",
  minOrder: coupon.minOrder != null ? String(coupon.minOrder) : "0",
  usageLimit: coupon.usageLimit != null ? String(coupon.usageLimit) : "",
  // null = unlimited: keep blank so editing never tightens it to 1/user.
  perUserLimit: coupon.perUserLimit != null ? String(coupon.perUserLimit) : "",
  firstBookingOnly: coupon.firstBookingOnly === true,
  applicableServices: (coupon.applicableServices || []).join(", "),
  validFrom: toDateInputValue(coupon.validFrom),
  validTo: toDateInputValue(coupon.validTo),
  active: coupon.active !== false,
});

const CouponModal = ({ open, onClose, onSaved, coupon }) => {
  const showToast = useShowToast();
  const editing = Boolean(coupon);
  const [form, setForm] = useState(blankForm());
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError("");
    setSaving(false);
    setForm(coupon ? formFromCoupon(coupon) : blankForm());
  }, [open, coupon]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose, saving]);

  if (!open) return null;

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    const isFlat = form.discountType === "flat";
    if (isFlat && !(Number(form.flatAmount) >= 1)) {
      setSaving(false);
      setError("Flat discount needs an amount of at least ₹1.");
      return;
    }
    if (!isFlat && !(Number(form.percent) >= 1 && Number(form.percent) <= 100)) {
      setSaving(false);
      setError("Percent discount must be between 1 and 100.");
      return;
    }
    const payload = {
      code: (form.code || "").trim().toUpperCase(),
      description: (form.description || "").trim(),
      discountType: isFlat ? "flat" : "percent",
      percent: isFlat ? null : Number(form.percent),
      flatAmount: isFlat ? Number(form.flatAmount) : null,
      maxDiscount: numberOrNull(form.maxDiscount),
      minOrder: numberOrZero(form.minOrder),
      usageLimit: numberOrNull(form.usageLimit),
      perUserLimit: numberOrNull(form.perUserLimit),
      firstBookingOnly: form.firstBookingOnly === true,
      applicableServices: String(form.applicableServices || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => SERVICE_IDS.includes(s)),
      validFrom: form.validFrom ? new Date(`${form.validFrom}T00:00:00`) : null,
      validTo: form.validTo ? new Date(`${form.validTo}T00:00:00`) : null,
      active: form.active,
    };
    try {
      if (editing) {
        await API.patch(`/coupons/${coupon._id}`, payload);
        showToast(`Coupon ${payload.code} updated!`, "success");
      } else {
        await API.post("/coupons", payload);
        showToast(`Coupon ${payload.code} created — live for customers.`, "success");
      }
      onSaved(payload);
    } catch (err) {
      setError(err.response?.data?.message || "Could not save coupon. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="login-modal-overlay" onClick={() => !saving && onClose()}>
      <div
        className="add-cook-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="coupon-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="login-modal-close"
          onClick={() => !saving && onClose()}
          aria-label="Close"
          disabled={saving}
        >
          <X size={20} />
        </button>

        <div className="add-cook-head">
          <span className="add-cook-icon" style={{ background: "linear-gradient(135deg,#7c2d12,#b45309)" }}>
            <Tag size={24} />
          </span>
          <h3 id="coupon-modal-title">{editing ? `Edit Coupon ${coupon.code}` : "Create a New Coupon"}</h3>
          <p>{editing ? "Adjust the discount terms — live changes apply immediately." : "Set the discount terms — the coupon goes live for customers right away."}</p>
        </div>

        <form onSubmit={handleSubmit}>
          {error && (
            <div className="error-alert-banner" style={{ marginBottom: "0.75rem" }}>
              <AlertCircle size={15} /> {error}
            </div>
          )}

          <div className="booking-form-group">
            <label>Coupon Code *</label>
            <input
              type="text"
              name="code"
              className="form-control"
              value={form.code}
              onChange={handleChange}
              placeholder="e.g. WELCOME50"
              maxLength={24}
              minLength={3}
              pattern="[A-Za-z0-9]+"
              title="3–24 letters and numbers, no spaces"
              required
              style={{ textTransform: "uppercase" }}
            />
          </div>

          <div className="modal-form-grid-2">
            <div className="booking-form-group">
              <label>Discount Type *</label>
              <select
                name="discountType"
                className="form-control"
                value={form.discountType}
                onChange={handleChange}
              >
                <option value="flat">Flat ₹ off</option>
                <option value="percent">Percent % off</option>
              </select>
            </div>
            <div className="booking-form-group">
              <label>{form.discountType === "flat" ? "Flat Discount ₹ *" : "Discount % *"}</label>
              {form.discountType === "flat" ? (
                <input
                  type="number"
                  name="flatAmount"
                  className="form-control"
                  value={form.flatAmount}
                  onChange={handleChange}
                  min={1}
                  step={1}
                  placeholder="e.g. 50"
                  required
                />
              ) : (
                <input
                  type="number"
                  name="percent"
                  className="form-control"
                  value={form.percent}
                  onChange={handleChange}
                  min={1}
                  max={100}
                  step={1}
                  placeholder="e.g. 15"
                  required
                />
              )}
            </div>
          </div>

          <div className="booking-form-group">
            <label>Description</label>
            <input
              type="text"
              name="description"
              className="form-control"
              value={form.description}
              onChange={handleChange}
              placeholder="e.g. Ganesh Utsav special — 20% off festive bookings"
            />
          </div>

          <div className="modal-form-grid-2">
            <div className="booking-form-group">
              <label>Max Discount ₹ (blank = uncapped)</label>
              <input type="number" name="maxDiscount" className="form-control" value={form.maxDiscount} onChange={handleChange} min={1} placeholder="e.g. 500" />
            </div>
            <div className="booking-form-group">
              <label>Min Order ₹</label>
              <input type="number" name="minOrder" className="form-control" value={form.minOrder} onChange={handleChange} min={0} placeholder="0" />
            </div>
          </div>

          <div className="modal-form-grid-2">
            <div className="booking-form-group">
              <label>Total Usage Limit (blank = unlimited)</label>
              <input type="number" name="usageLimit" className="form-control" value={form.usageLimit} onChange={handleChange} min={1} placeholder="e.g. 500" />
            </div>
            <div className="booking-form-group">
              <label>Uses per Customer (blank = unlimited)</label>
              <input type="number" name="perUserLimit" className="form-control" value={form.perUserLimit} onChange={handleChange} min={1} placeholder="1" />
            </div>
          </div>

          <div className="booking-form-group">
            <label className="coupon-active-toggle">
              <input type="checkbox" checked={form.firstBookingOnly} onChange={(e) => setForm((f) => ({ ...f, firstBookingOnly: e.target.checked }))} />
              <span>First booking only (e.g. WELCOME50 — one per new customer)</span>
            </label>
          </div>

          <div className="booking-form-group">
            <label>Services (blank = all services)</label>
            <input
              type="text"
              name="applicableServices"
              className="form-control"
              value={form.applicableServices}
              onChange={handleChange}
              placeholder="e.g. cook_for_me, teach_me"
            />
          </div>

          <div className="modal-form-grid-2">
            <div className="booking-form-group">
              <label>Valid From (blank = now)</label>
              <input type="date" name="validFrom" className="form-control" value={form.validFrom} onChange={handleChange} />
            </div>
            <div className="booking-form-group">
              <label>Valid To (blank = no expiry)</label>
              <input type="date" name="validTo" className="form-control" value={form.validTo} onChange={handleChange} />
            </div>
          </div>

          {editing && (
            <div className="booking-form-group">
              <label className="coupon-active-toggle">
                <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} />
                <span>Coupon is active (customers can see and use it)</span>
              </label>
            </div>
          )}

          <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={saving}>
            {saving ? (
              <>
                <Loader2 size={17} className="spin" /> Saving...
              </>
            ) : editing ? (
              <>
                <CheckCircle2 size={17} /> Save Changes
              </>
            ) : (
              <>
                <Tag size={17} /> Create Coupon
              </>
            )}
          </button>
          <button type="button" className="btn btn-outline btn-block" style={{ marginTop: "0.5rem" }} onClick={() => onClose()} disabled={saving}>
            Cancel
          </button>
        </form>
      </div>
    </div>
  );
};

export default CouponModal;