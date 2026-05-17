import { describe, it, expect, vi } from 'vitest';

/**
 * Phase C — TableExtensions + SLASH_TABLE_ITEM tests.
 *
 * The real @tiptap/extension-table* packages are runtime-only deps that
 * lean on a ProseMirror schema; pulling them into a jsdom Vitest run
 * would require a full editor harness. We instead mock each tiptap
 * table module with a minimal stand-in that records `.configure(opts)`
 * calls and exposes a stable `.name`, then assert the factory wires
 * options + names correctly. That keeps the test fast and deterministic
 * while still pinning the contract RichTextEditor relies on (array of
 * four extensions, correct names, resizable + class options).
 */

vi.mock('@tiptap/extension-table', () => ({
  default: {
    name: 'table',
    configure(options) {
      return { name: 'table', options };
    },
  },
}));

vi.mock('@tiptap/extension-table-row', () => ({
  default: {
    name: 'tableRow',
    configure(options) {
      return { name: 'tableRow', options };
    },
  },
}));

vi.mock('@tiptap/extension-table-cell', () => ({
  default: {
    name: 'tableCell',
    configure(options) {
      return { name: 'tableCell', options };
    },
  },
}));

vi.mock('@tiptap/extension-table-header', () => ({
  default: {
    name: 'tableHeader',
    configure(options) {
      return { name: 'tableHeader', options };
    },
  },
}));

import { buildTableExtensions } from '../TableExtensions';
import { SLASH_TABLE_ITEM } from '../SlashCommand';

describe('buildTableExtensions', () => {
  it('returns an array of length 4', () => {
    const exts = buildTableExtensions();
    expect(Array.isArray(exts)).toBe(true);
    expect(exts).toHaveLength(4);
  });

  it('each entry has a name matching the expected node type', () => {
    const exts = buildTableExtensions();
    const names = exts.map((e) => e.name);
    // Order matches the factory return: Table, TableRow, TableHeader, TableCell.
    expect(names).toEqual(['table', 'tableRow', 'tableHeader', 'tableCell']);
  });

  it('configures the Table extension with resizable: true', () => {
    const exts = buildTableExtensions();
    const table = exts.find((e) => e.name === 'table');
    expect(table).toBeDefined();
    expect(table.options.resizable).toBe(true);
  });

  it('configures the Table extension with HTMLAttributes class "rte-table"', () => {
    const exts = buildTableExtensions();
    const table = exts.find((e) => e.name === 'table');
    expect(table.options.HTMLAttributes).toEqual({ class: 'rte-table' });
  });
});

describe('SLASH_TABLE_ITEM', () => {
  it('exposes the slash-menu item shape (title/description/keywords/icon/command)', () => {
    expect(SLASH_TABLE_ITEM).toBeDefined();
    expect(typeof SLASH_TABLE_ITEM.title).toBe('string');
    expect(SLASH_TABLE_ITEM.title.length).toBeGreaterThan(0);
    expect(typeof SLASH_TABLE_ITEM.description).toBe('string');
    expect(Array.isArray(SLASH_TABLE_ITEM.keywords)).toBe(true);
    expect(SLASH_TABLE_ITEM.keywords.length).toBeGreaterThan(0);
    expect(SLASH_TABLE_ITEM.icon).toBeTruthy();
    expect(typeof SLASH_TABLE_ITEM.command).toBe('function');
  });

  it('command() runs the expected chain without throwing', () => {
    // Build a chain mock that records each step so we can verify the
    // exact insertTable args. Each chain method returns the same mock
    // so the fluent .chain().focus().deleteRange().insertTable().run()
    // call resolves cleanly.
    const run = vi.fn();
    const insertTable = vi.fn().mockReturnThis();
    const deleteRange = vi.fn().mockReturnThis();
    const focus = vi.fn().mockReturnThis();
    const chainObj = { focus, deleteRange, insertTable, run };
    // After insertTable returns chainObj (via mockReturnThis), we also
    // need .run() to be on the same object — which it already is. Wire
    // run() to no-op explicitly (the spy already counts the call).
    run.mockReturnValue(undefined);
    const chain = vi.fn(() => chainObj);
    const editor = { chain };
    const range = { from: 5, to: 6 };

    expect(() => SLASH_TABLE_ITEM.command({ editor, range })).not.toThrow();

    expect(chain).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(deleteRange).toHaveBeenCalledTimes(1);
    expect(deleteRange).toHaveBeenCalledWith(range);
    expect(insertTable).toHaveBeenCalledTimes(1);
    expect(insertTable).toHaveBeenCalledWith({ rows: 3, cols: 3, withHeaderRow: true });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
