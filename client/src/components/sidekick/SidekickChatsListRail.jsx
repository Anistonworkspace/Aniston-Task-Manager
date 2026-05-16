import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Search, MoreHorizontal, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

/**
 * SidekickChatsListRail — left rail of past chats inside the Sidekick panel
 * (skill §2.4).
 *
 * Storage: client-side only for now. Persisted to localStorage under
 * `sidekick:chats`. When a backend chat-store is added later, this component
 * only needs its data source swapped — the props stay the same.
 *
 *   <SidekickChatsListRail
 *     activeChatId={chatId}
 *     onSelect={(id) => ...}
 *     onNewChat={() => ...}
 *   />
 *
 * The rail auto-titles each chat from the first user message (truncated).
 * Empty chats are skipped — they don't pollute the list.
 */

const STORAGE_KEY = 'sidekick:chats';

export function readChats() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeChats(chats) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(chats)); } catch {}
}

export function deriveChatTitle(messages) {
  if (!Array.isArray(messages)) return 'New chat';
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser?.content) return 'New chat';
  return firstUser.content.length > 60 ? firstUser.content.slice(0, 60) + '…' : firstUser.content;
}

export default function SidekickChatsListRail({
  chats: chatsProp,
  activeChatId,
  onSelect,
  onNewChat,
  onDelete,
  collapsed = false,
}) {
  const [chats, setChats] = useState(() => chatsProp || readChats());
  const [query, setQuery] = useState('');
  const [hoveredId, setHoveredId] = useState(null);

  // Keep in sync with localStorage updates from other tabs.
  useEffect(() => {
    function onStorage(e) {
      if (e.key === STORAGE_KEY) setChats(readChats());
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Re-read on mount in case the parent's state diverged.
  useEffect(() => {
    if (chatsProp) setChats(chatsProp);
  }, [chatsProp]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((c) => (c.title || '').toLowerCase().includes(q));
  }, [chats, query]);

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 py-3 w-10 border-r border-border-light">
        <RailIconButton onClick={onNewChat} ariaLabel="New chat">
          <Plus size={14} />
        </RailIconButton>
      </div>
    );
  }

  return (
    <aside
      className="flex flex-col w-44 flex-shrink-0"
      style={{ borderRight: '1px solid var(--layout-border-color, #e2e2e2)' }}
    >
      <div className="p-2">
        <button
          type="button"
          onClick={onNewChat}
          className="w-full inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs font-semibold hover:bg-primary-600 transition-colors"
        >
          <Plus size={12} />
          New chat
        </button>
      </div>

      <div className="px-2 pb-1.5">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="w-full pl-7 pr-2 py-1 text-xs border border-border rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-primary-300 focus:border-primary"
          />
        </div>
      </div>

      <div className="flex-1 overflow-auto px-1.5 pb-2">
        <div className="px-1.5 pt-2 pb-1 text-[10px] uppercase tracking-wide font-semibold text-text-tertiary">
          Chats
        </div>

        {filtered.length === 0 ? (
          <div className="px-2 py-3 text-xs text-text-tertiary">
            {query ? 'No chats match.' : 'No chats yet.'}
          </div>
        ) : (
          filtered.map((chat) => {
            const active = chat.id === activeChatId;
            return (
              <div
                key={chat.id}
                onMouseEnter={() => setHoveredId(chat.id)}
                onMouseLeave={() => setHoveredId(null)}
                className={`group relative rounded-md text-left text-xs transition-colors ${
                  active ? 'bg-primary-50' : 'hover:bg-surface-100'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect?.(chat.id)}
                  className="w-full pl-2 pr-7 py-1.5 text-left"
                >
                  <div className={`font-medium truncate ${active ? 'text-primary' : 'text-text-primary'}`}>
                    {chat.title || 'Untitled chat'}
                  </div>
                  {chat.updatedAt && (
                    <div className="text-[10px] text-text-tertiary truncate">
                      {formatDistanceToNow(new Date(chat.updatedAt), { addSuffix: true })}
                    </div>
                  )}
                </button>
                {(hoveredId === chat.id || active) && onDelete && (
                  <button
                    type="button"
                    aria-label="Delete chat"
                    onClick={(e) => { e.stopPropagation(); onDelete(chat.id); }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded inline-flex items-center justify-center text-text-tertiary hover:bg-surface-200 hover:text-danger"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

function RailIconButton({ children, onClick, ariaLabel }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className="w-8 h-8 rounded-md inline-flex items-center justify-center text-text-tertiary hover:bg-surface-100 hover:text-text-secondary transition-colors"
    >
      {children}
    </button>
  );
}
