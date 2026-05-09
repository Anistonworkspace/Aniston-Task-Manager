import React, { useMemo, useState } from 'react';
import { Bell, BellRing, Plus, X } from 'lucide-react';

/**
 * TaskReminderField — Phase 5 task-level reminder picker.
 *
 * Renders a chip-style multi-select for the standard offsets, a single
 * "At due time" toggle, and a "Custom date & time" entry that the user can
 * add multiple instances of. Backend is the source of truth — the `value`
 * prop is the array of normalized specs as returned by GET /api/tasks/:id
 * (`reminders`), and `onChange` should hand back a new array of specs in
 * the same shape that POST/PUT accept:
 *
 *   { kind: 'offset', offsetMinutes: 60 }
 *   { kind: 'at_due' }
 *   { kind: 'custom', at: '<ISO 8601>' }
 *
 * UX notes:
 *  - Offset chips are a fixed list. Multi-select; clicking a chip toggles
 *    that offset in/out of the spec list.
 *  - "At due time" is its own chip.
 *  - "Custom" opens a date+time input and pushes a custom spec when valid.
 *    Past timestamps are rejected client-side with an inline message;
 *    server also rejects them in normalizeReminderSpecs.
 *  - When `dueDate` is null, the offset/at_due chips are disabled and a
 *    helpful hint is shown — those reminders depend on a deadline.
 */

const PRESET_OFFSETS = [
  { minutes: 5,    label: '5 min before' },
  { minutes: 15,   label: '15 min before' },
  { minutes: 30,   label: '30 min before' },
  { minutes: 60,   label: '1 hour before' },
  { minutes: 120,  label: '2 hours before' },
  { minutes: 1440, label: '1 day before' },
];

function specKey(spec) {
  if (!spec) return '';
  if (spec.kind === 'offset' || spec.reminderType === 'offset') {
    return `offset:${spec.offsetMinutes}`;
  }
  if (spec.kind === 'at_due' || spec.reminderType === 'at_due') return 'at_due';
  if (spec.kind === 'custom' || spec.reminderType === 'custom') {
    const at = spec.at || spec.customReminderAt;
    return `custom:${at ? new Date(at).toISOString() : 'invalid'}`;
  }
  return '';
}

/**
 * Convert the model shape (kind/reminderType + offsetMinutes/customReminderAt)
 * into the API write shape (always `kind` + appropriate fields). Used right
 * before handing onChange back so callers can post the array verbatim.
 */
function toWriteShape(specs) {
  return (specs || []).map((s) => {
    const kind = s.kind || s.reminderType;
    if (kind === 'offset') return { kind: 'offset', offsetMinutes: Number(s.offsetMinutes) };
    if (kind === 'at_due') return { kind: 'at_due' };
    if (kind === 'custom') {
      const at = s.at || s.customReminderAt;
      return { kind: 'custom', at: at instanceof Date ? at.toISOString() : new Date(at).toISOString() };
    }
    return null;
  }).filter(Boolean);
}

