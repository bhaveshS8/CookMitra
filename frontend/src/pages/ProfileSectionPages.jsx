import React, { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useDispatch } from "react-redux";
import { ArrowLeft } from "lucide-react";
import API from "../api/axios";
import { updateUser } from "../store/authSlice";
import { useShowToast } from "../store/hooks";
import {
  PersonalDetailsTab,
  SavedAddressesTab,
  MyActivityTab,
  SecurityPrivacyTab,
} from "./CustomerProfile";

const asList = (v) => (Array.isArray(v) ? v : v?.data && Array.isArray(v.data) ? v.data : []);

function SectionShell({ children }) {
  return (
    <div className="dashboard-container cp-page">
      <div className="cp-wrap">
        <div>
          <Link to="/dashboard/profile" className="back-link-bar">
            <ArrowLeft size={16} /> Back to Profile
          </Link>
        </div>
        {children}
      </div>
    </div>
  );
}

function SectionLoading({ label }) {
  return (
    <SectionShell>
      <div className="cp-skel" aria-busy="true" aria-label={label}>
        <span />
        <span />
        <span />
      </div>
      <p>{label}</p>
    </SectionShell>
  );
}

function SectionError({ message, onRetry }) {
  return (
    <SectionShell>
      <div className="cp-alert error" role="alert">
        {message}
      </div>
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Try again
      </button>
    </SectionShell>
  );
}

export function ProfilePersonalPage() {
  const dispatch = useDispatch();
  const showToast = useShowToast();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await API.get("/auth/me");
      setProfile(res.data);
      dispatch(
        updateUser({
          name: res.data?.name,
          email: res.data?.email,
          phone: res.data?.phone,
          address: res.data?.address,
          avatar: res.data?.avatar,
        })
      );
    } catch (err) {
      setError(err.response?.data?.message || "Failed to load your details. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [dispatch]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <SectionLoading label="Loading personal details…" />;
  if (error || !profile) return <SectionError message={error || "Profile not found."} onRetry={load} />;
  return (
    <SectionShell>
      <PersonalDetailsTab profile={profile} setProfile={setProfile} showToast={showToast} dispatch={dispatch} />
    </SectionShell>
  );
}

export function ProfileAddressesPage() {
  const showToast = useShowToast();
  const [addresses, setAddresses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await API.get("/auth/me/addresses");
      setAddresses(asList(res.data));
    } catch (err) {
      setError(err.response?.data?.message || "Failed to load your addresses. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <SectionLoading label="Loading saved addresses…" />;
  if (error) return <SectionError message={error} onRetry={load} />;
  return (
    <SectionShell>
      <SavedAddressesTab addresses={addresses} setAddresses={setAddresses} showToast={showToast} />
    </SectionShell>
  );
}

export function ProfileActivityPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [bookings, setBookings] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [bk, rv] = await Promise.all([
        API.get("/bookings/my").catch(() => ({ data: [] })),
        API.get("/reviews/my").catch(() => ({ data: [] })),
      ]);
      setBookings(asList(bk.data));
      setReviews(asList(rv.data));
    } catch (err) {
      setError(err.response?.data?.message || "Failed to load your activity. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Section deep links (e.g. from stat cards): landing scrolls are instant
  // on arrival, smooth when following in-page navigation or browser back.
  // Deferred a frame so it runs after the global scroll-to-top on arrival.
  useEffect(() => {
    if (!location.hash) return;
    const id = location.hash.replace("#", "");
    let raf = 0;
    raf = requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el || typeof el.scrollIntoView !== "function") return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      try {
        el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      } catch {
        el.scrollIntoView();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [location.hash]);

  if (loading) return <SectionLoading label="Loading your activity…" />;
  if (error) return <SectionError message={error} onRetry={load} />;
  return (
    <SectionShell>
      <MyActivityTab bookings={bookings} reviews={reviews} navigate={navigate} />
    </SectionShell>
  );
}

export function ProfileSecurityPage() {
  const showToast = useShowToast();
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await API.get("/auth/me");
      setProfile(res.data);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to load security settings. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <SectionLoading label="Loading security settings…" />;
  if (error || !profile) return <SectionError message={error || "Profile not found."} onRetry={load} />;
  return (
    <SectionShell>
      <SecurityPrivacyTab profile={profile} setProfile={setProfile} showToast={showToast} />
    </SectionShell>
  );
}
