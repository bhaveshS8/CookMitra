const express = require("express");
const { body } = require("express-validator");
const validate = require("../middleware/validate");
const { auth, authorize } = require("../middleware/auth");
const { status, sendWhatsAppText } = require("../utils/whatsappApi");
const { verifyWebhook, handleInbound } = require("../controllers/whatsappController");

const router = express.Router();

// Meta inbound webhook (cook Accept/Decline taps). No session auth by design —
// the X-Hub-Signature-256 HMAC over the RAW body is the credential, and every
// tap is re-authorized against the sender's WhatsApp number + booking state.
// (server.js mounts express.raw() for this path so verification can run.)
router.get("/webhook", verifyWebhook);
router.post("/webhook", handleInbound);

// Public (authenticated) status — reports readiness WITHOUT leaking secrets.
// Frontend uses this to decide whether to show "updates on WhatsApp" hints.
router.get("/status", auth, (req, res) => {
  const s = status();
  res.json({ enabled: s.enabled, configured: s.configured });
});

// Admin-only test send: verifies token + phone ID + recipient delivery.
// Body: { to: "9876543210", message?: "custom text" }
router.post(
  "/test",
  auth,
  authorize("ADMIN"),
  [
    body("to").trim().notEmpty().withMessage("Recipient number is required"),
    body("message").optional().isLength({ max: 4000 }).withMessage("Message too long"),
  ],
  validate,
  async (req, res) => {
    const text =
      String(req.body.message || "").trim() ||
      "✅ CookMitra WhatsApp integration works! You will receive booking updates here.";
    const result = await sendWhatsAppText(req.body.to, text);
    if (result.ok) return res.json({ message: "Test message sent", id: result.id });
    const code = result.skipped ? 400 : 502;
    return res.status(code).json({
      message:
        result.reason === "whatsapp-disabled"
          ? "WhatsApp is not configured. Set WHATSAPP_ENABLED=true, WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID (see docs/WHATSAPP_SETUP.md)."
          : result.reason === "invalid-recipient"
            ? "Invalid recipient number — send a 10-digit Indian mobile number."
            : `WhatsApp send failed: ${result.error || result.reason || "unknown error"}`,
      ...result,
    });
  }
);

module.exports = router;
