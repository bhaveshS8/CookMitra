import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import API from "../api/axios";
import { useDispatch } from "react-redux";
import { updateUser } from "../store/authSlice";

import { buildRetryState } from "../utils/bookingRetry";
import { formatDate, formatTimeRange12 } from "../utils/constants";
import "../styles/customer-profile.css";
import {
  ArrowLeft, BadgeCheck, CalendarCheck, CalendarClock, CheckCircle2,
  ChefHat, ChevronRight, Clock3, Eye, EyeOff, Mail, MapPin, Pencil,
  Phone, Plus, RotateCcw, Save, ShieldCheck, Star, Trash2, UserRound, AlertCircle,
} from "lucide-react";

const MANAGE_LINKS = [
  { id: "personal", title: "Personal Details", short: "Personal", to: "/dashboard/profile/personal", icon: UserRound, bg: "var(--accent-blue-light)", fg: "var(--accent-blue)" },
  { id: "addresses", title: "Saved Addresses", short: "Addresses", to: "/dashboard/profile/addresses", icon: MapPin, bg: "var(--accent-amber-light)", fg: "var(--accent-amber)" },
  { id: "activity", title: "My Activity", short: "Activity", to: "/dashboard/profile/activity", icon: CalendarCheck, bg: "var(--accent-emerald-light)", fg: "var(--accent-emerald)" },
  { id: "security", title: "Security & Privacy", short: "Security", to: "/dashboard/profile/security", icon: ShieldCheck, bg: "var(--accent-purple-light)", fg: "var(--accent-purple)" },
];
// Legacy `?tab=` deep links (from before sections became pages) redirect map.
const TAB_ROUTE_FOR = {
  personal: "/dashboard/profile/personal",
  addresses: "/dashboard/profile/addresses",
  activity: "/dashboard/profile/activity",
  security: "/dashboard/profile/security",
};
const ACTIVE_STATUSES = ["requested", "accepted", "confirmed", "in_progress"];
const ADDRESS_LABELS = ["Home", "Office", "Parents' Home", "Other"];

const asList = (v) => (Array.isArray(v) ? v : v?.data && Array.isArray(v.data) ? v.data : []);
const initialsOf = (name) => String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "U";
const normalizePhoneCore = (v) => {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
};
const validPhone = (v) => /^[6-9]\d{9}$/.test(normalizePhoneCore(v));
const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

function ProfileCompletion({ profile, addresses, onGo }) {
  const { pct, cta } = useMemo(() => {
    const hasName = Boolean(String(profile?.name || "").trim());
    const hasEmail = validEmail(profile?.email);
    const hasPhone = validPhone(profile?.phone || profile?.mobile);
    const hasAddress = Boolean((addresses || []).length);
    const done = [hasName && hasEmail && hasPhone, hasAddress].filter(Boolean).length;
    const total = 2;
    const next = !(hasName && hasEmail && hasPhone)
      ? { text: "Complete personal details", to: "/dashboard/profile/personal" }
      : !hasAddress
        ? { text: "Add a saved address", to: "/dashboard/profile/addresses" }
        : null;
    return { pct: Math.round((done / total) * 100), cta: next };
  }, [profile, addresses]);
  return (
    <div className="cp-progress-card" aria-label={`Profile ${pct}% complete`}>
      <div className="cp-progress-top"><span>Profile completion</span><span>{pct}%</span></div>
      <div className="cp-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Profile ${pct}% complete`}><span style={{ width: `${pct}%` }} /></div>
      {pct === 100
        ? <p className="cp-progress-done">All set 🎉</p>
        : cta && <button type="button" className="cp-progress-cta" onClick={() => onGo?.(cta.to)}>{cta.text} <ChevronRight size={14} /></button>}
    </div>
  );
}

function Field({ label, error, hint, children, htmlFor }) {
  return (
    <div className="cp-field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error && <span className="cp-err" role="alert">{error}</span>}
      {hint && !error && <span className="cp-hint">{hint}</span>}
    </div>
  );
}

