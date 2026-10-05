const crypto = require("crypto");

const TTL_MS = Number(process.env.DOC_URL_TTL_MS || 5 * 60 * 1000);

const b64url = (buf) =>
  Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64url = (s) => {
  const pad = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(pad.replace(/-/g, "+").replace(/_/g, "/"), "base64");
};

const signingKey = () => {
  const s = process.env.JWT_SECRET || "";
  return crypto.createHash("sha256").update(`doc-view:${s}`).digest();
};

const isPrivateDocPath = (docPath) => {
  const base = String(docPath || "").split("/").pop().split("?")[0].split("#")[0];
  if (!String(docPath || "").startsWith("/uploads")) return false;
  if (/^photo_/i.test(base)) return false;
  if (!/^(aadhar_|pan_)/i.test(base)) return false;
  if (base !== base.trim() || /[\\/]/.test(base)) return false;
  if (base === "." || base === ".." || base.includes("..")) return false;
  return true;
};

const signDocUrl = (docPath, userId, ttlMs = TTL_MS) => {
  if (!process.env.JWT_SECRET) throw new Error("Server auth is not configured");
  if (!isPrivateDocPath(docPath)) throw new Error("Document is not eligible for signed access");
  const uid = String(userId || "");
  if (!uid) throw new Error("User id is required");
  const exp = Date.now() + Math.max(30 * 1000, Math.min(ttlMs, 15 * 60 * 1000));
  const payload = JSON.stringify({ doc: docPath, uid, exp });
  const sig = crypto.createHmac("sha256", signingKey()).update(payload).digest();
  return {
    token: `${b64url(payload)}.${b64url(sig)}`,
    exp,
  };
};

const verifyDocToken = (token) => {
  if (!process.env.JWT_SECRET) return null;
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let payloadBuf;
  let sigBuf;
  try {
    payloadBuf = unb64url(parts[0]);
    sigBuf = unb64url(parts[1]);
  } catch {
    return null;
  }
  const expected = crypto.createHmac("sha256", signingKey()).update(payloadBuf).digest();
  if (sigBuf.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(sigBuf, expected)) return null;
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(payloadBuf.toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.doc !== "string" || typeof payload.uid !== "string") return null;
  if (!Number.isFinite(payload.exp) || Date.now() > payload.exp) return null;
  if (!isPrivateDocPath(payload.doc)) return null;
  return { doc: payload.doc, uid: payload.uid, exp: payload.exp };
};

module.exports = { signDocUrl, verifyDocToken, isPrivateDocPath, DOC_URL_TTL_MS: TTL_MS };
