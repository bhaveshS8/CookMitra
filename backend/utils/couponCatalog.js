// Promo coupon catalogue — single source of truth for the codes the platform
// ships with. Kept as a pure data module (no DB, no dotenv) so the pricing
// tests can assert that every live coupon is actually redeemable against the
// launch slabs without connecting to MongoDB.
//
// ─ How the ladder is designed ─────────────────────────────────────────────
// Launch slabs: 1h ₹199 · 2h ₹349 · 3h ₹499 · 4h ₹649 (25% platform commission).
// Two rules keep promos cheap but attractive:
//
//   1. Percent HEADLINE, flat COST: shoppers react to "% OFF", but a low cap
//      keeps the rupee cost fixed. FESTIVE20 shouts "20% OFF" yet can never
//      cost more than ₹70.
//   2. Bound the FREQUENCY, not just the size: every live code is
//      once-per-customer so one user can never bleed the margin dry. Total
//      max exposure per user across the whole ladder: 50 + 70 + 75 = ₹195.
//
// Every coupon below is sized so the discount fits INSIDE the platform's 25%
// on its smallest eligible session — so a discounted booking never eats into
// the cook's 75% share. `launch-pricing.test.js` enforces that invariant.
//
//   code        job                        min order   why
//   WELCOME50   acquire first booking      ₹349        flat ₹50 ≈ 14% on 2h, once, first-booking only
//   FESTIVE20   always-on festive hero     ₹349        20% capped at ₹70 (true 20% on 2h, capped above), once/user
//   REBOOK75    reward repeat bookings     ₹499        flat ₹75 ≈ 15% on 3h, once/user, 3h+ only
//   DIWALI100   push baskets to 4h         ₹649        flat ₹100 ≈ 15% on 4h, once/user, staged for Diwali
//
// Retired codes (see RETIRED_COUPON_CODES) were either unredeemable, false
// promises, or duplicates — run `npm run seed:coupons` to deactivate them.

// Coupons the platform ships with. `active: false` entries are staged
// campaigns the admin flips on from the Coupons tab when the season starts.
const INITIAL_COUPONS = [
  {
    code: "WELCOME50",
    description: "₹50 off your first booking (min order ₹349).",
    discountType: "flat",
    flatAmount: 50,
    minOrder: 349,
    perUserLimit: 1,
    firstBookingOnly: true,
    active: true,
  },
  {
    code: "FESTIVE20",
    description: "20% off festive bookings (min order ₹349).",
    discountType: "percent",
    percent: 20,
    maxDiscount: 70,
    minOrder: 349,
    perUserLimit: 1,
    firstBookingOnly: false,
    active: true,
  },
  {
    code: "REBOOK75",
    description: "₹75 off your next cook booking (min order ₹499).",
    discountType: "flat",
    flatAmount: 75,
    minOrder: 499,
    perUserLimit: 1,
    firstBookingOnly: false,
    active: true,
  },
  {
    code: "DIWALI100",
    description: "₹100 off festive faral sessions of 4 hours (min order ₹649).",
    discountType: "flat",
    flatAmount: 100,
    minOrder: 649,
    perUserLimit: 1,
    firstBookingOnly: false,
    active: false, // flip on for the Diwali faral season
  },
];

// Codes from earlier seed revisions that must not stay live. They are
// deactivated (never deleted — redemption history is append-only):
//
//   FESTIVE100  unredeemable: minOrder ₹799 exceeds the ₹649 top slab
//   NEWUSER100  duplicate of WELCOME50 (both are first-booking-only)
//   REFER50     implied referral tracking the platform does not have
//   REBOOK50    superseded by REBOOK75
//   WEEKDAY50   promised a weekday-only rule that was never implemented
//   FESTIVE50   superseded by FESTIVE20
const RETIRED_COUPON_CODES = [
  "FESTIVE100",
  "NEWUSER100",
  "REFER50",
  "REBOOK50",
  "WEEKDAY50",
  "FESTIVE50",
];

module.exports = { INITIAL_COUPONS, RETIRED_COUPON_CODES };