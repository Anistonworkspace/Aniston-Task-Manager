import React, {
  forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
} from 'react';
import { AtSign } from 'lucide-react';
import LetterAvatar from './LetterAvatar';

/**
 * MentionPopover — picker UI for the Tiptap mention extension (Phase D Slice 1).
 *
 * Rendered imperatively by SuggestionMentionRender (in RichTextEditor.jsx)
 * via @tiptap/react's ReactRenderer pattern — same approach as SlashCommand.
 *
 * Props:
 *   items        — current list of users (filtered by the suggestion plugin)
 *   loading      — true while the latest search is in flight
 *   command(it)  — called by the popover when the user picks an entry
 *   rect         — client-rect of the suggestion trigger (for fixed positioning)
 *
 * Exposes an imperative `onKeyDown({event})` that returns true when handled,
 * matching @tiptap/suggestion's render contract.
 */
const MentionPopover = forwardRef(function MentionPopover(
  { items, loading, command, rect },
  ref,
) {
  const [selected, setSelected] = useState(0);

  // Reset highlight on every new result so the list doesn't point past the
  // end after a tighter query.
  useLayoutEffect(() => { setSelected(0); }, [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown({ event }) {
      if (!items || items.length === 0) {
        // Let the editor consume arrow keys when there are no results so
        // the caret keeps moving as expected.
        return false;
      }
      if (event.key === 'ArrowDown') {
        setSelected((s) => (s + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelected((s) => (s - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const it = items[selected];
        if (it) { command(it); return true; }
      }
      return false;
    },
  }), [items, selected, command]);

  if (loading && (!items || items.length === 0)) {
    return (
      <div
        className="mention-menu fixed z-[9999] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg px-3 py-2 text-xs text-zinc-500"
        style={positionStyle(rect)}
      >
        Searching…
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div
        className="mention-menu fixed z-[9999] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg px-3 py-2 text-xs text-zinc-500"
        style={positionStyle(rect)}
      >
        No matches
      </div>
    );
  }

  return (
    <div
      className="mention-menu fixed z-[9999] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 w-[280px] max-h-[280px] overflow-y-auto"
      style={positionStyle(rect)}
    >
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide font-semibold text-zinc-400 flex items-center gap-1">
        <AtSign size={10} /> Mention
      </div>
      {items.map((u, idx) => {
        const isActive = idx === selected;
        return (
          <button
            key={u.id}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); command(u); }}
            onMouseEnter={() => setSelected(idx)}
            className={`w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-sm transition-colors ${
              isActive
                ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            }`}
          >
            <LetterAvatar name={u.name} size="sm" shape="circle" />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{u.name}</div>
              {u.email && (
                <div className="text-[10px] text-zinc-400 truncate">{u.email}</div>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
});

function positionStyle(rect) {
  if (!rect) return { display: 'none' };
  const top = rect.bottom + 6;
  const left = rect.left;
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800;
  const wouldOverflow = top + 280 > viewportH;
  return wouldOverflow
    ? { left, top: 'auto', bottom: viewportH - rect.top + 6 }
    : { left, top };
}

export default MentionPopover;
