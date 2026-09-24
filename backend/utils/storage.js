// Private-document storage — single source of truth for WHERE verification
// files (Aadhaar / PAN / photo) live on disk.
//
// Default: <backend>/uploads/cook-docs (development / single-host).
// Production MUST set UPLOAD_DIR to a persistent volume (Render disk, mounted
// volume). Ephemeral container disks are wiped on redeploy and uploaded ID
// documents would be LOST. For multi-instance or zero-loss durability use
// object storage (S3/R2) — see docs/UPLOAD_STORAGE.md.
//
// All readers (static /uploads mount, signed-URL view) resolve through
// resolveDocPath() so the directory can never drift between writer and reader
// (the F-01 class of bug: multer wrote to cook-docs/ while the viewer read
// uploads/).
const path = require("path");
const fs = require("fs");

const DEFAULT_DIR = path.join(__dirname, "..", "uploads", "cook-docs");

// UPLOAD_DIR is the EXACT directory holding the doc files (migrate existing
// files there when changing it). Trailing slashes and ~ are not expanded.
const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : DEFAULT_DIR;

// The public URL prefix is /uploads/<basename>/ — every stored DB URL already
// carries "cook-docs", so a custom UPLOAD_DIR must keep that basename.
if (path.basename(uploadDir) !== "cook-docs") {
  console.error(
    `storage: UPLOAD_DIR must end in "cook-docs" (got ${uploadDir}) — ` +
      "otherwise stored /uploads/cook-docs/... URLs break. Refusing to start."
  );
  process.exit(1);
}

try {
  fs.mkdirSync(uploadDir, { recursive: true });
} catch (err) {
  console.error(`storage: cannot create upload dir ${uploadDir}: ${err && err.message}`);
}

if (process.env.NODE_ENV === "production" && !process.env.UPLOAD_DIR) {
  console.warn(
    "storage: UPLOAD_DIR is not set — verification documents are stored on the " +
      "local container disk and WILL BE LOST on redeploy. Mount a persistent " +
      "disk (UPLOAD_DIR=/data/...) or migrate to S3/R2 (docs/UPLOAD_STORAGE.md)."
  );
}

// Absolute path for a flat doc filename, or null when the name is not a
// plain file inside the upload dir (traversal / nested-path defense).
const resolveDocPath = (base) => {
  const name = path.basename(String(base || ""));
  if (!name || name !== String(base || "").trim()) return null;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return null;
  const full = path.join(uploadDir, name);
  if (path.dirname(full) !== uploadDir) return null;
  return full;
};

// Owner segment of a stored filename: <field>_<userId>_<ts>_...<ext>.
const ownerIdOf = (base) => String(path.basename(String(base || ""))).split("_")[1] || "";

module.exports = { uploadDir, resolveDocPath, ownerIdOf };
