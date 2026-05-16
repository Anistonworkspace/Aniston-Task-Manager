import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sparkles, Maximize2, X, MessageSquare } from 'lucide-react';
import SidePanel from '../common/SidePanel';
import SidekickEmptyState from './SidekickEmptyState';
import SidekickChatThread from './SidekickChatThread';
import SidekickComposer from './SidekickComposer';
import SidekickChatsListRail, { readChats, writeChats, deriveChatTitle } from './SidekickChatsListRail';
import ActionSuggestions from './ActionSuggestions';
import { getActionSuggestions } from './actionSuggestionCatalog';
import useSidekickChat from './useSidekickChat';
import { useAuth } from '../../context/AuthContext';

/**
 * SidekickPanel — right-side AI Sidekick (skill §2).
 *
 *   <SidekickPanel
 *     isOpen={open}
 *     onClose={() => setOpen(false)}
 *     scope="meeting"     // optional: "meeting" | "doc" | "board"
 *     scopeId={id}        // optional
 *     scopeLabel="this meeting" // optional override for the "Based on this X" header
 *   />
 *
 * Drop-in replacement for the legacy fixed-bottom <AIAssistant>. The chat
 * history rail is localStorage-backed for now (see SidekickChatsListRail);
 * the rest of the UI doesn't care where chats come from.
 *
 * Width: 480px on desktop, full-width sheet on mobile.
 */

const PERSISTENCE_PREFIX = 'sidekick:chat:';
const FIRST_NAME_RE = /^[\w'-]+/;

function getFirstName(name) {
  if (!name) return null;
  const trimmed = name.trim();
  const match = FIRST_NAME_RE.exec(trimmed);
  return match ? match[0] : trimmed.split(/\s+/)[0];
}

function getPageContextLabel(pathname, scopeLabel) {
  if (scopeLabel) return scopeLabel;
  if (pathname.startsWith('/boards/')) return 'this board';
  if (pathname.startsWith('/meetings/')) return 'this meeting';
  if (pathname.startsWith('/workspaces/')) return 'this workspace';
  return null;
}

export default function SidekickPanel({
  isOpen,
  onClose,
  scope = null,
  scopeId = null,
  scopeLabel = null,
  pageContext = '',
  pageState = null,
  width = 480,
}) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Chat-list state (rail). Initialized from localStorage; mutations are
  // written back so the rail stays in sync across tabs and refreshes.
  const [chats, setChats] = useState(() => readChats());
  const [activeChatId, setActiveChatId] = useState(() => chats[0]?.id || createChatId());

  const persistenceKey = `${PERSISTENCE_PREFIX}${activeChatId}`;

  const effectivePageContext = pageContext || `Route: ${location.pathname}`;
  const effectivePageState = pageState || { route: location.pathname };

  const { messages, status, error, send, stop, reset, configured } = useSidekickChat({
    pageContext: effectivePageContext,
    pageState: effectivePageState,
    scope,
    scopeId,
    historyKey: persistenceKey,
  });

  // Whenever the active chat changes shape (title-worthy), upsert it in the
  // chats list so the rail reflects the current state.
  useEffect(() => {
    if (messages.length === 0) return;
    setChats((prev) => {
      const existing = prev.find((c) => c.id === activeChatId);
      const updated = {
        id: activeChatId,
        title: deriveChatTitle(messages),
        updatedAt: Date.now(),
        ...(existing || {}),
      };
      updated.title = deriveChatTitle(messages);
      updated.updatedAt = Date.now();
      const next = [updated, ...prev.filter((c) => c.id !== activeChatId)];
      writeChats(next);
      return next;
    });
  }, [messages, activeChatId]);

  function handleNewChat() {
    const id = createChatId();
    setActiveChatId(id);
    reset();
  }

  function handleSelectChat(id) {
    if (id === activeChatId) return;
    setActiveChatId(id);
    // The hook re-hydrates from localStorage via historyKey on next render.
  }

  function handleDeleteChat(id) {
    setChats((prev) => {
      const next = prev.filter((c) => c.id !== id);
      writeChats(next);
      // If the deleted chat is the active one, fall through to a fresh chat.
      if (id === activeChatId) {
        const nextActive = next[0]?.id || createChatId();
        setActiveChatId(nextActive);
      }
      return next;
    });
    try { localStorage.removeItem(`${PERSISTENCE_PREFIX}${id}`); } catch {}
  }

  function handleQuickAction(id) {
    const prompt = QUICK_PROMPTS[id];
    if (prompt) send(prompt);
  }

  function handleExpand() {
    onClose?.();
    navigate(activeChatId ? `/sidekick/${activeChatId}` : '/sidekick');
  }

  const firstName = getFirstName(user?.name);
  const scopeHeading = getPageContextLabel(location.pathname, scopeLabel) || (scope ? `this ${scope}` : null);
  const suggestionList = scope ? getActionSuggestions(scope) : [];

  return (
    <SidePanel
      open={isOpen}
      onClose={onClose}
      side="right"
      width={width}
      mode="overlay"
      ariaLabel="AI Sidekick"
      closeOnEscape
      trapFocus={false}
    >
      <SidekickHeader
        onClose={onClose}
        onExpand={handleExpand}
        scopeHeading={scopeHeading}
      />

      <div className="flex-1 flex min-h-0">
        <SidekickChatsListRail
          chats={chats}
          activeChatId={activeChatId}
          onNewChat={handleNewChat}
          onSelect={handleSelectChat}
          onDelete={handleDeleteChat}
        />

        <div className="flex-1 flex flex-col min-w-0">
          {!configured && configured !== null && (
            <ConfigBanner />
          )}

          {messages.length === 0 ? (
            <>
              <SidekickEmptyState
                userName={firstName}
                onSend={send}
                onQuickAction={handleQuickAction}
              />
              {suggestionList.length > 0 && (
                <div className="px-4 pb-3 -mt-2">
                  <ActionSuggestions
                    suggestions={suggestionList}
                    onSelect={(text) => send(text)}
                  />
                </div>
              )}
            </>
          ) : (
            <SidekickChatThread messages={messages} status={status} />
          )}

          {messages.length > 0 && (
            <div className="px-3 pb-3 pt-1">
              <SidekickComposer
                onSend={send}
                onStop={stop}
                status={status}
                placeholder="Message AI Sidekick…"
                disabled={configured === false}
              />
              <div className="mt-1.5 text-[10px] text-center text-text-tertiary">
                AI may be inaccurate, make sure to review it.{' '}
                <a href="/help/ai" className="underline">Learn more</a>
              </div>
            </div>
          )}
        </div>
      </div>
    </SidePanel>
  );
}

