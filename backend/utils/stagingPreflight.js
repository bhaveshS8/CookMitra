// Fail-closed staging preflight: pure inspection only.
// No Razorpay calls, no WhatsApp sends, no DB writes.
const maskTail = (v) => { const s = String(v || ""); return s ? `SET(len=${s.length})` : "MISSING"; };
const isPlaceholder = (v) => !v || /x{4,}/i.test(v) || /^your_/i.test(v) || /example/i.test(v) || /change_?me/i.test(v) || /sample/i.test(v) || /<.*>/.test(v);
const looksTestKey = (k) => String(k || "").startsWith("rzp_test_");
const looksLiveKey = (k) => String(k || "").startsWith("rzp_live_");
const PROD_MARKERS = [/festivecook/i, /prod/i, /live/i];
const STAGING_MARKERS = [/staging/i, /_test/i, /-test/i, /\/test/i, /qa/i];
const uriDbHint = (uri) => {
  try {
    const s = String(uri || "");
    const m = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]*)\/([^?]*)/);
    if (!m) return "unparseable-uri";
    return `${s.startsWith("mongodb+srv") ? "srv" : "std"}://${m[1].replace(/^[^@]*@/, "***@")}/${(m[2] || "").split("?")[0] || "<no-db>"}`;
  } catch { return "unparseable-uri"; }
};
const checkStagingReadiness = (env = process.env) => {
  const blockers = []; const warnings = []; const facts = {};
  const stagingUri = String(env.STAGING_MONGODB_URI || "").trim();
  const prodUri = String(env.MONGODB_URI || "").trim();
  facts.stagingUri = stagingUri ? uriDbHint(stagingUri) : "MISSING";
  facts.prodUriPresent = Boolean(prodUri);
  if (!stagingUri) blockers.push("STAGING_MONGODB_URI missing. Create empty isolated staging DB; never reuse production MONGODB_URI.");
  else {
    if (isPlaceholder(stagingUri) || stagingUri.includes("<")) blockers.push("STAGING_MONGODB_URI looks like a placeholder.");
    if (!STAGING_MARKERS.some((re) => re.test(stagingUri))) blockers.push(`STAGING_MONGODB_URI has no staging/test marker (hint: ${facts.stagingUri}).`);
    if (PROD_MARKERS.some((re) => re.test(stagingUri))) blockers.push(`STAGING_MONGODB_URI looks like production (hint: ${facts.stagingUri}). Refusing.`);
    if (prodUri && stagingUri === prodUri) blockers.push("STAGING_MONGODB_URI equals MONGODB_URI — staging must never be production.");
  }
  if (!prodUri) warnings.push("MONGODB_URI unset — fine for preflight.");
  const keyId = String(env.RAZORPAY_KEY_ID || "").trim();
  const keySecret = String(env.RAZORPAY_KEY_SECRET || "").trim();
  const whSecret = String(env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  facts.razorpayKey = keyId ? `prefix=${keyId.slice(0, 9)}*** len=${keyId.length}` : "MISSING";
  facts.razorpaySecret = maskTail(keySecret);
  facts.razorpayWebhook = whSecret ? "SET" : "MISSING";
  if (!keyId || !keySecret) blockers.push("RAZORPAY_KEY_ID/SECRET missing — supply rzp_test_* out-of-band.");
  else if (looksLiveKey(keyId)) blockers.push(`RAZORPAY_KEY_ID is LIVE (${keyId.slice(0, 9)}***). Refusing: staging needs rzp_test_* only.`);
  else if (!looksTestKey(keyId)) blockers.push(`RAZORPAY_KEY_ID not confirmed rzp_test_* (${keyId.slice(0, 9)}***).`);
  if (isPlaceholder(keySecret)) blockers.push("RAZORPAY_KEY_SECRET missing/placeholder.");
  if (!whSecret) blockers.push("RAZORPAY_WEBHOOK_SECRET missing — webhook/reconcile unverifiable.");
  if (String(env.NODE_ENV || "").toLowerCase() === "production") blockers.push("NODE_ENV=production in staging shell — refusing.");
  const waEnabled = String(env.WHATSAPP_ENABLED || "").toLowerCase() === "true";
  const waToken = String(env.WHATSAPP_TOKEN || "").trim();
  const waPhoneId = String(env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const waTpl = String(env.WHATSAPP_REQUEST_TEMPLATE || env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK || "").trim();
  const waLang = String(env.WHATSAPP_REQUEST_TEMPLATE_LANG || env.WHATSAPP_TEMPLATE_LANG_COOK_REQUEST || "en").trim();
  const waTo = String(env.WHATSAPP_TEST_RECIPIENT || env.WHATSAPP_SANDBOX_TO || "").trim();
  facts.whatsapp = { enabled: waEnabled, token: maskTail(waToken), phoneNumberId: waPhoneId ? "SET" : "MISSING", template: waTpl || "default:cook_booking_request", lang: waLang, testRecipient: waTo ? "SET" : "MISSING" };
  if (!waEnabled) warnings.push("WHATSAPP_ENABLED != 'true' — sandbox sends stay disabled.");
  if (!waToken) blockers.push("WHATSAPP_TOKEN missing — supply Meta sandbox/staging token.");
  if (!waPhoneId) blockers.push("WHATSAPP_PHONE_NUMBER_ID missing — supply sandbox test Phone Number ID.");
  if (!waTo) blockers.push("WHATSAPP_TEST_RECIPIENT (alias WHATSAPP_SANDBOX_TO) missing — one opted-in sandbox number; preflight never sends.");
  else if (!/^[6-9]\d{9}$/.test(waTo.replace(/\D/g, "").slice(-10))) blockers.push("WHATSAPP_TEST_RECIPIENT must be 10-digit Indian mobile.");
  return { ok: blockers.length === 0, blockers, warnings, facts };
};
module.exports = { checkStagingReadiness, uriDbHint, looksTestKey, looksLiveKey };
