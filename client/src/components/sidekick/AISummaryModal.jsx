import React, { useEffect, useRef, useState } from 'react';
import { X, Sparkles, Copy, Check, RefreshCw, AlertCircle, Settings, Loader2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import safeLog from '../../utils/safeLog';
import { getErrorMessage, getErrorCode } from '../../utils/errorMap';

/**
 * AISummaryModal — centered modal for one-shot AI summaries.
 *
 * Replaces AISummaryPopover for doc/board/task Summarize buttons that were
 * reported invisible in some user environments (May 2026 bug). Modals are
 * portal-rendered at z-index 10000 with a backdrop, anchored to viewport
 * center — they can't be missed.
 *
 *   <AISummaryModal
 *     isOpen={open}
 *     onClose={() => setOpen(false)}
 *     title="AI summary"               // header label
 *     subtitle={doc?.title || board?.name}   // small line under header
 *     run={async () => aiSummary.summarizeBoard(boardId)}
 *     timeoutMs={45000}                // optional override
 *   />
 *
 * Features:
 *   - Phase-based loading copy + sliding progress bar + elapsed-time counter
 *   - 45s hard timeout (so the modal never sits in loading forever)
 *   - Copy / Regenerate / Try Again affordances
 *   - Inline "AI not configured" → /integrations link
 *   - Esc closes; backdrop click closes; cleanup on unmount
 */
export default function AISummaryModal({
  isOpen,
  onClose,
  title = 'AI summary',
  subtitle = '',
  run,
  timeoutMs = 45000,
}) {
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'ok' | 'error'
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const requestRef = useRef(0);
  const runRef = useRef(run);

  useEffect(() => { runRef.current = run; }, [run]);

  // Kick off the request when the modal opens (and on regenerate via status='idle').
  useEffect(() => {
    if (!isOpen || status !== 'idle') return;
    const myReq = ++requestRef.current;
    setStatus('loading');
    setData(null);
    setError('');
    setErrorCode('');
    setElapsed(0);

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('AI took too long — please try again')), timeoutMs);
    });

    Promise.race([runRef.current(), timeoutPromise])
      .then((out) => {
        if (myReq !== requestRef.current) return;
        setData(out || {});
        setStatus('ok');
      })
      .catch((err) => {
        if (myReq !== requestRef.current) return;
        safeLog.error('[AISummaryModal] run failed', err);
        setError(getErrorMessage(err));
        setErrorCode(getErrorCode(err) || '');
        setStatus('error');
      });
  }, [isOpen, status, timeoutMs]);

  // Reset internal state on close so reopening starts fresh.
  useEffect(() => {
    if (!isOpen) {
      const t = setTimeout(() => {
        setStatus('idle');
        setData(null);
        setError('');
        setErrorCode('');
        setElapsed(0);
        requestRef.current++;
      }, 200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [isOpen]);

  // Tick elapsed time while loading.
  useEffect(() => {
    if (status !== 'loading') return undefined;
    const start = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.round((Date.now() - start) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [status]);

  // Esc closes the modal.
  useEffect(() => {
    if (!isOpen) return undefined;
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  async function handleCopy() {
    const text = data?.summary || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) { /* clipboard may be blocked */ }
  }

  function handleRegenerate() {
    setStatus('idle');
  }

  if (!isOpen) return null;

  let loadingLabel = 'Reading the content…';
  if (elapsed >= 3 && elapsed < 10) loadingLabel = 'Writing the summary…';
  else if (elapsed >= 10 && elapsed < 20) loadingLabel = 'Still working on it…';
  else if (elapsed >= 20) loadingLabel = 'AI is slow today, hang on…';

  return createPortal(
    <AnimatePresence>
      <motion.div
        key="backdrop"
        className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
        style={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      >
        <motion.div
          key="card"
          className="w-full max-w-lg rounded-xl shadow-2xl overflow-hidden bg-white"
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 8 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
          role="dialog"
          aria-label={title}
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex items-center gap-2 px-4 py-3 border-b border-gray-100">
            <span
              className="w-7 h-7 rounded-md inline-flex items-center justify-center text-white"
              style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
            >
              <Sparkles size={13} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-gray-900 truncate">{title}</div>
              {subtitle && (
                <div className="text-xs text-gray-500 truncate">{subtitle}</div>
              )}
            </div>
            {status === 'ok' && (
              <button
                type="button"
                onClick={handleCopy}
                className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"
                aria-label="Copy summary"
                title="Copy summary"
              >
                {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
              </button>
            )}
            {(status === 'ok' || status === 'error') && (
              <button
                type="button"
                onClick={handleRegenerate}
                className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"
                aria-label="Regenerate"
                title="Regenerate"
              >
                <RefreshCw size={14} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </header>

          <div className="px-4 py-4 min-h-[120px] max-h-[60vh] overflow-auto">
            {status === 'idle' && (
              <p className="text-sm text-gray-500">Preparing…</p>
            )}
            {status === 'loading' && (
              <div className="flex flex-col gap-3 text-sm text-gray-700">
                <div className="flex items-center gap-2">
                  <Loader2 size={14} className="text-blue-600 animate-spin" />
                  <span className="font-medium">{loadingLabel}</span>
                  <span className="ml-auto text-[11px] text-gray-400 tabular-nums">{elapsed}s</span>
                </div>
                <div className="h-1 w-full rounded overflow-hidden bg-gray-100">
                  <div
                    style={{
                      width: '40%',
                      height: '100%',
                      background: 'linear-gradient(90deg, transparent, #579bfc, transparent)',
                      animation: 'aiSummaryModalProgress 1.4s linear infinite',
                    }}
                  />
                </div>
                <style>{`
                  @keyframes aiSummaryModalProgress {
                    0%   { transform: translateX(-100%); }
                    100% { transform: translateX(350%); }
                  }
                `}</style>
                <p className="text-[11px] text-gray-400 leading-relaxed">
                  Sending content to the AI provider. This usually takes 3-10
                  seconds. The request times out after {Math.round(timeoutMs / 1000)} seconds.
                </p>
              </div>
            )}
            {status === 'error' && (
              <div className="flex items-start gap-2 text-sm text-red-600">
                <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <div className="font-medium">{error || 'Something went wrong.'}</div>
                  {errorCode === 'AI_NOT_CONFIGURED' && (
                    <Link
                      to="/integrations"
                      onClick={onClose}
                      className="inline-flex items-center gap-1 mt-2 text-xs font-semibold text-blue-600 hover:underline"
                    >
                      <Settings size={11} /> Configure AI provider
                    </Link>
                  )}
                  <button
                    type="button"
                    onClick={handleRegenerate}
                    className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-gray-700 border border-gray-200 px-2.5 py-1 rounded-md hover:bg-gray-50"
                  >
                    <RefreshCw size={11} /> Try again
                  </button>
                </div>
              </div>
            )}
            {status === 'ok' && (
              <SummaryRenderer data={data} />
            )}
          </div>

          <footer className="px-4 py-2 border-t border-gray-100 text-[11px] text-gray-400 text-center">
            AI may be inaccurate. Review before relying on it.
          </footer>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}

function SummaryRenderer({ data }) {
  const text = data?.summary || (typeof data === 'string' ? data : '');
  if (!text) {
    return <p className="text-sm text-gray-500">The AI returned an empty summary. Try Regenerate.</p>;
  }
  return (
    <p className="text-sm text-gray-900 leading-relaxed whitespace-pre-wrap">{text}</p>
  );
}
