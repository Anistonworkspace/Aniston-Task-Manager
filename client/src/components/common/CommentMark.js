// Phase F (polish) — Tiptap Mark that visually anchors a doc comment to
// the text range it was made on. Renders as a yellow highlight with a
// soft underline; clicking the highlighted text fires a parent-supplied
// callback (DocPage opens the comments sidebar focused on that thread).
//
// Design note: anchor positions (anchorFrom/anchorTo) on the server-side
// DocComment row are best-effort and DRIFT as users edit the doc. So the
// reapply logic in RichTextEditor doesn't trust them — it searches the
// live doc for `anchorText` instead. The mark is what survives between
// edits; positions are recomputed on each refresh.

import { Mark, mergeAttributes } from '@tiptap/core';

/**
 * buildCommentMarkExtension — call-site factory mirroring the existing
 * `buildMentionExtension` / `buildTaskChipExtension` pattern.
 *
 *   const ext = buildCommentMarkExtension();
 *
 * No options needed today; the factory exists for symmetry + so callers
 * who want to disable the mark just don't load the extension.
 */
export function buildCommentMarkExtension() {
  return CommentMark;
}

export const CommentMark = Mark.create({
  name: 'comment',

  // Inclusive at the END so typing right after a marked range doesn't
  // accidentally extend the mark into the new text. We DO want it inclusive
  // at the start so a cursor placed inside the mark stays inside it.
  inclusive: false,
  // Excludes itself — only one comment mark per character. (Multiple
  // overlapping comments collapse into the most-recently-applied. This is
  // a Phase-F-v2 problem to solve cleanly with multiple commentIds in one
  // mark; v1 keeps it simple.)
  excludes: '_',

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-comment-id'),
        renderHTML: (attrs) => (attrs.commentId ? { 'data-comment-id': attrs.commentId } : {}),
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'span[data-comment-id]' },
      { tag: 'span.comment-mark' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(
        { class: 'comment-mark' },
        HTMLAttributes,
      ),
      0,
    ];
  },
});

export default CommentMark;
