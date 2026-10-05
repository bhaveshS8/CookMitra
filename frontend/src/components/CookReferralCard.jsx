import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { formatCurrency } from "../utils/constants";
import { Share2, Copy, Wallet } from "lucide-react";

const CookReferralCard = () => {
  const showToast = useShowToast();
  const [referral, setReferral] = useState(null);
  const [earnings, setEarnings] = useState(null);

  useEffect(() => {
    API.get("/cook/referral").then((r) => setReferral(r.data)).catch(() => {});
    API.get("/cook/earnings").then((r) => setEarnings(r.data?.overview)).catch(() => {});
  }, []);

  if (!referral) return null;
  const link = referral.referralLink ? `${window.location.origin}${referral.referralLink}` : "";

  const copy = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copied`, "success");
    } catch {
      showToast("Copy failed — please copy manually", "error");
    }
  };

  return (
    <div className="cook-card cook-spaced-top">
      <h3>Refer & earn</h3>
      <p style={{ fontSize: "0.9rem", color: "var(--slate-600)" }}>
        Code <strong>{referral.referralCode}</strong> · {referral.totalReferrals} referred · {referral.totalSuccessfulReferrals} successful · {formatCurrency(earnings?.bonuses ?? 0)} bonuses · {formatCurrency(earnings?.lifetime ?? 0)} lifetime · {formatCurrency(earnings?.paid ?? 0)} paid · {formatCurrency(earnings?.pending ?? 0)} pending
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => copy(referral.referralCode, "Referral code")}><Copy size={14} /> Copy code</button>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => link && copy(link, "Referral link")}><Copy size={14} /> Copy link</button>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(`Join Cook Mitra as a cook: ${link} (code ${referral.referralCode})`)}`, "_blank", "noopener")}><Share2 size={14} /> Share</button>
        <Link className="btn btn-outline btn-sm" to="/cook/earnings"><Wallet size={14} /> View earnings</Link>
        <Link className="btn btn-outline btn-sm" to="/cook/earnings">View incentives</Link>
        <Link className="btn btn-outline btn-sm" to="/cook/earnings">View referrals</Link>
      </div>
    </div>
  );
};

export default CookReferralCard;
