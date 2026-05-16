import React, { useRef, useState } from 'react';
import { Paperclip, AtSign, Mic, ArrowUp, Square } from 'lucide-react';
import RainbowInputWrapper from './RainbowInputWrapper';

/**
 * SidekickComposer — input row with the brand-gradient border (skill §5.7).
 *
 *   <SidekickComposer
 *     onSend={(text) => ...}
 *     onStop={...}
 *     status="idle" | "thinking" | "streaming"
 *     placeholder="Message AI Sidekick…"
 *     disabled={false}
 *   />
 *
 * Sends on Enter, allows Shift+Enter for newlines. While `status` is
 * 'thinking' or 'streaming', the send button is replaced with a Stop button.
 */
export default function SidekickComposer({
  onSend,
  onStop,
  status = 'idle',
  placeholder = 'Message AI Sidekick…',
  disabled = false,
  autoFocus = false,
  className = '',
}) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const taRef = useRef(null);

  const inFlight = status === 'thinking' || status === 'streaming';
  const canSend = text.trim().length > 0 && !inFlight && !disabled;

  function send() {
    if (!canSend) return;
    onSend?.(text.trim());
    setText('');
    // Reset height — auto-grow is bounded so we don't snap back from 200px.
    if (taRef.current) taRef.current.style.height = 'auto';
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function handleInput(e) {
    setText(e.target.value);
    if (taRef.current) {
      taRef.current.style.height = 'auto';
      taRef.current.style.height = `${Math.min(taRef.current.scrollHeight, 200)}px`;
    }
  }

  return (
    <RainbowInputWrapper focused={focused} thickness={2} radius={12} className={className}>
      <div className="p-3 flex flex-col gap-2">
        <textarea
          ref={taRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKey}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          rows={1}
          autoFocus={autoFocus}
          disabled={disabled}
          aria-label="Message AI Sidekick"
          className="w-full resize-none bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none leading-relaxed"
          style={{ minHeight: 24, maxHeight: 200 }}
        />
        <div className="flex items-center gap-1">
          <ComposerIconButton ariaLabel="Attach file" disabled={disabled}>
            <Paperclip size={15} />
          </ComposerIconButton>
          <ComposerIconButton ariaLabel="Add context" disabled={disabled}>
            <AtSign size={15} />
          </ComposerIconButton>
          <ComposerIconButton ariaLabel="Voice input" disabled={disabled}>
            <Mic size={15} />
          </ComposerIconButton>
          <div className="ml-auto">
            {inFlight ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop response"
                className="w-9 h-9 rounded-md inline-flex items-center justify-center bg-text-primary text-white hover:opacity-90 transition-colors"
              >
                <Square size={13} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                aria-label="Send message"
                className={`w-9 h-9 rounded-md inline-flex items-center justify-center transition-colors ${
                  canSend ? 'bg-primary text-white hover:bg-primary-600' : 'bg-surface-200 text-text-tertiary cursor-not-allowed'
                }`}
              >
                <ArrowUp size={15} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </div>
    </RainbowInputWrapper>
  );
}

function ComposerIconButton({ children, ariaLabel, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="w-8 h-8 inline-flex items-center justify-center rounded-md text-text-tertiary hover:bg-surface-100 hover:text-text-secondary transition-colors disabled:opacity-40"
    >
      {children}
    </button>
  );
}
