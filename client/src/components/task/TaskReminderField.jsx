import React, { useMemo, useState } from 'react';
import { Bell, BellRing, Plus, X, Repeat, Clock } from 'lucide-react';

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

// Recurring-reminder interval presets (in minutes). "Custom…" reveals a
// numeric input for arbitrary hour+minute values within the backend's
// 15–10080 minute range.
const INTERVAL_PRESETS = [
  { minutes: 60,   label: 'Hourly' },
  { minutes: 120,  label: 'Every 2h' },
  { minutes: 180,  label: 'Every 3h' },
  { minutes: 240,  label: 'Every 4h' },
];

const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 10080;
const MAX_DAILY_TIMES = 12;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  if (spec.kind === 'interval' || spec.reminderType === 'interval') return 'interval';
  if (spec.kind === 'daily_times' || spec.reminderType === 'daily_times') return 'daily_times';
  return '';
}

/**
 * Format a minutes value as the helper line: "every 2 hours", "every 45 min", etc.
 */
function formatInterval(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return '';
  if (m >= 1440 && m % 1440 === 0) {
    const d = m / 1440;
    return d === 1 ? 'every day' : `every ${d} days`;
  }
  if (m >= 60 && m % 60 === 0) {
    const h = m / 60;
    return h === 1 ? 'every hour' : `every ${h} hours`;
  }
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return `every ${h}h ${r}min`;
  }
  return `every ${m} min`;
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
    if (kind === 'interval') {
      const m = Number(s.intervalMinutes);
      if (!Number.isFinite(m)) return null;
      return { kind: 'interval', intervalMinutes: m };
    }
    if (kind === 'daily_times') {
      const times = Array.isArray(s.times) ? s.times : s.timesOfDay;
      if (!Array.isArray(times) || times.length === 0) return null;
      return { kind: 'daily_times', times, ...(s.timezone ? { timezone: s.timezone } : {}) };
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

  // Recurring-reminder local state. Custom-interval inputs are tracked
  // here (not in `value`) because the user may be mid-typing — only valid,
  // committed values flow into the spec list.
  const [customHours, setCustomHours] = useState('1');
  const [customMinutes, setCustomMinutes] = useState('0');
  const [newTime, setNewTime] = useState('');
  const [timeError, setTimeError] = useState('');

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

  // ── Recurring reminder helpers ───────────────────────────────────────
  // Find the current recurring spec (interval OR daily_times, mutually
  // exclusive in the UI). Returns null if none is configured.
  const recurringSpec = useMemo(
    () => (value || []).find((s) => {
      const k = s.kind || s.reminderType;
      return k === 'interval' || k === 'daily_times';
    }) || null,
    [value]
  );
  const recurringKind = recurringSpec ? (recurringSpec.kind || recurringSpec.reminderType) : null;
  const recurringOn = !!recurringSpec;

  // Pull configured times-of-day from the spec for the pill list.
  const dailyTimes = useMemo(() => {
    if (recurringKind !== 'daily_times') return [];
    const t = recurringSpec.times || recurringSpec.timesOfDay;
    return Array.isArray(t) ? t : [];
  }, [recurringSpec, recurringKind]);

  // Is the current interval value one of the chip presets, or a custom one?
  const currentIntervalMinutes = recurringKind === 'interval'
    ? Number(recurringSpec.intervalMinutes)
    : null;
  const isPresetInterval = INTERVAL_PRESETS.some((p) => p.minutes === currentIntervalMinutes);
  const isCustomInterval = recurringKind === 'interval' && !isPresetInterval && Number.isFinite(currentIntervalMinutes);

  // Replace the recurring spec (if any) with the new one. Pass null to
  // remove all recurring specs (toggle off).
  function setRecurring(nextSpec) {
    if (disabled) return;
    const withoutRecurring = (value || []).filter((s) => {
      const k = s.kind || s.reminderType;
      return k !== 'interval' && k !== 'daily_times';
    });
    commit(nextSpec ? [...withoutRecurring, nextSpec] : withoutRecurring);
  }

  function toggleRecurring() {
    if (disabled) return;
    if (recurringOn) {
      setRecurring(null);
    } else {
      // Default: hourly. User can switch tabs or pick another preset.
      setRecurring({ kind: 'interval', intervalMinutes: 60 });
    }
  }

  function switchToIntervalTab() {
    if (disabled || recurringKind === 'interval') return;
    setRecurring({ kind: 'interval', intervalMinutes: 60 });
  }

  function switchToTimesTab() {
    if (disabled || recurringKind === 'daily_times') return;
    setRecurring({ kind: 'daily_times', times: ['09:00'] });
  }

  function pickIntervalPreset(minutes) {
    if (disabled) return;
    setRecurring({ kind: 'interval', intervalMinutes: minutes });
  }

  function applyCustomInterval() {
    if (disabled) return;
    const h = Math.max(0, Math.floor(Number(customHours) || 0));
    const m = Math.max(0, Math.floor(Number(customMinutes) || 0));
    const total = h * 60 + m;
    if (total < MIN_INTERVAL_MINUTES || total > MAX_INTERVAL_MINUTES) {
      // Inline guard — the chip stays selected but we don't commit a bad value.
      return;
    }
    setRecurring({ kind: 'interval', intervalMinutes: total });
  }

  function addDailyTime() {
    if (disabled) return;
    setTimeError('');
    if (!newTime) return;
    if (!HHMM_RE.test(newTime)) {
      setTimeError('Use 24-hour HH:MM format.');
      return;
    }
    if (dailyTimes.includes(newTime)) {
      setTimeError('That time is already added.');
      return;
    }
    if (dailyTimes.length >= MAX_DAILY_TIMES) {
      setTimeError(`At most ${MAX_DAILY_TIMES} times.`);
      return;
    }
    const next = [...dailyTimes, newTime].sort();
    setRecurring({ kind: 'daily_times', times: next });
    setNewTime('');
  }

  function removeDailyTime(t) {
    if (disabled) return;
    const next = dailyTimes.filter((x) => x !== t);
    if (next.length === 0) {
      // Don't leave an empty daily_times spec — backend rejects it and the
      // helper text would be confusing. Switch back to off.
      setRecurring(null);
    } else {
      setRecurring({ kind: 'daily_times', times: next });
    }
  }

  // Dynamic helper text for the recurring card footer. Kept short — the
  // header tooltip already explains the "until done" guarantee.
  const recurringHelper = (() => {
    if (!recurringOn) return null;
    if (recurringKind === 'interval') {
      const m = currentIntervalMinutes;
      if (!Number.isFinite(m)) return 'Pick a frequency.';
      return `Repeats ${formatInterval(m)}.`;
    }
    if (recurringKind === 'daily_times') {
      if (dailyTimes.length === 0) return 'Add a time.';
      return `Daily at ${dailyTimes.join(', ')}.`;
    }
    return null;
  })();

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

      {/* ── Recurring reminder card (compact) ──────────────────────────
          Single-row header when off; tabs + chip body when on. Designed to
          stay under ~120px tall when on, ~32px when off. */}
      <div className="mt-2 rounded-md border border-border bg-white/40 dark:bg-surface/40">
        {/* Header: title + on/off toggle on one line. Title shrinks to icon+label. */}
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <Repeat size={12} className="text-primary flex-shrink-0" aria-hidden="true" />
            <span className="text-xs text-text-primary" title="Repeats until the task is marked done">
              Repeat reminder
            </span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={recurringOn}
            aria-label={recurringOn ? 'Turn off repeating reminder' : 'Turn on repeating reminder'}
            onClick={toggleRecurring}
            disabled={disabled}
            className={`relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 ${
              recurringOn ? 'bg-primary' : 'bg-zinc-300 dark:bg-zinc-700'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                recurringOn ? 'translate-x-3.5' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>

        {recurringOn && (
          <div className="border-t border-border px-2 py-1.5 flex flex-col gap-1.5">
            {/* Tabs — compact pill row */}
            <div className="grid grid-cols-2 gap-0.5 p-0.5 rounded bg-zinc-100 dark:bg-zinc-800" role="tablist" aria-label="Repeat mode">
              <button
                type="button"
                role="tab"
                aria-selected={recurringKind === 'interval'}
                onClick={switchToIntervalTab}
                disabled={disabled}
                className={`text-[11px] px-1.5 py-0.5 rounded inline-flex items-center justify-center gap-1 transition-colors ${
                  recurringKind === 'interval'
                    ? 'bg-white dark:bg-surface text-text-primary'
                    : 'text-text-secondary hover:text-text-primary'
                } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <Repeat size={10} aria-hidden="true" /> Every N hours
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={recurringKind === 'daily_times'}
                onClick={switchToTimesTab}
                disabled={disabled}
                className={`text-[11px] px-1.5 py-0.5 rounded inline-flex items-center justify-center gap-1 transition-colors ${
                  recurringKind === 'daily_times'
                    ? 'bg-white dark:bg-surface text-text-primary'
                    : 'text-text-secondary hover:text-text-primary'
                } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <Clock size={10} aria-hidden="true" /> Specific times
              </button>
            </div>

            {/* Interval-mode body */}
            {recurringKind === 'interval' && (
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Interval presets">
                {INTERVAL_PRESETS.map((p) => {
                  const active = isPresetInterval && currentIntervalMinutes === p.minutes;
                  return (
                    <button
                      key={p.minutes}
                      type="button"
                      onClick={() => pickIntervalPreset(p.minutes)}
                      disabled={disabled}
                      aria-pressed={active}
                      className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 ${
                        active
                          ? 'bg-primary text-white border-primary'
                          : 'bg-white dark:bg-surface text-text-primary border-border hover:border-primary/30'
                      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      {p.label}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={applyCustomInterval}
                  disabled={disabled}
                  aria-pressed={isCustomInterval}
                  className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 ${
                    isCustomInterval
                      ? 'bg-primary text-white border-primary'
                      : 'bg-white dark:bg-surface text-text-primary border-border hover:border-primary/30'
                  } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  Custom…
                </button>

                {/* Custom hr+min inline, only when active. No labels — colon separates. */}
                {isCustomInterval && (
                  <span className="inline-flex items-center gap-0.5 text-[11px] text-text-secondary">
                    <input
                      type="number"
                      min="0"
                      max="168"
                      value={customHours}
                      onChange={(e) => setCustomHours(e.target.value)}
                      onBlur={applyCustomInterval}
                      disabled={disabled}
                      aria-label="Hours"
                      className="w-9 px-1 py-0.5 rounded border border-border bg-white dark:bg-surface text-text-primary text-center focus:outline-none focus:border-primary"
                    />
                    <span>h</span>
                    <input
                      type="number"
                      min="0"
                      max="59"
                      value={customMinutes}
                      onChange={(e) => setCustomMinutes(e.target.value)}
                      onBlur={applyCustomInterval}
                      disabled={disabled}
                      aria-label="Minutes"
                      className="w-9 px-1 py-0.5 rounded border border-border bg-white dark:bg-surface text-text-primary text-center focus:outline-none focus:border-primary"
                    />
                    <span>m</span>
                  </span>
                )}
              </div>
            )}

            {/* Times-of-day mode body */}
            {recurringKind === 'daily_times' && (
              <div className="flex flex-wrap items-center gap-1" role="list" aria-label="Daily reminder times">
                {dailyTimes.map((t) => (
                  <span
                    key={t}
                    role="listitem"
                    className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20"
                  >
                    {t}
                    <button
                      type="button"
                      onClick={() => removeDailyTime(t)}
                      disabled={disabled}
                      aria-label={`Remove ${t}`}
                      className="ml-0.5 p-px rounded hover:bg-primary/20 focus:outline-none focus:ring-1 focus:ring-primary/40"
                    >
                      <X size={9} aria-hidden="true" />
                    </button>
                  </span>
                ))}
                {dailyTimes.length < MAX_DAILY_TIMES && (
                  <>
                    <input
                      type="time"
                      value={newTime}
                      onChange={(e) => { setNewTime(e.target.value); setTimeError(''); }}
                      disabled={disabled}
                      aria-label="Add reminder time"
                      className="text-[11px] px-1.5 py-0.5 rounded border border-border bg-white dark:bg-surface focus:outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      onClick={addDailyTime}
                      disabled={disabled || !newTime}
                      aria-label="Add time"
                      className="text-[11px] p-1 rounded border border-border bg-white dark:bg-surface text-text-primary hover:border-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/40 inline-flex items-center disabled:opacity-50"
                    >
                      <Plus size={11} aria-hidden="true" />
                    </button>
                  </>
                )}
                {timeError && (
                  <p className="w-full text-[10px] text-danger m-0" role="alert">{timeError}</p>
                )}
              </div>
            )}

            {recurringHelper && (
              <p className="text-[10px] text-text-tertiary m-0">{recurringHelper}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
