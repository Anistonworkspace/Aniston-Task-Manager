import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X, CheckCircle2, AlertCircle, MinusCircle, Clock, Loader2,
  RefreshCw, ChevronDown, ChevronRight,
} from 'lucide-react';
import { listWorkflowRuns } from '../../services/workflowsService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import { formatDistanceToNow } from 'date-fns';

/**
 * RunHistoryDrawer — slide-in panel listing recent WorkflowRun rows for a
 * single workflow. Mounted as a sibling of the canvas; visibility is fully
 * controlled by `isOpen`.
 *
 * Server returns up to the 50 most recent runs (controller hardcodes the
 * limit). Each row is collapsible — the expanded body shows the trigger,
 * context preview, and error text when present.
 *
 * Status pill colours mirror Workflow's own lastRunStatus values:
 *   - ok       → green
 *   - partial  → amber (some nodes skipped — usually a long wait paused)
 *   - error    → red
 *   - anything else → gray
 */

const STATUS_STYLES = {
  ok:      { color: '#16a34a', bg: 'rgba(22, 163, 74, 0.12)',  Icon: CheckCircle2, label: 'OK' },
  partial: { color: '#d97706', bg: 'rgba(217, 119, 6, 0.12)',  Icon: MinusCircle,  label: 'Partial' },
  error:   { color: '#dc2626', bg: 'rgba(220, 38, 38, 0.12)',  Icon: AlertCircle,  label: 'Error' },
};

function defaultPill() {
  return { color: '#6b7280', bg: 'rgba(107, 114, 128, 0.12)', Icon: Clock, label: 'Run' };
}

export default function RunHistoryDrawer({ isOpen, workflowId, onClose }) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const load = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true);
    setError('');
    try {
      const { runs: list } = await listWorkflowRuns(workflowId);
      setRuns(Array.isArray(list) ? list : []);
    } catch (err) {
      safeLog.warn('[RunHistoryDrawer] load error', err);
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  // Esc to close, regardless of focus position inside the drawer.
  useEffect(() => {
    if (!isOpen) return undefined;
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            className="fixed inset-0 bg-black/40 z-[9990]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.aside
            className="fixed top-0 right-0 bottom-0 w-full max-w-md bg-surface shadow-2xl z-[9991] flex flex-col"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            role="dialog"
            aria-label="Workflow run history"
          >
            <header
              className="flex items-center gap-2 px-4 py-2.5 flex-shrink-0"
              style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
            >
              <div className="flex-1 min-w-0">
                <h2 className="text-sm font-bold text-text-primary truncate">Recent runs</h2>
                <p className="text-[11px] text-text-tertiary truncate">
                  Up to 50 most recent · {runs.length} loaded
                </p>
              </div>
              <button
                type="button"
                onClick={load}
                disabled={loading}
                title="Reload"
                className="p-1.5 rounded text-text-tertiary hover:bg-surface-100 disabled:opacity-50"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close run history"
                className="p-1.5 rounded text-text-tertiary hover:bg-surface-100"
              >
                <X size={14} />
              </button>
            </header>

            <div className="flex-1 overflow-auto p-3">
              {error && !loading ? (
                <div className="flex items-start gap-2 p-2.5 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
                  <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <div className="font-semibold mb-0.5">Couldn't load runs</div>
                    {error}
                  </div>
                </div>
              ) : loading && runs.length === 0 ? (
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="h-14 bg-surface-100 rounded animate-pulse" />
                  ))}
                </div>
              ) : runs.length === 0 ? (
                <p className="text-xs text-text-tertiary italic text-center py-6">
                  No runs yet. Publish the workflow or hit Test run.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {runs.map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      isExpanded={expandedId === run.id}
                      onToggle={() => setExpandedId((id) => (id === run.id ? null : run.id))}
                    />
                  ))}
                </ul>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}

