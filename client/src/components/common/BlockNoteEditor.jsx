import React, { useEffect, useImperativeHandle, forwardRef, useMemo, useRef, useState } from 'react';
import {
  useCreateBlockNote,
  createReactInlineContentSpec,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
} from '@blocknote/react';
import { BlockNoteSchema, defaultInlineContentSpecs, filterSuggestionItems } from '@blocknote/core';
import { BlockNoteView } from '@blocknote/mantine';

// CSS — top-level side-effect imports so Vite bundles the styles into the
// lazy-loaded BlockNoteEditor chunk.
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';

/**
 * BlockNoteEditor — Notion-style editor wrapper for personal docs
 * (feat/docs-personal-notion Phase 6 + Phase 7).
 *
 * Props:
 *   value         — BlockNote document (Block[]) or null/undefined for empty.
 *                   Consumed on FIRST mount only; subsequent updates flow
 *                   through `onChange`.
 *   onChange(blocks) — fired on every edit with the current Block[].
 *   placeholder   — single string shown in the first empty block.
 *   disabled      — read-only mode (archived docs, view-only collaborators).
 *   minHeight     — px height of the editor surface; defaults to 500.
 *   mentions      — Phase 7. Optional `{ suggest: async (q) => User[] }`.
 *                   When present, typing `@` opens a picker; selecting a
 *                   user inserts a `mention` inline content node whose
 *                   props carry the user's UUID. The doc-save path then
 *                   creates a DocMention row + doc_access grant (Phase 5).
 *
 * Imperative ref methods:
 *   getDocument() → current Block[]
 *   focus()       → move focus into the editor
 *   getEditor()   → underlying BlockNote editor instance
 */

// Phase 7 — custom inline content spec for @-mentions. The Block[] this
// editor emits will carry nodes like:
//   { type: 'mention', props: { userId: '<uuid>', label: 'Sara' }, content: 'none' }
// Server-side `extractMentions` walks these (alongside the Tiptap shape)
// and the existing Phase 5 sync wires up DocMention + doc_access.
const MentionInline = createReactInlineContentSpec(
  {
    type: 'mention',
    propSchema: {
      userId: { default: '' },
      label: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => (
      <span
        className="bn-mention"
        data-user-id={props.inlineContent.props.userId}
        style={{
          backgroundColor: 'rgba(0, 115, 234, 0.10)',
          color: '#0073ea',
          padding: '1px 4px',
          borderRadius: 4,
          fontWeight: 500,
        }}
      >
        @{props.inlineContent.props.label || 'user'}
      </span>
    ),
  }
);

// Schema with our custom mention inline content layered on top of the
// defaults. Created once at module load so the editor's React tree stays
// stable across re-renders.
const schemaWithMentions = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: MentionInline,
  },
});

// Sentinel for the initialContent ref so a normalized `undefined` doesn't
// keep re-evaluating on every render. Distinct from `undefined` so we can
// tell "not yet computed" from "computed and the result was undefined".
const SENTINEL = {};

