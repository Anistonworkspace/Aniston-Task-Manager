import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';

/**
 * Phase C — table block extensions for the rich text editor.
 *
 * Returns the four Tiptap table extensions configured for our editor's
 * conventions: resizable columns, no header by default (the user can
 * promote a row to header via the slash command's "header row" toggle in
 * a future polish), and Tailwind-friendly class hooks so the CSS layer
 * (.ProseMirror table {}) can style them without inline overrides.
 */
export function buildTableExtensions() {
  return [
    Table.configure({
      resizable: true,
      HTMLAttributes: { class: 'rte-table' },
    }),
    TableRow.configure({
      HTMLAttributes: { class: 'rte-table-row' },
    }),
    TableHeader.configure({
      HTMLAttributes: { class: 'rte-table-th' },
    }),
    TableCell.configure({
      HTMLAttributes: { class: 'rte-table-td' },
    }),
  ];
}