function Empty({ icon, title, text, action }) {
  return (
    <div className="cp-empty">
      <div>{icon}</div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

function ConfirmDialog({ open, title, text, confirmLabel, danger, onConfirm, onClose, busy }) {
  if (!open) return null;
  return (
    <div className="cp-dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} role="presentation">
      <div className="cp-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        <p className="cp-panel-desc">{text}</p>
        <div className="cp-actions">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className={`btn ${danger ? "btn-danger" : "btn-primary"}`} onClick={onConfirm} disabled={busy}>{busy ? "Please wait…" : confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

const CustomerProfile = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const goSection = useCallback((to) => navigate(to), [navigate]);

  // Backward compatibility: old `?tab=` deep links redirect to section pages.
  useEffect(() => {
    const t = searchParams.get("tab");
    if (t && TAB_ROUTE_FOR[t]) navigate(TAB_ROUTE_FOR[t], { replace: true });
  }, [searchParams, navigate]);

  const [profile, setProfile] = useState(null);
  const [stats, setStats] = useState(null);
  const [addresses, setAddresses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [me, st, addr, bk, rv] = await Promise.all([
        API.get("/auth/me"),
        API.get("/auth/me/stats").catch(() => ({ data: null })),
        API.get("/auth/me/addresses").catch(() => ({ data: [] })),
        API.get("/bookings/my").catch(() => ({ data: [] })),
        API.get("/reviews/my").catch(() => ({ data: [] })),
      ]);
      setProfile(me.data);
      dispatch(updateUser({ name: me.data?.name, email: me.data?.email, phone: me.data?.phone, address: me.data?.address, avatar: me.data?.avatar }));
      if (st.data) setStats(st.data);
      setAddresses(asList(addr.data));
      const bkList = asList(bk.data);
      const rvList = asList(rv.data);
      if (!st.data) {
        const upcoming = bkList.filter((b) => ACTIVE_STATUSES.includes(b.status)).length;
        const completed = bkList.filter((b) => b.status === "completed").length;
        setStats({ upcomingBookings: upcoming, completedBookings: completed, totalBookings: bkList.length, reviewsGiven: rvList.length });
      } else if (st.data.reviewsGiven == null) {
        setStats((s) => ({ ...s, reviewsGiven: rvList.length }));
      }
    } catch (err) {
      setLoadError(err.response?.data?.message || "Failed to load your account. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [dispatch]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const memberSince = profile?.memberSince || profile?.createdAt
    ? new Date(profile.memberSince || profile.createdAt).toLocaleDateString("en-IN", { month: "short", year: "numeric" })
    : "";
  const [avatarOk, setAvatarOk] = useState(true);
  useEffect(() => setAvatarOk(true), [profile?.avatar]);

  // At most two verification/login badges: backend-confirmed verifications
  // first, then the login method. Never invented — all from /auth/me.
  const loginLabel = (() => {
    const m = String(profile?.loginMethod || profile?.authProvider || "local");
    if (m === "google") return "Google sign-in";
    if (m === "local+google") return "Email + Google";
    return "Email sign-in";
  })();
  const shownBadges = [
    ...(profile?.emailVerified ? [{ key: "email", cls: "ok", Icon: BadgeCheck, text: "Email verified" }] : []),
    ...(profile?.phoneVerified ? [{ key: "phone", cls: "ok", Icon: BadgeCheck, text: "Phone verified" }] : []),
    { key: "login", cls: "info", Icon: ShieldCheck, text: loginLabel },
  ].slice(0, 2);

  const phoneCore = normalizePhoneCore(profile?.phone || profile?.mobile || "");
  const phoneDisplay = phoneCore ? `+91 ${phoneCore}` : "";

  // Stat-card navigation: total opens the full bookings view; the rest open
  // the activity page, landing on the matching section via URL hash.
  const goStat = useCallback((target) => {
    if (target.hash) {
      navigate({ pathname: target.route, hash: target.hash });
    } else {
      navigate(target.route);
    }
  }, [navigate]);

  if (loading) {
    return (
      <div className="dashboard-container cp-page" aria-busy="true" aria-label="Loading account">
        <div className="cp-wrap"><div className="cp-skel"><span /><span /><span /><span /></div><p>Loading your account…</p></div>
      </div>
    );
  }
  if (loadError && !profile) {
    return (
      <div className="dashboard-container cp-page">
        <div className="cp-alert error" role="alert"><AlertCircle size={16} /> {loadError}</div>
        <button type="button" className="btn btn-primary" onClick={loadAll}>Try again</button>
      </div>
    );
  }

  return (
    <div className="dashboard-container cp-page">
      <div className="cp-wrap">
        <div><Link to="/dashboard/my-bookings" className="back-link-bar"><ArrowLeft size={16} /> Back to My Bookings</Link></div>

        <section className="cp-header-card" aria-label="Account summary">
          <div className="cp-header-main">
            <div className="cp-avatar-wrap">
              <div className="cp-avatar" aria-hidden="true">
                {profile?.avatar && avatarOk
                  ? <img src={profile.avatar} alt="" onError={() => setAvatarOk(false)} />
                  : initialsOf(profile?.name)}
              </div>
              {profile?.emailVerified && (
                <span className="cp-avatar-badge" aria-hidden="true"><BadgeCheck size={13} /></span>
              )}
            </div>
            <div className="cp-header-text">
              <h1 className="cp-name">{profile?.name || "Your account"}</h1>
              <div className="cp-contact">
                {profile?.email && <span><Mail size={13} /> {profile.email}</span>}
                {phoneCore && (
                  <span>
                    <Phone size={13} /> {phoneDisplay}
                  </span>
                )}
              </div>
              {memberSince && <p className="cp-member-since"><CalendarClock size={12} /> Member since {memberSince}</p>}
              <div className="cp-meta-row">
                {shownBadges.map(({ key, cls, Icon, text }) => (
                  <span key={key} className={`cp-pill ${cls}`}><Icon size={12} /> {text}</span>
                ))}
              </div>
            </div>
          </div>
          <ProfileCompletion profile={profile} addresses={addresses} onGo={goSection} />
          <div className="cp-header-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => goSection("/dashboard/profile/personal")}><Pencil size={14} /> Edit profile</button>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => goSection("/dashboard/profile/activity")}><CalendarCheck size={14} /> My bookings</button>
          </div>
        </section>

        <section className="cp-stats" aria-label="Account statistics">
          {[
            { label: "Upcoming Bookings", value: stats?.upcomingBookings ?? 0, hint: "No upcoming sessions", action: "View upcoming bookings", target: { route: "/dashboard/profile/activity" }, bg: "var(--accent-blue-light)", fg: "var(--accent-blue)", Icon: Clock3 },
            { label: "Completed Bookings", value: stats?.completedBookings ?? 0, hint: "None yet", action: "View completed bookings", target: { route: "/dashboard/profile/activity", hash: "#cp-act-completed" }, bg: "var(--accent-emerald-light)", fg: "var(--accent-emerald)", Icon: CheckCircle2 },
            { label: "Total Bookings", value: stats?.totalBookings ?? 0, hint: "Book your first cook", action: "View all bookings", target: { route: "/dashboard/my-bookings" }, bg: "var(--accent-amber-light)", fg: "var(--accent-amber)", Icon: CalendarCheck },
            { label: "Reviews Given", value: stats?.reviewsGiven ?? 0, hint: "None yet", action: "View your reviews", target: { route: "/dashboard/profile/activity", hash: "#cp-act-reviews" }, bg: "var(--accent-purple-light)", fg: "var(--accent-purple)", Icon: Star },
          ].map(({ label, value, hint, action, target, bg, fg, Icon }) => {
            const n = Number(value) || 0;
            return (
              <button type="button" className="cp-stat" key={label} onClick={() => goStat(target)} aria-label={`${label}: ${n}. ${action}`}>
                <span className="cp-stat-top">
                  <span className="cp-stat-icon" style={{ background: bg, color: fg }} aria-hidden="true"><Icon size={20} /></span>
                  <span className="cp-stat-num">{n}</span>
                </span>
                <span className="cp-stat-text">
                  <span className="cp-stat-label">{label}</span>
                  {n === 0 && <span className="cp-stat-hint">{hint}</span>}
                </span>
                <span className="cp-stat-chev" aria-hidden="true"><ChevronRight size={18} /></span>
              </button>
            );
          })}
        </section>

        <section className="cp-panel" aria-label="Manage your account">
          <h2>Manage Your Account</h2>
          <div className="cp-manage-grid">
            {MANAGE_LINKS.map(({ id, title, short, to, icon: Icon, bg, fg }) => (
              <button
                key={id} type="button" className="cp-manage-btn" onClick={() => goSection(to)}
                aria-label={`${title}. Open ${title} page`}
              >
                <span className="cp-manage-icon" style={{ background: bg, color: fg }} aria-hidden="true"><Icon size={20} /></span>
                <span className="cp-manage-text">
                  <span className="cp-manage-title">{title}</span>
                  <span className="cp-manage-short">{short}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};

/* ---------- Tab 1 ---------- */
export function PersonalDetailsTab({ profile, setProfile, showToast, dispatch }) {
  const [form, setForm] = useState({ name: profile?.name || "", email: profile?.email || "", phone: normalizePhoneCore(profile?.phone || profile?.mobile || "") });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState("");
  const [emailWarn, setEmailWarn] = useState("");
  const initial = useRef(JSON.stringify(form));
  useEffect(() => { const f = { name: profile?.name || "", email: profile?.email || "", phone: normalizePhoneCore(profile?.phone || profile?.mobile || "") }; setForm(f); initial.current = JSON.stringify(f); }, [profile?.name, profile?.email, profile?.phone, profile?.mobile]); // eslint-disable-line
  const dirty = JSON.stringify(form) !== initial.current;

  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setOk(""); if (k === "email") setEmailWarn(v.trim().toLowerCase() !== String(profile?.email || "").toLowerCase() && v.trim() ? "Changing your email may require re-verification or signing in again." : ""); };

  const save = async (e) => {
    e?.preventDefault();
    const errs = {};
    if (!form.name.trim() || form.name.trim().length < 2) errs.name = "Name must be 2–80 characters";
    if (!validEmail(form.email)) errs.email = "Enter a valid email address";
    if (!validPhone(form.phone)) errs.phone = "Enter a valid 10-digit mobile number";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true); setOk("");
    try {
      const res = await API.put("/auth/me", { name: form.name.trim(), email: form.email.trim().toLowerCase(), phone: normalizePhoneCore(form.phone) });
      setProfile(res.data);
      dispatch(updateUser({ name: res.data?.name, email: res.data?.email, phone: res.data?.phone, avatar: res.data?.avatar }));
      initial.current = JSON.stringify({ ...form, phone: normalizePhoneCore(form.phone) });
      setOk(res.data?.emailChangeNotice || "Profile updated successfully.");
      showToast("Profile updated successfully.", "success");
    } catch (err) { const m = err.response?.data?.message || "Failed to update profile"; setErrors({ form: m }); showToast(m, "error"); }
    finally { setSaving(false); }
  };

  return (
    <section className="cp-panel" aria-label="Personal details">
      <h2>Personal Details</h2>
      <p className="cp-panel-desc">Name and contact your cook uses to reach you.</p>
      {errors.form && <div className="cp-alert error" role="alert"><AlertCircle size={15} /> {errors.form}</div>}
      {ok && <div className="cp-alert success" role="status"><CheckCircle2 size={15} /> {ok}</div>}
      {emailWarn && <div className="cp-alert warn" role="note"><AlertCircle size={15} /> {emailWarn}</div>}
      <form onSubmit={save} noValidate>
        <div className="cp-form-grid two">
          <Field label="Full Name" error={errors.name} htmlFor="cp-name">
            <input id="cp-name" name="name" className="form-control" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Enter your full name" autoComplete="name" maxLength={80} />
          </Field>
          <Field label="Email Address" error={errors.email} hint="Used for sign-in and password-reset emails." htmlFor="cp-email">
            <input id="cp-email" name="email" type="email" className="form-control" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="e.g. you@example.com" autoComplete="email" inputMode="email" />
          </Field>
          <Field label="Contact Number" error={errors.phone} hint="10-digit Indian mobile number." htmlFor="cp-phone">
            <input id="cp-phone" name="phone" className="form-control" value={form.phone} onChange={(e) => set("phone", e.target.value.replace(/[^\d+\s-]/g, ""))} placeholder="e.g. 9876543210" autoComplete="tel" inputMode="tel" maxLength={15} />
          </Field>
        </div>
        <div className="cp-actions">
          <button type="button" className="btn btn-outline" disabled={!dirty || saving} onClick={() => { const f = JSON.parse(initial.current); setForm(f); setErrors({}); setEmailWarn(""); }}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!dirty || saving}><Save size={16} /> {saving ? "Saving…" : "Save Changes"}</button>
        </div>
      </form>
    </section>
  );
}

/* ---------- Tab 2 ---------- */
export function SavedAddressesTab({ addresses, setAddresses, showToast }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ label: "Home", customLabel: "", flatNo: "", society: "", landmark: "", city: "", lat: "", lng: "", isDefault: false });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null);
  const [busy, setBusy] = useState(false);

  const startAdd = () => { setEditing("new"); setForm({ label: "Home", customLabel: "", flatNo: "", society: "", landmark: "", city: "", lat: "", lng: "", isDefault: addresses.length === 0 }); setErrors({}); };
  const startEdit = (a) => { setEditing(a._id); setForm({ label: a.label || "Home", customLabel: a.customLabel || "", flatNo: a.flatNo || "", society: a.society || "", landmark: a.landmark || "", city: a.city || "", lat: a.lat ?? "", lng: a.lng ?? "", isDefault: Boolean(a.isDefault) }); setErrors({}); };

  const validate = () => {
    const e = {};
    if (!ADDRESS_LABELS.includes(form.label)) e.label = "Choose a label";
    if (form.label === "Other" && !form.customLabel.trim()) e.customLabel = "Add a short name for this address";
    if (!form.flatNo.trim()) e.flatNo = "Flat/house number is required";
    if (!form.society.trim()) e.society = "Society/building is required";
    if (!form.city.trim()) e.city = "City is required";
    if (form.lat !== "" && (Number.isNaN(Number(form.lat)) || Number(form.lat) < -90 || Number(form.lat) > 90)) e.lat = "Invalid latitude";
    if (form.lng !== "" && (Number.isNaN(Number(form.lng)) || Number(form.lng) < -180 || Number(form.lng) > 180)) e.lng = "Invalid longitude";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const payload = () => ({
    label: form.label, customLabel: form.customLabel.trim(),
    flatNo: form.flatNo.trim(), society: form.society.trim(), landmark: form.landmark.trim(), city: form.city.trim(),
    ...(form.lat === "" ? {} : { lat: Number(form.lat) }), ...(form.lng === "" ? {} : { lng: Number(form.lng) }),
    isDefault: form.isDefault,
  });

  const save = async (e) => {
    e?.preventDefault();
    if (!validate()) return;
    setSaving(true);
    try {
      if (editing === "new") {
        const res = await API.post("/auth/me/addresses", payload());
        const next = form.isDefault ? addresses.map((a) => ({ ...a, isDefault: false })).concat(res.data) : addresses.concat(res.data);
        setAddresses(next); showToast("Address saved.", "success");
      } else {
        const res = await API.put(`/auth/me/addresses/${editing}`, payload());
        setAddresses(addresses.map((a) => (String(a._id) === String(editing) ? res.data : (form.isDefault ? { ...a, isDefault: false } : a))));
        showToast("Address updated.", "success");
      }
      setEditing(null);
    } catch (err) { showToast(err.response?.data?.message || "Failed to save address", "error"); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!confirmDel) return;
    setBusy(true);
    try {
      await API.delete(`/auth/me/addresses/${confirmDel._id}`);
      let next = addresses.filter((a) => String(a._id) !== String(confirmDel._id));
      if (confirmDel.isDefault && next.length) next = next.map((a, i) => ({ ...a, isDefault: i === 0 }));
      setAddresses(next); showToast("Address deleted.", "success");
    } catch (err) { showToast(err.response?.data?.message || "Failed to delete", "error"); }
    finally { setBusy(false); setConfirmDel(null); }
  };

  const makeDefault = async (a) => {
    try {
      const res = await API.patch(`/auth/me/addresses/${a._id}/default`);
      setAddresses(addresses.map((x) => ({ ...x, isDefault: String(x._id) === String(res.data?._id || a._id) })));
      showToast("Default address updated.", "success");
    } catch (err) { showToast(err.response?.data?.message || "Failed to set default", "error"); }
  };

  return (
    <section className="cp-panel" aria-label="Saved addresses">
      <h2>Saved Addresses</h2>
      <p className="cp-panel-desc">Pick a saved address while booking — you can still edit it per booking.</p>
      {addresses.length === 0 && !editing && (
        <Empty icon={<MapPin size={26} />} title="No saved addresses yet" text="Save your home or office so booking takes seconds." action={<button type="button" className="btn btn-primary" onClick={startAdd}><Plus size={15} /> Add Address</button>} />
      )}
      {addresses.length > 0 && (
        <div className="cp-addr-grid">
          {addresses.map((a) => (
            <article className="cp-addr-card" key={a._id}>
              <div className="cp-addr-top">
                <span className="cp-addr-label">{a.label === "Other" && a.customLabel ? a.customLabel : a.label}</span>
                {a.isDefault && <span className="cp-default-badge">Default</span>}
              </div>
              <div className="cp-addr-lines">
                <span>{[a.flatNo, a.society].filter(Boolean).join(", ")}</span>
                {[a.landmark ? `Near ${a.landmark}` : "", a.city].filter(Boolean).map((l, i) => <span key={i}>{l}</span>)}
              </div>
              <div className="cp-addr-btns">
                <button type="button" className="btn btn-outline btn-sm" onClick={() => startEdit(a)}><Pencil size={13} /> Edit</button>
                {!a.isDefault && <button type="button" className="btn btn-outline btn-sm" onClick={() => makeDefault(a)}>Set Default</button>}
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setConfirmDel(a)} aria-label={`Delete ${a.label} address`}><Trash2 size={13} /> Delete</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {(!editing && addresses.length > 0) && (
        <div className="cp-actions"><button type="button" className="btn btn-primary" onClick={startAdd}><Plus size={15} /> Add Address</button></div>
      )}
      {editing && (
        <form onSubmit={save} noValidate style={{ marginTop: addresses.length ? "1rem" : 0 }}>
          <div className="cp-form-grid two">
            <Field label="Label" error={errors.label} htmlFor="cp-addr-label">
              <select id="cp-addr-label" className="form-control" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })}>
                {ADDRESS_LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </Field>
            {form.label === "Other" && (
              <Field label="Short name" error={errors.customLabel} htmlFor="cp-addr-custom">
                <input id="cp-addr-custom" className="form-control" value={form.customLabel} onChange={(e) => setForm({ ...form, customLabel: e.target.value })} maxLength={40} placeholder="e.g. Grandma's place" />
              </Field>
            )}
            <Field label="Flat / House No." error={errors.flatNo} htmlFor="cp-flat"><input id="cp-flat" className="form-control" value={form.flatNo} onChange={(e) => setForm({ ...form, flatNo: e.target.value })} maxLength={120} placeholder="Flat 12, Plot 5" /></Field>
            <Field label="Society / Building" error={errors.society} htmlFor="cp-soc"><input id="cp-soc" className="form-control" value={form.society} onChange={(e) => setForm({ ...form, society: e.target.value })} maxLength={160} placeholder="Green Park Apartments" /></Field>
            <Field label="Landmark (optional)" htmlFor="cp-land"><input id="cp-land" className="form-control" value={form.landmark} onChange={(e) => setForm({ ...form, landmark: e.target.value })} maxLength={160} placeholder="Near city mall" /></Field>
            <Field label="City" error={errors.city} htmlFor="cp-city"><input id="cp-city" className="form-control" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} maxLength={80} placeholder="Pune" /></Field>
            <Field label="Latitude (optional)" error={errors.lat} htmlFor="cp-lat"><input id="cp-lat" className="form-control" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} inputMode="decimal" placeholder="18.52" /></Field>
            <Field label="Longitude (optional)" error={errors.lng} htmlFor="cp-lng"><input id="cp-lng" className="form-control" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} inputMode="decimal" placeholder="73.85" /></Field>
          </div>
          <label className="cp-radio" style={{ marginTop: "0.7rem" }}><input type="checkbox" checked={form.isDefault} onChange={(e) => setForm({ ...form, isDefault: e.target.checked })} /> Make default address</label>
          <div className="cp-actions">
            <button type="button" className="btn btn-outline" onClick={() => setEditing(null)} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}><Save size={15} /> {saving ? "Saving…" : editing === "new" ? "Save Address" : "Update Address"}</button>
          </div>
        </form>
      )}
      <ConfirmDialog open={Boolean(confirmDel)} title="Delete this address?" text={`"${confirmDel?.label}" will be removed from your address book.`} confirmLabel="Delete" danger onConfirm={remove} onClose={() => setConfirmDel(null)} busy={busy} />
    </section>
  );
}

/* ---------- Tab 3 ---------- */
export function MyActivityTab({ bookings, reviews, navigate }) {
  const upcoming = useMemo(() => bookings.filter((b) => ACTIVE_STATUSES.includes(b.status)).sort((a, b) => new Date(a.date) - new Date(b.date)), [bookings]);
  const completed = useMemo(() => bookings.filter((b) => b.status === "completed").sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10), [bookings]);
  const history = useMemo(() => bookings.filter((b) => ["cancelled", "expired", "rejected", "unattended"].includes(b.status)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10), [bookings]);
  const pretty = (s) => String(s || "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const bookAgain = (b) => navigate("/cook-on-demand", { state: { retryFromBooking: buildRetryState(b) } });

  const card = (b, showAgain) => (
    <article className="cp-activity-card" key={b._id}>
      <div className="cp-activity-top">
        <div className="cp-activity-title">
          <h3>{b.cook?.name || (b.status === "requested" ? "Finding your cook…" : pretty(b.serviceType))}</h3>
          <span className="cp-pill info">{pretty(b.status)}</span>
        </div>
        <div className="cp-activity-meta">
          <span><CalendarClock size={12} /> {formatDate ? formatDate(b.date) : String(b.date)?.slice(0, 10)} · {formatTimeRange12 ? formatTimeRange12(b.startTime, b.endTime, "-") : `${b.startTime}-${b.endTime}`}</span>
          {(b.selectedItems || []).length > 0 && <span><ChefHat size={12} /> {(b.selectedItems || []).slice(0, 3).join(" · ")}{(b.selectedItems || []).length > 3 ? ` +${b.selectedItems.length - 3} more` : ""}</span>}
        </div>
      </div>
      <div className="cp-activity-btns">
        <Link to={`/bookings/${b._id}`} className="btn btn-outline btn-sm">Manage <ChevronRight size={13} /></Link>
        {showAgain && <button type="button" className="btn btn-primary btn-sm" onClick={() => bookAgain(b)}><RotateCcw size={13} /> Book Again</button>}
      </div>
    </article>
  );

  return (
    <section className="cp-panel" aria-label="My activity">
      <h2>My Activity</h2>
      <p className="cp-panel-desc">Upcoming sessions, recent completions, history and the reviews you gave.</p>
      <h3 id="cp-act-upcoming" className="cp-act-anchor" style={{ fontSize: "0.95rem", margin: "0.6rem 0 0.5rem" }}><Clock3 size={14} /> Upcoming ({upcoming.length})</h3>
      {upcoming.length === 0 ? <Empty icon={<CalendarClock size={24} />} title="No upcoming bookings" text="When you book a cook, it will show up here." action={<Link to="/cook-on-demand" className="btn btn-primary btn-sm">Book a Cook</Link>} /> : <div style={{ display: "grid", gap: "0.6rem" }}>{upcoming.slice(0, 6).map((b) => card(b, false))}</div>}
      <h3 id="cp-act-completed" className="cp-act-anchor" style={{ fontSize: "0.95rem", margin: "1rem 0 0.5rem" }}><CheckCircle2 size={14} /> Recent completed ({completed.length})</h3>
      {completed.length === 0 ? <Empty icon={<CheckCircle2 size={24} />} title="No completed sessions yet" text="Your completed sessions will appear here." action={null} /> : <div style={{ display: "grid", gap: "0.6rem" }}>{completed.map((b) => card(b, true))}</div>}
      {history.length > 0 && (<><h3 style={{ fontSize: "0.95rem", margin: "1rem 0 0.5rem" }}>History</h3><div style={{ display: "grid", gap: "0.6rem" }}>{history.map((b) => card(b, true))}</div></>)}
      <h3 id="cp-act-reviews" className="cp-act-anchor" style={{ fontSize: "0.95rem", margin: "1rem 0 0.5rem" }}><Star size={14} /> Reviews given ({reviews.length})</h3>
      {reviews.length === 0 ? <Empty icon={<Star size={24} />} title="No reviews yet" text="After a completed session you can rate your cook." action={null} /> : (
        <div style={{ display: "grid", gap: "0.6rem" }}>
          {reviews.slice(0, 10).map((r) => (
            <div className="cp-review-card" key={r._id || r.booking}>
              <span><Star size={13} /> {r.rating}/5 · {r.cook?.name || "Cook"} {r.createdAt ? `· ${new Date(r.createdAt).toLocaleDateString("en-IN")}` : ""}</span>
              {r.comment && <p>“{r.comment}”</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------- Tab 4 ---------- */
export function SecurityPrivacyTab({ profile, showToast }) {
  const isGoogleOnly = Boolean(profile?.googleId || (profile?.authProvider === "google")) && !profile?.hasPassword;
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [show, setShow] = useState({ c: false, n: false, cf: false });
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState("");
  const googleOnly = profile?.loginMethod === "google" || profile?.authProvider === "google";

  const submit = async (e) => {
    e?.preventDefault();
    const errs = {};
    if (!form.current) errs.current = "Enter your current password";
    if (!form.next || form.next.length < 8) errs.next = "New password must be at least 8 characters";
    else if (form.next.length > 128) errs.next = "New password must be under 128 characters";
    else if (form.next === form.current) errs.next = "New password must be different";
    if (form.confirm !== form.next) errs.confirm = "Passwords do not match";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true); setOk("");
    try {
      await API.post("/auth/change-password", { currentPassword: form.current, newPassword: form.next });
      setOk("Password changed. Other sessions were signed out — use your new password next time.");
      setForm({ current: "", next: "", confirm: "" });
      showToast("Password changed successfully.", "success");
    } catch (err) { const m = err.response?.data?.message || "Failed to change password"; setErrors({ form: m }); showToast(m, "error"); }
    finally { setSaving(false); }
  };

  const pwField = (key, label, showKey, id) => (
    <Field label={label} error={errors[key]} htmlFor={id}>
      <div className="cp-pw-wrap">
        <input id={id} type={show[showKey] ? "text" : "password"} className="form-control" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} autoComplete={key === "current" ? "current-password" : "new-password"} />
        <button type="button" className="cp-pw-toggle" aria-label={show[showKey] ? `Hide ${label}` : `Show ${label}`} onClick={() => setShow((s) => ({ ...s, [showKey]: !s[showKey] }))}>{show[showKey] ? <EyeOff size={17} /> : <Eye size={17} />}</button>
      </div>
    </Field>
  );

  return (
    <section className="cp-panel" aria-label="Security and privacy">
      <h2>Security &amp; Privacy</h2>
      <p className="cp-panel-desc">Signed in via <strong>{googleOnly ? "Google" : profile?.loginMethod === "local+google" || profile?.authProvider === "local+google" ? "Email + Google" : "Email & password"}</strong>. We never show tokens or password hashes here.</p>
      {errors.form && <div className="cp-alert error" role="alert"><AlertCircle size={15} /> {errors.form}</div>}
      {ok && <div className="cp-alert success" role="status"><CheckCircle2 size={15} /> {ok}</div>}
      {googleOnly && <div className="cp-alert info" role="note"><ShieldCheck size={15} /> This account uses Google sign-in only. To set a password, use “Forgot password” on the login page — the change-password form below requires a current password.</div>}
      {!googleOnly && !isGoogleOnly && (
        <form onSubmit={submit} noValidate>
          <div className="cp-form-grid">
            {pwField("current", "Current Password", "c", "cp-cur")}
            {pwField("next", "New Password (min 8 characters)", "n", "cp-new")}
            {pwField("confirm", "Confirm New Password", "cf", "cp-cf")}
          </div>
          <div className="cp-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}><ShieldCheck size={15} /> {saving ? "Updating…" : "Change Password"}</button>
          </div>
        </form>
      )}
      <div className="cp-alert warn" role="note" style={{ marginTop: "0.9rem" }}><AlertCircle size={15} /> Account deletion is handled by support after verification — there is no self-service delete here by design.</div>
    </section>
  );
}

export default CustomerProfile;
