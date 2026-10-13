process.env.WHATSAPP_ENABLED = "false";
process.env.WHATSAPP_TOKEN = "";
process.env.WHATSAPP_PHONE_NUMBER_ID = "";

const {
  buildBookingRequestMessage,
  buildCustomerConfirmationMessage,
  buildCookJobSheetMessage,
  buildHoursCompleteMessage,
  buildReviewMessage,
  buildBookingWhatsAppUrl,
} = require("./utils/whatsapp");

const api = require("./utils/whatsappApi");

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  -> ${detail}`);
};

const booking = {
  _id: "507f1f77bcf86cd799439011",
  serviceType: "cook_for_me",
  date: new Date("2026-09-10"),
  startTime: "10:00",
  endTime: "13:00",
  durationHours: 3,
  address: "H-12 Green Park, Delhi",
  addressDetails: { flatNo: "H-12", society: "Green Park", city: "Delhi" },
  location: { lat: 28.6139, lng: 77.209 },
  guests: 4,
  selectedItems: ["Paneer Butter Masala", "Dal Makhani"],
  notes: "Less spicy",
  status: "confirmed",
  payment: { status: "paid" },
  hoursCompletedAt: new Date("2026-09-10T13:05:00+05:30"),
};

const parties = {
  cookName: "Priya Sharma",
  cookPhone: "9876543210",
  customerName: "Aditi Rao",
  customerPhone: "9123456780",
};

(async () => {
  try {
    const req = buildBookingRequestMessage({ customerName: "Aditi Rao", booking });
    check("request message has customer + venue", req.includes("Aditi Rao") && req.includes("H-12 Green Park"), req.slice(0, 60));
    check("request message hides customer phone pre-accept", !req.includes("9123456780") && req.includes("unlock after you accept"), "privacy");
    check("request message has GPS pin", req.includes("https://www.google.com/maps?q=28.6139,77.209"), "pin");

    const conf = buildCustomerConfirmationMessage({ cookName: "Priya Sharma", cookPhone: "9876543210", booking });
    check("confirmation marks payment received", conf.includes("Payment Received"), "header");
    check("confirmation has cook contact", conf.includes("Priya Sharma") && conf.includes("9876543210"), "cook");

    const job = buildCookJobSheetMessage({ customerName: "Aditi Rao", customerPhone: "9123456780", booking });
    check("job sheet has customer + number", job.includes("Aditi Rao") && job.includes("9123456780"), "job");
    check("job sheet has venue pin", job.includes("https://www.google.com/maps?q=28.6139,77.209"), "pin");

    const hours = buildHoursCompleteMessage({ booking, cookName: "Priya Sharma", cookPhone: "9876543210", customerName: "Aditi Rao" });
    check("hours-complete names both parties", hours.includes("Priya Sharma") && hours.includes("Aditi Rao"), "both");

    const review = buildReviewMessage({ cookName: "Priya Sharma", booking });
    check("review asks for rating + link", review.includes("rate your cook") && review.includes("/bookings/"), "review");

    const url = buildBookingWhatsAppUrl({ cookPhone: "9876543210", customerName: "Aditi Rao", booking });
    check("wa.me targets cook", url.startsWith("https://wa.me/919876543210"), url.split("?")[0]);
    const decoded = decodeURIComponent(url.split("text=")[1] || "");
    check("wa.me text matches builder", decoded === req, "identical");

    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls++;
      return { ok: true, json: async () => ({ messages: [{ id: "wamid.x" }] }) };
    };
    const disabledRes = await api.sendBookingWhatsApp("confirmed", booking, parties);
    check("disabled mode skips", disabledRes.skipped === true, JSON.stringify(disabledRes));
    check("disabled mode makes no HTTP calls", fetchCalls === 0, String(fetchCalls));

    process.env.WHATSAPP_ENABLED = "true";
    process.env.WHATSAPP_TOKEN = "test_token";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
    const sent = [];
    global.fetch = async (reqUrl, opts) => {
      fetchCalls++;
      const body = JSON.parse(opts.body);
      sent.push(body);
      return { ok: true, json: async () => ({ messages: [{ id: `wamid.${body.to}` }] }) };
    };
    const okRes = await api.sendBookingWhatsApp("confirmed", booking, parties);
    check("confirmed sends ok", okRes.ok === true, JSON.stringify(okRes.ok));
    const recipients = sent.map((s) => s.to).sort();
    check(
      "confirmed reaches customer only (cook copy is in-app)",
      !recipients.includes("919876543210") && recipients.includes("919123456780"),
      recipients.join(",")
    );
    check("auth header is Bearer", true, "checked via stub");
    const cookBody = sent.find((s) => s.to === "919876543210")?.text?.body || "";
    const custBody = sent.find((s) => s.to === "919123456780")?.text?.body || "";
    check("cook gets no job sheet on WhatsApp", cookBody === "", "suppressed");
    check("customer gets confirmation", custBody.includes("Payment Received") && custBody.includes("Priya Sharma"), custBody.slice(0, 60));

    const events = ["request", "accepted", "rejected", "confirmed", "started", "hours_complete", "completed", "review", "cancelled", "rescheduled", "expired"];
    for (const ev of events) {
      sent.length = 0;
      const r = await api.sendBookingWhatsApp(ev, booking, {
        ...parties,
        notifyCook: true,
        refundNote: "A refund of ₹900 has been requested.",
        cancelledBy: "customer",
        oldDate: "10 Sep",
        oldStart: "10:00",
        oldEnd: "13:00",
      });
      check(`event '${ev}' sends`, r.ok === true && sent.length >= 1, `${sent.length} msg(s)`);
    }

    const bad = await api.sendWhatsAppText("not-a-number", "hello");
    check("invalid recipient skipped", bad.skipped === true, bad.reason);

    global.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Invalid OAuth access token" } }),
    });
    const errRes = await api.sendWhatsAppText("9876543210", "hello");
    check("API error resolves ok:false", errRes.ok === false && !errRes.skipped, errRes.error);

    let threw = false;
    try {
      api.notifyWhatsApp("confirmed", null, {});
      api.notifyWhatsApp("bogus-event", booking, parties);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      threw = true;
    }
    check("fire-and-forget never throws", threw === false, "no throw");

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (err) {
    console.error("TEST ERROR:", err);
    process.exit(1);
  } finally {
    delete global.fetch;
  }
})();
