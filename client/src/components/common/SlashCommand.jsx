// Slash-command extension for the TipTap rich-text editor.
//
// User types `/` → a small floating menu appears next to the caret with
// block-insertion shortcuts (H1, H2, lists, quote, code, divider). Arrow
// keys move the highlight, Enter / Tab inserts, Escape dismisses.
//
// Implemented as a thin TipTap Extension wrapping the official
// `@tiptap/suggestion` plugin + a React menu rendered imperatively via
// `@tiptap/react`'s `ReactRenderer`. No tippy.js — positioning uses
// `position: fixed` based on the trigger's clientRect, which is enough
// for our use case (single-line caret indicator) and keeps deps minimal.
//
// Lazy-loaded with the RichTextEditor itself so non-Notes pages don't
// pay the suggestion-plugin bundle cost.

import React, {
  forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
} from 'react';
import { Extension } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import Suggestion from '@tiptap/suggestion';
import {
  Heading1, Heading2, Heading3, List, ListOrdered, Quote, Code, Minus, Pilcrow,
} from 'lucide-react';

// ─── Menu items ─────────────────────────────────────────────────────────
// Each item knows how to apply itself to the editor at a given range. The
// `command` runs after Suggestion has cleared the typed `/query` text, so
// every item starts from a clean caret. `keywords` widens fuzzy match
// (e.g. typing "ul" or "list" both find the bullet list item).
//
// Adding a new item: append a row here, give it a unique title and a
// command. The menu sizes itself automatically.
export const SLASH_ITEMS = [
  {
    title: 'Heading 1',
    description: 'Large section heading',
    keywords: ['h1', 'heading', 'title', 'large'],
    icon: Heading1,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run();
    },
  },
  {
    title: 'Heading 2',
    description: 'Medium section heading',
    keywords: ['h2', 'heading', 'subtitle'],
    icon: Heading2,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run();
    },
  },
  {
    title: 'Heading 3',
    description: 'Small section heading',
    keywords: ['h3', 'heading', 'sub'],
    icon: Heading3,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run();
    },
  },
  {
    title: 'Paragraph',
    description: 'Plain text',
    keywords: ['p', 'paragraph', 'text', 'plain'],
    icon: Pilcrow,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode('paragraph').run();
    },
  },
  {
    title: 'Bullet list',
    description: 'Unordered list',
    keywords: ['ul', 'bullet', 'list', 'unordered'],
    icon: List,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    title: 'Numbered list',
    description: 'Ordered list',
    keywords: ['ol', 'numbered', 'ordered', 'list'],
    icon: ListOrdered,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    title: 'Quote',
    description: 'Block quote',
    keywords: ['quote', 'blockquote', 'citation'],
    icon: Quote,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
    },
  },
  {
    title: 'Code block',
    description: 'Monospaced code',
    keywords: ['code', 'pre', 'snippet', 'monospace'],
    icon: Code,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run();
    },
  },
  {
    title: 'Divider',
    description: 'Horizontal rule',
    keywords: ['hr', 'divider', 'rule', 'separator', 'line'],
    icon: Minus,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run();
    },
  },
];

function filterItems(query) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return SLASH_ITEMS.slice(0, 8);
  return SLASH_ITEMS.filter((item) => {
    if (item.title.toLowerCase().includes(q)) return true;
    return (item.keywords || []).some((k) => k.toLowerCase().includes(q));
  }).slice(0, 8);
}

// ─── Menu UI component ──────────────────────────────────────────────────
// Receives `items`, `command` (called when user picks one), and `rect` (a
// DOMRect-like object describing the trigger's position so we can render
// the menu just below the caret). ReactRenderer talks to it via the
// imperative ref — `onKeyDown` forwards arrow / enter / esc events from
// the editor's keydown handler.
const SlashMenu = forwardRef(function SlashMenu({ items, command, rect }, ref) {
  const [selected, setSelected] = useState(0);
  // Reset highlight on every new query result so the list never points
  // past its end after the user types another character.
  useLayoutEffect(() => { setSelected(0); }, [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown({ event }) {
      if (event.key === 'ArrowDown') {
        setSelected((s) => (s + 1) % Math.max(1, items.length));
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelected((s) => (s - 1 + items.length) % Math.max(1, items.length));
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = items[selected];
        if (item) { command(item); return true; }
        return false;
      }
      return false;
    },
  }), [items, selected, command]);

  if (!items.length) {
    return (
      <div
        className="slash-menu fixed z-[9999] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg px-3 py-2 text-xs text-zinc-500"
        style={positionStyle(rect)}
      >
        No matches
      </div>
    );
  }

  return (
    <div
      className="slash-menu fixed z-[9999] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 w-[260px] max-h-[280px] overflow-y-auto"
      style={positionStyle(rect)}
    >
      {items.map((item, idx) => {
        const Icon = item.icon;
        const isActive = idx === selected;
        return (
          <button
            key={item.title}
            type="button"
            onMouseDown={(e) => { e.preventDefault(); command(item); }}
            onMouseEnter={() => setSelected(idx)}
            className={`w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-xs transition-colors ${
              isActive
                ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            }`}
          >
            <Icon size={14} className="flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium">{item.title}</div>
              <div className="text-[10px] text-zinc-400 truncate">{item.description}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
});

// Position the menu just below the trigger. If we'd run off the bottom of
// the viewport, flip above instead. The clientRect from the Suggestion
// plugin is viewport-relative, so `fixed` is the right choice.
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

// ─── The Extension itself ──────────────────────────────────────────────
export const SlashCommand = Extension.create({
  name: 'slashCommand',

  addOptions() {
    return {
      suggestion: {
        char: '/',
        startOfLine: false,
        // Called when the user picks an item. Suggestion has already
        // collected the typed range (the `/` + the query); we forward it
        // to the item so its command can `deleteRange(range)` first and
        // then apply the block transformation cleanly.
        command: ({ editor, range, props }) => {
          props.item.command({ editor, range });
        },
        items: ({ query }) => filterItems(query).map((item) => ({ ...item })),
        render: () => {
          let component;
          return {
            onStart: (props) => {
              component = new ReactRenderer(SlashMenu, {
                props: {
                  items: props.items,
                  rect: props.clientRect ? props.clientRect() : null,
                  command: (item) => props.command({ item }),
                },
                editor: props.editor,
              });
              document.body.appendChild(component.element);
            },
            onUpdate: (props) => {
              if (!component) return;
              component.updateProps({
                items: props.items,
                rect: props.clientRect ? props.clientRect() : null,
                command: (item) => props.command({ item }),
              });
            },
            onKeyDown: (props) => {
              if (props.event.key === 'Escape') {
                cleanup();
                return true;
              }
              return component?.ref?.onKeyDown(props) || false;
            },
            onExit: () => { cleanup(); },
          };

          function cleanup() {
            if (component) {
              if (component.element && component.element.parentNode) {
                component.element.parentNode.removeChild(component.element);
              }
              component.destroy();
              component = null;
            }
          }
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});

export default SlashCommand;
