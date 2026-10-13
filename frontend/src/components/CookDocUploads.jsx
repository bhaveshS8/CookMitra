import React, { useState } from "react";
import API from "../api/axios";
import { useSignedDocUrl } from "../utils/docUrls";
import { useShowToast } from "../store/hooks";
import { Upload, FileCheck, X, Camera } from "lucide-react";

const resolveApiOrigin = () => {
  const configured = process.env.REACT_APP_API_URL || "";
  if (typeof window !== "undefined" && configured) {
    try {
      const parsed = new URL(configured, window.location.origin);
      const bakedHost = parsed.hostname;
      const servedHost = window.location.hostname;
      const isBakedLocal =
        bakedHost === "localhost" ||
        bakedHost === "127.0.0.1" ||
        bakedHost === "[::1]";
      const isServedLocal =
        servedHost === "localhost" ||
        servedHost === "127.0.0.1" ||
        servedHost === "::1" ||
        servedHost === "";
      if (isBakedLocal && !isServedLocal) return "";
    } catch {
      return "";
    }
  }
  return (configured || "/api").replace(/\/api\/?$/, "");
};

const API_ORIGIN = resolveApiOrigin();

export const resolveFileUrl = (url) => {
  if (!url) return "";
  if (/^blob:/i.test(url)) return url;
  if (/^https:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      if (u.protocol === "https:") return url;
    } catch {
      return "";
    }
    return "";
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return "";
  const full = `${API_ORIGIN}${url.startsWith("/") ? url : `/${url}`}`;
  return full;
};

const PrivateDocLink = ({ storedPath, label }) => {
  const { url, loading, error } = useSignedDocUrl(storedPath);
  if (!storedPath) return null;
  if (loading) return <span className="cook-doc-link">Preparing secure preview…</span>;
  if (error || !url) return <span className="cook-doc-link">{error || "Preview unavailable"}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="cook-doc-link">
      {label}
    </a>
  );
};

const FIELD_TO_KEY = {
  aadhar: "aadharCardUrl",
  pan: "panCardUrl",
  photo: "photoUrl",
};

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const OVERSIZE_MSG = "File too large — each file must be 2MB or less";

const CookDocUploads = ({
  aadharCardUrl = "",
  panCardUrl = "",
  photoUrl = "",
  onChange,
  onError,
  onUploadingChange,
  requireDocs = true,
}) => {
  const showToast = useShowToast();
  const [uploading, setUploading] = useState({ aadhar: false, pan: false, photo: false });

  const setFieldUploading = (field, value) => {
    setUploading((prev) => {
      const next = { ...prev, [field]: value };
      onUploadingChange?.(Object.values(next).some(Boolean));
      return next;
    });
  };

  const handleFileUpload = async (field, file) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      onError?.(OVERSIZE_MSG);
      showToast(OVERSIZE_MSG, "error");
      return;
    }
    const urlKey = FIELD_TO_KEY[field];
    setFieldUploading(field, true);
    try {
      const fd = new FormData();
      fd.append(field, file);
      const res = await API.post("/cooks/upload-docs", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      const url = res.data?.[urlKey] || "";
      if (!url) throw new Error("Upload failed — no file URL returned");
      onChange?.(urlKey, url);
      showToast("File uploaded successfully!", "success");
    } catch (err) {
      const msg = err.response?.data?.message || "File upload failed (JPG/PNG/WEBP/PDF, max 2MB)";
      onError?.(msg);
      showToast(msg, "error");
    } finally {
      setFieldUploading(field, false);
    }
  };

  const fileInput = (field, accept, label) => (
    <label className="btn btn-outline btn-sm cook-file-btn">
      {field === "photo" ? <Camera size={15} /> : <Upload size={15} />}{" "}
      {uploading[field] ? "Uploading..." : label}
      <input
        type="file"
        accept={accept}
        hidden
        disabled={uploading[field]}
        onChange={(e) => {
          handleFileUpload(field, e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </label>
  );

  return (
    <div className="cook-field">
      <label className="cook-doc-group-label">
        Identity Verification{" "}
        {requireDocs && <span className="cook-required">(Aadhaar & PAN required)</span>}
      </label>

      <div className="cook-doc-card">
        <div className="cook-doc-head">
          <strong>
            Aadhaar Card {requireDocs && <span className="cook-required">*</span>}
          </strong>
          {aadharCardUrl && (
            <span className="badge badge-emerald">
              <FileCheck size={13} /> Uploaded
            </span>
          )}
        </div>
        {aadharCardUrl ? (
          <div className="cook-doc-row">
            <PrivateDocLink storedPath={aadharCardUrl} label="View uploaded Aadhaar" />
            <button
              type="button"
              className="btn btn-danger-outline btn-sm"
              onClick={() => onChange?.("aadharCardUrl", "")}
            >
              <X size={14} /> Remove
            </button>
          </div>
        ) : (
          fileInput("aadhar", "image/jpeg,image/png,image/webp,.pdf", "Upload Aadhaar (JPG/PNG/PDF, max 2MB)")
        )}
      </div>

      <div className="cook-doc-card">
        <div className="cook-doc-head">
          <strong>
            PAN Card {requireDocs && <span className="cook-required">*</span>}
          </strong>
          {panCardUrl && (
            <span className="badge badge-emerald">
              <FileCheck size={13} /> Uploaded
            </span>
          )}
        </div>
        {panCardUrl ? (
          <div className="cook-doc-row">
            <PrivateDocLink storedPath={panCardUrl} label="View uploaded PAN card" />
            <button
              type="button"
              className="btn btn-danger-outline btn-sm"
              onClick={() => onChange?.("panCardUrl", "")}
            >
              <X size={14} /> Remove
            </button>
          </div>
        ) : (
          fileInput("pan", "image/jpeg,image/png,image/webp,.pdf", "Upload PAN (JPG/PNG/PDF, max 2MB)")
        )}
      </div>

      <div className="cook-doc-card">
        <div className="cook-doc-head">
          <strong>
            Profile Photo <span className="cook-optional">(optional)</span>
          </strong>
          {photoUrl && (
            <span className="badge badge-emerald">
              <FileCheck size={13} /> Uploaded
            </span>
          )}
        </div>
        <div className="cook-doc-row">
          {photoUrl && (
            <img
              src={resolveFileUrl(photoUrl)}
              alt="Cook profile"
              className="cook-doc-photo"
            />
          )}
          {photoUrl ? (
            <button
              type="button"
              className="btn btn-danger-outline btn-sm"
              onClick={() => onChange?.("photoUrl", "")}
            >
              <X size={14} /> Remove
            </button>
          ) : (
            fileInput("photo", "image/jpeg,image/png,image/webp", "Upload Photo (JPG/PNG/WEBP, max 2MB)")
          )}
        </div>
      </div>
      <p className="cook-doc-hint">
        Your Aadhaar and PAN are visible only to the admin for verification.
      </p>
    </div>
  );
};

export default CookDocUploads;
