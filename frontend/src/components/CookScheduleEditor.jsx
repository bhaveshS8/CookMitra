import React, { useState } from "react";
import API from "../api/axios";
import { useShowToast } from "../store/hooks";
import { Save, CalendarDays, Trash2, Plus, Info } from "lucide-react";

// Cook's working-week editor: which days they take bookings, the hours of
// each open day, and any dates fully blocked (leave/travel). Saved to
// CookProfile.schedule — the slot engine (utils/slots.js) only offers start
// times inside these windows, so publishing this actually restricts bookings.
// Empty schedule = legacy behaviour (bookable 08:00–20:00 every day).
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
// Monday-first display order of the JS day indexes.
const ORDER = [1, 2, 3, 4, 5, 6, 0];

const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const CookScheduleEditor = ({ profile, onSaved }) => {
  const showToast = useShowToast();
  const weeklyFromProfile = profile?.schedule?.weekly?.length ? profile.schedule.weekly : [];
  const [weekly, setWeekly] = useState(() =>
    ORDER.map((day) => {
      const found = weeklyFromProfile.find((w) => w.day === day);
      return {
        day,
        enabled: Boolean(found?.enabled && found?.startTime && found?.endTime),
        startTime: found?.startTime || "09:00",
        endTime: found?.endTime || "18:00",
      };
    })
  );
  const [blockedDates, setBlockedDates] = useState(profile?.schedule?.blockedDates || []);
  const [newBlocked, setNewBlocked] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const setDay = (day, patch) =>
    setWeekly((prev) => prev.map((w) => (w.day === day ? { ...w, ...patch } : w)));

  const addBlocked = () => {
    const d = String(newBlocked || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    if (!blockedDates.includes(d)) setBlockedDates((prev) => [...prev, d].sort());
    setNewBlocked("");
  };

  const handleSave = async () => {
    setError("");
    // An enabled day needs a start before its end.
    for (const w of weekly) {
      if (!w.enabled) continue;
      const s = toMin(w.startTime);
      const e = toMin(w.endTime);
      if (s == null || e == null || e <= s) {
        const msg = `${DAY_NAMES[w.day]} needs a valid start/end time (end must be after start)`;
        setError(msg);
        showToast(msg, "error");
        return;
      }
    }
    setSaving(true);
    try {
      await API.put("/cooks/me", {
        schedule: {
          weekly: weekly.map((w) => ({
            day: w.day,
            startTime: w.enabled ? w.startTime : "",
            endTime: w.enabled ? w.endTime : "",
            enabled: w.enabled,
          })),
          blockedDates,
        },
      });
      showToast("Working hours saved — customers can now only book your open windows.", "success");
      onSaved?.();
    } catch (err) {
      const msg = err.response?.data?.message || "Could not save your working hours";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cook-card cook-spaced-top">
      <h3 style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
        <CalendarDays size={18} /> Working hours
      </h3>
      <p className="bd-mini-note" style={{ marginBottom: "0.75rem" }}>
        <Info size={13} style={{ display: "inline", verticalAlign: "-2px" }} /> Customers can only book
        inside these windows. Leave them all off to stay bookable 8 AM – 8 PM every day (the default).
      </p>
      <div className="cook-schedule-list">
        {weekly.map((w) => (
          <div
            key={w.day}
            style={{ display: "flex", alignItems: "center", gap: "0.6rem", padding: "0.4rem 0", flexWrap: "wrap" }}
          >
            <label style={{ display: "flex", alignItems: "center", gap: "0.45rem", minWidth: "9.5rem", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={w.enabled}
                onChange={(e) => setDay(w.day, { enabled: e.target.checked })}
              />
              <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{DAY_NAMES[w.day]}</span>
            </label>
            {w.enabled ? (
              <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <input
                  type="time"
                  className="form-control"
                  style={{ width: "auto" }}
                  value={w.startTime}
                  onChange={(e) => setDay(w.day, { startTime: e.target.value })}
                />
                <span style={{ color: "var(--slate-500)" }}>–</span>
                <input
                  type="time"
                  className="form-control"
                  style={{ width: "auto" }}
                  value={w.endTime}
                  onChange={(e) => setDay(w.day, { endTime: e.target.value })}
                />
              </span>
            ) : (
              <span style={{ fontSize: "0.85rem", color: "var(--slate-500)" }}>Not available</span>
            )}
          </div>
        ))}
      </div>

      <div className="cook-field" style={{ marginTop: "0.75rem" }}>
        <label>Blocked dates (leave / travel — nobody can book these days)</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", alignItems: "center" }}>
          <input
            type="date"
            className="form-control"
            style={{ width: "auto", minWidth: 0, flex: "1 1 160px" }}
            value={newBlocked}
            onChange={(e) => setNewBlocked(e.target.value)}
          />
          <button type="button" className="btn btn-outline btn-sm" onClick={addBlocked} disabled={!newBlocked}>
            <Plus size={14} /> Block date
          </button>
        </div>
        {blockedDates.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.6rem" }}>
            {blockedDates.map((d) => (
              <span
                key={d}
                className="my-chip"
                style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
              >
                {d}
                <button
                  type="button"
                  aria-label={`Unblock ${d}`}
                  onClick={() => setBlockedDates((prev) => prev.filter((x) => x !== d))}
                  style={{
                    background: "none",
                    border: 0,
                    cursor: "pointer",
                    padding: 0,
                    color: "var(--slate-500)",
                    display: "inline-flex",
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {error && <p style={{ color: "#dc2626", fontSize: "0.85rem", margin: "0.5rem 0" }}>{error}</p>}
      <button type="button" className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
        <Save size={15} /> {saving ? "Saving…" : "Save working hours"}
      </button>
    </div>
  );
};

export default CookScheduleEditor;
