import React, { useEffect, useMemo, useState } from 'react';
import { Sparkles, RefreshCw, AlertCircle, ChevronRight, Calendar } from 'lucide-react';
import Modal from '../common/Modal';
import StatusPill from '../common/StatusPill';
import aiSummary from '../../services/aiSummaryService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';

/**
 * PlanWeekModal (Plan A Slice 3) — renders the AI's Mon-Fri schedule.
 *
 *   <PlanWeekModal
 *     isOpen={open}
 *     onClose={() => setOpen(false)}
 *     tasks={tasks}              // user's open tasks for label lookup
 *   />
 *
 * On open, calls POST /api/ai/plan-week. Renders the 5-day plan with task
 * chips per day. Currently this is a "view-only" result — wiring the plan
 * into TimeBlock creation (drag into TimePlan) is a future slice; the
 * "Send to Time Plan" button is intentionally a no-op stub today, with a
 * Toast that explains the integration is coming.
 *
 * Honest scoping: the value-on-day-1 here is "see what AI thinks you should
 * do Mon-Fri." The Time Plan handoff is a wiring decision (which TimeBlock
 * fields to populate) that the user should approve before I bake it in.
 */

const DAY_LABELS = {
  mon: 'Mon',
  tue: 'Tue',
  wed: 'Wed',
  thu: 'Thu',
  fri: 'Fri',
};

const PRIORITY_COLOR = {
  low: 'blue', medium: 'orange', high: 'red', critical: 'red',
};

export default function PlanWeekModal({ isOpen, onClose, tasks = [] }) {
  const [status, setStatus] = useState('idle');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const taskById = useMemo(() => {
    const map = new Map();
    for (const t of tasks || []) {
      if (t?.id) map.set(t.id, t);
    }
    return map;
  }, [tasks]);

  async function run() {
    setStatus('loading');
    setError('');
    try {
      const out = await aiSummary.planWeek({
        // Cap the hint to 30 ids — the backend only uses this to bias the
        // plan, not as a hard filter, so we don't need every task.
        taskIds: (tasks || []).slice(0, 30).map((t) => t.id).filter(Boolean),
      });
      setData(out || {});
      setStatus('ok');
    } catch (err) {
      safeLog.error('[PlanWeekModal] plan-week failed', err);
      setError(getErrorMessage(err));
      setStatus('error');
    }
  }

  useEffect(() => {
    if (isOpen && status === 'idle') run();
    if (!isOpen) {
      // Reset between opens so the next open re-fetches a fresh plan.
      setTimeout(() => {
        setStatus('idle');
        setData(null);
        setError('');
      }, 200);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const schedule = Array.isArray(data?.schedule) ? data.schedule : [];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Plan my week" size="lg">
      <div className="-mt-2">
        <div className="flex items-center gap-2 mb-3">
          <span
            className="w-6 h-6 rounded-md inline-flex items-center justify-center text-white"
            style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
          >
            <Sparkles size={12} />
          </span>
          <p className="text-sm text-text-secondary flex-1">
            AI-suggested Mon-Fri plan based on your open tasks, priorities, and due dates.
          </p>
          <button
            type="button"
            onClick={() => { setStatus('idle'); run(); }}
            disabled={status === 'loading'}
            aria-label="Regenerate plan"
            title="Regenerate"
            className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-100 disabled:opacity-50"
          >
            <RefreshCw size={14} className={status === 'loading' ? 'animate-spin' : ''} />
          </button>
        </div>

        {status === 'loading' && (
          <div className="grid grid-cols-5 gap-2">
            {Object.keys(DAY_LABELS).map((day) => (
              <div key={day} className="rounded-md border border-border-light p-3 animate-pulse" style={{ backgroundColor: 'var(--surface-50, #f8f9fb)' }}>
                <div className="h-3 w-8 bg-surface-200 rounded mb-3" />
                <div className="h-2 w-full bg-surface-200 rounded mb-1.5" />
                <div className="h-2 w-3/4 bg-surface-200 rounded" />
              </div>
            ))}
          </div>
        )}

        {status === 'error' && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-red-50 dark:bg-red-900/20 text-sm text-red-700 dark:text-red-300">
            <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Couldn&apos;t generate a plan</div>
              <div className="text-xs">{error}</div>
            </div>
          </div>
        )}

        {status === 'ok' && schedule.length === 0 && (
          <div className="p-6 rounded-md border border-dashed border-border text-center text-sm text-text-secondary">
            AI didn&apos;t suggest a structured plan. {data?.notes ? <span className="block mt-1 text-xs">{data.notes}</span> : null}
          </div>
        )}

        {status === 'ok' && schedule.length > 0 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
              {schedule.map((day) => (
                <DayColumn
                  key={day.dayKey}
                  day={day}
                  taskById={taskById}
                />
              ))}
            </div>
            {data?.notes && (
              <div className="mt-3 p-3 rounded-md bg-blue-50 dark:bg-blue-900/20 text-xs text-blue-700 dark:text-blue-300">
                <strong>AI note:</strong> {data.notes}
              </div>
            )}
            <p className="mt-3 text-[10px] text-text-tertiary text-center">
              This is a suggestion. Time Plan integration ships in a follow-up slice — for now, copy items into your TimePlan manually.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

function DayColumn({ day, taskById }) {
  const items = (day.taskIds || []).map((id) => taskById.get(id)).filter(Boolean);
  const isEmpty = items.length === 0;
  return (
    <div
      className="rounded-md border p-2.5 min-h-[140px]"
      style={{
        borderColor: 'var(--layout-border-color, #e2e2e2)',
        backgroundColor: 'var(--surface-50, #f8f9fb)',
      }}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] uppercase tracking-wide font-bold text-text-secondary">
          {DAY_LABELS[day.dayKey] || day.dayKey}
        </span>
        <span className="text-[10px] text-text-tertiary">
          {items.length}
        </span>
      </div>

      {isEmpty && (
        <p className="text-[11px] text-text-tertiary italic">Nothing scheduled.</p>
      )}

      {!isEmpty && (
        <ul className="space-y-1">
          {items.map((t) => (
            <li key={t.id}>
              <div className="flex items-start gap-1.5">
                <StatusPill
                  color={PRIORITY_COLOR[t.priority] || 'gray'}
                  label={t.priority?.[0]?.toUpperCase() + (t.priority?.slice(1) || '')}
                  size="compact"
                  variant="outlined"
                />
                <span className="text-xs text-text-primary leading-snug flex-1 line-clamp-2">
                  {t.title || '(untitled)'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {day.reason && (
        <p className="mt-2 text-[10px] text-text-tertiary italic leading-relaxed">
          {day.reason}
        </p>
      )}
    </div>
  );
}
