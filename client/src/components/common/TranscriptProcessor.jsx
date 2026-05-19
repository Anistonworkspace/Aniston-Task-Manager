import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Sparkles, CheckSquare, Loader2, AlertCircle, RotateCcw, Plus, X,
  Calendar, User as UserIcon, Flag, FolderKanban,
} from 'lucide-react';
import api from '../../services/api';
import aiSummary from '../../services/aiSummaryService';
import safeLog from '../../utils/safeLog';
import { getErrorMessage } from '../../utils/errorMap';
import { useToast } from './Toast';

// Remember the user's last "save to" choice across sessions so they don't
// have to re-pick a board for every recording.
const BOARD_PREF_KEY = 'aniston.transcriptProcessor.defaultBoardId';
function loadBoardPref() {
  try { return localStorage.getItem(BOARD_PREF_KEY) || ''; } catch { return ''; }
}
function saveBoardPref(boardId) {
  try { localStorage.setItem(BOARD_PREF_KEY, boardId || ''); } catch { /* no-op */ }
}

/**
 * TranscriptProcessor — Notetaker closing-the-loop UI.
 *
 * Shown after the user stops a Meeting-Mode recording. Runs two AI calls
 * in PARALLEL (summarize + extract-actions) so the user sees results in
 * roughly one round-trip's time. Each extracted action item has a
 * one-click "Create task" button that POSTs to /api/tasks.
 *
 * Props:
 *   transcript       — the speaker-labeled transcript string
 *   defaultBoardId   — optional; if supplied, the inline create-task
 *                      defaults to that board. Otherwise the task lands
 *                      on the user's first available board (caller
 *                      passes that in; we do not auto-discover here).
 *   onActionCreated  — optional callback fired after a successful task
 *                      create, with the created task object.
 */
