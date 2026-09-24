import React from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ShieldCheck, FileText, RotateCcw, Mail } from "lucide-react";

const SUPPORT_EMAIL = "contactuscookmitra@gmail.com";
const SUPPORT_PHONE = "+91 9322321831";
const UPDATED = "September 2026";

// Shared layout for the compliance pages Razorpay requires merchants to
// publish: Terms, Privacy, Refunds/Cancellation, and Contact.
const LegalShell = ({ icon: Icon, eyebrow, title, intro, children }) => (
  <div className="dashboard-container legal-page">
    <Link to="/" className="back-link-bar">
      <ArrowLeft size={16} /> Back to Home
    </Link>
    <span className="badge badge-festive">
      <Icon size={14} /> {eyebrow}
    </span>
    <h1>{title}</h1>
    <p className="legal-intro">
      {intro}
      <span className="legal-date-stamp">
        Last updated: <strong>{UPDATED}</strong>.
      </span>
    </p>
    <div className="profile-card-block legal-content">{children}</div>
  </div>
);

export const TermsConditions = () => (
  <LegalShell
    icon={FileText}
    eyebrow="Legal"
    title="Terms & Conditions"
    intro="These terms govern your use of Cook Mitra (cookmitra) for booking home-cooking sessions."
  >
    <h3>1. The service</h3>
    <p>
      Cook Mitra connects households ("customers") with verified independent home cooks
      ("cooks") for in-home cooking sessions: Cook for Me, Cook With Me, Teach Me, and
      Preparation Help. Cooks are independent providers, not employees of Cook Mitra.
    </p>
    <h3>2. Booking & acceptance</h3>
    <ul>
      <li>You pick a date, service hours, and one of the cook's available time slots.</li>
      <li>Your request holds the slot for 5 minutes while the cook accepts or declines.</li>
      <li>Once accepted, you have 5 minutes to complete online payment; unpaid requests auto-cancel and release the slot.</li>
      <li>Only approved, verified cooks can receive requests.</li>
    </ul>
    <h3>3. Pricing & payments</h3>
    <ul>
      <li>Fee = the cook's hourly rate × booked hours, shown before you pay. No hidden charges.</li>
      <li>Online payments are processed securely by Razorpay (UPI, cards, net-banking, wallets). We never see or store your card/UPI credentials.</li>
      <li>Prices are in Indian Rupees (INR) and inclusive of applicable taxes.</li>
    </ul>
    <h3>4. Cancellation & refunds</h3>
    <p>
      Cancellations follow our <Link to="/refunds">Cancellation & Refund Policy</Link>:
      paid bookings cancelled in time are eligible for a refund to the original payment method
      within 5–7 business days of approval. All refunds are reviewed and approved by our team —
      nothing is refunded automatically.
    </p>
    <h3>5. Your responsibilities</h3>
    <ul>
      <li>Provide an accurate service address and be available at the venue on time.</li>
      <li>Ensure a safe, hygienic workspace and disclose allergies or dietary restrictions.</li>
      <li>Do not misuse the platform, share false information, or harass cooks.</li>
    </ul>
    <h3>6. Liability</h3>
    <p>
      Cook Mitra verifies cook identities and documents but is not liable for the quality
      of a session, delays, or events beyond our control. Liability, where applicable, is
      limited to the fee paid for the affected booking.
    </p>
    <h3>7. Contact</h3>
    <p>
      Questions about these terms: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> ·{" "}
      <a href="tel:+919322321831">{SUPPORT_PHONE}</a>.
    </p>
  </LegalShell>
);

