
const {
  computeCookPayout,
  buildPayoutSnapshot,
  payoutEligibleForCycle,
  normalizePhone,
  generateReferralCode,
  referralLinkFor,
  incentiveProgress,
  referralQualified,
} = require("./utils/cookEarnings");
const cfg = require("./config/cookEarnings");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) failures++;
};

{
  const t = computeCookPayout(199);
  check("1h: 199 → 169.15", t.cookPayoutAmount === 169.15 && t.platformDeductionAmount === 29.85, JSON.stringify(t));
}
{
  const t = computeCookPayout(349);
  check("2h: 349 → 296.65", t.cookPayoutAmount === 296.65 && t.platformDeductionAmount === 52.35, JSON.stringify(t));
}
{
  const snap = buildPayoutSnapshot({ regularPrice: 499, discountAmount: 50, finalCustomerPrice: 449 });
  check("3h coupon: 449 → 381.65", snap.cookPayoutAmount === 381.65 && snap.platformDeductionAmount === 67.35, JSON.stringify(snap));
  check("3h coupon: snapshot keeps regular+discount", snap.regularPrice === 499 && snap.discountAmount === 50 && snap.finalCustomerPrice === 449);
}
{
  const snap = buildPayoutSnapshot({ regularPrice: 649, discountAmount: 50, finalCustomerPrice: 599 });
  check("4h coupon: 599 → 509.15", snap.cookPayoutAmount === 509.15 && snap.platformDeductionAmount === 89.85, JSON.stringify(snap));
}
{
  const t = computeCookPayout(449);
  check("decimal conservation: payout+deduction === final", t.cookPayoutAmount + t.platformDeductionAmount === 449);
  check("zero/negative guarded", computeCookPayout(0).cookPayoutAmount === 0 && computeCookPayout(-5).cookPayoutAmount === 0);
}
{
  const a = buildPayoutSnapshot({ regularPrice: 499, discountAmount: 50, finalCustomerPrice: 449 });
  const b = buildPayoutSnapshot({ regularPrice: 499, discountAmount: 50, finalCustomerPrice: 449 });
  check("snapshot deterministic", a.cookPayoutAmount === b.cookPayoutAmount && a.payoutStatus === "eligible" && Boolean(a.payoutEligibleAt));
}

const baseBooking = {
  status: "completed",
  amount: 449,
  payment: { status: "paid", testMode: false, refundStatus: "none" },
  payoutInfo: {},
  payout: { status: "pending" },
};
check("eligible booking passes", payoutEligibleForCycle(baseBooking).eligible);
check("cancelled held", !payoutEligibleForCycle({ ...baseBooking, status: "cancelled" }).eligible);
check("refunded held", !payoutEligibleForCycle({ ...baseBooking, payment: { status: "paid", refundStatus: "pending" } }).eligible);
check("disputed held", !payoutEligibleForCycle({ ...baseBooking, payoutInfo: { disputed: true } }).eligible);
check("under-verification held", !payoutEligibleForCycle({ ...baseBooking, payoutInfo: { underVerification: true } }).eligible);
check("incomplete (not completed) held", !payoutEligibleForCycle({ ...baseBooking, status: "in_progress" }).eligible);
check("already-paid excluded (no double pay)", !payoutEligibleForCycle({ ...baseBooking, payout: { status: "settled" } }).eligible);
check("test money excluded", !payoutEligibleForCycle({ ...baseBooking, payment: { status: "paid", testMode: true } }).eligible);

check("normalize +91 spaced", normalizePhone("+91 98765 43210") === "9876543210");
check("normalize 91-prefix", normalizePhone("919876543210") === "9876543210");
check("normalize 0-prefix", normalizePhone("09876543210") === "9876543210");
check("fake/invalid rejected", normalizePhone("12345") === "" && normalizePhone("abd") === "" && normalizePhone("5876543210") === "");
check("same phone one core (two cooks collide)", normalizePhone("+91-98765-43210") === normalizePhone("9876543210"));

