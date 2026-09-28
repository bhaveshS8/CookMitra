import React from "react";
import { Link } from "react-router-dom";
import { useSelector } from "react-redux";
import { ShieldCheck, Heart, Sparkles, Mail, MapPin, Phone, Camera } from "lucide-react";
import cookMitraLogo from "../assets/logo.png";

const Footer = () => {
  const user = useSelector((s) => s.auth.user);
  const isAdmin = user?.role === "admin";
  const isCook = user?.role === "cook";
  const hideCustomerPages = isAdmin || isCook;
  return (
    <footer className="footer-modern">
      <div className="footer-inner">
        <div className="footer-top-grid">
          {/* Brand Col */}
          <div className="footer-brand-col">
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.75rem" }}>
              <img
                src={cookMitraLogo}
                alt="Cook Mitra logo"
                className="brand-logo-img"
                style={{ width: 38, height: 38 }}
              />
              <h3 style={{ margin: 0 }}>Cook Mitra</h3>
            </div>
            <p>
              Connecting families with verified culinary masters to celebrate traditional festivals
              with genuine flavor, warmth, and authentic heritage recipes.
            </p>
            <div style={{ display: "flex", gap: "0.6rem 1rem", marginTop: "1.25rem", flexWrap: "wrap" }}>
              <span className="badge badge-festive" style={{ background: "rgba(232, 89, 12, 0.15)", color: "#ffedd5" }}>
                <ShieldCheck size={14} /> 100% Verified Cooks
              </span>
              <span className="badge badge-festive" style={{ background: "rgba(245, 158, 11, 0.15)", color: "#fef3c7" }}>
                <Sparkles size={14} /> Authentic Taste
              </span>
            </div>
          </div>

          {/* Quick Links */}
          <div className="footer-links-col">
            <h4>Explore</h4>
            <ul className="footer-links-list">
              {!hideCustomerPages && (
                <>
                  <li><Link to="/cook-on-demand">Book a Cook</Link></li>
                </>
              )}
              {isAdmin ? (
                <li><Link to="/admin">Admin Dashboard</Link></li>
              ) : isCook ? (
                <li><Link to="/dashboard/cook-bookings">Cook Dashboard</Link></li>
              ) : (
                <>
                  <li><Link to="/register">Register as a Cook</Link></li>
                  <li><Link to="/login">Account Login</Link></li>
                </>
              )}
            </ul>
          </div>

          {/* Services */}
          {!hideCustomerPages && (
            <div className="footer-links-col">
              <h4>Services</h4>
              <ul className="footer-links-list">
                <li><Link to="/cook-on-demand?serviceType=cook_for_me">Cook For Me</Link></li>
                <li><Link to="/cook-on-demand?serviceType=cook_with_me">Cook With Me</Link></li>
                <li><Link to="/cook-on-demand?serviceType=teach_me">Teach Me</Link></li>
                <li><Link to="/cook-on-demand?serviceType=preparation_help">Preparation Help</Link></li>
              </ul>
            </div>
          )}

          {/* Contact & Support */}
          <div className="footer-links-col">
            <h4>Reach Us</h4>
            <ul className="footer-links-list">
              <li style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--slate-400)", minWidth: 0 }}>
                <Mail size={16} style={{ flexShrink: 0 }} />
                <a href="mailto:contactuscookmitra@gmail.com" style={{ color: "inherit", minWidth: 0, overflowWrap: "anywhere" }}>contactuscookmitra@gmail.com</a>
              </li>
              <li style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--slate-400)" }}>
                <Phone size={16} />
                <a href="tel:+919322321831" style={{ color: "inherit" }}>+91 9322321831</a>
              </li>
              <li style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--slate-400)" }}>
                <MapPin size={16} /> Pune, India
              </li>
              <li style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--slate-400)" }}>
                <Camera size={16} />
                <a href="https://instagram.com/cookmitra_india" target="_blank" rel="noreferrer" style={{ color: "inherit" }}>Instagram: @cookmitra_india</a>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="footer-bottom-bar">
          <div>
            &copy; {new Date().getFullYear()} Cook Mitra. Crafted with <Heart size={14} style={{ display: "inline", verticalAlign: "middle", color: "#f43f5e" }} /> for festive homes.
          </div>
          <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
            {isAdmin ? (
              <Link to="/admin">Admin Dashboard</Link>
            ) : isCook ? (
              <Link to="/dashboard/cook-bookings">Cook Dashboard</Link>
            ) : (
              <>
                <Link to="/cook-on-demand">Book a Cook</Link>
                <Link to="/register">Join as Chef</Link>
              </>
            )}
          </div>
          <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
            <Link to="/terms">Terms</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/refunds">Refunds</Link>
            <Link to="/contact">Contact</Link>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
