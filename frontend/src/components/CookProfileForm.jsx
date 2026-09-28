import React, { useState, useEffect } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { SERVICE_DETAILS } from "../utils/constants";
import CookDocUploads from "./CookDocUploads";
import { ChefHat, Check, AlertCircle } from "lucide-react";

const SERVICE_OPTIONS = ["cook_for_me", "cook_with_me", "teach_me", "preparation_help"];

// Single source of truth for the cook profile form, shared by the Cook Setup
// page and the cook dashboard's profile tab (they previously duplicated each
// other and had already diverged — the dashboard copy silently dropped the
// home address and additional documents fields).
// Props:
//   createTitle / manageTitle — headings for first-time vs existing profiles
//   showStatus — show the admin verification badge (setup page)
//   onSaved(profile, isUpdate) — optional callback after a successful save
const CookProfileForm = ({
  createTitle = "Create Cook Profile",
  manageTitle = "Manage Cook Profile",
  showStatus = false,
  onSaved,
}) => {
  const showToast = useShowToast();
  const [formData, setFormData] = useState({
    skills: "",
    experienceYears: 0,
    specialties: "",
    serviceTypes: [],
    serviceArea: "",
    address: "",
    documents: [],
    aadharCardUrl: "",
    panCardUrl: "",
    photoUrl: "",
  });
  const [existing, setExisting] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingDocs, setUploadingDocs] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const res = await API.get("/cooks/me");
        setExisting(res.data);
        setFormData({
          skills: res.data.skills || res.data.bio || "",
          experienceYears: res.data.experienceYears ?? 0,
          specialties: (res.data.specialties || []).join(", "),
          serviceTypes: res.data.serviceTypes || [],
          serviceArea: res.data.serviceArea || "",
          address: res.data.address || "",
          documents: res.data.documents || [],
          aadharCardUrl: res.data.aadharCardUrl || "",
          panCardUrl: res.data.panCardUrl || "",
          photoUrl: res.data.photoUrl || "",
        });
      } catch (err) {
        if (err.response?.status !== 404) {
          setError(err.response?.data?.message || "Failed to load profile");
        }
      } finally {
        setLoading(false);
      }
    };
    fetchProfile();
  }, []);

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const toggleServiceType = (type) => {
    setFormData((prev) => ({
      ...prev,
      serviceTypes: prev.serviceTypes.includes(type)
        ? prev.serviceTypes.filter((t) => t !== type)
        : [...prev.serviceTypes, type],
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.aadharCardUrl) {
      const msg = "Please upload your Aadhaar card";
      setError(msg);
      showToast(msg, "error");
      return;
    }
    if (!formData.panCardUrl) {
      const msg = "Please upload your PAN card";
      setError(msg);
      showToast(msg, "error");
      return;
    }
    if (formData.serviceTypes.length === 0) {
      const msg = "Please select at least one service you can offer";
      setError(msg);
      showToast(msg, "error");
      return;
    }
    setSaving(true);
    setError("");

    const payload = {
      skills: formData.skills,
      bio: formData.skills,
      experienceYears: Number.isFinite(Number(formData.experienceYears))
        ? Math.max(0, Number(formData.experienceYears))
        : 0,
      specialties: formData.specialties
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      serviceTypes: formData.serviceTypes,
      serviceArea: formData.serviceArea,
      address: formData.address,
      aadharCardUrl: formData.aadharCardUrl,
      panCardUrl: formData.panCardUrl,
      photoUrl: formData.photoUrl || "",
      documents: (formData.documents || [])
        .map((d) => ({ label: (d.label || "").trim(), url: (d.url || "").trim() }))
        .filter((d) => d.label || d.url),
    };

    try {
      const isUpdate = Boolean(existing);
      const res = isUpdate
        ? await API.put(`/cooks/${existing._id}`, payload)
        : await API.post("/cooks", payload);
      setExisting(res.data);
      showToast(
        isUpdate ? "Chef profile updated successfully!" : "Profile submitted for admin approval!",
        "success"
      );
      // Tell the navbar to reload the (possibly new) profile photo.
      window.dispatchEvent(new Event("cook-photo-updated"));
      onSaved?.(res.data, isUpdate);
    } catch (err) {
      const msg = err.response?.data?.message || "Failed to save profile";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="loading-spinner-wrapper">
        <div className="spinner"></div>
        <p>Loading profile...</p>
      </div>
    );
  }

  return (
    <div className="cook-form-card">
      <div className="cook-form-head">
        <ChefHat size={22} />
        <h1>{existing ? manageTitle : createTitle}</h1>
      </div>

      {showStatus && existing && (
        <div className="cook-verify-row">
          <span className="cook-verify-label">
            Verification Status:
          </span>
          <span
            className={`badge ${
              existing.approvalStatus === "approved"
                ? "badge-emerald"
                : existing.approvalStatus === "rejected"
                ? "badge-rose"
                : "badge-amber"
            }`}
          >
            {existing.approvalStatus?.toUpperCase()}
          </span>
        </div>
      )}

      {error && (
        <div className="error-alert-banner">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="cook-field">
          <label>Skills</label>
          <textarea
            name="skills"
            rows={3}
            className="form-control"
            value={formData.skills}
            onChange={handleChange}
            placeholder="Tell families about your cooking skills and signature festival sweets..."
          />
        </div>

        <div className="cook-field">
          <label>Experience (Years)</label>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            name="experienceYears"
            className="form-control"
            value={formData.experienceYears}
            onChange={handleChange}
            min="0"
          />
        </div>

        <div className="cook-field">
          <label>Specialties (Comma-separated)</label>
          <input
            name="specialties"
            className="form-control"
            value={formData.specialties}
            onChange={handleChange}
            placeholder="Chakli, Karanji, Modak, Puran Poli"
          />
        </div>

        <div className="cook-field">
          <label>Primary Service Area</label>
          <input
            name="serviceArea"
            className="form-control"
            value={formData.serviceArea}
            onChange={handleChange}
            placeholder="e.g. Pune, Baner, Kothrud"
          />
        </div>

        <div className="cook-field">
          <label>Home Address (visible to admin)</label>
          <textarea
            name="address"
            rows={2}
            className="form-control"
            value={formData.address}
            onChange={handleChange}
            placeholder="e.g. Flat 4B, Sunshine Society, Baner Road, Pune 411045"
          />
        </div>

        <CookDocUploads
          aadharCardUrl={formData.aadharCardUrl}
          panCardUrl={formData.panCardUrl}
          photoUrl={formData.photoUrl}
          onChange={(key, url) => setFormData((prev) => ({ ...prev, [key]: url }))}
          onError={(msg) => setError(msg)}
          onUploadingChange={setUploadingDocs}
        />

        <div className="cook-field">
          <label>
            Additional Documents (optional, visible to admin)
          </label>
          {(formData.documents || []).map((doc, i) => (
            <div key={i} className="cook-doc-grid">
              <input
                className="form-control"
                value={doc.label || ""}
                onChange={(e) => {
                  const docs = [...(formData.documents || [])];
                  docs[i] = { ...docs[i], label: e.target.value };
                  setFormData((prev) => ({ ...prev, documents: docs }));
                }}
                placeholder="e.g. Aadhaar Card"
              />
              <input
                className="form-control"
                value={doc.url || ""}
                onChange={(e) => {
                  const docs = [...(formData.documents || [])];
                  docs[i] = { ...docs[i], url: e.target.value };
                  setFormData((prev) => ({ ...prev, documents: docs }));
                }}
                placeholder="Document link (https://...)"
              />
              <button
                type="button"
                className="btn btn-danger-outline btn-sm"
                onClick={() =>
                  setFormData((prev) => ({
                    ...prev,
                    documents: (prev.documents || []).filter((_, j) => j !== i),
                  }))
                }
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() =>
              setFormData((prev) => ({
                ...prev,
                documents: [...(prev.documents || []), { label: "", url: "" }],
              }))
            }
          >
            + Add Document
          </button>
        </div>

        <div className="cook-field">
          <label>Services You Can Offer</label>
          <div className="cook-svc-grid">
            {SERVICE_OPTIONS.map((type) => {
              const isSelected = formData.serviceTypes.includes(type);
              const info = SERVICE_DETAILS[type] || { label: type.replace(/_/g, " ") };
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleServiceType(type)}
                  className={`cook-svc${isSelected ? " selected" : ""}`}
                  aria-pressed={isSelected}
                >
                  <span>{info.label}</span>
                  {isSelected && <Check size={16} />}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="submit"
          className="btn btn-primary btn-block btn-lg cook-form-submit"
          disabled={saving || uploadingDocs}
        >
          {saving
            ? "Saving Details..."
            : uploadingDocs
            ? "Uploading files..."
            : existing
            ? "Update Profile"
            : "Submit for Approval"}
        </button>
      </form>
    </div>
  );
};

export default CookProfileForm;
