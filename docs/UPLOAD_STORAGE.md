# Upload storage (verification documents)

Cook verification files (Aadhaar / PAN / photo) are written by multer to a
single directory resolved in `backend/utils/storage.js`:

- default: `<backend>/uploads/cook-docs` (local development / single host)
- production: set `UPLOAD_DIR` to a **persistent, dedicated** directory whose
  basename is `cook-docs` (the public URL prefix `/uploads/cook-docs/...` is
  baked into stored DB URLs, so the basename must stay `cook-docs` or the
  server refuses to start). Dedicated = nothing else lives in its parent: the
  static mount serves the parent directory (gated per-file), so siblings
  would be one misnamed file away from exposure.

The static `/uploads` mount, the Bearer gate, and the signed-URL viewer all
resolve through the same module, so writer and readers can never disagree on
the location.

## Production options

1. **Persistent disk (simplest, single instance):** attach the disk (e.g. at
   `/data`), migrate existing files, set `UPLOAD_DIR=/data/cook-docs`.
2. **Object storage (multi-instance / zero-loss):** S3 / Cloudflare R2. The
   seam is small — replace `resolveDocPath` reads with presigned-GET redirects
   (keeping the owner-or-admin check + short TTL in `routes/docs.js`), and
   point multer at the bucket (e.g. `multer-s3`). Keep the filename scheme
   (`<field>_<ownerUserId>_<ts>_...`) so ownership checks keep working, and
   keep `photo_*` public-read / `aadhar_*`+`pan_*` private.

## Rules (never regress)

- Private docs are NEVER publicly readable: owner cook or admin only, via
  Bearer-header static gate or short-lived HMAC doc token. Do not "fix"
  access problems by making the directory public.
- Filenames embed the OWNER cook's user id (`ownerIdOf`). Admin uploads are
  re-owned to the cook at upload time (`adminUploadCookDocs`).
- 2 MB/file, ≤3 files, JPG/PNG/WEBP/PDF allowlist (MIME + extension).
