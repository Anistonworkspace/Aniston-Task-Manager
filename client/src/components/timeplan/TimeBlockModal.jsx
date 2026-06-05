import React, { useEffect, useRef, useState } from 'react';
import { X, ListChecks, Flag, Activity, Bell, Repeat, AlignLeft, CalendarDays, Palette, Check } from 'lucide-react';
import api from '../../services/api';
import TaskPicker from './TaskPicker';
import TimeSelect from './TimeSelect';
import RichDescriptionEditor, { plainTextLength } from './RichDescriptionEditor';
import {
  TYPE_OPTIONS, STATUS_OPTIONS, PRIORITY_OPTIONS, REMINDER_OPTIONS, COLOR_PALETTE, autoColor,
  DAY_START_HOUR, DAY_END_HOUR,
} from './plannerTheme';

const MAX_DESC = 3000;

const DAY_START = `${String(DAY_START_HOUR).padStart(2, '0')}:00`;
const DAY_END = `${String(DAY_END_HOUR).padStart(2, '0')}:00`;
const DURATIONS = [{ label: '30m', m: 30 }, { label: '1h', m: 60 }, { label: '1.5h', m: 90 }, { label: '2h', m: 120 }, { label: '3h', m: 180 }];
const REPEAT_OPTIONS = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Daily (Mon–Sat)' },
  { value: 'weekdays', label: 'Every weekday (Mon–Fri)' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'custom', label: 'Custom days' },
];
const WEEKDAY_CHIPS = [{ d: 1, l: 'Mon' }, { d: 2, l: 'Tue' }, { d: 3, l: 'Wed' }, { d: 4, l: 'Thu' }, { d: 5, l: 'Fri' }, { d: 6, l: 'Sat' }];

