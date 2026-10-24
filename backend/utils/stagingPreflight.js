// Fail-closed staging preflight: pure inspection only.
// No Razorpay calls, no WhatsApp sends, no DB writes.
const maskTail = (v) => { const s = String(v || ""); return s ? `SET(len=${s.length})` : "MISSING"; };
const isPlaceholder = (v) => !v || /x{4,}/i.test(v) || /^your_/i.test(v) || /example/i.test(v) || /change_?me/i.test(v) || /sample/i.test(v) || /<.*>/.test(v);
const looksTestKey = (k) => String(k || "").startsWith("rzp_test_");
const looksLiveKey = (k) => String(k || "").startsWith("rzp_live_");
const PROD_MARKERS = [/festivecook/i, /prod/i, /live/i];
const STAGING_MARKERS = [/staging/i, /_test/i, /-test/i, /\/test/i, /qa/i];
const isLocalUrl = (value) => /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(String(value || ""));
const isHttpUrl = (value) => {
  try {
    const parsed = new URL(String(value || ""));
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
};
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
  const jwtSecret = String(env.JWT_SECRET || "").trim();
  const stagingBaseUrl = String(env.STAGING_BASE_URL || "").trim();
  facts.jwtSecret = maskTail(jwtSecret);
  facts.stagingBaseUrl = stagingBaseUrl ? "SET" : "MISSING";
  if (isPlaceholder(jwtSecret) || jwtSecret.length < 32) {
    blockers.push("JWT_SECRET missing/placeholder/too short - use a random staging-only secret (32+ chars; 64+ recommended).");
  }
  if (!stagingBaseUrl) {
    blockers.push("STAGING_BASE_URL missing - set the isolated staging API origin for E2E and webhook URLs.");
  } else if (!isHttpUrl(stagingBaseUrl)) {
    blockers.push("STAGING_BASE_URL must be an absolute http(s) URL.");
  } else if (isLocalUrl(stagingBaseUrl)) {
    blockers.push("STAGING_BASE_URL points at localhost - use the deployed staging hostname.");
  } else if (PROD_MARKERS.some((re) => re.test(stagingBaseUrl))) {
    blockers.push("STAGING_BASE_URL looks like production. Refusing.");
  }
  if (String(env.NODE_ENV || "").toLowerCase() === "production") blockers.push("NODE_ENV=production in staging shell — refusing.");
  const waEnabled = String(env.WHATSAPP_ENABLED || "").toLowerCase() === "true";
  const waToken = String(env.WHATSAPP_TOKEN || "").trim();
  const waPhoneId = String(env.WHATSAPP_PHONE_NUMBER_ID || "").trim();
  const waAppSecret = String(env.WHATSAPP_APP_SECRET || "").trim();
  const waVerifyToken = String(
    env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || env.WHATSAPP_VERIFY_TOKEN || ""
  ).trim();
  const waTpl = String(env.WHATSAPP_REQUEST_TEMPLATE || env.WHATSAPP_REQUEST_TEMPLATE_FOR_COOK || "").trim();
  const waLang = String(env.WHATSAPP_REQUEST_TEMPLATE_LANG || env.WHATSAPP_TEMPLATE_LANG_COOK_REQUEST || "en").trim();
  const waTo = String(env.WHATSAPP_TEST_RECIPIENT || env.WHATSAPP_SANDBOX_TO || "").trim();
  const clientUrl = String(env.CLIENT_URL || "").trim();
  facts.whatsapp = {
    enabled: waEnabled,
    token: maskTail(waToken),
    phoneNumberId: waPhoneId ? "SET" : "MISSING",
    appSecret: maskTail(waAppSecret),
    verifyToken: maskTail(waVerifyToken),
    template: waTpl || "default:cook_booking_request",
    lang: waLang,
    testRecipient: waTo ? "SET" : "MISSING",
  };
  facts.clientUrl = clientUrl ? "SET" : "MISSING";
  if (!waEnabled) blockers.push("WHATSAPP_ENABLED must be 'true' for the full staging E2E - sandbox delivery would be skipped.");
  if (!waToken) blockers.push("WHATSAPP_TOKEN missing - supply Meta sandbox/staging token.");
  if (!waPhoneId) blockers.push("WHATSAPP_PHONE_NUMBER_ID missing - supply sandbox test Phone Number ID.");
  if (!waAppSecret) blockers.push("WHATSAPP_APP_SECRET missing - forged webhook rejection cannot be verified.");
  if (!waVerifyToken) blockers.push("WHATSAPP_WEBHOOK_VERIFY_TOKEN (alias WHATSAPP_VERIFY_TOKEN) missing - Meta callback verification cannot pass.");
  if (!waTo) blockers.push("WHATSAPP_TEST_RECIPIENT (alias WHATSAPP_SANDBOX_TO) missing - one opted-in sandbox number; preflight never sends.");
  else if (!/^[6-9]\d{9}$/.test(waTo.replace(/\D/g, "").slice(-10))) blockers.push("WHATSAPP_TEST_RECIPIENT must be 10-digit Indian mobile.");
  if (!clientUrl) blockers.push("CLIENT_URL missing - staging links would fall back to localhost.");
  else if (!isHttpUrl(clientUrl)) blockers.push("CLIENT_URL must be an absolute http(s) URL for the staging frontend.");
  else if (isLocalUrl(clientUrl)) blockers.push("CLIENT_URL points at localhost - staging links must use the staging hostname.");
  else if (PROD_MARKERS.some((re) => re.test(clientUrl))) blockers.push("CLIENT_URL looks like production. Refusing.");
  return { ok: blockers.length === 0, blockers, warnings, facts };
};
module.exports = { checkStagingReadiness, uriDbHint, looksTestKey, looksLiveKey };

if (require.main === module) {
  const result = checkStagingReadiness(process.env);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error("STAGING PREFLIGHT FAILED: fix the blockers above. No external call was made.");
    process.exitCode = 1;
  }
}
