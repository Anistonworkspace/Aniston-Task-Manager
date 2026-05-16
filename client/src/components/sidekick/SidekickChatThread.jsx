import React, { useEffect, useRef } from 'react';
import { Sparkles, AlertCircle } from 'lucide-react';
import SidekickAIResponse from './SidekickAIResponse';
import SidekickUserMessage from './SidekickUserMessage';

/**
 * SidekickChatThread — the scrollable message list (skill §5.2).
 *
 *   <SidekickChatThread messages={messages} status="idle|thinking|streaming|error" />
 *
 * Auto-scrolls to bottom on new messages — but only if the user was already
 * near the bottom. If they've scrolled up to read older context, we don't
 * yank them back.
 */
export default function SidekickChatThread({ messages = [], status = 'idle' }) {
  const endRef = useRef(null);
  const containerRef = useRef(null);
  const lastMessageCountRef = useRef(messages.length);
  const wasNearBottomRef = useRef(true);

  // Track scroll position so we only auto-scroll when the user was reading
  // the bottom of the thread.
  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const slack = 48;
    wasNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < slack;
  }

  useEffect(() => {
    const grew = messages.length !== lastMessageCountRef.current;
    lastMessageCountRef.current = messages.length;
    if (grew && wasNearBottomRef.current && endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages.length, status]);

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-auto px-4 py-2">
      {messages.map((m, i) => {
        if (m.role === 'user') {
          return <SidekickUserMessage key={i} content={m.content} />;
        }
        if (m.role === 'assistant') {
          const isLast = i === messages.length - 1;
          const showCursor = isLast && (status === 'streaming');
          return <SidekickAIResponse key={i} message={m} showCursor={showCursor} />;
        }
        if (m.role === 'error') {
          return (
            <div key={i} className="my-2 flex items-start gap-2 text-sm text-danger">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{m.content}</span>
            </div>
          );
        }
        return null;
      })}

      {/* Thinking indicator while waiting for the first chunk. Doesn't show
          a placeholder bubble — just a small "AI is thinking" hint anchored
          above the composer. */}
      {status === 'thinking' && (
        <div className="my-2 flex items-center gap-2 text-xs text-text-secondary">
          <Sparkles size={12} className="text-primary animate-pulse" />
          <span>Thinking…</span>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}
