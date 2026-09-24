const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Local disk storage for cook verification documents (Aadhaar / PAN / photo).
// Directory comes from utils/storage (UPLOAD_DIR-aware) so writer, static
// mount and signed-URL viewer can never disagree on the location (F-01).
const { uploadDir } = require("../utils/storage");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-z0-9-_]+/gi, "_")
      .slice(0, 40);
    cb(null, `${file.fieldname}_${req.user?.id || "anon"}_${Date.now()}_${base}${ext}`);
  },
});

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

// MIME types are client-supplied and spoofable, so enforce the file extension
// too — otherwise an .html/.svg upload passes as image/jpeg and is served
// back verbatim under /uploads (stored XSS / content spoofing).
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (ALLOWED_MIME.has(file.mimetype) && ALLOWED_EXT.has(ext)) return cb(null, true);
  const err = new Error("Only JPG, PNG, WEBP images or PDF files are allowed");
  err.statusCode = 400;
  cb(err);
};

const cookDocUpload = multer({
  storage,
  fileFilter,
  // 2 MB per file, at most 3 files / 5 fields per request — a single-file
  // cap alone still allows disk-fill via many small parts.
  limits: { fileSize: 2 * 1024 * 1024, files: 3, fields: 5 },
});

module.exports = { cookDocUpload, cookDocUploadDir: uploadDir };
