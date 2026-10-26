process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
const { checkStagingReadiness } = require("./utils/stagingPreflight");
let passes = 0; let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); ok ? passes++ : failures++; };
const good = () => ({
  STAGING_MONGODB_URI: "mongodb+srv://u:p@cluster.net/cookmitra_staging?retryWrites=true",
  RAZORPAY_KEY_ID: "rzp_test_abc123", RAZORPAY_KEY_SECRET: "s3cr3tKeyValue",
  RAZORPAY_WEBHOOK_SECRET: "whsec", NODE_ENV: "staging",
  JWT_SECRET: "staging-only-jwt-secret-0123456789abcdef0123456789abcdef",
  STAGING_BASE_URL: "https://staging-api.cookmitra.example",
  WHATSAPP_ENABLED: "true", WHATSAPP_TOKEN: "sandbox-token",
  WHATSAPP_PHONE_NUMBER_ID: "111", WHATSAPP_TEST_RECIPIENT: "9876543210",
  WHATSAPP_APP_SECRET: "sandbox-app-secret",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "sandbox-verify-token",
  CLIENT_URL: "https://staging.cookmitra.example",
});
check("empty env blocked", checkStagingReadiness({}).ok === false);
check("good staging passes", checkStagingReadiness(good()).ok === true, JSON.stringify(checkStagingReadiness(good()).facts).slice(0, 80));
check("live key refused", checkStagingReadiness({ ...good(), RAZORPAY_KEY_ID: "rzp_live_x" }).ok === false);
check("non-test key refused", checkStagingReadiness({ ...good(), RAZORPAY_KEY_ID: "rk_test_x" }).ok === false);
check("prod-marked db refused", checkStagingReadiness({ ...good(), STAGING_MONGODB_URI: "mongodb://h/festivecook" }).ok === false);
check("same-as-prod refused", checkStagingReadiness({ ...good(), MONGODB_URI: good().STAGING_MONGODB_URI }).ok === false);
check("missing recipient refused", checkStagingReadiness({ ...good(), WHATSAPP_TEST_RECIPIENT: "" }).ok === false);
check("bad recipient refused", checkStagingReadiness({ ...good(), WHATSAPP_TEST_RECIPIENT: "123" }).ok === false);
check("prod NODE_ENV refused", checkStagingReadiness({ ...good(), NODE_ENV: "production" }).ok === false);
check("missing JWT secret refused", checkStagingReadiness({ ...good(), JWT_SECRET: "" }).ok === false);
check("weak JWT secret refused", checkStagingReadiness({ ...good(), JWT_SECRET: "short" }).ok === false);
check("missing staging base URL refused", checkStagingReadiness({ ...good(), STAGING_BASE_URL: "" }).ok === false);
check("localhost staging base URL refused", checkStagingReadiness({ ...good(), STAGING_BASE_URL: "http://localhost:5000" }).ok === false);
check("production staging base URL refused", checkStagingReadiness({ ...good(), STAGING_BASE_URL: "https://festivecook.example" }).ok === false);
check("invalid CLIENT_URL refused", checkStagingReadiness({ ...good(), CLIENT_URL: "staging-frontend" }).ok === false);
check("production CLIENT_URL refused", checkStagingReadiness({ ...good(), CLIENT_URL: "https://festivecook.example" }).ok === false);
check("whatsapp disabled refused", checkStagingReadiness({ ...good(), WHATSAPP_ENABLED: "false" }).ok === false);
check("missing app secret refused", checkStagingReadiness({ ...good(), WHATSAPP_APP_SECRET: "" }).ok === false);
check("missing verify token refused", checkStagingReadiness({ ...good(), WHATSAPP_WEBHOOK_VERIFY_TOKEN: "" }).ok === false);
check("legacy verify-token alias accepted", checkStagingReadiness({
  ...good(),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "",
  WHATSAPP_VERIFY_TOKEN: "legacy-verify-token",
}).ok === true);
check("missing CLIENT_URL refused", checkStagingReadiness({ ...good(), CLIENT_URL: "" }).ok === false);
check("localhost CLIENT_URL refused", checkStagingReadiness({ ...good(), CLIENT_URL: "http://localhost:3000" }).ok === false);
check("no secrets in facts", !/s3cr3tKeyValue|sandbox-token|sandbox-app-secret|sandbox-verify-token/.test(JSON.stringify(checkStagingReadiness(good()).facts)));
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