export const PrivacyPolicy = () => (
  <LegalShell
    icon={ShieldCheck}
    eyebrow="Legal"
    title="Privacy Policy"
    intro="How Cook Mitra collects, uses, and protects your information."
  >
    <h3>1. Information we collect</h3>
    <ul>
      <li>
        <strong>Account details:</strong> your name, email address, phone number, and role
        (customer or cook) when you sign up.
      </li>
      <li>
        <strong>Booking details:</strong> service address, venue location, number of guests,
        dishes or menu preferences, and any special notes you add to a request.
      </li>
      <li>
        <strong>Cook verification documents:</strong> Aadhaar, PAN, and photos submitted by
        cooks to verify their identity. These are stored securely and shown only to you when
        a booking is confirmed.
      </li>
      <li>
        <strong>Payment records:</strong> order IDs, payment IDs, and amounts. Card numbers,
        UPI IDs, and other payment credentials are handled only by Razorpay and never touch
        our servers.
      </li>
      <li>
        <strong>Cookies and device info:</strong> we use lightweight cookies to keep you
        logged in and to remember your location preference. We do not use tracking cookies
        for advertising.
      </li>
    </ul>

    <h3>2. How we use your information</h3>
    <ul>
      <li>To create and manage your account.</li>
      <li>To match you with a cook, hold a time slot during the request window, and
        coordinate the session.</li>
      <li>To share the details the other party needs: your cook receives your name, contact
        number, and venue for confirmed bookings; you receive the cook&apos;s name and contact
        details for confirmed bookings.</li>
      <li>To send booking confirmations, reminders, and payment receipts.</li>
      <li>To prevent fraud, resolve disputes, and improve the quality of the platform.</li>
    </ul>

    <h3>3. How we share your information</h3>
    <p>
      We do not sell, rent, or trade your personal data. We share information only when it is
      necessary for a booking or required by law:
    </p>
    <ul>
      <li>With the assigned cook or customer for the duration of a confirmed booking.</li>
      <li>With Razorpay for payment processing, under Razorpay&apos;s privacy terms.</li>
      <li>With government or legal authorities when we are legally required to do so.</li>
      <li>With service providers who help us run the platform (hosting, messaging, analytics)
        under strict confidentiality agreements.</li>
    </ul>

    <h3>4. Security &amp; retention</h3>
    <p>
      Your data is transmitted over encrypted (HTTPS) connections, and passwords are stored
      using secure hashing. We retain booking records for as long as needed for account
      management, tax, and dispute resolution, and then delete or anonymize them in line with
      our retention policy. Verification documents submitted by cooks are stored securely and
      removed when a cook is deactivated.
    </p>

    <h3>5. Your rights</h3>
    <p>
      Depending on your location, you may have the right to:
    </p>
    <ul>
      <li>Access the personal data we hold about you.</li>
      <li>Correct inaccurate data.</li>
      <li>Request deletion of your data, subject to legal retention requirements for active or
        recently closed bookings.</li>
      <li>Withdraw consent where processing is based on consent.</li>
    </ul>
    <p>
      To exercise any of these rights, write to{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. We aim to respond within one
      business day.
    </p>

    <h3>6. Children&apos;s privacy</h3>
    <p>
      Cook Mitra is not intended for children under 18. We do not knowingly collect personal
      data from children. If we learn that we have collected such data, we will delete it as
      soon as possible.
    </p>

    <h3>7. Changes to this policy</h3>
    <p>
      We may update this Privacy Policy from time to time. The latest version will always be
      published on this page with an updated &quot;Last updated&quot; date. Material changes will
      be notified through the app or by email where required.
    </p>

    <h3>8. Contact</h3>
    <p>
      Privacy questions or requests:{" "}
      <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> ·{" "}
      <a href="tel:+919322321831">{SUPPORT_PHONE}</a>.
    </p>
  </LegalShell>
);

export const RefundPolicy = () => (
  <LegalShell
    icon={RotateCcw}
    eyebrow="Legal"
    title="Cancellation & Refund Policy"
    intro="When you can cancel and how refunds reach you."
  >
    <h3>1. Free cancellation before acceptance</h3>
    <ul>
      <li>
        You can cancel a request at any time <strong>before the cook accepts</strong> (and up to{" "}
        <strong>30 minutes before the service start time</strong>) — there is no charge and the
        slot is released immediately.
      </li>
      <li>
        If the cook declines your request, or if the request expires unanswered, you are never
        charged. If payment was already collected, a refund is raised for our team&apos;s approval.
      </li>
    </ul>

    <h3>2. Cancelling a paid booking</h3>
    <p>
      Once a booking is accepted and paid, you can still cancel — but refunds follow the rules
      below. You can cancel from <strong>My Bookings</strong> or from the booking page. No refund
      is processed automatically: every request is <strong>reviewed and approved by our
      team</strong> first.
    </p>
    <ul>
      <li>
        Cancel until 30 minutes before the session start time and you are eligible for a full
        refund of the amount paid. Inside that 30-minute window the booking can no longer be
        cancelled online — please contact support.
      </li>
      <li>
        Paid bookings are refunded to the <strong>original payment method</strong> (UPI, card,
        net-banking, or wallet).
      </li>
      <li>
        Refunds typically reach your account within <strong>5–7 business days</strong> of approval,
        depending on your bank or payment provider.
      </li>
      <li>
        If an approved refund needs follow-up, our team will settle it manually and notify you.
        Please contact us with your booking ID and Razorpay payment ID.
      </li>
    </ul>

    <h3>3. Non-refundable cases</h3>
    <ul>
      <li>
        <strong>Completed sessions</strong> are not refundable. If a session has already taken
        place, please rate your experience instead.
      </li>
      <li>
        <strong>Test-mode checkouts</strong> move no real money, so there is nothing to refund.
      </li>
      <li>
        Sessions cancelled <strong>after they have started</strong> are not eligible for a refund.
      </li>
      <li>
        Refunds may be withheld in cases of <strong>misuse, fraud, or abuse</strong> of the
        platform, subject to our Terms &amp; Conditions.
      </li>
    </ul>

    <h3>4. Partial sessions and force majeure</h3>
    <p>
      If a session is interrupted or partially completed due to circumstances beyond our control
      (for example, severe weather, a public emergency, or illness that prevents the cook from
      attending), we will work with you to find a fair resolution — which may include a partial
      refund or a replacement cook where possible.
    </p>

    <h3>5. Payment-window expiry</h3>
    <p>
      After a cook accepts your request, you have <strong>5 minutes</strong> to complete
      payment. If that window lapses, the slot is released and no money is charged. If money was
      captured but the booking was not confirmed (for example, you closed the browser mid-payment),
      contact us with your Razorpay payment ID and we will confirm the status and refund you if
      needed.
    </p>

    <h3>6. How to request a refund</h3>
    <p>
      For any refund or cancellation issue, contact us with:
    </p>
    <ul>
      <li>Your <strong>booking ID</strong> (from your booking confirmation or receipt).</li>
      <li>Your <strong>Razorpay payment ID</strong> (from the payment receipt).</li>
      <li>A short description of the issue.</li>
    </ul>
    <p>
      Refund help: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> ·{" "}
      <a href="tel:+919322321831">{SUPPORT_PHONE}</a>. Please include your booking ID and
      Razorpay payment ID so we can assist you quickly.
    </p>
  </LegalShell>
);

export const ContactUs = () => (
  <LegalShell
    icon={Mail}
    eyebrow="Support"
    title="Contact Us"
    intro="We reply within one business day."
  >
    <h3>Cook Mitra Support</h3>
    <ul>
      <li>
        Email: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </li>
      <li>
        Phone / WhatsApp: <a href="tel:+919322321831">{SUPPORT_PHONE}</a>
      </li>
      <li>Area: Pune & Mumbai, India</li>
      <li>
        Instagram:{" "}
        <a href="https://instagram.com/cookmitra_india" target="_blank" rel="noreferrer">
          @cookmitra_india
        </a>
      </li>
      <li>Hours: 10:00 AM – 6:00 PM IST, all days</li>
    </ul>
    <h3>What to include</h3>
    <p>
      For booking or payment issues, mention your registered phone number, booking ID,
      and (for payments) the Razorpay payment ID from your booking receipt.
    </p>
  </LegalShell>
);
