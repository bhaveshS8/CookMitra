import React from "react";
import { Link } from "react-router-dom";
import CookProfileForm from "../components/CookProfileForm";
import { ArrowLeft, ChefHat, BadgeCheck, MapPin, Star } from "lucide-react";

const CookSetup = () => {
  return (
    <div className="cook-setup-page">
      <div className="cook-back-row">
        <Link to="/dashboard/cook-bookings" className="back-link-bar">
          <ArrowLeft size={16} /> Back to Cook Dashboard
        </Link>
      </div>

      <div className="cook-setup-intro-card">
        <span className="badge badge-festive cook-intro-badge">
          <ChefHat size={14} /> Chef profile
        </span>
        <h1>Your public chef page</h1>
        <p className="cook-setup-intro-sub">
          Families see this before they book you — a complete profile gets approved faster.
          You keep 75% of every booking; discounts are on us.
        </p>
        <ul className="cook-setup-steps">
          <li><BadgeCheck size={13} /> Skills + experience</li>
          <li><MapPin size={13} /> Service area</li>
          <li><Star size={13} /> ID verification</li>
        </ul>
      </div>

      <CookProfileForm showStatus />
    </div>
  );
};

export default CookSetup;
