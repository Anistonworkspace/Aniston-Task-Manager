const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * DocComment — Notion/Google-Docs-style threaded comment on a doc.
 *
 * One row per comment. Top-level comments have `parentId = null`; replies
 * point at their parent's id. The anchor (`anchorText` + best-effort
 * `anchorFrom`/`anchorTo` ProseMirror positions) survives doc edits — the
 * snapshot text is the canonical "what was this comment about" while the
 * positions are advisory and may stale after the doc has been heavily
 * edited.
 *
 * Deletion model: when a top-level comment with replies is removed we
 * keep the row but rewrite `body` to "[deleted]" so the thread structure
 * (and the children's `parentId`) stays intact. Childless comments are
 * hard-deleted. See docCommentController.deleteDocComment.
 *
 * Resolution: any workspace member can resolve/unresolve. resolvedAt +
 * resolvedBy track the action; clearing both fields restores "open"
 * state. Resolution toggles only top-level threads — replies inherit
 * their parent's resolved state via the UI (no per-reply flag).
 *
 * Author FK uses SET NULL so historical comments survive user deletion;
 * the UI renders "Unknown user" in that case.
 */
const DocComment = sequelize.define(
  'DocComment',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    docId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'docs', key: 'id' },
      onDelete: 'CASCADE',
    },
    parentId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'doc_comments', key: 'id' },
      onDelete: 'CASCADE',
      comment: 'NULL = top-level thread; UUID = reply to that comment.',
    },
    authorId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Plain text in v1. Future: rich text / mentions.',
    },
    anchorText: {
      type: DataTypes.TEXT,
      allowNull: false,
      comment: 'Snapshot of the selected text at comment time — survives edits.',
    },
    anchorFrom: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'ProseMirror position; best-effort, may stale after edits.',
    },
    anchorTo: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    resolved: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    resolvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    resolvedBy: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
    },
  },
  {
    tableName: 'doc_comments',
    timestamps: true,
    indexes: [
      { fields: ['docId'] },
      { fields: ['docId', 'resolved'] },
      { fields: ['parentId'] },
    ],
  }
);

module.exports = DocComment;
