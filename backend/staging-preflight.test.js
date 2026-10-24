process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
const { checkStagingReadiness } = require("./utils/stagingPreflight");
let passes = 0; let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); ok ? passes++ : failures++; };
const good = () => ({
  STAGING_MONGODB_URI: "mongodb+srv://u:p@cluster.net/cookmitra_staging?retryWrites=true",
  RAZORPAY_KEY_ID: "rzp_test_abc123", RAZORPAY_KEY_SECRET: "s3cr3tKeyValue",
  RAZORPAY_WEBHOOK_SECRET: "whsec", NODE_ENV: "staging",
  WHATSAPP_ENABLED: "true", WHATSAPP_TOKEN: "sandbox-token",
  WHATSAPP_PHONE_NUMBER_ID: "111", WHATSAPP_TEST_RECIPIENT: "9876543210",
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
check("no secrets in facts", !JSON.stringify(checkStagingReadiness(good()).facts).includes("s3cr3tKeyValue"));
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