function RunRow({ run, isExpanded, onToggle }) {
  const pill = STATUS_STYLES[run.status] || defaultPill();
  const Icon = pill.Icon;
  const started = run.startedAt ? new Date(run.startedAt) : null;
  const finished = run.finishedAt ? new Date(run.finishedAt) : null;
  const startedRel = started ? formatDistanceToNow(started, { addSuffix: true }) : '';
  // May-19 audit P0-3 surface — the engine writes "[skipped] kind (nodeId):
  // reason" lines into the `error` column when an action is denied by the
  // runtime permission gate. We sniff for that prefix so the UI can call
  // it out distinctly from a "real" engine error.
  const hasPermissionSkip = typeof run.error === 'string' && /\[skipped\]/.test(run.error);
  // Wait-resume marker — engine writes trigger='wait_resume' on continuation
  // runs after the cron picks up a paused WorkflowWait row.
  const isResume = run.trigger === 'wait_resume';

  return (
    <li className="rounded-md border border-border-light bg-surface">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-50"
      >
        {isExpanded
          ? <ChevronDown size={12} className="text-text-tertiary flex-shrink-0" />
          : <ChevronRight size={12} className="text-text-tertiary flex-shrink-0" />}
        <span
          className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ color: pill.color, backgroundColor: pill.bg }}
        >
          <Icon size={9} /> {pill.label}
        </span>
        <span className="text-xs text-text-primary font-medium truncate flex-1 min-w-0">
          {run.trigger || 'unknown'}
          {isResume && (
            <span className="ml-1.5 text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-violet-100 text-violet-700">
              resumed
            </span>
          )}
        </span>
        <span className="text-[10px] text-text-tertiary flex-shrink-0">
          {run.nodesRun || 0} action{(run.nodesRun || 0) === 1 ? '' : 's'} · {run.durationMs || 0}ms
        </span>
      </button>
      {isExpanded && (
        <div className="px-3 py-2 border-t border-border-light text-xs space-y-1.5">
          <div className="flex justify-between gap-2 text-text-tertiary">
            <span>Started</span>
            <span className="text-text-primary" title={started?.toISOString()}>
              {startedRel}
            </span>
          </div>
          {finished && (
            <div className="flex justify-between gap-2 text-text-tertiary">
              <span>Finished</span>
              <span className="text-text-primary" title={finished.toISOString()}>
                {formatDistanceToNow(finished, { addSuffix: true })}
              </span>
            </div>
          )}
          {run.actorId && (
            <div className="flex justify-between gap-2 text-text-tertiary">
              <span>Triggered by</span>
              <span className="text-text-primary truncate max-w-[180px]" title={run.actorId}>
                {run.actorId}
              </span>
            </div>
          )}
          {run.failedStepId && (
            <div className="flex justify-between gap-2 text-text-tertiary">
              <span>Failed step</span>
              <span className="text-text-primary truncate max-w-[180px]" title={run.failedStepId}>
                {run.failedStepId.slice(0, 8)}…
              </span>
            </div>
          )}
          {Number.isFinite(run.retryCount) && run.retryCount > 0 && (
            <div className="flex justify-between gap-2 text-text-tertiary">
              <span>Retry count</span>
              <span className="text-text-primary">{run.retryCount}</span>
            </div>
          )}
          {hasPermissionSkip && (
            <div className="rounded bg-amber-50 border border-amber-200 px-2 py-1.5 text-[11px] text-amber-800">
              <strong>One or more actions were skipped because the workflow author no longer holds the required permission.</strong>
              {' '}Review the creator's role / overrides, or assign a new author.
            </div>
          )}
          {run.error && (
            <div className="rounded bg-red-50 border border-red-200 px-2 py-1.5 text-[11px] text-red-700 whitespace-pre-wrap break-words">
              {run.error}
            </div>
          )}
          {run.context && (
            <details>
              <summary className="cursor-pointer text-text-tertiary text-[11px]">
                Trigger context
              </summary>
              <pre className="mt-1 bg-surface-50 border border-border-light rounded p-2 text-[10px] text-text-secondary overflow-auto max-h-40">
                {JSON.stringify(run.context, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
}
