
const {
  LAUNCH_SLABS,
  COMMISSION_RATE,
  isSlabDuration,
  slabPriceForDuration,
  splitPayout,
} = require("./utils/pricing");
const {
  normalizeCode,
  rejectionReason,
  computeDiscount,
} = require("./utils/coupons");
const { INITIAL_COUPONS, RETIRED_COUPON_CODES } = require("./utils/couponCatalog");

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
  if (!ok) failures++;
};

check("slab table matches launch prices", JSON.stringify(LAUNCH_SLABS) === JSON.stringify({ 1: 199, 2: 349, 3: 499, 4: 649 }));
check("3h costs 499", slabPriceForDuration(3) === 499);
check("5h has no slab", slabPriceForDuration(5) === null);
check("halves have no slab", slabPriceForDuration(1.5) === null);
check("isSlabDuration guards", isSlabDuration(4) === true && isSlabDuration(0) === false);
check("commission is 15%", COMMISSION_RATE === 0.15);
const split = splitPayout(449);
check("449 splits 67/382", split.commission === 67 && split.cookPayout === 382, JSON.stringify(split));

const flat50 = { discountType: "flat", flatAmount: 50, minOrder: 399 };
check("flat 50 off 499", computeDiscount(flat50, 499) === 50);
check("flat never exceeds order", computeDiscount({ discountType: "flat", flatAmount: 500 }, 199) === 199);
check("percent still works", computeDiscount({ discountType: "percent", percent: 20, maxDiscount: 500 }, 1000) === 200);
check("legacy coupon without type stays percent", computeDiscount({ percent: 10 }, 500) === 50);

check("unknown code rejected", rejectionReason(null, { amount: 499 }) === "This coupon is not valid for this booking.");
check("min order enforced", rejectionReason(flat50, { amount: 199 }) === "This coupon needs a minimum order of ₹399.");
check("min order passes", rejectionReason(flat50, { amount: 499 }) === null);
const usedOnce = { ...flat50, perUserLimit: 1, usedBy: ["u1"] };
check("reuse blocked", rejectionReason(usedOnce, { amount: 499, userId: "u1" }) === "You have already used this coupon.");
check("other user allowed", rejectionReason(usedOnce, { amount: 499, userId: "u2" }) === null);
const firstOnly = { ...flat50, firstBookingOnly: true, perUserLimit: null, usedBy: [] };
check("repeat customer blocked from first-booking coupon", rejectionReason(firstOnly, { amount: 499, userId: "u9", isFirstBooking: false }) === "This coupon is only for your first booking.");
check("new customer passes first-booking coupon", rejectionReason(firstOnly, { amount: 499, userId: "u9", isFirstBooking: true }) === null);
const scoped = { ...flat50, perUserLimit: null, usedBy: [], applicableServices: ["teach_me"] };
check("wrong service rejected", rejectionReason(scoped, { amount: 499, serviceType: "cook_for_me" }) === "This coupon is not valid for the selected service.");
check("right service passes", rejectionReason(scoped, { amount: 499, serviceType: "teach_me" }) === null);
check("code normalized", normalizeCode(" welcome50 ") === "WELCOME50");

const SLABS = Object.values(LAUNCH_SLABS);
const cache = {};

for (const c of INITIAL_COUPONS) {
  const label = `[${c.code}]`;
  cache[c.code] = c;

  const eligible = SLABS.filter(
    (slab) =>
      rejectionReason({ ...c, active: true }, { amount: slab }) === null &&
      computeDiscount(c, slab) > 0
  );
  check(
    `${label} redeemable on a launch slab`,
    eligible.length > 0,
    eligible.length ? `slabs ${eligible.join(", ")}` : `min order ₹${c.minOrder} exceeds top slab ₹${Math.max(...SLABS)}`
  );

  if (eligible.length > 0) {
    const cheapest = Math.min(...eligible);
    const discount = computeDiscount(c, cheapest);
    const commission = splitPayout(cheapest).commission;
    check(
      `${label} discount fits platform commission`,
      discount <= commission,
      `₹${discount} off ₹${cheapest} vs ₹${commission} commission`
    );
  }

  if (c.discountType === "percent") {
    check(`${label} percent coupon has a cap`, c.maxDiscount != null, `maxDiscount=${c.maxDiscount}`);
  }
}

check(
  "catalogue codes are unique",
  new Set(INITIAL_COUPONS.map((c) => c.code)).size === INITIAL_COUPONS.length
);
check(
  "retired codes never overlap the catalogue",
  RETIRED_COUPON_CODES.every((code) => !cache[code]),
  RETIRED_COUPON_CODES.filter((code) => cache[code]).join(", ")
);
check(
  "at least one coupon ships active",
  INITIAL_COUPONS.some((c) => c.active === true)
);

console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
