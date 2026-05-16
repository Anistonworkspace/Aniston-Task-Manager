import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Sparkles, ChevronRight, ArrowLeft } from 'lucide-react';
import SidekickChatThread from '../../components/sidekick/SidekickChatThread';
import SidekickComposer from '../../components/sidekick/SidekickComposer';
import SidekickEmptyState from '../../components/sidekick/SidekickEmptyState';
import SidekickChatsListRail, {
  readChats, writeChats, deriveChatTitle,
} from '../../components/sidekick/SidekickChatsListRail';
import useSidekickChat from '../../components/sidekick/useSidekickChat';
import { useAuth } from '../../context/AuthContext';

/**
 * SidekickPage — standalone full-page Sidekick (skill §3).
 *
 * Routes:
 *   /sidekick                 → new chat
 *   /sidekick/:chatId         → continue an existing chat
 *
 * Reuses every component from the in-panel Sidekick. The only differences
 * are layout (full-width vs 480px rail), the back-to-app affordance, and the
 * left rail is wider here (~280px) because we have the room.
 *
 * Chats persist to localStorage via the same shared store used by the panel,
 * so opening the page → expanding from the panel → coming back to the page
 * shows a coherent chat history.
 */

const PERSISTENCE_PREFIX = 'sidekick:chat:';

export default function SidekickPage() {
  const { chatId: routeChatId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [chats, setChats] = useState(() => readChats());
  const [activeChatId, setActiveChatId] = useState(
    routeChatId || chats[0]?.id || createChatId()
  );

  // Keep URL + active chat in sync.
  useEffect(() => {
    if (!routeChatId) {
      navigate(`/sidekick/${activeChatId}`, { replace: true });
      return;
    }
    if (routeChatId !== activeChatId) setActiveChatId(routeChatId);
  }, [routeChatId, activeChatId, navigate]);

  const persistenceKey = `${PERSISTENCE_PREFIX}${activeChatId}`;
  const firstName = user?.name?.split(' ')[0];

  const { messages, status, send, stop, reset, configured } = useSidekickChat({
    historyKey: persistenceKey,
    pageContext: 'Sidekick standalone page',
  });

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
    navigate(`/sidekick/${id}`);
    reset();
  }

  function handleSelectChat(id) {
    navigate(`/sidekick/${id}`);
  }

  function handleDeleteChat(id) {
    setChats((prev) => {
      const next = prev.filter((c) => c.id !== id);
      writeChats(next);
      if (id === activeChatId) {
        const nextActive = next[0]?.id || createChatId();
        navigate(`/sidekick/${nextActive}`);
      }
      return next;
    });
    try { localStorage.removeItem(`${PERSISTENCE_PREFIX}${id}`); } catch {}
  }

  return (
    <div className="h-full flex flex-col">
      <header
        className="flex items-center gap-3 px-4 py-2.5 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--layout-border-color, #e2e2e2)' }}
      >
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label="Back"
          className="p-1.5 rounded-md text-text-tertiary hover:bg-surface-100 hover:text-text-secondary transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <span
          className="w-7 h-7 rounded-md inline-flex items-center justify-center text-white"
          style={{ backgroundImage: 'linear-gradient(135deg, #9d50dd 0%, #579bfc 100%)' }}
        >
          <Sparkles size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold text-text-primary">AI Sidekick</h1>
        </div>
        <button
          type="button"
          onClick={handleNewChat}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-primary text-white hover:bg-primary-600 transition-colors"
        >
          + New chat
        </button>
      </header>

      <div className="flex-1 flex min-h-0">
        <div className="hidden md:flex w-72 flex-shrink-0">
          <SidekickChatsListRail
            chats={chats}
            activeChatId={activeChatId}
            onSelect={handleSelectChat}
            onNewChat={handleNewChat}
            onDelete={handleDeleteChat}
          />
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          {messages.length === 0 ? (
            <SidekickEmptyState
              userName={firstName}
              onSend={send}
              onQuickAction={(id) => {
                const prompt = QUICK_PROMPTS[id];
                if (prompt) send(prompt);
              }}
            />
          ) : (
            <SidekickChatThread messages={messages} status={status} />
          )}

          {messages.length > 0 && (
            <div className="px-4 pb-4 pt-1 max-w-3xl w-full mx-auto">
              <SidekickComposer
                onSend={send}
                onStop={stop}
                status={status}
                placeholder="Message AI Sidekick…"
                disabled={configured === false}
              />
              <div className="mt-1.5 text-[10px] text-center text-text-tertiary">
                AI may be inaccurate, make sure to review it.
              </div>
            </div>
          )}
        </div>
      </div>
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
