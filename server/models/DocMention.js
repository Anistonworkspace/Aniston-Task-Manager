const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * DocMention — record of an @-mention inside a doc body.
 *
 * One row per (doc, mentioned user). Used for:
 *   - Notification fan-out on save (with idempotencyKey so re-saves of the
 *     same doc don't re-notify everyone who's already mentioned).
 *   - Back-references: "this user is mentioned in 3 docs" lookups via a
 *     simple WHERE mentionedUserId = ?.
 *   - Future bidirectional UI: "Referenced in N docs" pill on user profiles.
 *
 * The mention's textual content (the user's name at mention time) lives in
 * the doc's contentJson — this table only tracks the linkage. When a user's
 * name changes the existing mention text doesn't update; the user-id link
 * still resolves.
 */
const DocMention = sequelize.define(
  'DocMention',
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
    mentionedUserId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      onDelete: 'CASCADE',
      comment: 'User mentioned via @-name in the doc body.',
    },
    mentionedByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
      comment: 'Author of the save that introduced this mention.',
    },
    // The Tiptap mention node may carry a position hint for "jump to mention"
    // UI. We store the byte offset into the contentText shadow so the UI can
    // approximate without round-tripping the full JSON.
    anchorOffset: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    resolvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Set when the mentioned user reads / acknowledges the mention.',
    },
  },
  {
    tableName: 'doc_mentions',
    timestamps: true,
    indexes: [
      { fields: ['docId'] },
      { fields: ['mentionedUserId'] },
      { unique: true, fields: ['docId', 'mentionedUserId'] },
    ],
  }
);

module.exports = DocMention;
