import React, { useState, useEffect, useRef } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

// CustomCalendar — modern popup calendar for booking date fields.
// Fully styled month grid (the native date popup is OS-controlled and
// can't be branded). Controlled by YYYY-MM-DD strings — same shape as
// <input type="date"> so it drops into the booking forms directly.
//
// Props:
//   value    — selected "YYYY-MM-DD" (or "" for none)
//   min      — earliest selectable "YYYY-MM-DD" (optional)
//   max      — latest selectable "YYYY-MM-DD" (optional)
//   onChange — (dateStr) => void
//   id       — field id for the label htmlFor (optional)
//   placeholder — field text when nothing is picked
const parseDay = (s) => {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return { y, m: mo, d };
};

const toStr = (y, m, d) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

const todayStr = () => {
  const n = new Date();
  return toStr(n.getFullYear(), n.getMonth() + 1, n.getDate());
};

const shiftMonth = (y, m, delta) => {
  const dt = new Date(y, m - 1 + delta, 1);
  return { y: dt.getFullYear(), m: dt.getMonth() + 1 };
};

const monthKey = (y, m) => y * 12 + m;

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const fmtField = (s) => {
  const p = parseDay(s);
  if (!p) return null;
  const dt = new Date(p.y, p.m - 1, p.d);
  const isToday = s === todayStr();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = s === toStr(tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate());
  return {
    main: dt.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" }),
    tag: isToday ? "Today" : isTomorrow ? "Tomorrow" : dt.toLocaleDateString("en-IN", { year: "numeric", month: "short" }),
  };
};

const CustomCalendar = ({ value, min, max, onChange, id, placeholder = "Pick a date" }) => {
  const [open, setOpen] = useState(false);
  const parsed = parseDay(value);
  const today = parseDay(todayStr());
  // Month currently on display — selected month, else today.
  const [view, setView] = useState(() =>
    parsed ? { y: parsed.y, m: parsed.m } : { y: today.y, m: today.m }
  );
  const wrapRef = useRef(null);
  const fieldRef = useRef(null);

  // When the value changes from outside (quick chips, draft restore),
  // follow it with the displayed month.
  useEffect(() => {
    if (parsed) setView({ y: parsed.y, m: parsed.m });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Close on Escape and hand focus back to the field.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        setOpen(false);
        fieldRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open ]);

  const minP = parseDay(min);
  const maxP = parseDay(max);
  const minKey = minP ? monthKey(minP.y, minP.m) : null;
  const maxKey = maxP ? monthKey(maxP.y, maxP.m) : monthKey(today.y, today.m) + 12;
  const viewKey = monthKey(view.y, view.m);
  const canPrev = minKey == null || viewKey > minKey;
  const canNext = maxKey == null || viewKey < maxKey;

  const daysInMonth = new Date(view.y, view.m, 0).getDate();
  const leadBlanks = new Date(view.y, view.m - 1, 1).getDay();
  const monthName = new Date(view.y, view.m - 1, 1).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });

  const isDisabled = (d) => {
    const s = toStr(view.y, view.m, d);
    if (min && s < min) return true;
    if (max && s > max) return true;
    return false;
  };

  const pick = (d) => {
    onChange?.(toStr(view.y, view.m, d));
    setOpen(false);
    fieldRef.current?.focus();
  };

  const goToday = () => {
    const t = todayStr();
    if (min && t < min) return;
    if (max && t > max) return;
    onChange?.(t);
    setOpen(false);
    fieldRef.current?.focus();
  };

  const goTomorrow = () => {
    const n = new Date();
    n.setDate(n.getDate() + 1);
    const t = toStr(n.getFullYear(), n.getMonth() + 1, n.getDate());
    if (min && t < min) return;
    if (max && t > max) return;
    onChange?.(t);
    setOpen(false);
    fieldRef.current?.focus();
  };

  const shown = fmtField(value);

  return (
    <span className="ccal" ref={wrapRef}>
      <button
        ref={fieldRef}
        id={id}
        type="button"
        className={`ccal-field ${shown ? "has-value" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={shown ? `Chosen date ${shown.main}. Activate to change.` : placeholder}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ccal-field-icon" aria-hidden="true">
          <CalendarDays size={16} />
        </span>
        <span className="ccal-field-text">
          {shown ? (
            <>
              <strong>{shown.main}</strong>
              <em>{shown.tag}</em>
            </>
          ) : (
            <span className="ccal-field-empty">{placeholder}</span>
          )}
        </span>
        <ChevronRight
          size={15}
          aria-hidden="true"
          className={`ccal-field-chev ${open ? "open" : ""}`}
        />
      </button>

      {open && (
        <>
          <span
            className="ccal-overlay"
            aria-hidden="true"
            onClick={() => setOpen(false)}
          />
          <span
            className="ccal-pop"
            role="dialog"
            aria-modal="false"
            aria-label="Choose a date"
          >
            <span className="ccal-head">
              <button
                type="button"
                className="ccal-nav"
                aria-label="Previous month"
                disabled={!canPrev}
                onClick={() => canPrev && setView((v) => shiftMonth(v.y, v.m, -1))}
              >
                <ChevronLeft size={16} />
              </button>
              <span className="ccal-month" aria-live="polite">
                {monthName}
              </span>
              <button
                type="button"
                className="ccal-nav"
                aria-label="Next month"
                disabled={!canNext}
                onClick={() => canNext && setView((v) => shiftMonth(v.y, v.m, 1))}
              >
                <ChevronRight size={16} />
              </button>
            </span>

            <span className="ccal-week" aria-hidden="true">
              {WEEKDAYS.map((w) => (
                <span key={w}>{w}</span>
              ))}
            </span>

            <span className="ccal-grid" key={`${view.y}-${view.m}`} role="group" aria-label={monthName}>
              {Array.from({ length: leadBlanks }).map((_, i) => (
                <span key={`b${i}`} className="ccal-blank" aria-hidden="true" />
              ))}
              {Array.from({ length: daysInMonth }).map((_, i) => {
                const d = i + 1;
                const s = toStr(view.y, view.m, d);
                const disabled = isDisabled(d);
                const selected = value === s;
                const isToday = s === todayStr();
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={disabled}
                    aria-pressed={selected}
                    aria-label={`${d} ${monthName}${isToday ? " (today)" : ""}`}
                    className={`ccal-day ${selected ? "selected" : ""} ${isToday ? "today" : ""}`}
                    onClick={() => pick(d)}
                  >
                    {d}
                  </button>
                );
              })}
            </span>

            <span className="ccal-foot">
              <span className="ccal-quick">
                <button type="button" className="ccal-today" onClick={goToday}>
                  Today
                </button>
                <button type="button" className="ccal-today" onClick={goTomorrow}>
                  Tomorrow
                </button>
              </span>
              {shown && <span className="ccal-picked">{shown.main}</span>}
            </span>
          </span>
        </>
      )}
    </span>
  );
};

export default CustomCalendar;
