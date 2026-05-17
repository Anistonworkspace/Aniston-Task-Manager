const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * DocTaskReference — record of a task chip inside a doc body.
 *
 * Mirrors DocMention's shape but for tasks. One row per (doc, task). Used
 * for:
 *   - Bidirectional links: `WHERE taskId = ?` gives "this task is
 *     mentioned in N docs" — feeds a future "Referenced in 3 docs" pill
 *     on the task modal.
 *   - Future activity log: "Alice linked task T-7 to doc 'Q3 plan'."
 *
 * No notification on insert: the mentioned task's owners already get
 * notifications via their own task subscriptions, so doc-anchored task
 * references would be noise. DocMention notifies because users may not
 * be watching a doc; tasks have their own watcher model.
 */
const DocTaskReference = sequelize.define(
  'DocTaskReference',
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
    taskId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'tasks', key: 'id' },
      onDelete: 'CASCADE',
    },
    addedByUserId: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL',
      comment: 'Author of the save that introduced this reference.',
    },
    anchorOffset: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Cumulative plain-text offset to the task chip — best-effort.',
    },
  },
  {
    tableName: 'doc_task_references',
    timestamps: true,
    indexes: [
      { fields: ['docId'] },
      { fields: ['taskId'] },
      { unique: true, fields: ['docId', 'taskId'] },
    ],
  }
);

module.exports = DocTaskReference;
