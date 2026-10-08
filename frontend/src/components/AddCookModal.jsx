import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { ChefHat, X, UserPlus, Loader2, AlertCircle, CheckCircle2, Copy, Check } from "lucide-react";

const initialForm = {
  name: "",
  email: "",
  phone: "",
  password: "",
  serviceArea: "",
  specialties: "",
};

const AddCookModal = ({ open, onClose, onCreated }) => {
  const showToast = useShowToast();
  const [form, setForm] = useState(initialForm);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null);
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
        serviceArea: form.serviceArea.trim(),
        specialties: form.specialties
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
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

  // Portal to document.body so the fixed overlay always escapes any
  // ancestor overflow/transform/stacking context on the admin page.
  // Without this, `position: fixed` resolves against a transformed
  // ancestor and the form can render off-screen / invisible on click.
  const modal = (
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
  if (typeof document !== "undefined" && document.body) {
    return createPortal(modal, document.body);
  }
  return modal;
};

export default AddCookModal;
