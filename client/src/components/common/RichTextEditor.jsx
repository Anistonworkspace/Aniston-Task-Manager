import React, { useEffect, forwardRef, useImperativeHandle, useMemo, useState } from 'react';
import { useEditor, EditorContent, BubbleMenu, ReactRenderer } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
// Phase G — opt-in real-time collaboration via Y.js + Hocuspocus.
// Loaded conditionally inside the `extensions` useMemo so callers that
// don't pass a `collab` prop never pull these into their schema (the
// extensions are inert without a YDoc and add nothing to the editor's
// runtime weight when absent).
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
// Doc Editor Phase D Slice 1 — @-mention extension. Opt-in via the
// `mentions` prop so the editor stays lean when callers don't use it
// (NotesPage, TaskModal description).
import Mention from '@tiptap/extension-mention';
import {
  Bold as BoldIcon, Italic as ItalicIcon, List as ListIcon, ListOrdered,
  Heading1, Heading2, Quote, Code, Strikethrough, Undo2, Redo2, Sparkles,
  MessageSquare as CommentIcon,
} from 'lucide-react';
import { SlashCommand, SLASH_TASK_LINK_ITEM, SLASH_MENTION_ITEM, SLASH_TABLE_ITEM } from './SlashCommand';
// Phase C — table block extensions. Always loaded (tables are universal),
// matches the buildXxxExtension factory pattern used by mentions / task
// chips below.
import { buildTableExtensions } from './TableExtensions';
import MentionPopover from './MentionPopover';
// Doc Editor Phase D Slice 2 — task-chip extension. Same opt-in pattern as
// mentions; the editor stays lean for callers that don't link tasks.
import { buildTaskChipExtension } from './TaskChipNode';
// Phase E — "AI" pill inside the selection bubble menu.
import BubbleAIMenu from './BubbleAIMenu';
// Phase F (polish) — opt-in Mark that highlights commented text ranges.
import { buildCommentMarkExtension } from './CommentMark';

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
  {
    value, onUpdate,
    placeholder = 'Type here…',
    disabled = false,
    minHeight = 220,
    // Phase D Slice 1 — opt-in mention support.
    //   mentions = { suggest: async (q) => [{ id, name, email, avatar }] }
    // Pass nothing → mention extension is not loaded. Passing the prop
    // installs the Tiptap mention extension wired to the consumer-supplied
    // search function and renders MentionPopover via ReactRenderer.
    mentions = null,
    // Phase D Slice 2 — opt-in task-chip support.
    //   tasks = {
    //     suggest: async (q) => [{ id, title, status, boardId, boardName, boardColor, priority, dueDate }]
    //     onInsert?: (task) => void   // fired after the chip is inserted
    //   }
    // Same lifecycle as `mentions`: omit → extension not loaded.
    tasks = null,
    // Slice 2c — `bordered={false}` strips the outer border / rounded box
    // / background so the editor blends into its host page. DocPage uses
    // this for a clean Notion-style writing surface. NotesPage and
    // TaskModal keep the default bordered look.
    bordered = true,
    // Phase E — opt-in inline AI on selection. When wired, the bubble
    // menu gains an "AI" pill that opens BubbleAIMenu over the selection.
    //   ai = { onTransform: async ({ mode, text }) => ({ output }) }
    // Omit to hide the AI affordance entirely.
    ai = null,
    // Phase F — opt-in comments. When wired, the bubble menu gains a
    // "💬 Comment" pill. Clicking it captures the live selection (text +
    // ProseMirror range) and hands it to the parent so the comments
    // sidebar can pre-fill the composer's pendingAnchor.
    //   comments = { onStartComment: ({ text, from, to }) => void }
    // Omit to hide the comment affordance entirely.
    comments = null,
    // Phase G — opt-in real-time collaboration. When wired, the editor
    // mounts the Tiptap Collaboration + CollaborationCursor extensions
    // and lets Y.js own the document content (no `value` round-tripping,
    // no `setContent` syncs).
    //   collab = {
    //     ydoc,          // Y.Doc instance owned by useDocCollab
    //     provider,      // HocuspocusProvider — drives awareness
    //     currentUser,   // { name, color } for the user's caret label
    //   }
    // Omit (or pass null) to keep the editor in single-user mode.
    collab = null,
    // Phase H polish (image drag-paste) — opt-in image upload.
    //   images = { uploadFn: async (file) => ({ url }), onError?, maxBytes? }
    // When images.uploadFn is set, buildImageExtension mounts a
    // ProseMirror plugin that intercepts paste / drop, uploads the file
    // via uploadFn, inserts a placeholder, then replaces it with the
    // resolved <img>. Omit to skip the image extension entirely.
    images = null,
  },
  ref
) {
  // Phase E — local UI state for the AI bubble dropdown (anchored to the
  // current selection rectangle).
  const [aiMenu, setAiMenu] = useState(null); // { left, top, text } | null
  // Memoize the extension list so changing `mentions` / `tasks` doesn't
  // recreate the editor on every parent render. Tiptap re-uses its editor
  // instance when the extensions reference is stable.
  const extensions = useMemo(() => {
    // Phase D Slice 2c — when the caller wired up mentions / tasks, add
    // discoverability items to the slash menu. Users who don't know
    // about the `@` / `+` trigger chars can find the same flows via
    // `/mention` / `/task`.
    const slashExtras = [];
    if (tasks && typeof tasks.suggest === 'function') slashExtras.push(SLASH_TASK_LINK_ITEM);
    if (mentions && typeof mentions.suggest === 'function') slashExtras.push(SLASH_MENTION_ITEM);
    // Phase C — tables are universal; always offer the slash item.
    slashExtras.push(SLASH_TABLE_ITEM);

    // Phase G — when collab is on, Y.js's CRDT owns history. Tiptap's
    // StarterKit ships ProseMirror history by default, which conflicts
    // with y-prosemirror (each side rewinds independently → split-brain
    // doc). Disable StarterKit's history; the Collaboration extension
    // wires Ctrl-Z / Ctrl-Y to y-undo under the hood.
    const list = [
      collab ? StarterKit.configure({ history: false }) : StarterKit.configure({}),
      ...buildTableExtensions(),
      Placeholder.configure({ placeholder }),
      SlashCommand.configure({ extraItems: slashExtras }),
    ];
    if (mentions && typeof mentions.suggest === 'function') {
      list.push(buildMentionExtension(mentions.suggest));
    }
    if (tasks && typeof tasks.suggest === 'function') {
      list.push(buildTaskChipExtension({
        suggest: tasks.suggest,
        onInsert: tasks.onInsert,
        onCreateNew: tasks.onCreateNew,
      }));
    }
    // Phase F polish — when the caller wires `comments.markedRanges`,
    // load the CommentMark extension so the live editor knows about the
    // mark schema. Applying the marks at the right positions happens in
    // a separate effect below (we wait for the editor instance to exist).
    if (comments && Array.isArray(comments.markedRanges)) {
      list.push(buildCommentMarkExtension());
    }
    // Phase G — Collaboration + CollaborationCursor. Order matters
    // only loosely (Tiptap merges schemas), but we push these last so
    // they layer on top of mark/node extensions defined above.
    if (collab && collab.ydoc) {
      list.push(Collaboration.configure({ document: collab.ydoc }));
      if (collab.provider) {
        list.push(CollaborationCursor.configure({
          provider: collab.provider,
          user: collab.currentUser || { name: 'Anonymous', color: '#3b82f6' },
        }));
      }
    }
    // Phase H polish — image drag-paste with upload. Only mounted when
    // the caller supplies `images.uploadFn`; the renderer-only fallback
    // (no upload, just renders <img>) is implicit in buildImageExtension's
    // default behavior so saved docs with images always display.
    if (images && typeof images.uploadFn === 'function') {
      list.push(buildImageExtension({
        uploadFn: images.uploadFn,
        onError: images.onError,
        maxBytes: images.maxBytes,
      }));
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placeholder, !!mentions, !!tasks, !!(comments && comments.markedRanges), collab?.ydoc, collab?.provider, !!(images && images.uploadFn)]);

  const editor = useEditor({
    extensions,
    // Phase G — when collab is on, Y.js owns the content. Passing an
    // initial `content` would inject local HTML into the CRDT on mount
    // and racemingle with the server's authoritative state, producing
    // duplicated paragraphs the first time a peer types. The
    // Collaboration extension fills the doc from the YDoc instead.
    content: collab
      ? undefined
      : (looksLikeHtml(value) ? value : (value ? `<p>${escapeHtml(value)}</p>` : '')),
    editable: !disabled,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      // TipTap emits "<p></p>" for an empty doc. Normalize that to ""
      // so the parent's "dirty"/"is content empty" checks behave like a
      // textarea would.
      const normalized = html === '<p></p>' ? '' : html;
      // Pass the live editor's JSON as a second arg so callers like
      // DocPage can persist the lossless Tiptap document directly without
      // re-parsing HTML through a temp editor (which would strip any
      // custom node types they didn't register — e.g. mentions, task
      // chips). NotesPage / TaskModal callers that only use the HTML
      // continue to work because they ignore the second arg.
      let json = null;
      try { json = editor.getJSON(); } catch { json = null; }
      onUpdate?.(normalized, json);
    },
  });

  // Keep editor.editable in sync if `disabled` flips at runtime.
  useEffect(() => {
    if (editor && editor.isEditable !== !disabled) {
      editor.setEditable(!disabled);
    }
  }, [editor, disabled]);

  // Phase F polish — re-apply comment marks whenever the parent supplies
  // a new set of `comments.markedRanges`. Anchor positions on the server
  // (anchorFrom/anchorTo) drift as users edit; we trust the `anchorText`
  // snapshot and search the live doc for it instead. First occurrence
  // wins per range (good enough for v1; multiple-instance support is
  // Phase-F-v2 alongside multiple-comments-per-mark).
  useEffect(() => {
    if (!editor || !comments || !Array.isArray(comments.markedRanges)) return;
    const commentMark = editor.schema.marks.comment;
    if (!commentMark) return;
    // Defer one tick so any pending content updates flush first.
    const handle = setTimeout(() => {
      let tr = editor.state.tr;
      // Clear all existing comment marks across the doc, then re-apply.
      tr = tr.removeMark(0, editor.state.doc.content.size, commentMark);
      const plain = editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
      let dirty = false;
      for (const range of comments.markedRanges) {
        const id = range?.commentId || range?.id;
        const text = String(range?.anchorText || '').trim();
        if (!id || !text) continue;
        const idx = plain.indexOf(text);
        if (idx < 0) continue;
        // Map plain-text indices back to ProseMirror positions. Walk the
        // doc, accumulating textBetween-equivalent offsets, and emit
        // start/end positions for the hit.
        const { from, to } = mapPlainRangeToDocPositions(editor.state.doc, idx, idx + text.length);
        if (from == null || to == null) continue;
        tr = tr.addMark(from, to, commentMark.create({ commentId: id }));
        dirty = true;
      }
      if (dirty) {
        tr.setMeta('addToHistory', false);
        editor.view.dispatch(tr);
      }
    }, 0);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, comments?.markedRanges]);

  // Push external content changes (e.g. AI "Use This" replaces the body)
  // into the editor. We compare against editor.getHTML() to avoid loops —
  // the editor's own onUpdate already keeps the parent in sync, so we only
  // overwrite when the external value really diverges.
  //
  // Phase G — when collab is on, Y.js owns content sync. Calling
  // setContent here would dispatch a transaction that the y-prosemirror
  // binding then forwards to every peer as if the user typed it,
  // causing content to duplicate or clobber across tabs. Skip entirely.
  useEffect(() => {
    if (!editor) return;
    if (collab) return;
    const current = editor.getHTML();
    const next = looksLikeHtml(value) ? value : (value ? `<p>${escapeHtml(value)}</p>` : '<p></p>');
    if (current !== next && value !== htmlToPlainText(current)) {
      editor.commands.setContent(next, false);
    }
  }, [value, editor, collab]);

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
    getJSON: () => editor?.getJSON() ?? { type: 'doc', content: [] },
    // Phase D Slice 2b — escape hatch for callers that need to dispatch
    // a ProseMirror transaction directly (e.g. live chip-status patching
    // from a socket event). Internal-use only; prefer the named methods.
    getEditor: () => editor || null,
  }), [editor]);

  if (!editor) return null;

  const btnBase = 'p-1.5 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const btnActive = 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400';

  return (
    <div
      className={
        bordered
          ? 'border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden'
          : 'bg-transparent'
      }
    >
      <div
        className={
          bordered
            ? 'flex items-center flex-wrap gap-0.5 px-2 py-1.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/60'
            : 'flex items-center flex-wrap gap-0.5 px-0 py-1 mb-2 border-b border-gray-200/60 dark:border-gray-700/40'
        }
      >
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
        {ai && typeof ai.onTransform === 'function' && (
          <>
            <span className="w-px h-4 bg-zinc-200 dark:bg-zinc-700 mx-1" />
            <BubbleBtn
              title="AI actions"
              onClick={() => {
                // Anchor the BubbleAIMenu to the live selection's
                // viewport rect so it lines up regardless of where in
                // the doc the user is. We render the menu as a fixed
                // overlay; tippy/portal lifecycles are tricky inside
                // BubbleMenu so we handle our own positioning.
                const sel = editor.state.selection;
                const view = editor.view;
                if (!view || sel.empty) return;
                const start = view.coordsAtPos(sel.from);
                const end = view.coordsAtPos(sel.to);
                setAiMenu({
                  text: editor.state.doc.textBetween(sel.from, sel.to, '\n'),
                  from: sel.from,
                  to: sel.to,
                  left: Math.min(start.left, end.left),
                  top: end.bottom + 6,
                });
              }}
            >
              <Sparkles size={13} className="text-violet-500" />
              <span className="ml-1 text-[11px] font-semibold text-violet-600 dark:text-violet-300">AI</span>
            </BubbleBtn>
          </>
        )}
        {comments && typeof comments.onStartComment === 'function' && (
          <>
            <span className="w-px h-4 bg-zinc-200 dark:bg-zinc-700 mx-1" />
            <BubbleBtn
              title="Comment on selection"
              onClick={() => {
                // Snapshot the selection text + range and hand it to
                // the parent. Parent opens the comments sidebar with
                // this as `pendingAnchor`. Editor selection stays intact
                // so the user can keep typing if they cancel the
                // composer.
                const sel = editor.state.selection;
                if (sel.empty) return;
                comments.onStartComment({
                  text: editor.state.doc.textBetween(sel.from, sel.to, '\n'),
                  from: sel.from,
                  to: sel.to,
                });
              }}
            >
              <CommentIcon size={13} className="text-amber-500" />
              <span className="ml-1 text-[11px] font-semibold text-amber-600 dark:text-amber-300">Comment</span>
            </BubbleBtn>
          </>
        )}
      </BubbleMenu>
      {/* Phase E — the AI action menu floats over the page once the user
          clicks the bubble's AI pill. Rendered alongside (not inside) the
          BubbleMenu because the BubbleMenu reflows on every selection
          change and would unmount our popover mid-interaction. */}
      {aiMenu && ai && typeof ai.onTransform === 'function' && (
        <>
          <div className="fixed inset-0 z-[9998]" onMouseDown={() => setAiMenu(null)} />
          <div
            className="fixed z-[9999]"
            style={{ left: aiMenu.left, top: aiMenu.top }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <BubbleAIMenu
              selectedText={aiMenu.text}
              onTransform={({ mode, text }) => ai.onTransform({ mode, text })}
              onReplace={(output) => {
                if (!editor) return;
                const isContinue = output && aiMenu.from === aiMenu.to;
                if (isContinue) {
                  // No selection (continue from cursor): insert + a space.
                  editor.chain().focus().insertContent(output).run();
                } else {
                  // Replace the original selection in-place.
                  editor.chain()
                    .focus()
                    .insertContentAt({ from: aiMenu.from, to: aiMenu.to }, output)
                    .run();
                }
              }}
              onClose={() => setAiMenu(null)}
            />
          </div>
        </>
      )}
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

/**
 * Phase F polish — translate plain-text offsets (as you'd see them in
 * `doc.textBetween(0, end, '\n')`) into the ProseMirror positions that
 * `tr.addMark(from, to, mark)` expects. Walks `doc.descendants`, summing
 * up text-node lengths, and emits the cumulative ProseMirror positions
 * at the requested boundaries.
 *
 * Returns `{from, to}` of ProseMirror positions, or `{from: null, to: null}`
 * if either boundary couldn't be located (e.g. the range slipped past
 * the end of the doc).
 */
function mapPlainRangeToDocPositions(doc, plainFrom, plainTo) {
  let cursor = 0;
  let from = null;
  let to = null;
  doc.descendants((node, pos) => {
    if (from != null && to != null) return false;
    if (node.isText) {
      const len = node.text?.length || 0;
      const nodeStart = cursor;
      const nodeEnd = cursor + len;
      if (from == null && plainFrom >= nodeStart && plainFrom <= nodeEnd) {
        from = pos + (plainFrom - nodeStart);
      }
      if (to == null && plainTo >= nodeStart && plainTo <= nodeEnd) {
        to = pos + (plainTo - nodeStart);
      }
      cursor = nodeEnd;
    } else if (node.isBlock && cursor > 0 && node.isTextblock) {
      // textBetween uses '\n' between block nodes — bump the plain-text
      // cursor to keep parity.
      cursor += 1;
    }
    return true;
  });
  return { from, to };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Phase D Slice 1 — wrap the official @tiptap/extension-mention with our
 * MentionPopover render contract. `suggestFn(query)` is supplied by the
 * caller and should return a Promise of `[{ id, name, email, avatar }]`
 * matching the popover's data shape. The mention node renders as a
 * styled <span class="mention" data-id="…" data-label="…"> in HTML.
 *
 * Output JSON shape:
 *   { type: 'mention', attrs: { id: '<uuid>', label: '<name at mention time>' } }
 *
 * The backend's extractMentions helper looks for exactly this shape.
 */
function buildMentionExtension(suggestFn) {
  return Mention.configure({
    HTMLAttributes: {
      class: 'mention px-1 py-0.5 rounded text-[#0073ea] bg-[#0073ea]/10 text-sm font-medium',
    },
    renderText({ node }) {
      return `@${node.attrs.label || node.attrs.id || 'mention'}`;
    },
    suggestion: {
      char: '@',
      // The Suggestion plugin invokes `items` on every keystroke after `@`.
      // Returning a promise keeps the API contract simple (the popover
      // re-renders once items resolves).
      items: async ({ query }) => {
        try {
          const result = await suggestFn(query || '');
          return Array.isArray(result) ? result : [];
        } catch {
          return [];
        }
      },
      command: ({ editor, range, props }) => {
        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: 'mention',
              attrs: { id: props.id, label: props.name || props.label || props.id },
            },
            { type: 'text', text: ' ' },
          ])
          .run();
      },
      render: () => {
        let component;
        return {
          onStart: (props) => {
            component = new ReactRenderer(MentionPopover, {
              props: {
                items: props.items,
                loading: false,
                rect: props.clientRect ? props.clientRect() : null,
                command: (item) => props.command({ ...item }),
              },
              editor: props.editor,
            });
            document.body.appendChild(component.element);
          },
          onUpdate: (props) => {
            component?.updateProps({
              items: props.items,
              loading: false,
              rect: props.clientRect ? props.clientRect() : null,
              command: (item) => props.command({ ...item }),
            });
          },
          onKeyDown: (props) => {
            if (props.event.key === 'Escape') {
              if (component?.element?.parentNode) component.element.parentNode.removeChild(component.element);
              component?.destroy();
              component = null;
              return true;
            }
            return component?.ref?.onKeyDown(props) || false;
          },
          onExit: () => {
            if (component?.element?.parentNode) {
              component.element.parentNode.removeChild(component.element);
            }
            component?.destroy();
            component = null;
          },
        };
      },
    },
  });
}

