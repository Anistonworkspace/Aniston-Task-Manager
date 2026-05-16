import React, { useEffect, forwardRef, useImperativeHandle } from 'react';
import { useEditor, EditorContent, BubbleMenu } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import {
  Bold as BoldIcon, Italic as ItalicIcon, List as ListIcon, ListOrdered,
  Heading1, Heading2, Quote, Code, Strikethrough, Undo2, Redo2,
} from 'lucide-react';
import { SlashCommand } from './SlashCommand';

// Helpers exposed so callers can convert between plain text and HTML
// without importing TipTap themselves.
export function htmlToPlainText(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').trim();
}

export function looksLikeHtml(s) {
  return typeof s === 'string' && /<[a-z][^>]*>/i.test(s);
}

// A small TipTap-based rich text editor. The parent owns the value (HTML
// string) and receives `onUpdate` whenever the user types. Speech-to-text
// callers can use the ref's `insertText(text)` method to append dictated
// chunks without clobbering existing formatting.
const RichTextEditor = forwardRef(function RichTextEditor(
  { value, onUpdate, placeholder = 'Type here…', disabled = false, minHeight = 220 },
  ref
) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // We want explicit toolbar buttons for these — no need to disable.
      }),
      Placeholder.configure({ placeholder }),
      // Slash command — type "/" to open a block-insertion menu (H1/H2/lists/
      // quote/code/divider). Pure client-side, no DB / network calls. The
      // popup is rendered into document.body via a portal so it can escape
      // the editor's overflow boundary cleanly.
      SlashCommand,
    ],
    content: looksLikeHtml(value) ? value : (value ? `<p>${escapeHtml(value)}</p>` : ''),
    editable: !disabled,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // TipTap emits "<p></p>" for an empty doc. Normalize that to ""
      // so the parent's "dirty"/"is content empty" checks behave like a
      // textarea would.
      const normalized = html === '<p></p>' ? '' : html;
      onUpdate?.(normalized);
    },
  });

  // Keep editor.editable in sync if `disabled` flips at runtime.
  useEffect(() => {
    if (editor && editor.isEditable !== !disabled) {
      editor.setEditable(!disabled);
    }
  }, [editor, disabled]);

  // Push external content changes (e.g. AI "Use This" replaces the body)
  // into the editor. We compare against editor.getHTML() to avoid loops —
  // the editor's own onUpdate already keeps the parent in sync, so we only
  // overwrite when the external value really diverges.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    const next = looksLikeHtml(value) ? value : (value ? `<p>${escapeHtml(value)}</p>` : '<p></p>');
    if (current !== next && value !== htmlToPlainText(current)) {
      editor.commands.setContent(next, false);
    }
  }, [value, editor]);

  useImperativeHandle(ref, () => ({
    // Used by speech-to-text: append a finalized transcript chunk to the
    // end of the document without disturbing the user's caret position
    // mid-document. We move the selection to the doc end first.
    insertText(text) {
      if (!editor || !text) return;
      editor
        .chain()
        .focus('end')
        .insertContent((editor.isEmpty ? '' : ' ') + text)
        .run();
    },
    focus() { editor?.commands.focus(); },
    isEmpty: () => !editor || editor.isEmpty,
    getHTML: () => editor?.getHTML() ?? '',
    getText: () => editor?.getText() ?? '',
  }), [editor]);

  if (!editor) return null;

  const btnBase = 'p-1.5 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const btnActive = 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400';

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden">
      <div className="flex items-center flex-wrap gap-0.5 px-2 py-1.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60">
        <ToolbarBtn title="Bold (Ctrl+B)" onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} disabled={disabled} className={btnBase} activeClass={btnActive}>
          <BoldIcon size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Italic (Ctrl+I)" onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} disabled={disabled} className={btnBase} activeClass={btnActive}>
          <ItalicIcon size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} disabled={disabled} className={btnBase} activeClass={btnActive}>
          <Strikethrough size={14} />
        </ToolbarBtn>
        <span className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1" />
        <ToolbarBtn title="Heading 1" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} disabled={disabled} className={btnBase} activeClass={btnActive}>
          <Heading1 size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Heading 2" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} disabled={disabled} className={btnBase} activeClass={btnActive}>
          <Heading2 size={14} />
        </ToolbarBtn>
        <span className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1" />
        <ToolbarBtn title="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} disabled={disabled} className={btnBase} activeClass={btnActive}>
          <ListIcon size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} disabled={disabled} className={btnBase} activeClass={btnActive}>
          <ListOrdered size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Quote" onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')} disabled={disabled} className={btnBase} activeClass={btnActive}>
          <Quote size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Code block" onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive('codeBlock')} disabled={disabled} className={btnBase} activeClass={btnActive}>
          <Code size={14} />
        </ToolbarBtn>
        <span className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1" />
        <ToolbarBtn title="Undo (Ctrl+Z)" onClick={() => editor.chain().focus().undo().run()} disabled={disabled || !editor.can().undo()} className={btnBase} activeClass={btnActive}>
          <Undo2 size={14} />
        </ToolbarBtn>
        <ToolbarBtn title="Redo (Ctrl+Y)" onClick={() => editor.chain().focus().redo().run()} disabled={disabled || !editor.can().redo()} className={btnBase} activeClass={btnActive}>
          <Redo2 size={14} />
        </ToolbarBtn>
      </div>
      {/* Contextual formatting toolbar — appears next to highlighted text
          so the user can bold/italic/strike/code without reaching for the
          top toolbar. Hidden when the selection is empty, inside a code
          block (formatting wouldn't apply), or while the editor is
          read-only. */}
      <BubbleMenu
        editor={editor}
        tippyOptions={{ duration: 100, placement: 'top' }}
        shouldShow={({ editor, from, to }) => {
          if (!editor.isEditable) return false;
          if (from === to) return false; // empty selection
          if (editor.isActive('codeBlock')) return false;
          return true;
        }}
        className="flex items-center gap-0.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-md shadow-lg px-1 py-1"
      >
        <BubbleBtn title="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
          <BoldIcon size={13} />
        </BubbleBtn>
        <BubbleBtn title="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <ItalicIcon size={13} />
        </BubbleBtn>
        <BubbleBtn title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
          <Strikethrough size={13} />
        </BubbleBtn>
        <BubbleBtn title="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
          <Code size={13} />
        </BubbleBtn>
      </BubbleMenu>
      <EditorContent
        editor={editor}
        className="rte-content px-3 py-3 text-sm text-gray-700 dark:text-gray-300 focus:outline-none"
        style={{ minHeight }}
      />
    </div>
  );
});

function BubbleBtn({ children, onClick, active, title }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={title}
      className={`p-1.5 rounded transition-colors ${
        active
          ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
          : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarBtn({ children, onClick, active, disabled, title, className, activeClass }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${className} ${active ? activeClass : ''}`}
    >
      {children}
    </button>
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default RichTextEditor;
