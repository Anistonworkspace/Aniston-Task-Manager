import React, { useEffect, useRef, useState } from 'react';
import { Bold, Italic, Underline, List, ListOrdered, Link2, Eraser } from 'lucide-react';

/** Plain-text length of the editor content (what the limit counts). */
export function plainTextLength(html) {
  if (!html) return 0;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').trim().length;
}

/**
 * Lightweight rich-text editor for the planner description — a contentEditable
 * surface with a Google-Calendar-style toolbar (bold / italic / underline /
 * bullet / numbered / link / clear). Emits HTML; the SERVER sanitizes it
 * (xss allowlist) on save, so no untrusted markup is ever persisted. No extra
 * dependency. Output is plain formatted HTML using the shared `.planner-rich`
 * styles (so it renders identically in the detail popover). Shows a live
 * character counter against `max` (counted on the visible text, not markup).
 */
export default function RichDescriptionEditor({ value, onChange, max = 3000, placeholder = 'Add a note about what you’ll do…' }) {
  const ref = useRef(null);
  const [len, setLen] = useState(() => plainTextLength(value));

  // Seed once; afterwards the DOM is the source of truth (avoids caret jumps).
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (value || '')) ref.current.innerHTML = value || '';
    setLen(plainTextLength(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = () => {
    const html = ref.current ? ref.current.innerHTML : '';
    setLen((ref.current?.textContent || '').trim().length);
    onChange(html);
  };

  function exec(cmd, arg) {
    document.execCommand(cmd, false, arg);
    ref.current?.focus();
    emit();
  }
  function addLink() {
    const url = window.prompt('Link URL (https://…):');
    if (url) exec('createLink', url);
  }

  const Btn = ({ onClick, title, children }) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()} /* keep selection */
      onClick={onClick}
      className="rounded p-1 text-text-secondary hover:bg-surface hover:text-text-primary"
    >
      {children}
    </button>
  );

  return (
    <div className="rounded-lg border border-border focus-within:border-primary">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
        <Btn onClick={() => exec('bold')} title="Bold"><Bold size={14} /></Btn>
        <Btn onClick={() => exec('italic')} title="Italic"><Italic size={14} /></Btn>
        <Btn onClick={() => exec('underline')} title="Underline"><Underline size={14} /></Btn>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <Btn onClick={() => exec('insertUnorderedList')} title="Bullet list"><List size={14} /></Btn>
        <Btn onClick={() => exec('insertOrderedList')} title="Numbered list"><ListOrdered size={14} /></Btn>
        <Btn onClick={addLink} title="Insert link"><Link2 size={14} /></Btn>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <Btn onClick={() => exec('removeFormat')} title="Clear formatting"><Eraser size={14} /></Btn>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Description"
        data-placeholder={placeholder}
        onInput={emit}
        className="planner-rich min-h-[96px] max-h-[220px] overflow-y-auto px-3 py-2 text-sm text-text-primary focus:outline-none"
      />
      <div className="flex justify-end border-t border-border px-2 py-1">
        <span className={`text-[10px] font-medium ${len > max ? 'text-danger' : 'text-text-tertiary'}`}>{len}/{max}</span>
      </div>
    </div>
  );
}
