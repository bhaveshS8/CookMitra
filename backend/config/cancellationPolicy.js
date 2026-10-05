
const POLICY_VERSION = process.env.CANCELLATION_POLICY_VERSION || "2026-10-05-v1";

const gatewayFixedFee = Number(process.env.NON_REFUNDABLE_GATEWAY_FEE || 0);

module.exports = {
  version: POLICY_VERSION,
  gatewayFixedFee: Number.isFinite(gatewayFixedFee) && gatewayFixedFee > 0 ? gatewayFixedFee : 0,
  slabs: {
    BEFORE_ASSIGNMENT: { cancellationChargePercent: 0, refundPercent: 100 },
    MORE_THAN_24_HOURS: { cancellationChargePercent: 10, refundPercent: 90 },
    WITHIN_24_HOURS: { cancellationChargePercent: 25, refundPercent: 75 },
    WITHIN_6_HOURS: { cancellationChargePercent: 50, refundPercent: 50 },
    COOK_ARRIVED: { cancellationChargePercent: 100, refundPercent: 0 },
    CUSTOMER_NO_SHOW: { cancellationChargePercent: 100, refundPercent: 0 },
    COOK_CANCELLED: { cancellationChargePercent: 0, refundPercent: 100 },
    COOK_FAILED_SERVICE: { cancellationChargePercent: 0, refundPercent: 100 },
  },
};