/**
 * Phase H — opt-in image extension. Same `buildXxxExtension` factory pattern
 * as `buildMentionExtension` / `buildTaskChipExtension` so the parent
 * editor can mount it conditionally without bloating callers that don't
 * need image rendering.
 *
 * Why a hand-written Node instead of `@tiptap/extension-image`?
 *   The official package isn't in `client/package.json` and we'd rather
 *   not pull a new dependency for what is — at this slice — a thin
 *   schema declaration. The minimal Node below covers the round-trip
 *   shape we need (parse `<img>` → render `<img>` with src/alt/title),
 *   so Tiptap can persist + restore images stored inside `contentJson`.
 *
 * Phase H-v2 (drag-paste upload) — when the caller supplies `uploadFn`,
 * the factory installs an `addProseMirrorPlugins()` block that intercepts
 * `handlePaste` and `handleDrop` on the editor view, uploads any image
 * files it finds, and replaces a temporary placeholder Node with the
 * resolved `<img>` once the upload settles. When `uploadFn` is omitted
 * the factory falls back to the original renderer-only behavior so
 * existing callers (NotesPage / TaskModal) continue to work without
 * picking up the plugin.
 *
 * Output JSON shape:
 *   { type: 'image', attrs: { src, alt, title } }
 *   Placeholder during upload:
 *   { type: 'image', attrs: { src: null, alt: 'loading…',
 *                             title: '__uploading__:<id>' } }
 */
