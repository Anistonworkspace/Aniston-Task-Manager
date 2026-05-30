import { render, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import React from 'react';

import BlockNoteEditor from '../BlockNoteEditor';

afterEach(cleanup);

describe('BlockNoteEditor — mounts cleanly for every server-side content shape', () => {
  it('value=[] (BlockNote empty seed)', () => {
    expect(() =>
      render(<BlockNoteEditor value={[]} onChange={() => {}} />)
    ).not.toThrow();
  });

  it('value=null', () => {
    expect(() =>
      render(<BlockNoteEditor value={null} onChange={() => {}} />)
    ).not.toThrow();
  });

  it('value=undefined', () => {
    expect(() =>
      render(<BlockNoteEditor value={undefined} onChange={() => {}} />)
    ).not.toThrow();
  });

  it('value={type:"doc", content:[]} (Tiptap legacy envelope accidentally fed in)', () => {
    expect(() =>
      render(<BlockNoteEditor value={{ type: 'doc', content: [] }} onChange={() => {}} />)
    ).not.toThrow();
  });

  it('value=[]-of-primitives (garbage payload from a buggy importer)', () => {
    expect(() =>
      render(<BlockNoteEditor value={['nope', 42, null]} onChange={() => {}} />)
    ).not.toThrow();
  });

  it('value=non-empty Block[]', () => {
    const blocks = [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'hi', styles: {} }],
      },
    ];
    expect(() =>
      render(<BlockNoteEditor value={blocks} onChange={() => {}} />)
    ).not.toThrow();
  });
});