const BlockNoteEditor = forwardRef(function BlockNoteEditor({
  value,
  onChange,
  placeholder = 'Start writing… type / for blocks.',
  disabled = false,
  minHeight = 500,
  mentions = null,
}, ref) {
  // First-render-only initial content snapshot. Re-renders with a different
  // `value` do NOT re-seed the editor — that path is reserved for explicit
  // restoreVersion / migrate-from-tiptap flows that remount with a fresh key.
  // We use a sentinel object (not `undefined`) so a legitimate `undefined`
  // normalize result doesn't keep re-running every render.
  const initialContentRef = useRef(SENTINEL);
  if (initialContentRef.current === SENTINEL) {
    const normalized = normalizeInitialContent(value);
    initialContentRef.current = normalized;
    if (import.meta?.env?.DEV && normalized === undefined && value != null) {
      // eslint-disable-next-line no-console
      console.warn(
        '[BlockNoteEditor] received non-BlockNote content shape; seeding empty editor.',
        { receivedType: Array.isArray(value) ? 'array' : typeof value, length: Array.isArray(value) ? value.length : undefined },
      );
    }
  }

  const editor = useCreateBlockNote({
    schema: schemaWithMentions,
    initialContent: initialContentRef.current,
  });

  // Wire onChange. BlockNote's editor.onChange returns an unsubscribe.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => {
    if (!editor) return undefined;
    return editor.onChange(() => {
      try {
        const blocks = editor.document;
        onChangeRef.current?.(blocks);
      } catch (_) { /* swallow — editor unmounting */ }
    });
  }, [editor]);

  // Keep the latest mentions.suggest callback in a ref so SuggestionMenuController's
  // getItems can call the current handler without remounting the menu on every render.
  const mentionsRef = useRef(mentions);
  useEffect(() => { mentionsRef.current = mentions; }, [mentions]);

  // Phase 7 — mention picker. SuggestionMenuController triggers on `@`,
  // calls getItems(query) on every keystroke, and renders the result list
  // as a popover. On select, we insertInlineContent with the mention shape
  // + a trailing space so the user can keep typing immediately.
  const getMentionItems = useMemo(() => async (query) => {
    const suggest = mentionsRef.current?.suggest;
    if (typeof suggest !== 'function') return [];
    let users = [];
    try {
      users = await suggest(query || '');
    } catch (_) { return []; }
    return (Array.isArray(users) ? users : []).map((u) => ({
      title: u.name || u.email || 'User',
      subtext: u.email,
      onItemClick: () => {
        try {
          editor?.insertInlineContent([
            {
              type: 'mention',
              props: { userId: u.id, label: u.name || u.email || 'User' },
            },
            ' ',
          ]);
        } catch (_) { /* editor gone */ }
      },
    }));
  }, [editor]);

  useImperativeHandle(ref, () => ({
    getDocument: () => editor?.document || [],
    focus: () => {
      try { editor?.focus(); } catch (_) { /* not mounted */ }
    },
    getEditor: () => editor,
  }), [editor]);

  // June 2026 — custom slash ('/') menu so we can drop the entire "Media"
  // section (Image / Video / Audio / File). We render our own
  // SuggestionMenuController for '/' and disable BlockNote's built-in slash
  // menu via `slashMenu={false}` on BlockNoteView below. Media items are
  // matched by group ('Media') AND title as a locale-robust fallback.
  const MEDIA_TITLES = useMemo(() => new Set(['Image', 'Video', 'Audio', 'File']), []);
  const getSlashItems = useMemo(() => async (query) => {
    const items = getDefaultReactSlashMenuItems(editor).filter(
      (item) => item.group !== 'Media' && !MEDIA_TITLES.has(item.title),
    );
    return filterSuggestionItems(items, query);
  }, [editor, MEDIA_TITLES]);

  const wrapperStyle = useMemo(() => ({ minHeight: `${minHeight}px` }), [minHeight]);

  // Follow the host app's dark-mode toggle. The ThemeContext adds `.dark`
  // to <html> on dark mode; we mirror that to BlockNote's `theme` prop so
  // the Mantine layer doesn't keep painting a white surface on top of the
  // app's dark canvas. Listening to a MutationObserver on documentElement.class
  // also picks up theme flips made outside React (system-pref sync).
  const [bnTheme, setBnTheme] = useState(() => (
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
      ? 'dark' : 'light'
  ));
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    const sync = () => setBnTheme(root.classList.contains('dark') ? 'dark' : 'light');
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  if (!editor) return null;

  return (
    <div className="blocknote-wrapper" style={wrapperStyle}>
      <BlockNoteView
        editor={editor}
        editable={!disabled}
        theme={bnTheme}
        // Disable the built-in slash menu so our custom controller below can
        // own '/' and drop the Media section. (The '@' trigger has no
        // built-in menu, so the mention controller just adds one.)
        slashMenu={false}
      >
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={getSlashItems}
        />
        {mentions && (
          <SuggestionMenuController
            triggerCharacter="@"
            getItems={async (query) => filterSuggestionItems(await getMentionItems(query), query)}
          />
        )}
      </BlockNoteView>
      {placeholder && (
        <style>{`
          .blocknote-wrapper .bn-block-content[data-content-type="paragraph"]:empty::before,
          .blocknote-wrapper .bn-block-content[data-content-type="paragraph"] > [data-node-view-content]:empty::before {
            content: ${JSON.stringify(placeholder)};
            color: var(--text-tertiary, #9ca3af);
            pointer-events: none;
            position: absolute;
          }
        `}</style>
      )}
    </div>
  );
});

// Defensive normalizer for the `value` prop. BlockNote v0.51 requires
// initialContent to be either `undefined` (it then seeds a single empty
// paragraph internally) or a non-empty array of Block-shaped objects.
// Anything else (null, Tiptap envelope, array of primitives, malformed
// payload from a buggy importer) is coerced to `undefined` so the editor
// always mounts with a valid document instead of crashing the page.
export function normalizeInitialContent(value) {
  if (value == null) return undefined;
  if (!Array.isArray(value)) {
    // Tiptap envelope (`{type:'doc',content:[...]}`) or any other object
    // shape: BlockNote can't read it. Let the editor seed empty and the
    // user (or the legacy-conversion flow) repair it later.
    return undefined;
  }
  if (value.length === 0) return undefined;
  // Every element must be a plain block object. One bad element corrupts
  // the entire mount, so we treat the whole array as invalid.
  const allBlocks = value.every((b) => b && typeof b === 'object' && !Array.isArray(b));
  return allBlocks ? value : undefined;
}

export default BlockNoteEditor;
