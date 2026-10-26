import { useState } from "react";
import API from "../api/axios";
import { useFetch } from "../hooks/useFetch";
import { useShowToast } from "../store/hooks";
import { Plus, Pencil, Trash2, Check, X, CalendarHeart, Sparkles } from "lucide-react";

// Admin: event catalogue (§16) — add / edit / delete / activate-deactivate.
const EventTypeManager = () => {
  const { data, loading, refetch } = useFetch("/events?all=1");
  const showToast = useShowToast();
  const [form, setForm] = useState({ name: "", description: "" });
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const list = Array.isArray(data) ? data : [];
  const activeCount = list.filter((t) => t.active).length;

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
    <div className="event-admin etm">
      <header className="etm-hero">
        <span className="etm-hero-icon" aria-hidden="true">
          <CalendarHeart size={22} />
        </span>
        <div className="etm-hero-copy">
          <p className="etm-eyebrow">Event catalogue</p>
          <h2 className="etm-title">Event Types</h2>
          <p className="etm-sub">
            Occasions customers can book — Birthday, Anniversary, Family Function, Home Celebration, Other.
          </p>
        </div>
        <div className="etm-hero-stats">
          <span className="etm-hero-stat">
            <strong>{list.length}</strong>
            <span>Total</span>
          </span>
          <span className="etm-hero-stat etm-hero-stat--active">
            <strong>{activeCount}</strong>
            <span>Active</span>
          </span>
        </div>
      </header>

      <form onSubmit={handleSubmit} className="etm-form">
        <div className="etm-form-head">
          <span className="etm-form-icon" aria-hidden="true">
            {editing ? <Pencil size={16} /> : <Sparkles size={16} />}
          </span>
          <div>
            <h3 className="etm-form-title">{editing ? "Edit event type" : "Add a new event type"}</h3>
            <p className="etm-form-sub">
              {editing
                ? "Update the name or description, then save your changes."
                : "Give the occasion a clear name and a short helper description."}
            </p>
          </div>
        </div>

        <div className="etm-form-grid">
          <div className="etm-field">
            <label htmlFor="event-type-name">Event name</label>
            <input
              id="event-type-name"
              type="text"
              className="form-control"
              placeholder="e.g. Housewarming"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="etm-field etm-field--wide">
            <label htmlFor="event-type-desc">Short description</label>
            <input
              id="event-type-desc"
              type="text"
              className="form-control"
              placeholder="One line shown to customers when they pick an occasion"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
        </div>

        <div className="etm-form-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            {editing ? <Check size={15} /> : <Plus size={15} />} {editing ? "Update event" : "Add event"}
          </button>
          {editing && (
            <button type="button" className="btn btn-outline btn-sm" onClick={reset}>
              <X size={15} /> Cancel
            </button>
          )}
        </div>
      </form>

      <div className="etm-list-head">
        <h3>All event types</h3>
        <span className="etm-list-count">{list.length} {list.length === 1 ? "occasion" : "occasions"}</span>
      </div>

      {loading ? (
        <div className="loading-spinner-wrapper">
          <div className="spinner"></div>
          <p>Loading events...</p>
        </div>
      ) : list.length > 0 ? (
        <div className="etm-list">
          {list.map((t) => (
            <article key={t._id} className={`etm-card${t.active ? "" : " is-inactive"}`}>
              <div className="etm-card-head">
                <div className="etm-card-title-wrap">
                  <h4 className="etm-card-title">{t.name}</h4>
                  <p className="etm-card-desc">{t.description || "No description added yet."}</p>
                </div>
                <span className={`etm-badge ${t.active ? "etm-badge--active" : "etm-badge--inactive"}`}>
                  <span className="etm-badge-dot" aria-hidden="true" />
                  {t.active ? "Active" : "Inactive"}
                </span>
              </div>
              <div className="etm-card-actions">
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    setEditing(t._id);
                    setForm({ name: t.name, description: t.description || "" });
                  }}
                >
                  <Pencil size={14} /> Edit
                </button>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => handleToggle(t)}>
                  {t.active ? "Deactivate" : "Activate"}
                </button>
                <button type="button" className="btn btn-danger-outline btn-sm" onClick={() => handleDelete(t)}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="etm-empty">
          <CalendarHeart size={28} aria-hidden="true" />
          <p>
            No events yet — run <code>npm run seed:events</code> on the backend or add one above.
          </p>
        </div>
      )}
    </div>
  );
};

export default EventTypeManager;