export default function TranscriptProcessor({
  transcript,
  defaultBoardId: propBoardId,
  onActionCreated,
}) {
  const toast = useToast();
  const [summaryStatus, setSummaryStatus] = useState('idle'); // idle | loading | ok | error
  const [summary, setSummary] = useState('');
  const [summaryError, setSummaryError] = useState('');

  const [actionsStatus, setActionsStatus] = useState('idle');
  const [actions, setActions] = useState([]);
  const [actionsError, setActionsError] = useState('');
  // Per-action create state: { [index]: 'creating' | 'created' | 'error' }
  const [actionCreateState, setActionCreateState] = useState({});
  // Per-action discard state — user can hide noise from the list.
  const [hiddenIndexes, setHiddenIndexes] = useState(new Set());

  // Board picker — fetched in parallel with the summary + actions calls.
  // Resolution order for the active board:
  //   1. caller-supplied prop (e.g. recording opened from a board page)
  //   2. user-picked override (from the dropdown)
  //   3. last remembered choice from localStorage
  //   4. first available board
  const [boards, setBoards] = useState([]);
  const [boardsLoading, setBoardsLoading] = useState(true);
  const [userPickedBoardId, setUserPickedBoardId] = useState('');
  const effectiveBoardId = useMemo(() => {
    if (propBoardId) return propBoardId;
    if (userPickedBoardId) return userPickedBoardId;
    const remembered = loadBoardPref();
    if (remembered && boards.some((b) => b.id === remembered)) return remembered;
    return boards[0]?.id || '';
  }, [propBoardId, userPickedBoardId, boards]);

  const runSummary = useCallback(async () => {
    if (!transcript || !transcript.trim()) {
      setSummary('Transcript was empty — nothing to summarize.');
      setSummaryStatus('ok');
      return;
    }
    setSummaryStatus('loading');
    setSummaryError('');
    try {
      // /api/ai/chat expects a `messages` array of {role, content} turns
      // and returns `{ data: { message } }`. Sending a single `prompt`
      // string would trip the "Messages array is required" 400.
      const userPrompt = `Summarize this meeting transcript in 3-5 sentences. Lead with the bottom line; call out decisions and unresolved questions.\n\nTranscript:\n${transcript.slice(0, 8000)}`;
      const res = await api.post('/ai/chat', {
        messages: [{ role: 'user', content: userPrompt }],
      });
      const text = res?.data?.data?.message || res?.data?.message || '';
      setSummary(String(text).trim());
      setSummaryStatus('ok');
    } catch (err) {
      safeLog.error('[TranscriptProcessor] summary error', err);
      setSummaryError(getErrorMessage(err));
      setSummaryStatus('error');
    }
  }, [transcript]);

  const runActions = useCallback(async () => {
    if (!transcript || !transcript.trim()) {
      setActions([]);
      setActionsStatus('ok');
      return;
    }
    setActionsStatus('loading');
    setActionsError('');
    try {
      const out = await aiSummary.extractActions({ text: transcript });
      setActions(Array.isArray(out?.actions) ? out.actions : []);
      setActionsStatus('ok');
    } catch (err) {
      safeLog.error('[TranscriptProcessor] actions error', err);
      setActionsError(getErrorMessage(err));
      setActionsStatus('error');
    }
  }, [transcript]);

  // Kick both off in parallel on mount and whenever the transcript changes.
  useEffect(() => {
    runSummary();
    runActions();
  }, [runSummary, runActions]);

  // Board fetch — fires alongside the AI calls so by the time the user
  // reads the summary the picker is already populated. Filters out
  // archived boards client-side; the endpoint may include them.
  useEffect(() => {
    if (propBoardId) {
      // Caller pinned a board — no need to load the picker.
      setBoardsLoading(false);
      return;
    }
    let cancelled = false;
    setBoardsLoading(true);
    api.get('/boards')
      .then((res) => {
        if (cancelled) return;
        const list = res?.data?.data?.boards
          || res?.data?.boards
          || (Array.isArray(res?.data) ? res.data : [])
          || [];
        const active = list.filter((b) => !b.isArchived);
        setBoards(active);
      })
      .catch((err) => {
        safeLog.warn('[TranscriptProcessor] board fetch failed', err);
      })
      .finally(() => { if (!cancelled) setBoardsLoading(false); });
    return () => { cancelled = true; };
  }, [propBoardId]);

  async function handleCreateTask(action, idx) {
    if (!effectiveBoardId) {
      toast.error('Pick a board first.');
      return;
    }
    setActionCreateState((s) => ({ ...s, [idx]: 'creating' }));
    try {
      const payload = { title: action.title, boardId: effectiveBoardId };
      if (action.priority) payload.priority = action.priority;
      if (action.dueDate) payload.dueDate = action.dueDate;
      const res = await api.post('/tasks', payload);
      const body = res.data?.data ?? res.data ?? {};
      const task = body.task || body;
      if (!task?.id) throw new Error('Server returned no task');
      setActionCreateState((s) => ({ ...s, [idx]: 'created' }));
      toast.success(`Task created: ${action.title.slice(0, 40)}…`);
      onActionCreated?.(task);
    } catch (err) {
      safeLog.error('[TranscriptProcessor] create task failed', err);
      setActionCreateState((s) => ({ ...s, [idx]: 'error' }));
      toast.error(getErrorMessage(err));
    }
  }

  function handleBoardChange(boardId) {
    setUserPickedBoardId(boardId);
    saveBoardPref(boardId);
  }

  function handleHide(idx) {
    setHiddenIndexes((prev) => {
      const next = new Set(prev);
      next.add(idx);
      return next;
    });
  }

  const visibleActions = actions
    .map((a, i) => ({ ...a, _idx: i }))
    .filter((a) => !hiddenIndexes.has(a._idx));

  return (
    <div className="space-y-3 mt-3">
      {/* Summary card */}
      <section className="rounded-lg border border-violet-200 dark:border-violet-800 bg-violet-50/40 dark:bg-violet-900/10 overflow-hidden">
        <header className="flex items-center gap-2 px-3 py-2 border-b border-violet-200/60 dark:border-violet-800/60 bg-violet-100/60 dark:bg-violet-900/30">
          <span
            className="w-5 h-5 rounded inline-flex items-center justify-center text-white"
            style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
          >
            <Sparkles size={11} />
          </span>
          <span className="text-xs font-semibold text-violet-700 dark:text-violet-200">AI summary</span>
          {summaryStatus === 'ok' && (
            <button
              type="button"
              onClick={runSummary}
              className="ml-auto p-1 rounded text-violet-500 hover:bg-violet-100 dark:hover:bg-violet-900/40"
              title="Regenerate"
              aria-label="Regenerate summary"
            >
              <RotateCcw size={11} />
            </button>
          )}
        </header>
        <div className="px-3 py-2.5 text-sm">
          {summaryStatus === 'loading' && (
            <span className="inline-flex items-center gap-2 text-violet-700 dark:text-violet-200">
              <Loader2 size={12} className="animate-spin" /> Summarizing the meeting…
            </span>
          )}
          {summaryStatus === 'error' && (
            <div className="text-rose-600 inline-flex items-start gap-2">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span className="text-[12px]">{summaryError}</span>
            </div>
          )}
          {summaryStatus === 'ok' && (
            <p className="whitespace-pre-wrap text-zinc-700 dark:text-zinc-200 leading-relaxed">{summary}</p>
          )}
        </div>
      </section>

      {/* Action items card */}
      <section className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-900/10 overflow-hidden">
        <header className="flex items-center gap-2 px-3 py-2 border-b border-emerald-200/60 dark:border-emerald-800/60 bg-emerald-100/60 dark:bg-emerald-900/30">
          <CheckSquare size={12} className="text-emerald-600" />
          <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-200">
            Action items{' '}
            {actionsStatus === 'ok' && (
              <span className="text-emerald-500/80">({visibleActions.length})</span>
            )}
          </span>
          {actionsStatus === 'ok' && (
            <button
              type="button"
              onClick={() => { setActions([]); setHiddenIndexes(new Set()); runActions(); }}
              className="ml-auto p-1 rounded text-emerald-600 hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
              title="Regenerate"
              aria-label="Regenerate actions"
            >
              <RotateCcw size={11} />
            </button>
          )}
        </header>
        <div className="px-3 py-2.5 text-sm">
          {/* Board picker — only shown when caller didn't pin a board.
              Sits at the top so the user can configure it BEFORE clicking
              any Create-task button. */}
          {!propBoardId && (
            <div className="mb-2.5 flex items-center gap-2">
              <FolderKanban size={11} className="text-emerald-600 flex-shrink-0" />
              <label className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 flex-shrink-0">
                Save to board:
              </label>
              {boardsLoading ? (
                <span className="text-[11px] text-emerald-700/60 inline-flex items-center gap-1">
                  <Loader2 size={11} className="animate-spin" /> loading…
                </span>
              ) : boards.length === 0 ? (
                <span className="text-[11px] text-amber-700">
                  No boards available — create one first.
                </span>
              ) : (
                <select
                  value={effectiveBoardId}
                  onChange={(e) => handleBoardChange(e.target.value)}
                  className="flex-1 min-w-0 text-[11px] px-1.5 py-0.5 bg-white dark:bg-zinc-900 border border-emerald-200 dark:border-emerald-700 rounded outline-none focus:border-emerald-500 truncate"
                >
                  {boards.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}
          {actionsStatus === 'loading' && (
            <span className="inline-flex items-center gap-2 text-emerald-700 dark:text-emerald-200">
              <Loader2 size={12} className="animate-spin" /> Finding tasks in the transcript…
            </span>
          )}
          {actionsStatus === 'error' && (
            <div className="text-rose-600 inline-flex items-start gap-2">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span className="text-[12px]">{actionsError}</span>
            </div>
          )}
          {actionsStatus === 'ok' && visibleActions.length === 0 && (
            <p className="text-[12px] text-emerald-700/70 dark:text-emerald-300/70">
              No clear action items in this transcript. (Or you've hidden all of them.)
            </p>
          )}
          {actionsStatus === 'ok' && visibleActions.length > 0 && (
            <ul className="space-y-1.5">
              {visibleActions.map((a) => {
                const state = actionCreateState[a._idx];
                return (
                  <li
                    key={a._idx}
                    className="flex items-start gap-2 rounded bg-white dark:bg-zinc-900 border border-emerald-200/60 dark:border-emerald-800/60 px-2.5 py-2"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-zinc-800 dark:text-zinc-100 leading-snug">
                        {a.title}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-1 text-[10px] text-zinc-500">
                        {a.owner && (
                          <span className="inline-flex items-center gap-1">
                            <UserIcon size={10} /> {a.owner}
                          </span>
                        )}
                        {a.dueDate && (
                          <span className="inline-flex items-center gap-1">
                            <Calendar size={10} /> {a.dueDate}
                          </span>
                        )}
                        {a.priority && (
                          <span className="inline-flex items-center gap-1 capitalize">
                            <Flag size={10} /> {a.priority}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {state === 'created' ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600">
                          <CheckSquare size={11} /> Created
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleCreateTask(a, a._idx)}
                          disabled={state === 'creating' || !effectiveBoardId}
                          className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold text-white bg-primary rounded hover:bg-primary-600 disabled:opacity-50 disabled:cursor-not-allowed"
                          title={effectiveBoardId ? 'Create task on the selected board' : 'Pick a board first'}
                        >
                          {state === 'creating' ? (
                            <Loader2 size={11} className="animate-spin" />
                          ) : (
                            <Plus size={11} />
                          )}
                          Create task
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleHide(a._idx)}
                        className="p-1 rounded text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        title="Hide this item"
                        aria-label="Hide action item"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {actionsStatus === 'ok' && !effectiveBoardId && visibleActions.length > 0 && (
            <p className="mt-2 text-[10px] text-amber-700 dark:text-amber-300">
              Pick a board above to enable one-click task creation.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