function addMinutes(hhmm, mins) {
  const [h, m] = hhmm.split(':').map(Number);
  const total = Math.min(h * 60 + m + mins, DAY_END_HOUR * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const selectCls = 'w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-text-primary focus:border-primary focus:outline-none';

function Field({ label, icon, children }) {
  return (
    <div>
      <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-secondary">{icon}{label}</label>
      {children}
    </div>
  );
}

/**
 * Google-Calendar-style create/edit dialog. Sends recurrenceRule on create so
 * the backend expands a bounded series; on edit it changes this occurrence only
 * (series-edit is a reported limitation). Description is rich HTML (sanitized
 * server-side). Times use the professional TimeSelect, not a native clock.
 */
export default function TimeBlockModal({ block, date, forUserId, ownerName, onSave, onClose }) {
  const isEdit = !!block?.id;
  const [title, setTitle] = useState(block?.title || '');
  const [selectedTask, setSelectedTask] = useState(block?.task || (block?.taskId ? { id: block.taskId, title: block.title || 'Linked task' } : null));
  const [blockDate, setBlockDate] = useState(block?.date || date);
  const [startTime, setStartTime] = useState(block?.startTime || '09:00');
  const [endTime, setEndTime] = useState(block?.endTime || '10:00');
  const [type, setType] = useState(block?.type || 'task_work');
  const [priority, setPriority] = useState(block?.priority || 'normal');
  const [status, setStatus] = useState(block?.status || 'planned');
  const [description, setDescription] = useState(block?.description || '');
  // Default new blocks to a 15-minute reminder; respect an edited block's value.
  const [reminder, setReminder] = useState(
    block?.reminderMinutesBefore != null ? String(block.reminderMinutesBefore) : (isEdit ? '' : '15'),
  );
  const [color, setColor] = useState(block?.color || autoColor(Math.floor(Math.random() * COLOR_PALETTE.length)));
  const [repeat, setRepeat] = useState('none');
  const [customDays, setCustomDays] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef(null);

  useEffect(() => {
    const prev = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    if (dialogRef.current) dialogRef.current.focus();
    return () => { document.removeEventListener('keydown', onKey); if (prev && prev.focus) prev.focus(); };
  }, [onClose]);

  function handleTaskSelect(task) {
    setSelectedTask(task);
    if (task && !title.trim()) setTitle(task.title || '');
  }
  function applyDuration(mins) { setEndTime(addMinutes(startTime, mins)); }

  function recurrenceRule() {
    if (isEdit || repeat === 'none') return undefined;
    if (repeat === 'custom') return customDays.length ? `custom:${[...customDays].sort().join(',')}` : undefined;
    return repeat;
  }

  async function handleSubmit(e) {
    e?.preventDefault();
    if (startTime >= endTime) return setError('Start time must be before end time.');
    if (startTime < DAY_START || endTime > DAY_END) return setError(`Time blocks must be within working hours (${DAY_START}–${DAY_END}).`);
    if (!selectedTask && !title.trim()) return setError('Add a title (or link a task) for this block.');
    if (plainTextLength(description) > MAX_DESC) return setError(`Description must be ${MAX_DESC} characters or fewer.`);

    const payload = {
      date: blockDate,
      startTime,
      endTime,
      title: title.trim() || null,
      taskId: selectedTask?.id || null,
      description,
      type,
      priority,
      status,
      color,
      reminderMinutesBefore: reminder ? Number(reminder) : null,
      ...(forUserId ? { forUserId } : {}),
    };

    setSaving(true);
    setError('');
    try {
      if (isEdit) {
        await api.put(`/timeplans/${block.id}`, payload);
      } else {
        const rule = recurrenceRule();
        await api.post('/timeplans', { ...payload, ...(rule ? { recurrenceRule: rule } : {}) });
      }
      onSave();
    } catch (err) {
      setError(err?.response?.data?.message || 'Failed to save time block.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit time block' : 'New time block'}
        tabIndex={-1}
        className="flex max-h-[92vh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-modal focus:outline-none animate-slide-up sm:rounded-2xl sm:animate-scale-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h3 className="font-title text-base font-bold text-text-primary">{isEdit ? 'Edit Time Block' : 'New Time Block'}</h3>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-text-secondary hover:bg-surface" aria-label="Close"><X size={16} /></button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* Big title (GCal style) */}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={300}
            autoFocus
            placeholder={selectedTask ? selectedTask.title : 'Add title'}
            className="w-full border-0 border-b-2 border-border bg-transparent pb-2 text-lg font-semibold text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
          />

          {ownerName && (
            <p className="-mt-1 text-xs text-text-tertiary">Planning for <span className="font-medium text-text-secondary">{ownerName}</span></p>
          )}

          {/* Date + time row */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Date" icon={<CalendarDays size={12} />}>
              <input type="date" value={blockDate} onChange={(e) => setBlockDate(e.target.value)} className={selectCls} />
            </Field>
            <Field label="Start" icon={null}>
              <TimeSelect value={startTime} onChange={setStartTime} min={DAY_START} max={DAY_END} ariaLabel="Start time" />
            </Field>
            <Field label="End" icon={null}>
              <TimeSelect value={endTime} onChange={setEndTime} min={DAY_START} max={DAY_END} ariaLabel="End time" />
            </Field>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {DURATIONS.map((d) => (
              <button key={d.label} type="button" onClick={() => applyDuration(d.m)}
                className="rounded-md bg-surface px-2.5 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-primary/10 hover:text-primary">
                {d.label}
              </button>
            ))}
          </div>

          <Field label="Link to task (optional)" icon={<ListChecks size={12} />}>
            <TaskPicker selectedTask={selectedTask} onSelect={handleTaskSelect} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Type" icon={<Activity size={12} />}>
              <select value={type} onChange={(e) => setType(e.target.value)} className={selectCls}>
                {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Priority" icon={<Flag size={12} />}>
              <select value={priority} onChange={(e) => setPriority(e.target.value)} className={selectCls}>
                {PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Status" icon={<ListChecks size={12} />}>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={selectCls}>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Reminder" icon={<Bell size={12} />}>
              <select value={reminder} onChange={(e) => setReminder(e.target.value)} className={selectCls}>
                {REMINDER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </div>

          <Field label="Color" icon={<Palette size={12} />}>
            <div className="flex flex-wrap gap-1.5">
              {COLOR_PALETTE.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  title={c.label}
                  aria-label={c.label}
                  aria-pressed={color === c.hex}
                  onClick={() => setColor(c.hex)}
                  className={`flex h-7 w-7 items-center justify-center rounded-full transition-transform hover:scale-110 ${color === c.hex ? 'ring-2 ring-offset-2 ring-text-tertiary' : ''}`}
                  style={{ backgroundColor: c.hex }}
                >
                  {color === c.hex && <Check size={13} className="text-white" />}
                </button>
              ))}
            </div>
          </Field>

          {!isEdit && (
            <Field label="Repeat" icon={<Repeat size={12} />}>
              <select value={repeat} onChange={(e) => setRepeat(e.target.value)} className={selectCls}>
                {REPEAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {repeat === 'custom' && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {WEEKDAY_CHIPS.map((w) => {
                    const on = customDays.includes(w.d);
                    return (
                      <button key={w.d} type="button"
                        onClick={() => setCustomDays((p) => (on ? p.filter((x) => x !== w.d) : [...p, w.d]))}
                        aria-pressed={on}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${on ? 'bg-primary text-white' : 'bg-surface text-text-secondary hover:bg-primary/10'}`}>
                        {w.l}
                      </button>
                    );
                  })}
                </div>
              )}
              {repeat !== 'none' && <p className="mt-1.5 text-[11px] text-text-tertiary">Creates a series for the next 4 weeks (Sundays skipped). Editing a single occurrence won’t change the rest.</p>}
            </Field>
          )}

          <Field label="Description" icon={<AlignLeft size={12} />}>
            <RichDescriptionEditor value={description} onChange={setDescription} max={MAX_DESC} />
          </Field>

          {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
        </form>

        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-surface">Cancel</button>
          <button type="button" onClick={handleSubmit} disabled={saving}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-600 disabled:opacity-50">
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Add Block'}
          </button>
        </div>
      </div>
    </div>
  );
}
