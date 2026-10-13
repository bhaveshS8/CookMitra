import React, { useState, useEffect } from "react";
import API from "../api/axios";
import { useDispatch } from "react-redux";
import { updateUser } from "../store/authSlice";
import { useShowToast } from "../store/hooks";
import { getPhoneCore, validatePhone } from "../utils/authValidation";
import { resolveFileUrl } from "./CookDocUploads";
import { ChefHat, AlertCircle, Phone, Camera, Upload, X } from "lucide-react";

const DEFAULT_SERVICE_TYPES = ["cook_for_me"];

const CookProfileForm = ({
  createTitle = "Create Cook Profile",
  manageTitle = "Manage Cook Profile",
  showStatus = false,
  onSaved,
}) => {
  const showToast = useShowToast();
  const dispatch = useDispatch();
  const [formData, setFormData] = useState({
    mobileNumber: "",
    skills: "",
    experienceYears: 0,
    specialties: "",
    serviceArea: "",
    address: "",
    photoUrl: "",
  });
  const [existing, setExisting] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [error, setError] = useState("");

  const handlePhotoUpload = async (file) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      const msg = "File too large — photo must be 2MB or less";
      setError(msg);
      showToast(msg, "error");
      return;
    }
    setUploadingPhoto(true);
    try {
      const fd = new FormData();
      fd.append("photo", file);
      const res = await API.post("/cooks/upload-docs", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const url = res.data?.photoUrl || "";
      if (!url) throw new Error("Upload failed — no file URL returned");
      setFormData((prev) => ({ ...prev, photoUrl: url }));
      showToast("Photo uploaded successfully!", "success");
    } catch (err) {
      const msg = err.response?.data?.message || "Photo upload failed (JPG/PNG/WEBP, max 2MB)";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setUploadingPhoto(false);
    }
  };

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const res = await API.get("/cooks/me");
        setExisting(res.data);
        const profileMobile =
          res.data?.user?.mobile || res.data?.user?.phone || res.data?.mobileNumber || "";
        let accountMobile = profileMobile;
        try {
          const me = await API.get("/auth/me");
          accountMobile =
            me.data?.mobile || me.data?.phone || profileMobile || "";
          if (accountMobile) {
            dispatch(updateUser({ phone: me.data?.phone, mobile: me.data?.mobile }));
          }
        } catch {
          // /cooks/me already gave us the number — non-fatal if /auth/me fails
        }
        setFormData({
          mobileNumber: accountMobile || "",
          skills: res.data.skills || res.data.bio || "",
          experienceYears: res.data.experienceYears ?? 0,
          specialties: (res.data.specialties || []).join(", "),
          serviceArea: res.data.serviceArea || "",
          address: res.data.address || "",
          photoUrl: res.data.photoUrl || "",
        });
      } catch (err) {
        if (err.response?.status !== 404) {
          setError(err.response?.data?.message || "Failed to load profile");
        } else {
          // No cook profile yet — still prefill mobile from account
          try {
            const me = await API.get("/auth/me");
            const accountMobile = me.data?.mobile || me.data?.phone || "";
            if (accountMobile) {
              setFormData((prev) => ({ ...prev, mobileNumber: accountMobile }));
              dispatch(updateUser({ phone: me.data?.phone, mobile: me.data?.mobile }));
            }
          } catch {
            // prefill is best-effort
          }
        }
      } finally {
        setLoading(false);
      }
    };
    fetchProfile();
  }, [dispatch]);

  const handleChange = (e) => {
    let { name, value } = e.target;
    if (name === "mobileNumber") {
      // Keep mobile input numeric-friendly (+91 / spaces allowed); validated on submit.
      value = String(value || "")
        .replace(/[^\d+ ]/g, "")
        .replace(/(?!^)\+/g, "")
        .slice(0, 14);
      if (error) setError("");
    }
    setFormData({ ...formData, [name]: value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const mobileErr = validatePhone(formData.mobileNumber);
    if (mobileErr) {
      setError(mobileErr);
      showToast(mobileErr, "error");
      return;
    }
    setSaving(true);
    setError("");

    const normalizedMobile = getPhoneCore(formData.mobileNumber);
    const payload = {
      mobileNumber: normalizedMobile,
      mobile: normalizedMobile,
      phone: normalizedMobile,
      skills: formData.skills,
      bio: formData.skills,
      experienceYears: Number.isFinite(Number(formData.experienceYears))
        ? Math.max(0, Number(formData.experienceYears))
        : 0,
      specialties: formData.specialties
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      serviceTypes: DEFAULT_SERVICE_TYPES,
      serviceArea: formData.serviceArea,
      address: formData.address,
      photoUrl: formData.photoUrl || "",
    };

    try {
      // Keep the account mobile in sync (used for bookings + WhatsApp).
      // The cook endpoints also persist the mobile to the User account, so the
      // number is saved even if this account-sync call fails (best-effort).
      let accountSynced = false;
      try {
        const meRes = await API.put("/auth/me", {
          phone: normalizedMobile,
          mobile: normalizedMobile,
        });
        dispatch(
          updateUser({ phone: meRes.data?.phone, mobile: meRes.data?.mobile })
        );
        accountSynced = true;
      } catch (mobileErr) {
        // Non-fatal — fall through to the cook profile save below, which
        // syncs User.phone/mobile itself. Surface only if that fails too.
        void mobileErr;
      }
      const isUpdate = Boolean(existing);
      const res = isUpdate
        ? await API.put(`/cooks/${existing._id}`, payload)
        : await API.post("/cooks", payload);
      setExisting(res.data);
      if (!accountSynced) {
        dispatch(
          updateUser({ phone: normalizedMobile, mobile: normalizedMobile })
        );
      }
      showToast(
        isUpdate ? "Chef profile updated successfully!" : "Profile submitted for admin approval!",
        "success"
      );
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
          <label>Mobile Number</label>
          <div className="input-with-icon">
            <Phone size={16} className="input-icon-prefix" />
            <input
              name="mobileNumber"
              className="form-control"
              value={formData.mobileNumber}
              onChange={handleChange}
              placeholder="10-digit mobile number"
              inputMode="numeric"
              maxLength={14}
              required
            />
          </div>
          <span className="field-hint">
            Used for booking coordination and WhatsApp updates.
          </span>
        </div>

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

        <div className="cook-field">
          <label>
            <Camera size={15} style={{ verticalAlign: "-2px" }} /> Profile Photo{" "}
            <span className="cook-optional">(optional)</span>
          </label>
          <div className="cook-doc-card">
            <div className="cook-doc-row">
              {formData.photoUrl && (
                <img
                  src={resolveFileUrl(formData.photoUrl)}
                  alt="Cook profile"
                  className="cook-doc-photo"
                />
              )}
              {formData.photoUrl ? (
                <button
                  type="button"
                  className="btn btn-danger-outline btn-sm"
                  onClick={() =>
                    setFormData((prev) => ({ ...prev, photoUrl: "" }))
                  }
                >
                  <X size={14} /> Remove
                </button>
              ) : (
                <label className="btn btn-outline btn-sm cook-file-btn">
                  <Upload size={15} />{" "}
                  {uploadingPhoto ? "Uploading..." : "Upload Photo (JPG/PNG/WEBP, max 2MB)"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    hidden
                    disabled={uploadingPhoto}
                    onChange={(e) => {
                      handlePhotoUpload(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
            </div>
          </div>
        </div>

        <button
          type="submit"
          className="btn btn-primary btn-block btn-lg cook-form-submit"
          disabled={saving || uploadingPhoto}
        >
          {saving
            ? "Saving Details..."
            : uploadingPhoto
            ? "Uploading photo..."
            : existing
            ? "Update Profile"
            : "Submit for Approval"}
        </button>
      </form>
    </div>
  );
};

export default CookProfileForm;
