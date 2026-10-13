const multer = require("multer");
const path = require("path");
const fs = require("fs");

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

const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".pdf"]);

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (ALLOWED_MIME.has(file.mimetype) && ALLOWED_EXT.has(ext)) return cb(null, true);
  const err = new Error("Only JPG, PNG, WEBP images or PDF files are allowed");
  err.statusCode = 400;
  cb(err);
};

const BYTE = (buf, ...sig) => sig.every((b, i) => buf[i] === b);
const SIGNATURE_CHECKS = {
  ".jpg": (buf) => BYTE(buf, 0xff, 0xd8, 0xff),
  ".jpeg": (buf) => BYTE(buf, 0xff, 0xd8, 0xff),
  ".png": (buf) => BYTE(buf, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  ".webp": (buf) =>
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP",
  ".pdf": (buf) => buf.length >= 5 && buf.toString("ascii", 0, 5) === "%PDF-",
};
const DANGEROUS_MARKERS = ["<html", "<script", "<?php", "<%", "<!doctype", "mz\x90\x00"];
const HEADER_SCAN_BYTES = 4096;

const unlinkQuiet = (p) => {
  try {
    if (p) fs.unlinkSync(p);
  } catch {
  }
};

const validateUploadedContent = (req, res, next) => {
  try {
    const groups = req.files && typeof req.files === "object" ? Object.values(req.files) : [];
    const files = [...groups.flat(), ...(req.file ? [req.file] : [])].filter(Boolean);
    if (!files.length) return next();
    for (const file of files) {
      const ext = path.extname(file.path || file.originalname || "").toLowerCase();
      const check = SIGNATURE_CHECKS[ext];
      let header;
      try {
        const fd = fs.openSync(file.path, "r");
        try {
          const buf = Buffer.alloc(Math.min(HEADER_SCAN_BYTES, file.size || HEADER_SCAN_BYTES));
          const read = fs.readSync(fd, buf, 0, buf.length, 0);
          header = buf.slice(0, read);
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        header = null;
      }
      const badSignature = !header || !check || !check(header);
      const headText = header ? header.toString("latin1").toLowerCase() : "";
      const hasMarker = DANGEROUS_MARKERS.some((m) => headText.includes(m));
      if (badSignature || hasMarker) {
        for (const f of files) unlinkQuiet(f.path);
        return res.status(400).json({
          message: "File content does not match its type — upload a genuine JPG, PNG, WEBP or PDF file.",
          code: "INVALID_FILE_CONTENT",
        });
      }
    }
    return next();
  } catch {
    return res.status(400).json({ message: "File upload failed" });
  }
};

const cookDocUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024, files: 3, fields: 5 },
});

module.exports = { cookDocUpload, cookDocUploadDir: uploadDir, validateUploadedContent };
