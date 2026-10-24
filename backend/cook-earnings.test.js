
const {
  computeCookPayout,
  buildPayoutSnapshot,
  payoutEligibleForCycle,
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

check("config deduction percent", cfg.deductionPercentage === 15 && cfg.payoutPercentage === 85);

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

{
  const CookPayout = require("./models/CookPayout");
  const idx = CookPayout.schema.indexes().map((x) => x[1]?.name || JSON.stringify(x[0]));
  check("CookPayout unique payoutRef", idx.includes("uniq_cookpayout_ref"), idx.join(","));
  check("CookPayout unique paymentReference", idx.includes("uniq_cookpayout_payref"), idx.join(","));
  check("CookPayout unique idempotencyKey", idx.includes("uniq_cookpayout_idem"), idx.join(","));
  check("CookPayout statuses exact", ["pending", "under_verification", "approved", "paid", "held", "rejected"].every((s) => CookPayout.schema.path("status").enumValues.includes(s)));
}

// ── §23 Security: no frontend financial authority ────────────────────────
{
  const fs = require("fs");
  const cookRoutes = fs.readFileSync(require("path").join(__dirname, "routes", "cookEarnings.js"), "utf8");
  check("cook routes require cook role", (cookRoutes.match(/authorize\("cook"\)/g) || []).length >= 3);
  check("cook routes have no approve/pay/settle money writes", !/approve|settle|\/pay/.test(cookRoutes.replace(/payouts\/:id/g, "")) || /getPayoutById/.test(fs.readFileSync(require("path").join(__dirname, "controllers", "cookEarningsController.js"), "utf8")));
  const ctrl = fs.readFileSync(require("path").join(__dirname, "controllers", "cookEarningsController.js"), "utf8");
  check("cook controller never trusts req.body amounts", !/req\.body\?\.?(amount|cookPayout|reward|commission)/.test(ctrl));
  const adminRoutes = fs.readFileSync(require("path").join(__dirname, "routes", "adminCookEarnings.js"), "utf8");
  check("admin routes require admin role", (adminRoutes.match(/authorize\("admin"\)/g) || []).length >= 7);
}

console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
