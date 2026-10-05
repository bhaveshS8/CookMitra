
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
    description: "20% off festive bookings (min order ₹499).",
    discountType: "percent",
    percent: 20,
    maxDiscount: 70,
    minOrder: 499,
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
    code: "DIWALI90",
    description: "₹90 off festive faral sessions of 4 hours (min order ₹649).",
    discountType: "flat",
    flatAmount: 90,
    minOrder: 649,
    perUserLimit: 1,
    firstBookingOnly: false,
    active: false, // flip on for the Diwali faral season
  },
];

const RETIRED_COUPON_CODES = [
  "FESTIVE100",
  "NEWUSER100",
  "REFER50",
  "REBOOK50",
  "WEEKDAY50",
  "FESTIVE50",
  "DIWALI100",
];

module.exports = { INITIAL_COUPONS, RETIRED_COUPON_CODES };