import React, { createRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

// Same jsdom Range stub as RichTextEditor.mentions.test.jsx — Tiptap
// needs it to initialise ProseMirror without throwing.
beforeEach(() => {
  if (typeof window !== 'undefined') {
    if (!document.createRange().getBoundingClientRect) {
      Document.prototype.createRange = function () {
        return {
          setStart: () => {},
          setEnd: () => {},
          getBoundingClientRect: () => ({
            top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
          }),
          getClientRects: () => [],
          commonAncestorContainer: document.body,
        };
      };
    }
  }
});

import RichTextEditor from '../RichTextEditor';

describe('RichTextEditor task-chip opt-in (Phase D Slice 2)', () => {
  it('mounts cleanly when the tasks prop is omitted (default null)', () => {
    const { container } = render(
      <RichTextEditor value="" onUpdate={() => {}} />
    );
    expect(container.querySelector('.ProseMirror')).toBeTruthy();
    // Toolbar still renders — quick regression check.
    expect(container.querySelector('button[title="Bold (Ctrl+B)"]')).toBeTruthy();
  });

  it('accepts a tasks prop with a suggest function without throwing on mount', () => {
    const suggest = vi.fn(async () => [
      { id: 't1', title: 'Ship docs', status: 'working_on_it', boardName: 'Eng', boardColor: '#22c55e' },
    ]);
    const { container } = render(
      <RichTextEditor value="" onUpdate={() => {}} tasks={{ suggest }} />
    );
    expect(container.querySelector('.ProseMirror')).toBeTruthy();
  });

  it('does NOT call tasks.suggest on initial mount (lazy invocation)', () => {
    const suggest = vi.fn(async () => []);
    render(
      <RichTextEditor value="hello" onUpdate={() => {}} tasks={{ suggest }} />
    );
    expect(suggest).not.toHaveBeenCalled();
  });

  it('accepts a tasks prop that also supplies onInsert without throwing', () => {
    const suggest = vi.fn(async () => []);
    const onInsert = vi.fn();
    const { container } = render(
      <RichTextEditor value="" onUpdate={() => {}} tasks={{ suggest, onInsert }} />
    );
    expect(container.querySelector('.ProseMirror')).toBeTruthy();
  });

  it('toggles cleanly when tasks prop flips from null → non-null via rerender', () => {
    const suggest = vi.fn(async () => []);
    const { container, rerender } = render(
      <RichTextEditor value="" onUpdate={() => {}} tasks={null} />
    );
    expect(container.querySelector('.ProseMirror')).toBeTruthy();

    rerender(
      <RichTextEditor value="" onUpdate={() => {}} tasks={{ suggest }} />
    );
    // Editor still mounted — no crash from the extension swap.
    expect(container.querySelector('.ProseMirror')).toBeTruthy();
    expect(container.querySelector('button[title="Bold (Ctrl+B)"]')).toBeTruthy();
  });

  it('does not log a Tiptap/React error during mount when both mentions and tasks are wired', () => {
    const suggest = vi.fn(async () => []);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <RichTextEditor
        value="hello"
        onUpdate={() => {}}
        mentions={{ suggest }}
        tasks={{ suggest }}
      />
    );
    expect(container.querySelector('.ProseMirror')).toBeTruthy();
    const relevant = errorSpy.mock.calls.filter((call) => {
      const first = call[0];
      return typeof first === 'string' && /(mention|task|chip)/i.test(first);
    });
    expect(relevant).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('onUpdate fires with two args (html: string, json: object) when the user types', () => {
    const ref = createRef();
    const onUpdate = vi.fn();
    render(
      <RichTextEditor ref={ref} value="" onUpdate={onUpdate} />
    );
    act(() => { ref.current.insertText('hello'); });
    expect(onUpdate).toHaveBeenCalled();
    const [html, json] = onUpdate.mock.calls[onUpdate.mock.calls.length - 1];
    expect(typeof html).toBe('string');
    expect(json).toBeTruthy();
    expect(json.type).toBe('doc');
    expect(Array.isArray(json.content)).toBe(true);
  });

  it('ref.getJSON() returns a { type:"doc", content:[...] } shape', () => {
    const ref = createRef();
    render(
      <RichTextEditor ref={ref} value="hello" onUpdate={() => {}} />
    );
    const json = ref.current.getJSON();
    expect(json).toBeTruthy();
    expect(json.type).toBe('doc');
    expect(Array.isArray(json.content)).toBe(true);
  });
});
