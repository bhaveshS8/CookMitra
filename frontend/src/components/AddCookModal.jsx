import React, { useEffect, useState } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { ChefHat, X, UserPlus, Loader2, AlertCircle, CheckCircle2, Copy, Check } from "lucide-react";

const SERVICE_TYPES = [
  { id: "cook_for_me", label: "Cook for Me" },
  { id: "cook_with_me", label: "Cook With Me" },
  { id: "teach_me", label: "Teach Me" },
  { id: "preparation_help", label: "Preparation Help" },
];

const initialForm = {
  name: "",
  email: "",
  phone: "",
  password: "",
  rate: "500",
  serviceArea: "",
  specialties: "",
  serviceTypes: ["cook_with_me"],
};

const AddCookModal = ({ open, onClose, onCreated }) => {
  const showToast = useShowToast();
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null);
  // Login credentials to show the admin (password is hashed server-side,
  // so this success screen is the only place it is ever visible).
  const [createdCreds, setCreatedCreds] = useState(null);
  const [copied, setCopied] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(initialForm);
      setError("");
      setCreated(null);
      setCreatedCreds(null);
      setCopied("");
    }
  }, [open]);

  const copyText = async (text, key) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // clipboard unavailable — admin can still select the text manually
      }
      ta.remove();
    }
    setCopied(key);
    setTimeout(() => setCopied(""), 2000);
  };

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

  const toggleServiceType = (id) => {
    setForm((f) => {
      const has = f.serviceTypes.includes(id);
      const next = has
        ? f.serviceTypes.filter((t) => t !== id)
        : [...f.serviceTypes, id];
      return { ...f, serviceTypes: next.length ? next : ["cook_with_me"] };
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        password: form.password,
        rate: Number(form.rate),
        serviceArea: form.serviceArea.trim(),
        specialties: form.specialties
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        serviceTypes: form.serviceTypes,
      };
      const res = await API.post("/auth/cooks", payload);
      setCreated(res.data?.user || {});
      setCreatedCreds({ email: form.email.trim(), password: form.password });
      showToast(`Cook ${res.data?.user?.name} added successfully!`, "success");
      onCreated?.(res.data);
    } catch (err) {
      const msg = err.response?.data?.message || err.message || "Could not add cook";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  const addAnother = () => {
    setCreated(null);
    setCreatedCreds(null);
    setCopied("");
    setForm(initialForm);
    setError("");
  };

  return (
    <div className="login-modal-overlay" onClick={() => !saving && onClose()}>
      <div
        className="add-cook-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-cook-title"
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
          <span className="add-cook-icon">
            <ChefHat size={24} />
          </span>
          <h3 id="add-cook-title">Add a New Cook</h3>
          <p>Create a cook account. They get an approved profile and can sign in right away.</p>
        </div>

        {created ? (
          <div className="add-cook-success">
            <CheckCircle2 size={40} style={{ color: "var(--accent-emerald)", margin: "0 auto 0.75rem" }} />
            <h4>{created.name} added!</h4>
            <p style={{ color: "var(--slate-500)", margin: "0 0 1rem" }}>
              The cook can now log in and appears in the approved cooks list.
            </p>
            {createdCreds && (
              <div className="add-cook-creds">
                <div className="add-cook-creds-title">Login credentials — share with the cook</div>
                <div className="add-cook-cred-row">
                  <div className="add-cook-cred-field">
                    <span>Email</span>
                    <strong>{createdCreds.email}</strong>
                  </div>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => copyText(createdCreds.email, "email")}
                    title="Copy email"
                  >
                    {copied === "email" ? <Check size={15} /> : <Copy size={15} />}
                    {copied === "email" ? "Copied" : "Copy"}
                  </button>
                </div>
                <div className="add-cook-cred-row">
                  <div className="add-cook-cred-field">
                    <span>Password</span>
                    <strong className="add-cook-cred-pass">{createdCreds.password}</strong>
                  </div>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => copyText(createdCreds.password, "password")}
                    title="Copy password"
                  >
                    {copied === "password" ? <Check size={15} /> : <Copy size={15} />}
                    {copied === "password" ? "Copied" : "Copy"}
                  </button>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-block btn-sm"
                  onClick={() =>
                    copyText(
                      `CookMitra login\nEmail: ${createdCreds.email}\nPassword: ${createdCreds.password}`,
                      "both"
                    )
                  }
                >
                  {copied === "both" ? <Check size={15} /> : <Copy size={15} />}
                  {copied === "both" ? "Copied!" : "Copy login details"}
                </button>
                <p className="add-cook-creds-note">
                  Share these now — the password is encrypted on save and can't be viewed again later.
                </p>
              </div>
            )}
            <button className="btn btn-primary btn-block btn-lg" onClick={addAnother}>
              <UserPlus size={17} /> Add Another Cook
            </button>
            <button className="btn btn-outline btn-block" onClick={() => onClose()}>
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {error && (
              <div className="error-alert-banner" style={{ marginBottom: "0.75rem" }}>
                <AlertCircle size={15} /> {error}
              </div>
            )}

            <div className="booking-form-group">
              <label>Full Name *</label>
              <input
                type="text"
                name="name"
                className="form-control"
                value={form.name}
                onChange={handleChange}
                placeholder="e.g. Meera Patil"
                required
              />
            </div>

            <div className="modal-form-grid-2">
              <div className="booking-form-group">
                <label>Email *</label>
                <input
                  type="email"
                  name="email"
                  className="form-control"
                  value={form.email}
                  onChange={handleChange}
                  placeholder="chef@example.com"
                  required
                />
              </div>
              <div className="booking-form-group">
                <label>Phone *</label>
                <input
                  type="tel"
                  name="phone"
                  className="form-control"
                  value={form.phone}
                  onChange={handleChange}
                  placeholder="98765 43210"
                  required
                />
              </div>
            </div>

            <div className="booking-form-group">
              <label>Password * (cook uses this to sign in)</label>
              <input
                type="text"
                name="password"
                className="form-control"
                value={form.password}
                onChange={handleChange}
                placeholder="min 8 characters"
                minLength={8}
                required
              />
            </div>

            <div className="modal-form-grid-2">
              <div className="booking-form-group">
                <label>Hourly Rate (₹) *</label>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9]*[.]?[0-9]*"
                  name="rate"
                  className="form-control"
                  value={form.rate}
                  onChange={handleChange}
                  min={1}
                  required
                />
              </div>
              <div className="booking-form-group">
                <label>Service Area</label>
                <input
                  type="text"
                  name="serviceArea"
                  className="form-control"
                  value={form.serviceArea}
                  onChange={handleChange}
                  placeholder="e.g. Pune"
                />
              </div>
            </div>

            <div className="booking-form-group">
              <label>Specialties (comma separated)</label>
              <input
                type="text"
                name="specialties"
                className="form-control"
                value={form.specialties}
                onChange={handleChange}
                placeholder="e.g. Puran Poli, Modak, Sheera"
              />
            </div>

            <div className="booking-form-group">
              <label>Services Offered</label>
              <div className="service-pick-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
                {SERVICE_TYPES.map((s) => {
                  const selected = form.serviceTypes.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`service-pick-card ${selected ? "selected" : ""}`}
                      onClick={() => toggleServiceType(s.id)}
                      style={{ padding: "0.7rem", fontSize: "0.85rem" }}
                    >
                      {selected ? (
                        <span className="service-pick-check">
                          <CheckCircle2 size={16} />
                        </span>
                      ) : null}
                      <span>{s.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 size={17} className="spin" /> Adding Cook...
                </>
              ) : (
                <>
                  <UserPlus size={17} /> Add Cook
                </>
              )}
            </button>
            <button
              type="button"
              className="btn btn-outline btn-block"
              style={{ marginTop: "0.5rem" }}
              onClick={() => onClose()}
              disabled={saving}
            >
              Cancel
            </button>
          </form>
        )}
      </div>
    </div>
  );
};

export default AddCookModal;
