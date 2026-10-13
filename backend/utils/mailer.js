
const canDeliver = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);

const { resolveFrontendBaseUrl, isLocalhost } = require("./frontendBase");

const sendResetEmail = async ({ to, name, token }) => {
  if (!canDeliver()) return { delivered: false, reason: "smtp-not-configured" };
  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch {
    console.error(
      "SMTP_HOST is set but nodemailer is not installed — run `npm i nodemailer` in backend/ to enable reset emails."
    );
    return { delivered: false, reason: "nodemailer-missing" };
  }
  const appBase = resolveFrontendBaseUrl() || "http://localhost:3000";
  if (process.env.NODE_ENV === "production" && isLocalhost(appBase)) {
    console.error(
      "CONFIG ERROR: reset-email link would point at localhost in production — set FRONTEND_BASE_URL=https://<your-live-domain> (FRONTEND_URL/CLIENT_URL also honored) and restart/redeploy. Refusing to send a broken link."
    );
    return { delivered: false, reason: "reset-base-not-configured" };
  }
  const resetUrl = `${String(appBase).replace(/\/$/, "")}/reset-password?token=${token}`;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" },
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: "Reset your CookMitra password",
    text: [
      `Hi ${name || "there"},`,
      "",
      "Someone requested a password reset for your CookMitra account.",
      "If that was you, set a new password within 1 hour:",
      resetUrl,
      "",
      "If you did not request this, just ignore this email.",
    ].join("\n"),
  });
  return { delivered: true };
};

module.exports = { canDeliver, sendResetEmail };
