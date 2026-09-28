// Password-reset delivery hook.
//
// There is no email provider wired in this codebase yet, so this module tries
// SMTP when explicitly configured (SMTP_HOST/PORT/USER/PASS/FROM) and reports
// whether the token actually left the server. Callers decide what to do when
// delivery is unavailable:
// - non-production: return the raw token in the API response (dev testing);
// - production without SMTP: generic message only (configure SMTP to go live).
// When SMTP_* is configured but nodemailer isn't installed, delivery is
// skipped with a clear log line — install nodemailer + set the vars to enable.

const canDeliver = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);

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
  const appBase =
    process.env.CLIENT_URL || process.env.FRONTEND_BASE_URL || "http://localhost:3000";
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
