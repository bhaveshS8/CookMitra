import { useState } from "react";
import API from "../api/axios";
import { useFetch } from "../hooks/useFetch";
import { useShowToast } from "../store/hooks";
import { Plus, Pencil, Trash2, Check, X } from "lucide-react";

// Admin: event catalogue (§16) — add / edit / delete / activate-deactivate.
const EventTypeManager = () => {
  const { data, loading, refetch } = useFetch("/events?all=1");
  const showToast = useShowToast();
  const [form, setForm] = useState({ name: "", description: "" });
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const list = Array.isArray(data) ? data : [];

  const reset = () => {
    setForm({ name: "", description: "" });
    setEditing(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      showToast("Event name is required", "error");
      return;
    }
    setBusy(true);
    try {
      if (editing) {
        await API.put(`/events/${editing}`, { name: form.name.trim(), description: form.description.trim() });
        showToast("Event updated!", "success");
      } else {
        await API.post("/events", { name: form.name.trim(), description: form.description.trim() });
        showToast("Event added!", "success");
      }
      reset();
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Save failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (t) => {
    try {
      await API.put(`/events/${t._id}`, { active: !t.active });
      showToast(`Event ${t.active ? "deactivated" : "activated"}`, "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Update failed", "error");
    }
  };

  const handleDelete = async (t) => {
    if (!window.confirm(`Delete event "${t.name}"? Existing bookings keep their event label.`)) return;
    try {
      await API.delete(`/events/${t._id}`);
      showToast("Event deleted", "success");
      refetch();
    } catch (err) {
      showToast(err.response?.data?.message || "Delete failed", "error");
    }
  };

  return (
    <div className="event-admin">
      <h2 style={{ fontSize: "1.4rem", marginBottom: "0.4rem" }}>Event Types</h2>
      <p style={{ color: "var(--slate-600)", margin: "0 0 1.25rem", fontSize: "0.92rem" }}>
        Occasions customers can book — Birthday, Anniversary, Family Function, Home Celebration, Other.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1.25rem" }}>
        <input
          type="text"
          className="form-control"
          style={{ maxWidth: 240 }}
          placeholder="Event name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          type="text"
          className="form-control"
          style={{ maxWidth: 320 }}
          placeholder="Short description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {editing ? <Check size={15} /> : <Plus size={15} />} {editing ? "Update" : "Add Event"}
        </button>
        {editing && (
          <button type="button" className="btn btn-outline btn-sm" onClick={reset}>
            <X size={15} /> Cancel
          </button>
        )}
      </form>

      {loading ? (
        <div className="loading-spinner-wrapper">
          <div className="spinner"></div>
          <p>Loading events...</p>
        </div>
      ) : list.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {list.map((t) => (
            <div
              key={t._id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.7rem",
                padding: "0.65rem 0.8rem",
                background: "#fff",
                border: "1px solid var(--border-subtle)",
                borderRadius: "10px",
                flexWrap: "wrap",
              }}
            >
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontWeight: 700 }}>{t.name}</div>
                <div style={{ fontSize: "0.82rem", color: "var(--slate-500)" }}>{t.description || "—"}</div>
              </div>
              <span className={`badge ${t.active ? "badge-emerald" : "badge-slate"}`}>
                {t.active ? "ACTIVE" : "INACTIVE"}
              </span>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => {
                  setEditing(t._id);
                  setForm({ name: t.name, description: t.description || "" });
                }}
              >
                <Pencil size={14} /> Edit
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => handleToggle(t)}>
                {t.active ? "Deactivate" : "Activate"}
              </button>
              <button className="btn btn-danger-outline btn-sm" onClick={() => handleDelete(t)}>
                <Trash2 size={14} /> Delete
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p style={{ color: "var(--slate-500)" }}>
          No events yet — run <code>npm run seed:events</code> on the backend or add one above.
        </p>
      )}
    </div>
  );
};

export default EventTypeManager;
