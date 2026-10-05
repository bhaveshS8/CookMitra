import React, { useState, useEffect } from "react";
import { FileText, X, ExternalLink } from "lucide-react";
import { resolveFileUrl } from "./CookDocUploads";
import { useSignedDocUrl, isPrivateDocPath } from "../utils/docUrls";

export const isPdfUrl = (url) => /\.pdf(\?|#|$)/i.test(url || "");

const ThumbImg = ({ src, alt }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed || !src) {
    return (
      <span className="admin-doc-pdf">
        <FileText size={26} />
        <span>FILE</span>
      </span>
    );
  }
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
};

const useViewUrl = (storedPath) => {
  const needsSigned = isPrivateDocPath(storedPath);
  const signed = useSignedDocUrl(needsSigned ? storedPath : "");
  if (!storedPath) return { url: "", loading: false, error: "" };
  if (!needsSigned) return { url: resolveFileUrl(storedPath), loading: false, error: "" };
  return signed;
};

const ThumbButton = ({ doc, index, onOpen }) => {
  const { url, loading } = useViewUrl(doc.url);
  const pdf = isPdfUrl(doc.url);
  return (
    <button
      type="button"
      className="admin-doc-thumb"
      onClick={() => onOpen(index)}
      title={`View ${doc.label}`}
    >
      {pdf ? (
        <span className="admin-doc-pdf">
          <FileText size={26} />
          <span>PDF</span>
        </span>
      ) : (
        <ThumbImg src={loading ? "" : url} alt={doc.label} />
      )}
      <span className="admin-doc-label">{doc.label}</span>
    </button>
  );
};

const LightboxBody = ({ doc }) => {
  const { url, loading, error } = useViewUrl(doc.url);
  if (loading) return <p>Preparing secure preview…</p>;
  if (error || !url) return <p>{error || "Document preview unavailable."}</p>;
  return (
    <>
      <div className="admin-doc-lightbox-bar">
        <strong>{doc.label}</strong>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <a href={url} target="_blank" rel="noreferrer" className="btn btn-outline btn-sm">
            <ExternalLink size={14} /> Open original
          </a>
        </div>
      </div>
      {isPdfUrl(doc.url) ? (
        <iframe src={url} title={doc.label} />
      ) : (
        <img src={url} alt={doc.label} />
      )}
    </>
  );
};

const AdminDocViewer = ({ docs }) => {
  const [active, setActive] = useState(null);
  const items = (docs || []).filter((d) => d?.url);

  useEffect(() => {
    if (active === null) return;
    const onKey = (e) => {
      if (e.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [active]);

  useEffect(() => {
    if (active !== null) return undefined;
    const el = document.querySelector(".admin-doc-thumb:focus");
    if (el) el.blur();
    return undefined;
  }, [active]);

  const missing = (docs || []).filter((d) => !d?.url);

  return (
    <>
      <div className="admin-doc-grid">
        {items.map((d, i) => (
          <ThumbButton key={i} doc={d} index={i} onOpen={setActive} />
        ))}
        {missing.map((d, i) => (
          <span key={`m-${i}`} className="admin-doc-missing">
            {d.label}: not uploaded
          </span>
        ))}
      </div>

      {active !== null && items[active] && (
        <div className="admin-doc-lightbox" onClick={() => setActive(null)}>
          <div className="admin-doc-lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <LightboxBody doc={items[active]} />
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setActive(null)}>
              <X size={14} /> Close
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default AdminDocViewer;
