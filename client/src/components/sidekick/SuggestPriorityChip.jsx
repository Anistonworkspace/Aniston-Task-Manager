import React, { useCallback, useState } from 'react';
import { Sparkles, Check, X, RefreshCw, AlertCircle } from 'lucide-react';
import Popover from '../common/Popover';
import StatusPill from '../common/StatusPill';
import aiSummary from '../../services/aiSummaryService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';

/**
 * SuggestPriorityChip (Plan A Slice 3) — inline button that asks the AI to
 * recommend a priority for a task and renders the suggestion as a popover.
 *
 *   <SuggestPriorityChip
 *     taskTitle={task.title}
 *     taskDescription={task.description}
 *     boardId={task.boardId}
 *     currentPriority={task.priority}
 *     onApply={(priority) => setPriority(priority)}
 *   />
 *
 * UX:
 *   - Click → fetches /api/ai/suggest-priority
 *   - Shows the suggested priority pill + 1-sentence reason + optional
 *     suggested due date
 *   - User can Apply (calls `onApply(priority, suggestedDueDate)`) or Reject
 *   - Regenerate re-runs the call with the same inputs
 *
 * The chip is intentionally tiny so it doesn't crowd the priority cell. It
 * lives ALONGSIDE the existing priority picker, never replaces it.
 */

const PRIORITY_COLOR = {
  low:      'blue',
  medium:   'orange',
  high:     'red',
  critical: 'red',
};

const PRIORITY_LABEL = {
  low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical',
};

export default function SuggestPriorityChip({
  taskTitle,
  taskDescription,
  boardId,
  currentPriority,
  onApply,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('idle');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const fetchSuggestion = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      const out = await aiSummary.suggestPriority({
        taskTitle: taskTitle || '(no title)',
        taskDescription,
        boardId,
      });
      setData(out);
      setStatus('ok');
    } catch (err) {
      safeLog.error('[SuggestPriorityChip] fetch failed', err);
      setError(getErrorMessage(err));
      setStatus('error');
    }
  }, [taskTitle, taskDescription, boardId]);

  function handleOpenChange(next) {
    setOpen(next);
    if (next && status === 'idle') {
      fetchSuggestion();
    }
  }

  function handleApply() {
    if (!data?.priority) return;
    onApply?.(data.priority, data.suggestedDueDate || null);
    setOpen(false);
  }

  function handleReject() {
    setOpen(false);
    // Reset on close so a future click re-fetches a fresh suggestion.
    setTimeout(() => {
      setStatus('idle');
      setData(null);
      setError('');
    }, 200);
  }

  const matchesCurrent = data?.priority && data.priority === currentPriority;

  return (
    <Popover open={open} onOpenChange={handleOpenChange} placement="bottom-start" offset={6}>
      <Popover.Trigger>
        <button
          type="button"
          disabled={disabled}
          title="Ask AI to suggest a priority"
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/10 transition-colors disabled:opacity-40"
        >
          <Sparkles size={10} /> Suggest
        </button>
      </Popover.Trigger>
      <Popover.Content width={280} ariaLabel="AI priority suggestion">
        <div
          className="rounded-md shadow-md overflow-hidden"
          style={{
            backgroundColor: 'var(--primary-background-color, #ffffff)',
            border: '1px solid var(--layout-border-color, #e2e2e2)',
          }}
        >
          <header className="flex items-center gap-2 px-3 py-1.5 border-b border-border-light">
            <Sparkles size={11} className="text-primary" />
            <span className="text-xs font-semibold text-text-primary flex-1">AI priority</span>
            {(status === 'ok' || status === 'error') && (
              <button
                type="button"
                onClick={() => { setStatus('idle'); fetchSuggestion(); }}
                aria-label="Regenerate"
                className="p-1 rounded text-text-tertiary hover:bg-surface-100"
              >
                <RefreshCw size={11} />
              </button>
            )}
          </header>

          <div className="px-3 py-2.5 text-sm">
            {status === 'loading' && (
              <div className="flex items-center gap-2 text-text-secondary">
                <Sparkles size={12} className="text-primary animate-pulse" />
                <span className="text-xs">Reading task context…</span>
              </div>
            )}
            {status === 'error' && (
              <div className="flex items-start gap-2 text-danger text-xs">
                <AlertCircle size={12} className="flex-shrink-0 mt-0.5" />
                <span>{error || 'Suggestion failed.'}</span>
              </div>
            )}
            {status === 'ok' && data && (
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[10px] uppercase tracking-wide text-text-tertiary">Suggested</span>
                  <StatusPill
                    color={PRIORITY_COLOR[data.priority] || 'gray'}
                    label={PRIORITY_LABEL[data.priority] || data.priority || 'Unknown'}
                    variant="filled"
                    size="compact"
                  />
                  {matchesCurrent && (
                    <span className="text-[10px] text-text-tertiary">(no change)</span>
                  )}
                </div>
                {data.reason && (
                  <p className="text-xs text-text-secondary leading-relaxed">{data.reason}</p>
                )}
                {data.suggestedDueDate && (
                  <p className="mt-1.5 text-[11px] text-text-tertiary">
                    Suggested due date: <strong className="text-text-secondary">{data.suggestedDueDate}</strong>
                  </p>
                )}
              </div>
            )}
          </div>

          {status === 'ok' && data && (
            <footer className="px-3 py-2 border-t border-border-light bg-surface-50 flex items-center justify-end gap-1.5">
              <button
                type="button"
                onClick={handleReject}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-text-secondary hover:bg-surface-100"
              >
                <X size={11} /> Dismiss
              </button>
              <button
                type="button"
                onClick={handleApply}
                disabled={!onApply || matchesCurrent}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-primary text-white hover:bg-primary-600 disabled:bg-surface-200 disabled:text-text-tertiary"
              >
                <Check size={11} /> Apply
              </button>
            </footer>
          )}
        </div>
      </Popover.Content>
    </Popover>
  );
}
