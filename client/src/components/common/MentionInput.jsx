import React, {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { AtSign } from 'lucide-react';

/**
 * MentionInput — drop-in <textarea> replacement with `@`-mention autocomplete.
 *
 *   <MentionInput
 *     value={description}
 *     onChange={setDescription}
 *     users={[{ id, name, email?, designation? }, ...]}
 *     placeholder="What help do you need?"
 *     rows={3}
 *     className="..."
 *   />
 *
 * Typing `@` opens a portaled dropdown filtered by the characters that
 * follow. Arrow keys / Tab navigate, Enter / click select, Escape closes.
 * Selecting inserts `@<name> ` (with a trailing space) at the caret and
 * fires onChange with the new value.
 *
 * Mentions render in the saved value as plain text `@Sara Lee` — there is
 * no special marker. Callers that need richer semantics (e.g. parsing back
 * out a user id) should use a Tiptap-based editor instead; this is the
 * lightweight version for places that just want the affordance without
 * pulling in a rich-text dependency.
 *
 * Performance — filter happens in-memory over the `users` array on every
 * keystroke. For thousands of users you'd want a server-side suggest API.
 * Today's userbase is well within the comfortable client-side range.
 */
export default function MentionInput({
  value,
  onChange,
  users = [],
  placeholder,
  rows = 3,
  className = '',
  disabled = false,
  id,
  'aria-label': ariaLabel,
}) {
  const textareaRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // The character offset of the `@` that opened the menu. Used to splice the
  // selected name back into the value at the right spot.
  const [triggerStart, setTriggerStart] = useState(-1);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, ready: false });

  const filtered = useMemo(() => {
    if (!menuOpen) return [];
    const q = (query || '').toLowerCase();
    if (!q) return users.slice(0, 8);
    return users
      .filter((u) => {
        const name = String(u?.name || '').toLowerCase();
        const email = String(u?.email || '').toLowerCase();
        return name.includes(q) || email.includes(q);
      })
      .slice(0, 8);
  }, [menuOpen, query, users]);

  // Reset focus index whenever the filter set changes — keeps the highlight
  // on a valid row instead of pointing past the end of the list.
  useEffect(() => { setActiveIndex(0); }, [filtered.length]);

  // Position the dropdown beneath the textarea — simple anchored placement
  // rather than caret-tracking. Caret-tracking inside a textarea requires a
  // mirror element + measuring; not worth the complexity for v1.
  useLayoutEffect(() => {
    if (!menuOpen || !textareaRef.current) return;
    const rect = textareaRef.current.getBoundingClientRect();
    let top = rect.bottom + 4;
    let left = rect.left;
    const menuW = 240;
    if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
    // Flip above the textarea if there's no room below.
    if (top + 220 > window.innerHeight - 8 && rect.top > 220) {
      top = rect.top - 4 - 220;
    }
    setMenuPos({ top, left, ready: true });
  }, [menuOpen, filtered.length]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setTriggerStart(-1);
    setQuery('');
  }, []);

  const insertMention = useCallback((user) => {
    const ta = textareaRef.current;
    if (!ta || triggerStart < 0 || !user) {
      closeMenu();
      return;
    }
    const caret = ta.selectionStart || 0;
    const before = value.slice(0, triggerStart);
    const after = value.slice(caret);
    const mentionText = `@${user.name} `;
    const next = before + mentionText + after;
    onChange?.(next);
    // Restore caret to just after the inserted mention. Done in a microtask
    // so React has applied the new value before we touch selection.
    Promise.resolve().then(() => {
      if (textareaRef.current) {
        const pos = before.length + mentionText.length;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(pos, pos);
      }
    });
    closeMenu();
  }, [triggerStart, value, onChange, closeMenu]);

  function handleChange(e) {
    const next = e.target.value;
    onChange?.(next);

    const caret = e.target.selectionStart || 0;
    // Walk backward from the caret looking for an unbroken token after `@`.
    // Whitespace or newline breaks the run; running into the start of the
    // string also counts.
    let start = -1;
    for (let i = caret - 1; i >= 0; i--) {
      const ch = next[i];
      if (ch === '@') { start = i; break; }
      if (/\s/.test(ch)) break;
    }
    if (start >= 0) {
      // Don't trigger when `@` is preceded by a non-whitespace char (e.g.
      // an email address mid-typing). The `@` must start a fresh token.
      const prev = next[start - 1];
      if (start === 0 || /\s/.test(prev) || prev === '\n') {
        setTriggerStart(start);
        setQuery(next.slice(start + 1, caret));
        setMenuOpen(true);
        return;
      }
    }
    closeMenu();
  }

  function handleKeyDown(e) {
    if (!menuOpen || filtered.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insertMention(filtered[activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    }
  }

  return (
    <>
      <textarea
        ref={textareaRef}
        id={id}
        aria-label={ariaLabel}
        value={value || ''}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(closeMenu, 120)}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        className={className}
      />
      {menuOpen && filtered.length > 0 && menuPos.ready && createPortal(
        <div
          role="listbox"
          aria-label="Mention suggestions"
          style={{
            position: 'fixed',
            top: menuPos.top,
            left: menuPos.left,
            width: 240,
            zIndex: 'var(--context-menu-z-index, 10000)',
            backgroundColor: 'var(--primary-background-color, #ffffff)',
            border: '1px solid var(--layout-border-color, #e2e2e2)',
            borderRadius: 8,
            boxShadow: 'var(--box-shadow-medium, 0 4px 12px rgba(0,0,0,0.12))',
            maxHeight: 220,
            overflowY: 'auto',
          }}
          onMouseDown={(e) => e.preventDefault()} // keep textarea focus
        >
          <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wide font-semibold text-text-tertiary border-b border-border-light flex items-center gap-1">
            <AtSign size={10} /> Mention a user
          </div>
          {filtered.map((u, i) => (
            <button
              key={u.id}
              role="option"
              aria-selected={i === activeIndex}
              type="button"
              onClick={() => insertMention(u)}
              onMouseEnter={() => setActiveIndex(i)}
              className={`w-full text-left px-2.5 py-1.5 text-xs ${
                i === activeIndex ? 'bg-primary/10 text-primary' : 'text-text-primary hover:bg-surface-100'
              }`}
            >
              <div className="font-medium truncate">{u.name}</div>
              {(u.designation || u.email) && (
                <div className="text-[10px] text-text-tertiary truncate">
                  {u.designation || u.email}
                </div>
              )}
            </button>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
