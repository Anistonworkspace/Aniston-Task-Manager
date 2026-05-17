import React, { useState } from 'react';
import {
  Sparkles, ChevronRight, Wand2, Minimize2, Maximize2, Check, ArrowRight,
  Coffee, Briefcase, Loader2, AlertCircle, RotateCcw,
} from 'lucide-react';

/**
 * BubbleAIMenu — Phase E.
 *
 * Inline AI controls that appear next to a text selection inside the
 * Tiptap RichTextEditor. The parent passes:
 *
 *   selectedText — the current selection (string). If empty, the menu
 *                  collapses into a single "AI" affordance because the
 *                  only legal action then is "continue writing".
 *
 *   onTransform({ mode, text }) → Promise<{ output: string }>
 *                  the network call. Caller wires this through
 *                  aiSummary.transformInline.
 *
 *   onReplace(text)
 *                  apply the AI's output to the editor (replace the
 *                  selection or insert at the cursor for "continue").
 *                  Parent runs the Tiptap chain.
 *
 *   onClose()      caller-controlled visibility teardown.
 *
 * UI states: idle (mode list) → loading (spinner) → result preview
 * (Replace / Try again). Pure presentational — no Tiptap deps.
 */

const MODES = [
  { key: 'improve',      label: 'Improve writing',      desc: 'Clearer, stronger phrasing', icon: Wand2,      needsSelection: true },
  { key: 'shorter',      label: 'Make shorter',         desc: 'Same meaning, fewer words',  icon: Minimize2,  needsSelection: true },
  { key: 'longer',       label: 'Make longer',          desc: 'Add concrete detail',        icon: Maximize2,  needsSelection: true },
  { key: 'grammar',      label: 'Fix grammar',          desc: 'Spelling + grammar only',    icon: Check,      needsSelection: true },
  { key: 'continue',     label: 'Continue writing',     desc: 'Write the next sentences',   icon: ArrowRight, needsSelection: false },
  { key: 'casual',       label: 'More casual',          desc: 'Conversational tone',        icon: Coffee,     needsSelection: true },
  { key: 'professional', label: 'More professional',    desc: 'Polished business tone',     icon: Briefcase,  needsSelection: true },
];

export default function BubbleAIMenu({
  selectedText,
  onTransform,
  onReplace,
  onClose,
}) {
  const [status, setStatus] = useState('idle'); // idle | loading | result | error
  const [activeMode, setActiveMode] = useState(null);
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');

  const hasSelection = !!(selectedText && selectedText.trim());

  async function runMode(mode) {
    setStatus('loading');
    setActiveMode(mode);
    setError('');
    try {
      // "continue" runs even when nothing is selected — we send the
      // selection (often empty) and let the model do its job. For other
      // modes, an empty selection is a no-op (button is disabled below).
      const text = hasSelection ? selectedText : (selectedText || '');
      const result = await onTransform({ mode, text });
      setOutput(String(result?.output || '').trim());
      setStatus('result');
    } catch (err) {
      setError(err?.message || 'AI request failed');
      setStatus('error');
    }
  }

  function handleReplace() {
    if (!output) return;
    onReplace(output);
    onClose?.();
  }

  return (
    <div
      className="bubble-ai-menu w-[300px] max-h-[420px] overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-xl"
      role="menu"
      aria-label="AI actions"
      onMouseDown={(e) => e.preventDefault() /* keep editor selection */}
    >
      <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2">
        <span
          className="w-5 h-5 rounded inline-flex items-center justify-center text-white"
          style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
        >
          <Sparkles size={11} />
        </span>
        <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">AI actions</span>
        <span className="ml-auto text-[10px] text-zinc-400">
          {hasSelection ? `${selectedText.length} chars selected` : 'No selection'}
        </span>
      </div>

      {status === 'idle' && (
        <div className="py-1">
          {MODES.map((m) => {
            const Icon = m.icon;
            const disabled = m.needsSelection && !hasSelection;
            return (
              <button
                key={m.key}
                type="button"
                disabled={disabled}
                onClick={() => runMode(m.key)}
                className={`w-full text-left flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                  disabled
                    ? 'text-zinc-300 dark:text-zinc-600 cursor-not-allowed'
                    : 'text-zinc-700 dark:text-zinc-300 hover:bg-emerald-50/60 dark:hover:bg-emerald-900/20'
                }`}
                title={disabled ? 'Select text first' : m.label}
              >
                <Icon size={14} className="flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{m.label}</div>
                  <div className="text-[10px] text-zinc-400 truncate">{m.desc}</div>
                </div>
                <ChevronRight size={12} className="text-zinc-300 dark:text-zinc-600 flex-shrink-0" />
              </button>
            );
          })}
        </div>
      )}

      {status === 'loading' && (
        <div className="px-4 py-6 flex flex-col items-center gap-2 text-zinc-600 dark:text-zinc-300">
          <Loader2 size={20} className="animate-spin text-primary" />
          <p className="text-[12px]">
            Running <span className="font-semibold">{labelFor(activeMode)}</span>…
          </p>
          <p className="text-[10px] text-zinc-400">This usually takes 1-3 seconds.</p>
        </div>
      )}

      {status === 'error' && (
        <div className="px-4 py-4 flex flex-col items-start gap-2 text-rose-600">
          <div className="flex items-center gap-2 text-xs">
            <AlertCircle size={14} />
            <span className="font-semibold">AI request failed</span>
          </div>
          <p className="text-[11px] text-zinc-500">{error}</p>
          <div className="flex gap-1.5 mt-1">
            <button
              type="button"
              onClick={() => runMode(activeMode)}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-primary border border-primary-200 bg-primary-50 rounded hover:bg-primary-100"
            >
              <RotateCcw size={11} /> Try again
            </button>
            <button
              type="button"
              onClick={() => { setStatus('idle'); setError(''); setActiveMode(null); }}
              className="px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-700"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {status === 'result' && (
        <div className="px-3 py-3 flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wide font-semibold text-zinc-400">
            Preview · {labelFor(activeMode)}
          </div>
          {output ? (
            <div className="text-[13px] whitespace-pre-wrap text-zinc-700 dark:text-zinc-200 leading-relaxed border border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-800/30 rounded p-2 max-h-[200px] overflow-y-auto">
              {output}
            </div>
          ) : (
            <div className="text-[12px] text-zinc-400 italic">
              AI returned an empty response. Try again.
            </div>
          )}
          <div className="flex items-center justify-end gap-1.5 mt-1">
            <button
              type="button"
              onClick={() => { setStatus('idle'); setOutput(''); setActiveMode(null); }}
              className="px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-700"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => runMode(activeMode)}
              className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-zinc-600 border border-zinc-200 bg-white rounded hover:bg-zinc-50"
            >
              <RotateCcw size={10} /> Regenerate
            </button>
            <button
              type="button"
              onClick={handleReplace}
              disabled={!output}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-primary rounded hover:bg-primary-600 disabled:opacity-50"
            >
              <Check size={11} /> {activeMode === 'continue' ? 'Insert' : 'Replace'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function labelFor(modeKey) {
  return MODES.find((m) => m.key === modeKey)?.label || 'AI';
}
