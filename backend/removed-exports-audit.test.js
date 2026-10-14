// Removed-exports audit: locks intentional API removals from the
// referral/lead/incentive cleanup so accidental re-export or missing
// internal use is caught. Offline: no DB, no network.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
const bookingController = require("./controllers/bookingController");
const transitions = require("./services/bookingTransitions");
let passes = 0; let failures = 0;
const check = (n, ok, d) => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  -> " + d : ""}`); ok ? passes++ : failures++; };

// Intentionally removed from bookingController (dead code / moved ownership)
check("sessionStartDate not re-exported", bookingController.sessionStartDate === undefined);
check("RESCHEDULE_REASONS removed", bookingController.RESCHEDULE_REASONS === undefined);
check("normalizeRescheduleReason removed", bookingController.normalizeRescheduleReason === undefined);
check("sweepExpiredBookings not re-exported via controller", bookingController.sweepExpiredBookings === undefined);

// Still present (callers depend on these)
check("sessionEndDate still exported", typeof bookingController.sessionEndDate === "function");
check("cancelLocked still exported", typeof bookingController.cancelLocked === "function");
check("rescheduleLocked still exported", typeof bookingController.rescheduleLocked === "function");
check("sweepExpiredBookings owned by transitions", typeof transitions.sweepExpiredBookings === "function");

// Cook-cancel / replacement / payout-override surface still present
check("cancelBooking present", typeof bookingController.cancelBooking === "function");
check("acceptBooking present", typeof bookingController.acceptBooking === "function");
const finance = require("./utils/finance");
check("payoutEligibility exposes verificationOnly", "verificationOnly" in finance.payoutEligibility({ payment: {}, payout: {} }));

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
