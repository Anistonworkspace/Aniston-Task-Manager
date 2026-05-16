import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

// BubbleMenu mock is applied globally in src/test/setup.js so all tests
// that touch RichTextEditor mount cleanly. See that file for the why.

// jsdom doesn't implement Range or selection methods Tiptap needs, so we
// stub them. These are safe defaults — they let ProseMirror initialise
// without throwing; the tests assert on the React/JS surface, not on
// browser-level layout.
beforeEach(() => {
  if (typeof window !== 'undefined') {
    if (!document.createRange().getBoundingClientRect) {
      Document.prototype.createRange = function () {
        return {
          setStart: () => {},
          setEnd: () => {},
          getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
          getClientRects: () => [],
          commonAncestorContainer: document.body,
        };
      };
    }
  }
});

import RichTextEditor, { htmlToPlainText, looksLikeHtml } from '../RichTextEditor';

describe('RichTextEditor helpers', () => {
  it('htmlToPlainText strips tags and trims whitespace', () => {
    expect(htmlToPlainText('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
    expect(htmlToPlainText('')).toBe('');
    expect(htmlToPlainText(null)).toBe('');
  });

  it('looksLikeHtml detects tags vs plain text', () => {
    expect(looksLikeHtml('<p>x</p>')).toBe(true);
    expect(looksLikeHtml('plain text')).toBe(false);
    expect(looksLikeHtml('< not a tag')).toBe(false);
    expect(looksLikeHtml(null)).toBe(false);
  });
});

describe('RichTextEditor smoke', () => {
  it('mounts without error and renders the toolbar', () => {
    const { container } = render(
      <RichTextEditor value="" onUpdate={() => {}} placeholder="Type…" />
    );
    // Toolbar buttons render with title attributes — assert on a few.
    expect(container.querySelector('button[title="Bold (Ctrl+B)"]')).toBeTruthy();
    expect(container.querySelector('button[title="Heading 1"]')).toBeTruthy();
    expect(container.querySelector('button[title="Code block"]')).toBeTruthy();
  });

  it('renders plain-text value wrapped in a <p> on initial load', () => {
    const { container } = render(
      <RichTextEditor value="hello plain" onUpdate={() => {}} />
    );
    const content = container.querySelector('.rte-content');
    expect(content).toBeTruthy();
    // Tiptap renders the doc inside ProseMirror; verify the text appears.
    expect(content.textContent).toContain('hello plain');
  });

  it('accepts HTML value and renders it as-is', () => {
    const { container } = render(
      <RichTextEditor value="<p>Hello <strong>world</strong></p>" onUpdate={() => {}} />
    );
    const content = container.querySelector('.rte-content');
    expect(content.textContent).toContain('Hello world');
    // The bold wrapper should round-trip through the editor.
    expect(content.querySelector('strong')).toBeTruthy();
  });

  it('respects the disabled prop on initial mount', () => {
    const { container } = render(
      <RichTextEditor value="x" onUpdate={() => {}} disabled />
    );
    const content = container.querySelector('.ProseMirror');
    // Tiptap sets contenteditable=false when editable is false.
    expect(content?.getAttribute('contenteditable')).toBe('false');
  });

  it('exposes imperative ref API (insertText / focus / isEmpty / getHTML / getText)', () => {
    const ref = createRef();
    render(<RichTextEditor ref={ref} value="" onUpdate={() => {}} />);
    expect(typeof ref.current.insertText).toBe('function');
    expect(typeof ref.current.focus).toBe('function');
    expect(typeof ref.current.isEmpty).toBe('function');
    expect(typeof ref.current.getHTML).toBe('function');
    expect(typeof ref.current.getText).toBe('function');
  });

  it('insertText appends to existing content', () => {
    const ref = createRef();
    const onUpdate = vi.fn();
    render(<RichTextEditor ref={ref} value="hello" onUpdate={onUpdate} />);
    act(() => { ref.current.insertText(' world'); });
    expect(ref.current.getText()).toContain('hello');
    expect(ref.current.getText()).toContain('world');
  });
});
