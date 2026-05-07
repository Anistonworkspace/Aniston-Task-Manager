import React, { useEffect, useMemo, useState } from 'react';
import { Calendar, Clock, RefreshCw, AlertTriangle, Save } from 'lucide-react';
import Modal from '../common/Modal';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../common/Toast';
import {
  createTemplate,
  updateTemplate,
  FREQUENCIES,
  WEEKDAY_LABELS,
  ESCALATION_TARGETS,
  dueTimeToInputValue,
  getMonthlyDaysFromTemplate,
  normalizeFrequencyForUI,
} from '../../services/recurringTasks';

/**
 * RecurringTemplateModal — create or edit a Daily Work / Recurring template.
 *
 * Mode: `template` prop is null → create. Non-null → edit (PATCH only changed
 * fields). The form is intentionally one big modal (~640px wide); breaking it
 * into a wizard adds friction without information density gain.
 *
 * Server-side authorization re-runs on submit, so the form is permissive
 * client-side (we don't block buttons preemptively except where the rule is
 * unambiguous, e.g. a member's assignee dropdown is locked to themselves).
 *
 * `presetBoardId` is optional — set when launched from BoardPage to pre-fill
 * the board choice.
 */
export default function RecurringTemplateModal({
  isOpen,
  onClose,
  onSaved,
  template = null,
  presetBoardId = null,
}) {
  const { user, isMember } = useAuth();
  const { success: toastSuccess, error: toastError } = useToast();

  // ─── Form state ───────────────────────────────────────────────────────────
  const isEdit = !!template;

  const browserTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
    catch { return 'UTC'; }
  }, []);

  const [form, setForm] = useState(() => buildInitialForm(template, { user, presetBoardId, browserTz }));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Load options for dropdowns. Boards + assignable users are both small and
  // the call is cheap; we fetch them on open and reuse for the modal lifetime.
  const [boards, setBoards] = useState([]);
  const [users, setUsers] = useState([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setError('');
    setSubmitting(false);
    setForm(buildInitialForm(template, { user, presetBoardId, browserTz }));
    // Fetch options each time the modal opens — cheap, and ensures fresh data
    // (e.g. a board the user just created shows up immediately).
    let cancelled = false;
    (async () => {
      setOptionsLoading(true);
      try {
        const [boardsRes, usersRes] = await Promise.all([
          api.get('/boards'),
          api.get('/auth/assignable-users'),
        ]);
        if (cancelled) return;
        const allBoards = boardsRes.data.boards || boardsRes.data || [];
        const allUsers = usersRes.data.users || usersRes.data || [];
        setBoards(allBoards.filter(b => !b.isArchived));
        setUsers(allUsers);
      } catch (e) {
        if (!cancelled) setError('Could not load boards or users. Please try again.');
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, template?.id]);

  // Selected board's groups, used to populate the group dropdown.
  const selectedBoard = useMemo(
    () => boards.find(b => b.id === form.boardId) || null,
    [boards, form.boardId]
  );
  const groupChoices = useMemo(() => {
    const groups = selectedBoard?.groups || [];
    return Array.isArray(groups) ? groups : [];
  }, [selectedBoard]);

  // Whenever the board changes, reset groupId to the first available group
  // (avoiding orphaned IDs that won't render anything on the destination board).
  useEffect(() => {
    if (!selectedBoard) return;
    const has = groupChoices.find(g => g.id === form.groupId);
    if (!has) {
      setForm((f) => ({ ...f, groupId: groupChoices[0]?.id || 'new' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBoard?.id]);

  // Members may only target themselves. Lock the assignee dropdown to the
  // current user so the UI matches the server's enforcement.
  const assigneeChoices = useMemo(() => {
    if (isMember) return users.filter(u => u.id === user.id);
    return users;
  }, [users, isMember, user]);

  // 'custom' is no longer a user-selectable frequency, but be defensive in
  // case a stale form state slips through — the server still accepts it.
  const requiresWeekdays = form.frequency === 'weekly' || form.frequency === 'custom';
  const requiresDayOfMonth = form.frequency === 'monthly';

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function toggleWeekday(d) {
    setForm((f) => {
      const has = f.weekdays.includes(d);
      const next = has ? f.weekdays.filter(x => x !== d) : [...f.weekdays, d].sort((a,b) => a - b);
      return { ...f, weekdays: next };
    });
  }

  function toggleMonthlyDay(d) {
    setForm((f) => {
      const has = f.daysOfMonth.includes(d);
      const next = has
        ? f.daysOfMonth.filter((x) => x !== d)
        : [...new Set([...f.daysOfMonth, d])].sort((a, b) => a - b);
      return { ...f, daysOfMonth: next };
    });
  }

  function toggleEscalationTarget(t) {
    setForm((f) => {
      const has = f.escalationTargets.includes(t);
      const next = has ? f.escalationTargets.filter(x => x !== t) : [...f.escalationTargets, t];
      return { ...f, escalationTargets: next };
    });
  }

  function validate() {
    if (!form.title.trim()) return 'Title is required.';
    if (!form.boardId) return 'Pick a board.';
    if (!form.assigneeId) return 'Pick an assignee.';
    if (!form.startDate) return 'Pick a start date.';
    if (form.endDate && form.endDate < form.startDate) return 'End date must be on or after start date.';
    if (requiresWeekdays && form.weekdays.length === 0) return 'Pick at least one weekday.';
    if (requiresDayOfMonth) {
      if (!Array.isArray(form.daysOfMonth) || form.daysOfMonth.length === 0) {
        return 'Pick at least one day of the month.';
      }
      const bad = form.daysOfMonth.find((d) => !Number.isInteger(d) || d < 1 || d > 31);
      if (bad !== undefined) return 'Days of month must be integers between 1 and 31.';
    }
    if (form.escalateIfMissed && form.escalationTargets.length === 0) {
      return 'Pick at least one escalation target, or turn off "Notify if missed".';
    }
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const v = validate();
    if (v) { setError(v); return; }

    // Build payload. Send weekdays / dayOfMonth only when relevant for the
    // chosen frequency so we don't accidentally widen valid ranges.
    const payload = {
      title: form.title.trim(),
      description: form.description.trim() || undefined,
      boardId: form.boardId,
      groupId: form.groupId || 'new',
      assigneeId: form.assigneeId,
      priority: form.priority,
      frequency: form.frequency,
      startDate: form.startDate,
      endDate: form.endDate || null,
      // dueTime input is "HH:mm" — server normalises to "HH:mm:ss".
      dueTime: form.dueTime,
      timezone: form.timezone,
      escalateIfMissed: form.escalateIfMissed,
      escalationTargets: form.escalateIfMissed ? form.escalationTargets : ['assignee', 'manager'],
      isActive: form.isActive,
    };
    if (requiresWeekdays) payload.weekdays = form.weekdays;
    if (requiresDayOfMonth) {
      // New monthly templates always send the multi-day array. The server
      // mirrors `daysOfMonth[0]` onto the legacy `dayOfMonth` integer column,
      // so older code paths that still read `dayOfMonth` keep working without
      // any migration.
      payload.daysOfMonth = form.daysOfMonth;
    }

    setSubmitting(true);
    try {
      let saved;
      if (isEdit) {
        saved = await updateTemplate(template.id, payload);
        toastSuccess('Recurring work updated.');
      } else {
        // createTemplate returns { template, immediateGeneration }. The
        // server now seeds the NEXT UPCOMING occurrence (today or future) on
        // create, so the assignee sees a concrete task right away with the
        // correct future dueDate.
        //
        // Branches:
        //   generated=true, occurrenceDate=today      → today's task is live
        //   generated=true, occurrenceDate=future     → next occurrence task
        //                                               is created with that
        //                                               future dueDate
        //   alreadyExisted=true                       → idempotent re-seed,
        //                                               no new row but the
        //                                               instance is there
        //   error / non-window reason                 → template saved but
        //                                               first instance failed
        //                                               (board archived,
        //                                               assignee inactive,…)
        //                                               cron will retry
        //   reason='no-future-occurrence'             → schedule yields no
        //                                               eligible date (e.g.
        //                                               endDate already past)
        const result = await createTemplate(payload);
        saved = result.template;
        const ig = result.immediateGeneration || {};
        if (ig.generated || ig.alreadyExisted) {
          toastSuccess(
            `Recurring work created. First task assigned for ${ig.occurrenceDate || 'the next scheduled date'}.`
          );
        } else if (ig.reason === 'no-future-occurrence') {
          toastError(
            'Recurring work saved, but the schedule yields no upcoming date '
            + '(check end date and weekday/day-of-month selection).'
          );
        } else if (ig.error || ig.reason) {
          // Partial success — template saved, but first instance failed for a
          // user-actionable reason. Cron will retry next tick.
          toastError(
            `Recurring work saved, but the first task could not be generated`
            + (ig.reason ? ` (${ig.reason})` : '')
            + `. The system will retry on the next scheduled run.`
          );
        } else {
          toastSuccess('Recurring work created.');
        }
      }
      onSaved?.(saved);
      onClose();
    } catch (err) {
      const msg = err?.response?.data?.message
        || err?.response?.data?.errors?.[0]?.msg
        || err?.message
        || 'Failed to save.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? 'Edit Daily Work' : 'New Daily Work / Recurring Task'}
      size="lg"
      footer={(
        <>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-100 rounded-md transition-colors"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="recurring-template-form"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary hover:bg-primary-hover rounded-md disabled:opacity-50 transition-colors"
            disabled={submitting || optionsLoading}
          >
            <Save size={14} />
            {submitting ? 'Saving…' : (isEdit ? 'Save changes' : 'Create')}
          </button>
        </>
      )}
    >
      <form id="recurring-template-form" onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900/40 text-red-700 dark:text-red-300 text-sm">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Basic */}
        <Section title="Basics">
          <Field label="Title *">
            <input
              type="text"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              maxLength={300}
              placeholder="e.g. Daily Sales Report"
              className={inputCls}
              required
            />
          </Field>
          <Field label="Description">
            <textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              maxLength={5000}
              rows={2}
              placeholder="Optional context for the assignee"
              className={inputCls + ' resize-none'}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Board *">
              <select
                value={form.boardId}
                onChange={(e) => set('boardId', e.target.value)}
                className={inputCls}
                required
                disabled={optionsLoading}
              >
                <option value="">Select a board…</option>
                {boards.map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Group">
              <select
                value={form.groupId}
                onChange={(e) => set('groupId', e.target.value)}
                className={inputCls}
                disabled={!selectedBoard}
              >
                {groupChoices.length === 0 && (
                  <option value="new">New (default)</option>
                )}
                {groupChoices.map(g => (
                  <option key={g.id} value={g.id}>{g.title || g.id}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Assignee *" hint={isMember ? 'Members can only assign to themselves.' : undefined}>
              <select
                value={form.assigneeId}
                onChange={(e) => set('assigneeId', e.target.value)}
                className={inputCls}
                required
                disabled={isMember || optionsLoading}
              >
                <option value="">Select…</option>
                {assigneeChoices.map(u => (
                  <option key={u.id} value={u.id}>
                    {u.name || u.email}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Priority">
              <select value={form.priority} onChange={(e) => set('priority', e.target.value)} className={inputCls}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </Field>
          </div>
        </Section>

        {/* Schedule */}
        <Section title="Schedule" icon={Calendar}>
          <Field label="Frequency *">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {FREQUENCIES.map(f => (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => set('frequency', f.value)}
                  className={
                    `flex flex-col items-start text-left p-2 rounded-md border transition-colors text-xs `
                    + (form.frequency === f.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border hover:bg-surface-100 text-text-secondary')
                  }
                >
                  <span className="font-semibold text-[12px]">{f.label}</span>
                  <span className="text-[10px] mt-0.5 opacity-70">{f.hint}</span>
                </button>
              ))}
            </div>
          </Field>

          {requiresWeekdays && (
            <Field label="Weekdays *">
              <div className="flex flex-wrap gap-2">
                {WEEKDAY_LABELS.map((lbl, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => toggleWeekday(i)}
                    className={
                      `px-3 py-1 text-xs font-medium rounded-md border transition-colors `
                      + (form.weekdays.includes(i)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border hover:bg-surface-100 text-text-secondary')
                    }
                  >
                    {lbl}
                  </button>
                ))}
              </div>
            </Field>
          )}

          {requiresDayOfMonth && (
            <Field
              label="Days of month *"
              hint="Tap any day to toggle it. If a chosen day exceeds the month length (e.g. 31 in February), the last day of the month is used."
            >
              <MonthDayPicker
                selected={form.daysOfMonth}
                onToggle={toggleMonthlyDay}
              />
              {form.daysOfMonth.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-text-tertiary">
                  <span className="font-medium text-text-secondary">Selected:</span>
                  {form.daysOfMonth.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => toggleMonthlyDay(d)}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 transition-colors"
                      title={`Remove day ${d}`}
                    >
                      {d}
                      <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              )}
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date *">
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => set('startDate', e.target.value)}
                className={inputCls}
                required
              />
            </Field>
            <Field label="End date" hint="Optional — leave blank for open-ended">
              <input
                type="date"
                value={form.endDate || ''}
                onChange={(e) => set('endDate', e.target.value)}
                className={inputCls}
                min={form.startDate}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Due time *" icon={Clock}>
              <input
                type="time"
                value={form.dueTime}
                onChange={(e) => set('dueTime', e.target.value)}
                className={inputCls}
                required
              />
            </Field>
            <Field label="Timezone" hint="Times above are in this zone">
              <input
                type="text"
                value={form.timezone}
                onChange={(e) => set('timezone', e.target.value)}
                placeholder="e.g. Asia/Kolkata"
                className={inputCls}
                list="recurring-tz-suggestions"
              />
              {/* Common timezones — users can still type any IANA name. */}
              <datalist id="recurring-tz-suggestions">
                <option value="UTC" />
                <option value={browserTz} />
                <option value="Asia/Kolkata" />
                <option value="America/New_York" />
                <option value="America/Los_Angeles" />
                <option value="Europe/London" />
                <option value="Europe/Berlin" />
                <option value="Asia/Singapore" />
                <option value="Asia/Tokyo" />
                <option value="Australia/Sydney" />
              </datalist>
            </Field>
          </div>
        </Section>

        {/* Missed behavior */}
        <Section title="Missed behavior" icon={RefreshCw}>
          <div className="text-xs text-text-secondary leading-relaxed">
            If today's task isn't completed by its due time it stays as overdue
            in history. Today's new instance is still created the next day.
            Optionally, notify someone when this happens.
          </div>
          <Toggle
            label="Notify if missed"
            description="Send a notification at due time if the task is still not Done."
            checked={form.escalateIfMissed}
            onChange={(v) => set('escalateIfMissed', v)}
          />
          {form.escalateIfMissed && (
            <Field label="Escalation targets">
              <div className="flex flex-wrap gap-2">
                {ESCALATION_TARGETS.map(t => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => toggleEscalationTarget(t.value)}
                    className={
                      `px-2.5 py-1 text-xs font-medium rounded-md border transition-colors `
                      + (form.escalationTargets.includes(t.value)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border hover:bg-surface-100 text-text-secondary')
                    }
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </Field>
          )}
        </Section>

        {isEdit && (
          <Section title="State">
            <Toggle
              label="Active"
              description="Pause to stop generating new instances. Existing instances are not affected."
              checked={form.isActive}
              onChange={(v) => set('isActive', v)}
            />
          </Section>
        )}
      </form>
    </Modal>
  );
}

// ─── Local helpers ─────────────────────────────────────────────────────────

const inputCls = 'w-full px-2.5 py-1.5 text-sm bg-surface-100 dark:bg-[#2a2c30] border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/30 text-text-primary';

function Section({ title, icon: Icon, children }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
        {Icon && <Icon size={12} />}
        <span>{title}</span>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, icon: Icon, hint, children }) {
  return (
    <label className="block">
      <span className="flex items-center gap-1 text-xs font-medium text-text-secondary mb-1">
        {Icon && <Icon size={12} />}
        {label}
      </span>
      {children}
      {hint && <span className="block text-[10px] text-text-tertiary mt-1">{hint}</span>}
    </label>
  );
}

function Toggle({ label, description, checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-start gap-3 w-full text-left p-2.5 rounded-md hover:bg-surface-100 transition-colors"
    >
      <span className={
        `relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border transition-colors mt-0.5 `
        + (checked ? 'bg-primary border-primary' : 'bg-surface-200 dark:bg-[#3a3c40] border-border')
      }>
        <span className={
          `absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform `
          + (checked ? 'translate-x-4' : 'translate-x-0.5')
        } />
      </span>
      <span className="flex-1">
        <span className="block text-sm font-medium text-text-primary">{label}</span>
        {description && <span className="block text-[11px] text-text-tertiary mt-0.5">{description}</span>}
      </span>
    </button>
  );
}

/**
 * MonthDayPicker — 7-column grid of clickable day-of-month chips (1–31).
 *
 * Toggling a chip adds/removes it from the selection. Visual styling mirrors
 * the existing weekday chips so the modal stays cohesive in both light and
 * dark themes (uses the same `border-primary` / `bg-primary/10` accents and
 * `border-border` / `text-text-secondary` neutrals as the weekday picker
 * directly above it). Pure render component — selection state lives in the
 * parent form so payload reconciliation stays in one place.
 */
function MonthDayPicker({ selected, onToggle }) {
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const selectedSet = new Set(selected || []);
  return (
    <div
      role="group"
      aria-label="Days of month"
      className="grid grid-cols-7 gap-1.5"
    >
      {days.map((d) => {
        const isOn = selectedSet.has(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={isOn}
            onClick={() => onToggle(d)}
            className={
              `h-8 text-xs font-medium rounded-md border transition-colors `
              + (isOn
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border hover:bg-surface-100 text-text-secondary')
            }
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}

// ─── Form initial state ────────────────────────────────────────────────────

function buildInitialForm(template, ctx) {
  if (template) {
    // getMonthlyDaysFromTemplate returns the modern array if present, else
    // wraps the legacy `dayOfMonth` integer — so editing an existing
    // single-day monthly template loads naturally as `[5]` in the new picker.
    const daysOfMonth = getMonthlyDaysFromTemplate(template);
    return {
      title: template.title || '',
      description: template.description || '',
      boardId: template.boardId || '',
      groupId: template.groupId || 'new',
      assigneeId: template.assigneeId || '',
      priority: template.priority || 'medium',
      // Legacy 'custom' templates collapse onto 'weekly' in the UI — same
      // server-side semantics, no DB rewrite needed. Saving will persist
      // the new 'weekly' value, transparently migrating old rows.
      frequency: normalizeFrequencyForUI(template.frequency),
      weekdays: Array.isArray(template.weekdays) ? template.weekdays : [],
      daysOfMonth,
      startDate: template.startDate || todayStr(),
      endDate: template.endDate || '',
      dueTime: dueTimeToInputValue(template.dueTime),
      timezone: template.timezone || ctx.browserTz,
      escalateIfMissed: !!template.escalateIfMissed,
      escalationTargets: Array.isArray(template.escalationTargets) && template.escalationTargets.length > 0
        ? template.escalationTargets
        : ['assignee', 'manager'],
      isActive: template.isActive !== false,
    };
  }
  // Create defaults — assignee defaults to current user (always valid for the
  // self-assign rule). Members will see the dropdown locked anyway.
  return {
    title: '',
    description: '',
    boardId: ctx.presetBoardId || '',
    groupId: 'new',
    assigneeId: ctx.user?.id || '',
    priority: 'medium',
    frequency: 'daily',
    weekdays: [],
    daysOfMonth: [],
    startDate: todayStr(),
    endDate: '',
    dueTime: '18:00',
    timezone: ctx.browserTz || 'UTC',
    escalateIfMissed: false,
    escalationTargets: ['assignee', 'manager'],
    isActive: true,
  };
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
