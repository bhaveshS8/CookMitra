import React, { useState } from "react";
import API, { getStoredToken } from "../api/axios";
import { useShowToast } from "../store/hooks";
import { Upload, FileCheck, X, Camera } from "lucide-react";

// Backend serves uploaded files under /uploads; API base ends with /api.
// Falls back to same-origin so single-service deployments need no build env.
// Mirrors api/axios resolveBaseURL: a baked localhost URL is discarded when
// served from a real host, otherwise uploaded photos point at the visitor's
// own machine and 404 in production.
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
  if (/^https?:\/\//i.test(url)) return url;
  const full = `${API_ORIGIN}${url.startsWith("/") ? url : `/${url}`}`;
  // Identity docs (aadhar_*/pan_*) are access-controlled server-side via
  // ?token= — <img>/<iframe> can't send auth headers. Public profile photos
  // (photo_*) stay bare so they remain cacheable and shareable.
  const base = String(url).split("/").pop().split("?")[0];
  if (!url.startsWith("/uploads") || /^photo_/i.test(base)) return full;
  try {
    const token = getStoredToken();
    if (token) return `${full}${full.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  } catch {
    // ignore — the server will answer 401 and the thumb degrades gracefully
  }
  return full;
};

const FIELD_TO_KEY = {
  aadhar: "aadharCardUrl",
  pan: "panCardUrl",
  photo: "photoUrl",
};

// Reusable Aadhaar (required) / PAN (required) / profile photo (optional)
// upload section for cook profile forms. Uploads immediately via
// POST /cooks/upload-docs and reports URLs through onChange(urlKey, url).
// Props: aadharCardUrl, panCardUrl, photoUrl, onChange, onError (optional),
// requireDocs (default true — set false to skip required markers/validation hints).
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
      const msg = err.response?.data?.message || "File upload failed (JPG/PNG/WEBP/PDF, max 5MB)";
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

      {/* Aadhaar Card */}
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
            <a
              href={resolveFileUrl(aadharCardUrl)}
              target="_blank"
              rel="noreferrer"
              className="cook-doc-link"
            >
              View uploaded Aadhaar
            </a>
            <button
              type="button"
              className="btn btn-danger-outline btn-sm"
              onClick={() => onChange?.("aadharCardUrl", "")}
            >
              <X size={14} /> Remove
            </button>
          </div>
        ) : (
          fileInput("aadhar", "image/jpeg,image/png,image/webp,.pdf", "Upload Aadhaar (JPG/PNG/PDF, max 5MB)")
        )}
      </div>

      {/* PAN Card */}
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
            <a
              href={resolveFileUrl(panCardUrl)}
              target="_blank"
              rel="noreferrer"
              className="cook-doc-link"
            >
              View uploaded PAN card
            </a>
            <button
              type="button"
              className="btn btn-danger-outline btn-sm"
              onClick={() => onChange?.("panCardUrl", "")}
            >
              <X size={14} /> Remove
            </button>
          </div>
        ) : (
          fileInput("pan", "image/jpeg,image/png,image/webp,.pdf", "Upload PAN (JPG/PNG/PDF, max 5MB)")
        )}
      </div>

      {/* Profile Photo (optional) */}
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
            fileInput("photo", "image/jpeg,image/png,image/webp", "Upload Photo (JPG/PNG/WEBP, max 5MB)")
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
