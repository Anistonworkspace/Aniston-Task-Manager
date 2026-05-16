import React, { useState } from 'react';
import { Sparkles, ChevronDown, ChevronRight, Copy, ThumbsUp, ThumbsDown, Check } from 'lucide-react';
import SidekickMarkdown from './SidekickMarkdown';
import SidekickSourcesPopover from './SidekickSourcesPopover';
import { useToast } from '../common/Toast';

/**
 * SidekickAIResponse — single AI message card (skill §5.4).
 *
 * Layout:
 *   - Optional "✨ Thinking process ▾" expander (when message.thinking is set).
 *   - Markdown body.
 *   - Action row: Copy, 👍, 👎 (and sources popover when message.sources set).
 *   - Streaming cursor while the message is in-flight (showCursor=true).
 *
 *   <SidekickAIResponse message={{ content, thinking, sources }} showCursor />
 */
export default function SidekickAIResponse({
  message,
  showCursor = false,
  onFeedback,
}) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [feedback, setFeedback] = useState(null); // 'up' | 'down' | null
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const content = message?.content || '';
  const thinking = message?.thinking;
  const sources = message?.sources;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Copy failed');
    }
  }

  function handleFeedback(kind) {
    setFeedback(kind);
    onFeedback?.(kind, message);
  }

  return (
    <div className="my-3">
      {/* Avatar + author label */}
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="w-6 h-6 rounded-full inline-flex items-center justify-center text-white"
          style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
        >
          <Sparkles size={12} />
        </span>
        <span className="text-xs font-semibold text-text-secondary">AI Sidekick</span>
      </div>

      {/* Thinking expander */}
      {thinking && (
        <div className="mb-2 rounded-md border border-border-light overflow-hidden">
          <button
            type="button"
            onClick={() => setThinkingOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-50 transition-colors"
          >
            {thinkingOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Sparkles size={11} />
            <span>Thinking process</span>
          </button>
          {thinkingOpen && (
            <div className="px-3 py-2 bg-surface-50 text-xs text-text-secondary leading-relaxed whitespace-pre-wrap">
              {thinking}
            </div>
          )}
        </div>
      )}

      {/* Body */}
      <div className="text-sm text-text-primary">
        <SidekickMarkdown text={content} />
        {showCursor && (
          <span
            className="inline-block w-2 h-4 ml-0.5 align-middle"
            style={{
              backgroundColor: 'var(--text-secondary, #5a5a5a)',
              animation: 'sidekick-blink 1s steps(2, start) infinite',
            }}
            aria-hidden="true"
          />
        )}
      </div>

      {/* Action row — hidden while streaming */}
      {!showCursor && (
        <div className="mt-2 flex items-center gap-1">
          <ActionButton onClick={handleCopy} ariaLabel="Copy message">
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </ActionButton>
          <ActionButton
            onClick={() => handleFeedback('up')}
            ariaLabel="Helpful"
            active={feedback === 'up'}
          >
            <ThumbsUp size={13} />
          </ActionButton>
          <ActionButton
            onClick={() => handleFeedback('down')}
            ariaLabel="Not helpful"
            active={feedback === 'down'}
          >
            <ThumbsDown size={13} />
          </ActionButton>
          <div className="ml-auto">
            <SidekickSourcesPopover sources={sources} />
          </div>
        </div>
      )}

      <style>{`
        @keyframes sidekick-blink {
          0%, 100% { opacity: 0; }
          50% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function ActionButton({ children, onClick, ariaLabel, active }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={`w-7 h-7 inline-flex items-center justify-center rounded-md transition-colors ${
        active
          ? 'bg-primary-50 text-primary'
          : 'text-text-tertiary hover:bg-surface-100 hover:text-text-secondary'
      }`}
    >
      {children}
    </button>
  );
}
