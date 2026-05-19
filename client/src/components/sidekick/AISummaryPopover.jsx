import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Copy, Check, RefreshCw, AlertCircle, Settings } from 'lucide-react';
import { Link } from 'react-router-dom';
import Popover from '../common/Popover';
import { useToast } from '../common/Toast';
import safeLog from '../../utils/safeLog';
import { getErrorMessage, getErrorCode } from '../../utils/errorMap';

/**
 * AISummaryPopover (Plan A Slice 3) — reusable one-shot AI result UI.
 *
 *   <AISummaryPopover
 *     trigger={<button>Summarize</button>}
 *     run={async () => aiSummary.summarizeTask(task.id)}
 *     emptyText="No summary available yet."
 *   />
 *
 * On open, runs `run()` once. Shows loading → result → error states.
 * Provides Copy and Regenerate actions. Closes on outside-click / Escape.
 *
 * The `run` function returns `{ summary }` (or anything with a `.summary`
 * string). Custom renderers can be passed via `renderResult` for callers
 * that want richer structure (e.g. priority chips).
 *
 * Stays focused on PRESENTATION. The caller picks the data source and the
 * exact API call — this component does not know about the AI endpoints.
 */
export default function AISummaryPopover({
  trigger,
  run,
  title = 'AI summary',
  placement = 'bottom-end',
  width = 360,
  emptyText = 'No content yet.',
  renderResult,
  onInsert,
  insertLabel = 'Insert into description',
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'ok' | 'error'
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [copied, setCopied] = useState(false);
  // May 2026 — elapsed-time counter for the loading state so the user
  // can tell the call is still alive vs. wedged. AI providers (DeepSeek,
  // OpenRouter) routinely take 5-15s on a longish summary; the previous
  // static "Reading the data and writing the summary…" gave no signal.
  const [elapsed, setElapsed] = useState(0);
  const requestRef = useRef(0);
  const toast = useToast();

  const startRun = useCallback(async () => {
    const myReq = ++requestRef.current;
    setStatus('loading');
    setData(null);
    setError('');
    setErrorCode('');
    setElapsed(0);
    // Belt-and-suspenders timeout: even though the api layer has its
    // own 30s timeout, surface a clear failure if the whole pipeline
    // (flush + AI call + render) exceeds 45s. Prevents the popover from
    // sitting in "loading" forever if some upstream layer hangs.
    const timeoutMs = 45000;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('AI took too long — please try again')), timeoutMs);
    });
    try {
      const out = await Promise.race([run(), timeoutPromise]);
      if (myReq !== requestRef.current) return; // a newer run started; drop result
      setData(out || {});
      setStatus('ok');
    } catch (err) {
      if (myReq !== requestRef.current) return;
      safeLog.error('[AISummaryPopover] run failed', err);
      setError(getErrorMessage(err));
      setErrorCode(getErrorCode(err) || '');
      setStatus('error');
    }
  }, [run]);

  // Kick off the run the first time the popover opens, and on Regenerate.
  useEffect(() => {
    if (open && status === 'idle') startRun();
  }, [open, status, startRun]);

  // Elapsed-time tick while the AI request is in flight. Stops as soon
  // as we leave the 'loading' state (success, error, or popover close).
  useEffect(() => {
    if (status !== 'loading') return undefined;
    const start = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.round((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [status]);

  async function handleCopy() {
    const text = data?.summary || (typeof data === 'string' ? data : '');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed');
    }
  }

  function handleRegenerate() {
    setStatus('idle'); // will trigger the effect again
  }

  return (
    <Popover open={open} onOpenChange={(next) => {
      // Reset state when the popover fully closes so reopening starts fresh.
      if (!next) {
        setTimeout(() => {
          setStatus('idle');
          setData(null);
          setError('');
        }, 200);
      }
      setOpen(next);
    }} placement={placement} offset={6}>
      <Popover.Trigger>{trigger}</Popover.Trigger>
      <Popover.Content width={width} ariaLabel={title}>
        <div
          className="rounded-md shadow-md overflow-hidden"
          style={{
            backgroundColor: 'var(--primary-background-color, #ffffff)',
            border: '1px solid var(--layout-border-color, #e2e2e2)',
          }}
        >
          <header className="flex items-center gap-2 px-3 py-2 border-b border-border-light">
            <span
              className="w-5 h-5 rounded inline-flex items-center justify-center text-white"
              style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
            >
              <Sparkles size={11} />
            </span>
            <span className="text-xs font-semibold text-text-primary truncate flex-1">
              {title}
            </span>
            {status === 'ok' && (
              <button
                type="button"
                onClick={handleCopy}
                className="p-1 rounded text-text-tertiary hover:bg-surface-100"
                aria-label="Copy summary"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
            )}
            {(status === 'ok' || status === 'error') && (
              <button
                type="button"
                onClick={handleRegenerate}
                className="p-1 rounded text-text-tertiary hover:bg-surface-100"
                aria-label="Regenerate"
                title="Regenerate"
              >
                <RefreshCw size={12} />
              </button>
            )}
          </header>

          <div className="px-3 py-3 text-sm">
            {status === 'idle' && (
              <p className="text-text-tertiary">Ready to summarize…</p>
            )}
            {status === 'loading' && (
              <div className="flex flex-col gap-1.5 text-text-secondary">
                <div className="flex items-center gap-2">
                  <Sparkles size={13} className="text-primary animate-pulse" />
                  <span>
                    {elapsed < 3
                      ? 'Reading the doc…'
                      : elapsed < 10
                        ? 'Writing the summary…'
                        : elapsed < 20
                          ? 'Still working on it…'
                          : 'AI is slow today, hang on…'}
                  </span>
                  <span className="ml-auto text-[10px] text-text-tertiary tabular-nums">
                    {elapsed}s
                  </span>
                </div>
                {/* Indeterminate progress bar — gives a visible "alive"
                    signal while the provider thinks. Pure CSS keyframes
                    so we don't pull in a JS animation lib. */}
                <div className="h-0.5 w-full rounded overflow-hidden" style={{ backgroundColor: 'var(--surface-100, #f0f2f5)' }}>
                  <div
                    className="h-full"
                    style={{
                      width: '40%',
                      background: 'linear-gradient(90deg, transparent, var(--primary, #0073ea), transparent)',
                      animation: 'aiSummaryProgress 1.4s linear infinite',
                    }}
                  />
                </div>
                <style>{`
                  @keyframes aiSummaryProgress {
                    0%   { transform: translateX(-100%); }
                    100% { transform: translateX(350%); }
                  }
                `}</style>
              </div>
            )}
            {status === 'error' && (
              <div className="flex items-start gap-2 text-danger">
                <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div>{error || 'Something went wrong.'}</div>
                  {errorCode === 'AI_NOT_CONFIGURED' && (
                    <Link
                      to="/integrations"
                      onClick={() => setOpen(false)}
                      className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-primary hover:underline"
                    >
                      <Settings size={11} /> Configure AI provider
                    </Link>
                  )}
                </div>
              </div>
            )}
            {status === 'ok' && (
              renderResult
                ? renderResult(data)
                : <SummaryRenderer data={data} emptyText={emptyText} />
            )}
          </div>

          {status === 'ok' && onInsert && data?.summary && (
            <footer className="px-3 py-2 border-t border-border-light bg-surface-50 flex justify-end">
              <button
                type="button"
                onClick={() => { onInsert(data.summary); setOpen(false); }}
                className="text-xs font-semibold text-primary hover:underline"
              >
                {insertLabel}
              </button>
            </footer>
          )}

          <footer className="px-3 py-1.5 border-t border-border-light text-[10px] text-text-tertiary text-center">
            AI may be inaccurate. Review before relying on it.
          </footer>
        </div>
      </Popover.Content>
    </Popover>
  );
}

function SummaryRenderer({ data, emptyText }) {
  const text = data?.summary || (typeof data === 'string' ? data : '');
  if (!text) return <p className="text-text-tertiary">{emptyText}</p>;
  return (
    <p className="text-text-primary leading-relaxed whitespace-pre-wrap">{text}</p>
  );
}
