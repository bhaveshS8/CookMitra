const path = require("path");
const fs = require("fs");

const DEFAULT_DIR = path.join(__dirname, "..", "uploads", "cook-docs");

const uploadDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : DEFAULT_DIR;

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

const resolveDocPath = (base) => {
  const name = path.basename(String(base || ""));
  if (!name || name !== String(base || "").trim()) return null;
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return null;
  const full = path.join(uploadDir, name);
  if (path.dirname(full) !== uploadDir) return null;
  return full;
};

const ownerIdOf = (base) => String(path.basename(String(base || ""))).split("_")[1] || "";

module.exports = { uploadDir, resolveDocPath, ownerIdOf };