export default function TaskReminderField({
  value = [],
  onChange,
  dueDate,            // YYYY-MM-DD or null — offset/at_due chips disable when missing
  disabled = false,
  className = '',
}) {
  const [customAt, setCustomAt] = useState('');
  const [customError, setCustomError] = useState('');

  // Pre-compute which presets are currently selected so the chip styling is
  // a single conditional.
  const selectedKeys = useMemo(
    () => new Set((value || []).map(specKey).filter(Boolean)),
    [value]
  );

  function commit(nextSpecs) {
    if (typeof onChange === 'function') onChange(toWriteShape(nextSpecs));
  }

  function toggleOffset(minutes) {
    if (disabled) return;
    const key = `offset:${minutes}`;
    if (selectedKeys.has(key)) {
      commit(value.filter((s) => specKey(s) !== key));
    } else {
      commit([...value, { kind: 'offset', offsetMinutes: minutes }]);
    }
  }

  function toggleAtDue() {
    if (disabled) return;
    if (selectedKeys.has('at_due')) {
      commit(value.filter((s) => specKey(s) !== 'at_due'));
    } else {
      commit([...value, { kind: 'at_due' }]);
    }
  }

  function addCustom() {
    if (disabled) return;
    setCustomError('');
    if (!customAt) {
      setCustomError('Pick a date and time.');
      return;
    }
    const d = new Date(customAt);
    if (Number.isNaN(d.getTime())) {
      setCustomError('Invalid date or time.');
      return;
    }
    if (d.getTime() <= Date.now()) {
      setCustomError('Reminder must be in the future.');
      return;
    }
    const key = `custom:${d.toISOString()}`;
    if (selectedKeys.has(key)) {
      setCustomError('That reminder is already set.');
      return;
    }
    commit([...value, { kind: 'custom', at: d.toISOString() }]);
    setCustomAt('');
  }

  function removeCustom(spec) {
    commit(value.filter((s) => specKey(s) !== specKey(spec)));
  }

  // Custom reminders rendered separately so the user can see + remove each one.
  const customSpecs = (value || []).filter((s) => (s.kind || s.reminderType) === 'custom');

  // Derived state: offset/at_due chips depend on a deadline. Without one,
  // the chips are visually disabled with an inline hint.
  const offsetsLocked = !dueDate;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center gap-1.5 text-xs text-text-secondary">
        <Bell size={12} aria-hidden="true" />
        <span>Reminders</span>
      </div>

      {/* Offset + at-due chips */}
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Reminder offsets">
        {PRESET_OFFSETS.map((p) => {
          const key = `offset:${p.minutes}`;
          const active = selectedKeys.has(key);
          return (
            <button
              key={p.minutes}
              type="button"
              onClick={() => toggleOffset(p.minutes)}
              disabled={disabled || offsetsLocked}
              aria-pressed={active}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 ${
                active
                  ? 'bg-primary text-white border-primary'
                  : 'bg-white dark:bg-surface text-text-primary border-border hover:border-primary/30'
              } ${disabled || offsetsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {p.label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={toggleAtDue}
          disabled={disabled || offsetsLocked}
          aria-pressed={selectedKeys.has('at_due')}
          className={`text-xs px-2.5 py-1 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 ${
            selectedKeys.has('at_due')
              ? 'bg-primary text-white border-primary'
              : 'bg-white dark:bg-surface text-text-primary border-border hover:border-primary/30'
          } ${disabled || offsetsLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          At due time
        </button>
      </div>
      {offsetsLocked && (
        <p className="text-[11px] text-text-tertiary">
          Set a due date to enable timed reminders.
        </p>
      )}

      {/* Custom date+time picker — stacked vertically so the "Add custom"
          button never gets clipped inside the narrow 340px Schedule card.
          Input is full-width with `min-w-0` to play nicely with the rail's
          flex parent; button sits on its own row below, left-aligned,
          width-fit so it stays compact. */}
      <div className="flex flex-col gap-1.5 mt-1 w-full min-w-0">
        <input
          type="datetime-local"
          value={customAt}
          onChange={(e) => { setCustomAt(e.target.value); setCustomError(''); }}
          disabled={disabled}
          aria-label="Custom reminder date and time"
          className="text-xs px-2 py-1 rounded-md border border-border bg-white dark:bg-surface focus:outline-none focus:border-primary w-full min-w-0 max-w-full"
        />
        <button
          type="button"
          onClick={addCustom}
          disabled={disabled || !customAt}
          className="text-xs px-2.5 py-1 rounded-md border border-border bg-white dark:bg-surface text-text-primary hover:border-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/40 inline-flex items-center gap-1 disabled:opacity-50 w-fit max-w-full mt-2 self-start"
        >
          <Plus size={12} aria-hidden="true" /> Add custom
        </button>
        {customError && (
          <p className="text-[11px] text-danger" role="alert">{customError}</p>
        )}
      </div>

      {/* Existing custom reminders — each removable */}
      {customSpecs.length > 0 && (
        <ul className="flex flex-col gap-1 mt-1 list-none p-0">
          {customSpecs.map((s) => {
            const at = s.at || s.customReminderAt;
            const d = at ? new Date(at) : null;
            const label = d
              ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
              : '(invalid)';
            return (
              <li key={specKey(s)} className="flex items-center gap-2 text-xs text-text-primary">
                <BellRing size={12} className="text-primary" aria-hidden="true" />
                <span>{label}</span>
                <button
                  type="button"
                  onClick={() => removeCustom(s)}
                  disabled={disabled}
                  aria-label={`Remove custom reminder for ${label}`}
                  className="ml-1 p-0.5 rounded text-text-tertiary hover:text-danger focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
