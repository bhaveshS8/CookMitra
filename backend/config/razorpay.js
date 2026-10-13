const Razorpay = require("razorpay");

const keyId = process.env.RAZORPAY_KEY_ID || "";
const keySecret = process.env.RAZORPAY_KEY_SECRET || "";

const looksPlaceholder = (v) =>
  !v || /x{4,}/i.test(v) || /^your_/i.test(v) || /example/i.test(v) || /change_?me/i.test(v) || /sample/i.test(v);

const isConfigured =
  Boolean(keyId && keySecret) && !looksPlaceholder(keyId) && !looksPlaceholder(keySecret);

let instance = null;
if (isConfigured) {
  instance = new Razorpay({ key_id: keyId, key_secret: keySecret });
}

module.exports = { razorpay: instance, isConfigured, keyId };