function SidekickHeader({ onClose, onExpand, scopeHeading }) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2.5 flex-shrink-0"
      style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
    >
      <span
        className="w-7 h-7 rounded-md inline-flex items-center justify-center text-white"
        style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
      >
        <Sparkles size={13} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-text-primary truncate">AI Sidekick</div>
        {scopeHeading && (
          <div className="text-[10px] italic text-text-tertiary truncate">
            ✨ Based on {scopeHeading}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onExpand}
        aria-label="Open in full page"
        className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-100 hover:text-text-secondary transition-colors"
      >
        <Maximize2 size={14} />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close Sidekick"
        className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-100 hover:text-text-secondary transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function ConfigBanner() {
  return (
    <div
      className="px-4 py-2 flex items-center gap-2 text-xs"
      style={{
        backgroundColor: 'rgba(251, 191, 36, 0.12)',
        color: 'rgb(180, 83, 9)',
        borderBottom: '1px solid rgba(251, 191, 36, 0.3)',
      }}
    >
      <MessageSquare size={12} className="flex-shrink-0" />
      <span>
        AI is not configured. An admin needs to set it up in
        <a href="/integrations" className="ml-1 underline font-semibold">Integrations</a>.
      </span>
    </div>
  );
}

function createChatId() {
  return `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const QUICK_PROMPTS = {
  board:      'I want to create a new board. What should I include?',
  doc:        "Help me start writing a doc. What's a good outline?",
  research:   'Help me research a topic — ask me what to look up.',
  analyze:    'I want to analyze some data — what should we look at?',
  brainstorm: "Let's brainstorm ideas. What problem are we solving?",
  more:       'Show me what else you can help with.',
};
