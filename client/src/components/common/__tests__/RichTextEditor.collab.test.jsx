import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/* ──────────────────────────────────────────────────────────────
 * Phase G — RichTextEditor `collab` prop smoke tests.
 *
 * We capture every extension Tiptap is asked to load (via the mocked
 * `useEditor`) so we can assert presence/absence of Collaboration +
 * CollaborationCursor without standing up a real ProseMirror editor.
 *
 * Mocks:
 *   - @hocuspocus/provider + yjs — never touched by these tests, but
 *     stubbed for safety against accidental construction.
 *   - @tiptap/extension-collaboration{,-cursor} — return tagged sentinels
 *     so we can verify they appear in the extension list.
 *   - @tiptap/react useEditor — captures the extensions array per render
 *     and returns a minimal editor stub the component renders against.
 * ────────────────────────────────────────────────────────────── */

const { capturedExtensions, COLLAB_TAG, CURSOR_TAG } = vi.hoisted(() => ({
  capturedExtensions: [],
  COLLAB_TAG: Symbol('collab-extension'),
  CURSOR_TAG: Symbol('cursor-extension'),
}));

vi.mock('@hocuspocus/provider', () => ({
  HocuspocusProvider: class { destroy() {} on() {} awareness = { on() {}, getStates: () => new Map() } },
}));

vi.mock('yjs', () => ({
  Doc: class { destroy() {} },
}));

vi.mock('@tiptap/extension-collaboration', () => ({
  default: {
    configure: vi.fn((opts) => ({ __tag: COLLAB_TAG, opts })),
  },
}));

vi.mock('@tiptap/extension-collaboration-cursor', () => ({
  default: {
    configure: vi.fn((opts) => ({ __tag: CURSOR_TAG, opts })),
  },
}));

vi.mock('@tiptap/react', async () => {
  const React = await import('react');
  return {
    // Capture the extensions array (the part we want to assert on)
    // and return a minimal editor stub the component code paths can
    // read from without exploding.
    useEditor: (config) => {
      capturedExtensions.push(config.extensions);
      return {
        commands: { focus: () => {}, setContent: () => {} },
        chain: () => ({
          focus: () => ({ toggleBold: () => ({ run: () => {} }) }),
        }),
        isActive: () => false,
        isEditable: true,
        setEditable: () => {},
        isEmpty: true,
        getHTML: () => '',
        getText: () => '',
        getJSON: () => ({ type: 'doc', content: [] }),
        can: () => ({ undo: () => false, redo: () => false }),
        state: { tr: { addMark: () => {}, removeMark: () => {} }, doc: { content: { size: 0 }, textBetween: () => '', descendants: () => {} }, selection: { from: 0, to: 0, empty: true } },
        view: { dispatch: () => {}, coordsAtPos: () => ({ left: 0, top: 0, bottom: 0 }) },
        schema: { marks: {} },
        on: () => {},
        off: () => {},
      };
    },
    EditorContent: ({ editor, ...rest }) => React.createElement('div', { 'data-testid': 'editor-content', ...rest }),
    BubbleMenu: () => null,
    ReactRenderer: class { constructor() { this.element = document.createElement('div'); } updateProps() {} destroy() {} },
  };
});

import RichTextEditor from '../RichTextEditor';
import CollaborationExt from '@tiptap/extension-collaboration';
import CursorExt from '@tiptap/extension-collaboration-cursor';

beforeEach(() => {
  capturedExtensions.length = 0;
  CollaborationExt.configure.mockClear();
  CursorExt.configure.mockClear();
});

describe('RichTextEditor — collab prop', () => {
  it('does not load Collaboration or CollaborationCursor when collab prop is null', () => {
    render(<RichTextEditor value="" onUpdate={() => {}} collab={null} />);
    expect(capturedExtensions.length).toBeGreaterThan(0);
    const lastList = capturedExtensions[capturedExtensions.length - 1];
    const hasCollab = lastList.some((e) => e && e.__tag === COLLAB_TAG);
    const hasCursor = lastList.some((e) => e && e.__tag === CURSOR_TAG);
    expect(hasCollab).toBe(false);
    expect(hasCursor).toBe(false);
    expect(CollaborationExt.configure).not.toHaveBeenCalled();
    expect(CursorExt.configure).not.toHaveBeenCalled();
  });

  it('loads BOTH Collaboration and CollaborationCursor when a collab prop is provided', () => {
    const ydoc = { __ydoc: true };
    const provider = { __provider: true };
    render(
      <RichTextEditor
        value=""
        onUpdate={() => {}}
        collab={{ ydoc, provider, currentUser: { name: 'Sara', color: '#22c55e' } }}
      />,
    );
    const lastList = capturedExtensions[capturedExtensions.length - 1];
    const collabExt = lastList.find((e) => e && e.__tag === COLLAB_TAG);
    const cursorExt = lastList.find((e) => e && e.__tag === CURSOR_TAG);
    expect(collabExt).toBeTruthy();
    expect(cursorExt).toBeTruthy();
    expect(CollaborationExt.configure).toHaveBeenCalledWith(
      expect.objectContaining({ document: ydoc }),
    );
    expect(CursorExt.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        provider,
        user: expect.objectContaining({ name: 'Sara', color: '#22c55e' }),
      }),
    );
  });

  it('handles a collab prop transitioning from null to non-null without crashing', () => {
    const ydoc = { __ydoc: true };
    const provider = { __provider: true };
    const { rerender } = render(
      <RichTextEditor value="initial" onUpdate={() => {}} collab={null} />,
    );
    const firstList = capturedExtensions[capturedExtensions.length - 1];
    expect(firstList.some((e) => e && e.__tag === COLLAB_TAG)).toBe(false);

    // Flip collab on — the memo key (collab?.ydoc, collab?.provider)
    // changes, so a fresh extension list is computed and useEditor is
    // called again with the new array.
    expect(() => {
      rerender(
        <RichTextEditor
          value="initial"
          onUpdate={() => {}}
          collab={{ ydoc, provider, currentUser: { name: 'Sara' } }}
        />,
      );
    }).not.toThrow();

    const nextList = capturedExtensions[capturedExtensions.length - 1];
    expect(nextList.some((e) => e && e.__tag === COLLAB_TAG)).toBe(true);
    expect(nextList.some((e) => e && e.__tag === CURSOR_TAG)).toBe(true);
    cleanup();
  });
});
