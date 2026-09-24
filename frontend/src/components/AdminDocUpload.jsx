import React, { useState } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { resolveFileUrl } from "./CookDocUploads";
import { Upload, FileCheck, Loader2 } from "lucide-react";

// Admin-side "upload on behalf of a cook" panel. Posts each file straight to
// POST /cooks/:id/upload-docs (admin-gated) — the backend saves it, attaches
// the URL to the cook's profile and notifies the cook. :id may be a CookProfile
// id or the cook's User id; `current` carries the profile's present doc URLs so
// the panel can show "on file / replace" states.
const FIELDS = [
  { key: "aadhar", label: "Aadhaar Card", urlKey: "aadharCardUrl" },
  { key: "pan", label: "PAN Card", urlKey: "panCardUrl" },
  { key: "photo", label: "Profile Photo", urlKey: "photoUrl" },
];

const AdminDocUpload = ({ cookId, current = {}, onUploaded }) => {
  const showToast = useShowToast();
  const [uploading, setUploading] = useState(null); // field key currently uploading

  const upload = async (field, file) => {
    if (!file || !cookId) return;
    // Must match backend/middleware/upload.js multer fileSize limit — instant
    // client-side error instead of a wasted upload round-trip.
    if (file.size > 2 * 1024 * 1024) {
      showToast("File too large — each file must be 2MB or less", "error");
      return;
    }
    setUploading(field);
    try {
      const fd = new FormData();
      fd.append(field, file);
      const res = await API.post(`/cooks/${cookId}/upload-docs`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      showToast("Document uploaded to the cook's profile.", "success");
      onUploaded?.(res.data);
    } catch (err) {
      showToast(
        err.response?.data?.message || "Upload failed (JPG/PNG/WEBP/PDF, max 2MB)",
        "error"
      );
    } finally {
      setUploading(null);
    }
  };

  return (
    <div className="cook-docs-card">
      <p className="cook-doc-hint" style={{ marginBottom: "0.5rem" }}>
        Upload on behalf of the cook — files attach instantly and the cook is
        notified.
      </p>
      {FIELDS.map((f) => {
        const url = current?.[f.urlKey];
        const busy = uploading === f.key;
        return (
          <div key={f.key} className="cook-doc-card">
            <div className="cook-doc-head">
              <strong>{f.label}</strong>
              {url && (
                <span className="badge badge-emerald">
                  <FileCheck size={13} /> On file
                </span>
              )}
            </div>
            <div className="cook-doc-row">
              {f.key === "photo" && url ? (
                <img
                  src={resolveFileUrl(url)}
                  alt={f.label}
                  className="cook-doc-photo"
                />
              ) : null}
              <label
                className={`btn btn-outline btn-sm cook-file-btn${busy ? " disabled" : ""}`}
              >
                {busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
                {busy ? "Uploading…" : url ? "Replace file" : "Upload file"}
                <input
                  type="file"
                  accept={
                    f.key === "photo"
                      ? "image/jpeg,image/png,image/webp"
                      : "image/jpeg,image/png,image/webp,.pdf"
                  }
                  style={{ display: "none" }}
                  disabled={busy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    upload(f.key, file);
                  }}
                />
              </label>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default AdminDocUpload;