import { Node as TiptapNode, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from 'prosemirror-state';

// MIME types we will attempt to upload. Anything else (SVG, BMP, HEIC,
// PDFs dragged in as "image/*", etc.) is rejected client-side with a
// toast via `onError` so the user understands why nothing happened.
export const ALLOWED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

// Default 25 MB — mirrors the server's MAX_FILE_SIZE default. Override
// per-caller via `buildImageExtension({ maxBytes })`.
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

// Marker we stamp on the placeholder Node so the success/failure handler
// can locate the right placeholder later (the user may have continued
// typing or pasted a second image in the meantime, so position math
// alone isn't enough).
const UPLOAD_PLACEHOLDER_TITLE_PREFIX = '__uploading__:';

const ImageNode = TiptapNode.create({
  name: 'image',
  group: 'block',
  inline: false,
  atom: true,
  draggable: true,

  addOptions() {
    return {
      // Caller-supplied async (file: File) => Promise<{ url }> upload
      // helper. When set, the paste/drop plugin below activates. When
      // null, the factory falls back to renderer-only behavior.
      uploadFn: null,
      // Caller-supplied (err, file) => void notifier. Phase H-v2 wires
      // this to DocPage's toast layer. Swallowed silently when omitted
      // so misconfigured callers never throw unhandled rejections.
      onError: null,
      // Per-caller size cap. 25 MB default.
      maxBytes: DEFAULT_MAX_BYTES,
      HTMLAttributes: { class: 'rte-image' },
    };
  },

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => el.getAttribute('src'),
        renderHTML: (attrs) => (attrs.src ? { src: attrs.src } : {}),
      },
      alt: {
        default: null,
        parseHTML: (el) => el.getAttribute('alt'),
        renderHTML: (attrs) => (attrs.alt ? { alt: attrs.alt } : {}),
      },
      title: {
        default: null,
        parseHTML: (el) => el.getAttribute('title'),
        renderHTML: (attrs) => (attrs.title ? { title: attrs.title } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'img[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
  },

  addProseMirrorPlugins() {
    // Renderer-only mode: callers that don't pass an `uploadFn` keep the
    // pre-Phase-H-v2 behavior — no plugin, no event interception. This
    // is the backward-compat path NotesPage / TaskModal already rely on.
    const uploadFn = this.options.uploadFn;
    if (typeof uploadFn !== 'function') return [];

    return [buildImageDropPastePlugin({
      uploadFn,
      onError: typeof this.options.onError === 'function' ? this.options.onError : () => {},
      maxBytes: Number.isFinite(this.options.maxBytes) ? this.options.maxBytes : DEFAULT_MAX_BYTES,
    })];
  },
});

/**
 * Build the ProseMirror Plugin that intercepts paste / drop events and
 * routes any image File payload through `uploadFn`. Exported so the test
 * suite can exercise the plugin's `handlePaste` / `handleDrop` directly
 * without spinning up a full Tiptap editor (which depends on jsdom
 * primitives that don't cleanly model drag-drop coordinates). Production
 * callers should NEVER import this directly — use `buildImageExtension`,
 * which wires it into the Image Node's `addProseMirrorPlugins`.
 */
export function buildImageDropPastePlugin({ uploadFn, onError = () => {}, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof uploadFn !== 'function') {
    throw new Error('buildImageDropPastePlugin: uploadFn is required');
  }
  return new Plugin({
    key: new PluginKey('rteImageDropPaste'),
    props: {
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (!items || !items.length) return false;
        const files = [];
        for (let i = 0; i < items.length; i += 1) {
          const it = items[i];
          if (it && it.kind === 'file') {
            const f = typeof it.getAsFile === 'function' ? it.getAsFile() : null;
            if (f) files.push(f);
          }
        }
        const imageFiles = files.filter((f) => f && f.type && f.type.startsWith('image/'));
        if (imageFiles.length === 0) return false;

        event.preventDefault?.();
        const pos = view.state.selection.from;
        imageFiles.forEach((file) => {
          handleImageUpload({ view, file, pos, uploadFn, onError, maxBytes });
        });
        return true;
      },

      handleDrop: (view, event) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        const imageFiles = [];
        for (let i = 0; i < files.length; i += 1) {
          const f = files[i];
          if (f && f.type && f.type.startsWith('image/')) imageFiles.push(f);
        }
        if (imageFiles.length === 0) return false;

        event.preventDefault?.();
        // Resolve the drop coordinates to a doc position. Fall back to
        // the current selection if posAtCoords can't pin it down (e.g.
        // dropped on a padding region jsdom doesn't model).
        let pos = view.state.selection.from;
        try {
          const coords = typeof view.posAtCoords === 'function'
            ? view.posAtCoords({ left: event.clientX, top: event.clientY })
            : null;
          if (coords && Number.isFinite(coords.pos)) pos = coords.pos;
        } catch { /* keep fallback pos */ }
        imageFiles.forEach((file) => {
          handleImageUpload({ view, file, pos, uploadFn, onError, maxBytes });
        });
        return true;
      },
    },
  });
}