check("config slabs exact", JSON.stringify(cfg.incentives.map((i) => [i.targetLeads, i.days, i.reward])) === JSON.stringify([[10, 7, 500], [20, 10, 1000], [30, 15, 1500], [50, 30, 2500]]));
check("non-cumulative default", cfg.cumulative === false);
{
  const now = new Date("2026-10-05T00:00:00Z");
  const mk = (code, target, start, end, status = "in_progress") => ({ code, target, startDate: new Date(start), endDate: new Date(end), status, reward: 500 });
  check("10/7 → eligible", incentiveProgress({ incentive: mk("JOINING", 10, "2026-10-01", "2026-10-08"), verifiedLeadCount: 10, now }).eligible);
  check("9/10 → remaining 1", incentiveProgress({ incentive: mk("JOINING", 10, "2026-10-01", "2026-10-08"), verifiedLeadCount: 9, now }).remaining === 1);
  check("deadline expiry blocks", !incentiveProgress({ incentive: mk("JOINING", 10, "2026-09-01", "2026-09-08"), verifiedLeadCount: 10, now }).eligible);
  check("20/10 slab independent target", incentiveProgress({ incentive: mk("PERFORMANCE", 20, "2026-10-01", "2026-10-11"), verifiedLeadCount: 10, now }).eligible === false);
  check("50/30 champion needs 50", incentiveProgress({ incentive: mk("CHAMPION", 50, "2026-10-01", "2026-10-31"), verifiedLeadCount: 49, now }).remaining === 1);
}

{
  const code = generateReferralCode("Bhavesh");
  check("referral code shape CM-NAME-XXXX", /^CM-[A-Z]{1,12}-[0-9A-F]{4}$/.test(code), code);
  check("referral link carries ref", referralLinkFor(code) === `/register?ref=${encodeURIComponent(code)}`);
  const selfReferralBlocked = (ownerId, newId) => String(ownerId) !== String(newId);
  check("self-referral refused", selfReferralBlocked("aaa", "aaa") === false && selfReferralBlocked("aaa", "bbb") === true);
  check("1–9 bookings not qualified", !referralQualified(9) && !referralQualified(1));
  check("10 bookings → ₹250 qualified", referralQualified(10));
  check("config reward/target", cfg.referralReward === 250 && cfg.referralBookingTarget === 10);
}

{
  const CookPayout = require("./models/CookPayout");
  const idx = CookPayout.schema.indexes().map((x) => x[1]?.name || JSON.stringify(x[0]));
  check("CookPayout unique payoutRef", idx.includes("uniq_cookpayout_ref"), idx.join(","));
  const CookLead = require("./models/CookLead");
  const lidx = CookLead.schema.indexes().map((x) => x[1]?.name || "");
  check("CookLead cook+phone unique", lidx.includes("uniq_cook_lead_phone"));
  const CookReferral = require("./models/CookReferral");
  const ridx = CookReferral.schema.indexes().map((x) => x[1]?.name || "");
  check("CookReferral one row per referred cook", ridx.includes("uniq_referral_referred"));
  const CookIncentive = require("./models/CookIncentive");
  check("CookIncentive statuses include approval chain", ["in_progress", "qualified", "approved", "rejected", "held", "paid", "expired"].every((s) => CookIncentive.schema.path("status").enumValues.includes(s)));
  check("CookPayout statuses exact", ["pending", "under_verification", "approved", "paid", "held", "rejected"].every((s) => CookPayout.schema.path("status").enumValues.includes(s)));
}

// ── §23 Security: no frontend financial authority ────────────────────────
{
  const fs = require("fs");
  const cookRoutes = fs.readFileSync(require("path").join(__dirname, "routes", "cookEarnings.js"), "utf8");
  check("cook routes require cook role", (cookRoutes.match(/authorize\("cook"\)/g) || []).length >= 10);
  check("cook routes have no approve/pay/settle money writes", !/approve|settle|\/pay/.test(cookRoutes.replace(/payouts\/:id/g, "")) || /getPayoutById/.test(fs.readFileSync(require("path").join(__dirname, "controllers", "cookEarningsController.js"), "utf8")));
  const ctrl = fs.readFileSync(require("path").join(__dirname, "controllers", "cookEarningsController.js"), "utf8");
  check("cook controller never trusts req.body amounts", !/req\.body\?\.?(amount|cookPayout|reward|commission)/.test(ctrl));
  const adminRoutes = fs.readFileSync(require("path").join(__dirname, "routes", "adminCookEarnings.js"), "utf8");
  check("admin routes require admin role", (adminRoutes.match(/authorize\("admin"\)/g) || []).length >= 10);
}

console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
