// Doc Editor Phase D Slice 2 — TaskChip Tiptap node.
//
// User types `+` inside a doc → a task picker pops up; picking a task
// inserts a single inline atom node with shape:
//
//   { type: 'taskChip', attrs: { taskId, label, status } }
//
// The backend's extractTaskRefs walker keys off `type === 'taskChip'` to
// drive the doc_task_references join table.
//
// Mirrors the mention extension pattern in RichTextEditor.jsx but lives in
// its own file because the node has its own attrs, parseHTML/renderHTML,
// and trigger char (`+` vs mention's `@`).

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from 'prosemirror-state';
import TaskPickerPopover from './TaskPickerPopover';

export const TASK_CHIP_TRIGGER = '+';

// Distinct plugin key — without this, ProseMirror throws
// "Adding different instances of a keyed plugin (suggestion$)" because
// @tiptap/suggestion uses the same internal key by default and the
// Mention extension already owns one Suggestion instance in this editor.
const TaskChipPluginKey = new PluginKey('taskChipSuggestion');

/**
 * Build a configured TaskChip node. `suggestFn(query)` is supplied by the
 * caller — it should return a Promise of
 *   [{ id, title, status, priority, boardId, boardName, boardColor, dueDate }]
 * matching the picker's data shape.
 *
 * The configuration object is wrapped to keep the public RichTextEditor
 * surface (`tasks={{ suggest, onInsert? }}`) symmetrical with the existing
 * `mentions={...}` opt-in.
 */
export function buildTaskChipExtension({ suggest, onInsert, onCreateNew } = {}) {
  if (typeof suggest !== 'function') {
    throw new Error('buildTaskChipExtension: `suggest` is required');
  }
  return TaskChip.configure({
    HTMLAttributes: {
      // Same Monday-blue accent as mentions but with the hash-tag treatment
      // so the two are visually distinct. Slice 2c adds cursor-pointer +
      // hover state so the chip reads as clickable inside the doc.
      class: 'task-chip inline-flex items-center px-1.5 py-0.5 rounded text-[#0073ea] bg-[#0073ea]/10 hover:bg-[#0073ea]/20 text-sm font-medium cursor-pointer transition-colors',
    },
    suggestion: {
      char: TASK_CHIP_TRIGGER,
      pluginKey: TaskChipPluginKey,
      // Suggestion plugin invokes `items` after every keystroke past the
      // trigger char. Returning a promise lets the popover re-render once
      // the search resolves.
      items: async ({ query }) => {
        try {
          const result = await suggest(query || '');
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
              type: 'taskChip',
              attrs: {
                taskId: props.id,
                label: props.title || props.label || props.id,
                status: props.status || null,
                // Phase D Slice 2c — keep boardId on the chip so click
                // can deep-link to `/boards/<boardId>?taskId=<taskId>`
                // without an extra API round-trip.
                boardId: props.boardId || null,
              },
            },
            { type: 'text', text: ' ' },
          ])
          .run();
        if (typeof onInsert === 'function') {
          try { onInsert(props); } catch { /* non-fatal */ }
        }
      },
      render: () => {
        let component;
        // Slice 2b — wrap onCreateNew with the editor+range so DocPage
        // can insert the chip programmatically at the saved position
        // once the modal returns the new task. Without this closure,
        // by the time the modal resolves the suggestion plugin has
        // already exited and `range` is gone.
        const handleCreateNew = (editor, range) => (query) => {
          if (typeof onCreateNew !== 'function') return;
          // Clear the typed "+query" range first — otherwise the
          // chip would be inserted alongside literal text the user
          // already typed past the trigger char.
          try { editor.chain().focus().deleteRange(range).run(); } catch { /* no-op */ }
          // Pass a continuation the modal can call with the created
          // task to actually drop the chip into the doc.
          onCreateNew({
            query,
            insertChip: (task) => {
              if (!task?.id) return;
              try {
                editor
                  .chain()
                  .focus()
                  .insertContentAt(editor.state.selection.from, [
                    {
                      type: 'taskChip',
                      attrs: {
                        taskId: task.id,
                        label: task.title || task.label || task.id,
                        status: task.status || null,
                        boardId: task.boardId || null,
                      },
                    },
                    { type: 'text', text: ' ' },
                  ])
                  .run();
              } catch { /* no-op */ }
              if (typeof onInsert === 'function') {
                try { onInsert(task); } catch { /* no-op */ }
              }
            },
          });
        };
        return {
          onStart: (props) => {
            component = new ReactRenderer(TaskPickerPopover, {
              props: {
                items: props.items,
                loading: false,
                rect: props.clientRect ? props.clientRect() : null,
                command: (item) => props.command({ ...item }),
                query: props.query,
                onCreateNew: handleCreateNew(props.editor, props.range),
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
              query: props.query,
              onCreateNew: handleCreateNew(props.editor, props.range),
            });
          },
          onKeyDown: (props) => {
            if (props.event.key === 'Escape') {
              if (component?.element?.parentNode) {
                component.element.parentNode.removeChild(component.element);
              }
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

// ─── The Node itself ─────────────────────────────────────────────
//
// Inline atom: rendered as a single visual unit, selected like one cursor
// step, never breaks across lines. The three attrs are persisted into the
// Tiptap JSON envelope and round-trip through the doc-save path.
const TaskChip = Node.create({
  name: 'taskChip',
  group: 'inline',
  inline: true,
  selectable: true,
  atom: true,
  draggable: false,

  addOptions() {
    return {
      HTMLAttributes: {},
      suggestion: {
        char: TASK_CHIP_TRIGGER,
        pluginKey: TaskChipPluginKey,
        items: () => [],
        render: () => ({}),
      },
    };
  },

  addAttributes() {
    return {
      taskId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-task-id'),
        renderHTML: (attrs) => (attrs.taskId ? { 'data-task-id': attrs.taskId } : {}),
      },
      label: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-label'),
        renderHTML: (attrs) => (attrs.label ? { 'data-label': attrs.label } : {}),
      },
      status: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-status'),
        renderHTML: (attrs) => (attrs.status ? { 'data-status': attrs.status } : {}),
      },
      boardId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-board-id'),
        renderHTML: (attrs) => (attrs.boardId ? { 'data-board-id': attrs.boardId } : {}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'span[data-type="task-chip"]' },
      { tag: 'span.task-chip' },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = node.attrs.label || node.attrs.taskId || 'task';
    return [
      'span',
      mergeAttributes(
        { 'data-type': 'task-chip' },
        this.options.HTMLAttributes,
        HTMLAttributes,
      ),
      `+${label}`,
    ];
  },

  // The chip renders to plain text as `+Title` when copied or exported via
  // editor.getText(). This mirrors the mention extension's `renderText`
  // behavior so search-shadow extraction stays consistent.
  renderText({ node }) {
    return `+${node.attrs.label || node.attrs.taskId || 'task'}`;
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

export default TaskChip;