/**
 * Insert a placeholder Image node at `pos`, kick off the upload, then
 * either swap the placeholder for the resolved `<img>` Node or remove
 * the placeholder and notify the caller via `onError`. Centralised here
 * so both paste and drop paths share identical lifecycle handling.
 */
async function handleImageUpload({ view, file, pos, uploadFn, onError, maxBytes }) {
  // Client-side guards. We reject loudly here rather than letting the
  // server return 400/413, because the server response time is wasted
  // when we already know the upload will fail.
  if (file.size > maxBytes) {
    const mb = Math.round(maxBytes / (1024 * 1024));
    onError(new Error(`Image is too large (max ${mb} MB).`), file);
    return;
  }
  if (!ALLOWED_IMAGE_MIME.has(file.type)) {
    onError(new Error(`Unsupported image type: ${file.type || 'unknown'}.`), file);
    return;
  }

  const placeholderId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const placeholderTitle = `${UPLOAD_PLACEHOLDER_TITLE_PREFIX}${placeholderId}`;
  const imageType = view.state.schema.nodes.image;
  if (!imageType) {
    // No Image node in the schema (shouldn't happen — we installed it
    // above — but be defensive: a future schema change could move it).
    onError(new Error('Image node is not registered in the editor schema.'), file);
    return;
  }

  // Insert placeholder. We use a Node attribute (`title`) as the
  // identifying marker rather than ProseMirror Decorations because
  // Decorations would not survive a `doc.descendants` re-scan when the
  // user has typed between the placeholder and the upload completion.
  const placeholderNode = imageType.create({
    src: null,
    alt: 'loading…',
    title: placeholderTitle,
  });
  try {
    const tr = view.state.tr.insert(pos, placeholderNode);
    view.dispatch(tr);
  } catch (err) {
    // Rare — would only fire if the position has been deleted between
    // the event firing and dispatch (e.g. another concurrent transaction
    // collapsed the doc). Surface to caller and bail.
    onError(err, file);
    return;
  }

  let result;
  try {
    result = await uploadFn(file);
  } catch (err) {
    removePlaceholder(view, placeholderTitle);
    onError(err, file);
    return;
  }

  const url = result && (result.url || (result.file && result.file.url));
  if (!url) {
    removePlaceholder(view, placeholderTitle);
    onError(new Error('Upload completed but no URL was returned.'), file);
    return;
  }

  // Find the placeholder by walking the doc. We can't trust the original
  // `pos` because the user may have edited above it during the upload.
  const placement = findNodeByTitle(view.state.doc, placeholderTitle);
  if (!placement) {
    // Placeholder was deleted (user undid the paste or removed the
    // node mid-upload). Treat as success-but-no-op — the user clearly
    // doesn't want this image anymore.
    return;
  }
  try {
    const finalNode = imageType.create({
      src: url,
      alt: file.name || null,
      title: null,
    });
    const tr = view.state.tr.replaceWith(placement.from, placement.to, finalNode);
    view.dispatch(tr);
  } catch (err) {
    removePlaceholder(view, placeholderTitle);
    onError(err, file);
  }
}

function removePlaceholder(view, placeholderTitle) {
  try {
    const placement = findNodeByTitle(view.state.doc, placeholderTitle);
    if (!placement) return;
    const tr = view.state.tr.delete(placement.from, placement.to);
    view.dispatch(tr);
  } catch {
    /* best-effort — placeholder leakage is preferable to a thrown error */
  }
}

function findNodeByTitle(doc, title) {
  let hit = null;
  doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.type?.name === 'image' && node.attrs?.title === title) {
      hit = { from: pos, to: pos + node.nodeSize };
      return false;
    }
    return true;
  });
  return hit;
}

export function buildImageExtension({ uploadFn, onError, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return ImageNode.configure({
    uploadFn: typeof uploadFn === 'function' ? uploadFn : null,
    onError: typeof onError === 'function' ? onError : null,
    maxBytes: Number.isFinite(maxBytes) ? maxBytes : DEFAULT_MAX_BYTES,
    HTMLAttributes: { class: 'rte-image' },
  });
}

export default RichTextEditor;
