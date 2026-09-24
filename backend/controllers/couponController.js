const Coupon = require("../models/Coupon");
const Booking = require("../models/Booking");
const { normalizeCode, rejectionReason, computeDiscount } = require("../utils/coupons");
const { paginationParams, applyPagination, sendList } = require("../utils/pagination");

// POST /api/coupons/validate — preview a coupon against an order amount.
// Auth required (per-user limits need the user). Never mutates usage.
// Body: { code, amount, serviceType? }.
exports.validateCoupon = async (req, res, next) => {
  try {
    const { code, amount, serviceType } = req.body;
    const coupon = await Coupon.findOne({ code: normalizeCode(code) });
    // First-booking check only runs for coupons that need it, so plain
    // coupons never pay the extra query.
    let isFirstBooking;
    if (coupon?.firstBookingOnly && req.user?.id) {
      isFirstBooking =
        (await Booking.countDocuments({ customer: req.user.id })) === 0;
    }
    const reason = rejectionReason(coupon, {
      amount,
      userId: req.user?.id,
      serviceType,
      isFirstBooking,
    });
    if (reason) {
      return res.status(400).json({ message: reason });
    }
    const fullFee = Math.round(Number(amount));
    const discount = computeDiscount(coupon, fullFee);
    if (discount <= 0) {
      return res.status(400).json({ message: "This coupon gives no discount on this order." });
    }
    res.json({
      code: coupon.code,
      discountType: coupon.discountType || "percent",
      percent: coupon.percent,
      flatAmount: coupon.flatAmount,
      maxDiscount: coupon.maxDiscount,
      discount,
      fullFee,
      payable: fullFee - discount,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/coupons/active — public list of currently usable offers
// (codes are promos meant to be shared; per-user state is checked at apply).
exports.listActiveCoupons = async (req, res, next) => {
  try {
    const now = new Date();
    const pg = paginationParams(req);
    const coupons = await applyPagination(
      Coupon.find({
        active: true,
        $and: [
          { $or: [{ validFrom: null }, { validFrom: { $lte: now } }] },
          { $or: [{ validTo: null }, { validTo: { $gte: now } }] },
          {
            $or: [
              { usageLimit: null },
              { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
            ],
          },
        ],
      })
        .select(
          // perUserLimit is customer-facing ("one per customer") — keep it
          // in the public list alongside the other enforced terms.
          "code description discountType percent flatAmount maxDiscount minOrder firstBookingOnly perUserLimit validTo"
        )
        .sort({ percent: -1 }),
      pg
    );
    // Total must count the whole active set, not just the returned page.
    const countActive = () =>
      Coupon.countDocuments({
        active: true,
        $and: [
          { $or: [{ validFrom: null }, { validFrom: { $lte: now } }] },
          { $or: [{ validTo: null }, { validTo: { $gte: now } }] },
          {
            $or: [
              { usageLimit: null },
              { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
            ],
          },
        ],
      });
    return sendList(res, coupons, pg, countActive);
  } catch (error) {
    next(error);
  }
};

// GET /api/coupons — admin: every coupon with usage stats.
exports.listCoupons = async (req, res, next) => {
  try {
    const pg = paginationParams(req);
    const coupons = await applyPagination(Coupon.find().sort({ createdAt: -1 }), pg);
    return sendList(res, coupons, pg, () => Coupon.countDocuments());
  } catch (error) {
    next(error);
  }
};

// Phase 12: explicit write-allowlist (mass assignment). Only these fields may
// ever reach the Coupon model — usage accounting (usedCount/usedBy/createdBy)
// is server-owned, and $-prefixed keys can never become update operators.
const COUPON_WRITABLE = [
  "code",
  "description",
  "discountType",
  "percent",
  "flatAmount",
  "maxDiscount",
  "minOrder",
  "usageLimit",
  "perUserLimit",
  "firstBookingOnly",
  "applicableServices",
  "validFrom",
  "validTo",
  "active",
];
const pickCouponWritable = (obj) => {
  const out = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const key of COUPON_WRITABLE) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  return out;
};

// POST /api/coupons — admin: create a coupon. Usage accounting is
// server-owned: usedCount/usedBy can never be set at creation (update strips
// them too) — otherwise promo history could be forged.
exports.createCoupon = async (req, res, next) => {
  try {
    const body = pickCouponWritable(req.body);
    const coupon = await Coupon.create({
      ...body,
      code: normalizeCode(req.body.code),
      createdBy: req.user.id,
    });
    res.status(201).json(coupon);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "A coupon with this code already exists" });
    }
    next(error);
  }
};

// PATCH /api/coupons/:id — admin: edit a coupon (incl. active toggle).
// usedCount/usedBy history is append-only: edits can never rewrite it.
exports.updateCoupon = async (req, res, next) => {
  try {
    const editable = pickCouponWritable(req.body);
    if (req.body.code !== undefined) editable.code = normalizeCode(req.body.code);
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, editable, {
      new: true,
      runValidators: true,
    });
    if (!coupon) {
      return res.status(404).json({ message: "Coupon not found" });
    }
    res.json(coupon);
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "A coupon with this code already exists" });
    }
    next(error);
  }
};

// DELETE /api/coupons/:id — admin: delete a coupon that was never used.
// Used coupons are history (bookings reference them), so deactivate instead.
exports.deleteCoupon = async (req, res, next) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ message: "Coupon not found" });
    }
    if (Number(coupon.usedCount) > 0) {
      return res.status(400).json({
        message: `Cannot delete ${coupon.code} — it has ${coupon.usedCount} redemption(s). Deactivate it instead.`,
      });
    }
    await coupon.deleteOne();
    res.json({ message: `Coupon ${coupon.code} deleted`, id: coupon._id });
  } catch (error) {
    next(error);
  }
};
