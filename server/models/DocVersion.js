const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * DocVersion — periodic snapshot of a doc's contentJson.
 *
 * Created on every Nth autosave (controller decides — default every 10
 * saves OR every 5 minutes, whichever fires first). Restoring a version
 * just overwrites the live doc's contentJson + creates a new "Restored
 * from version X" entry — never deletes prior versions.
 *
 * Retention policy is enforced by a future cron (NOT in Phase B). For now
 * snapshots accumulate; admins can purge via direct SQL if needed.
 */
const DocVersion = sequelize.define(
  'DocVersion',
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
    contentJson: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    contentText: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: '',
    },
    savedBy: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    note: {
      type: DataTypes.STRING(200),
      allowNull: true,
      comment: 'Optional human label ("Restored from 2026-05-15", "Pre-launch snapshot")',
    },
  },
  {
    tableName: 'doc_versions',
    timestamps: true,
    updatedAt: false, // versions are immutable
    indexes: [
      { fields: ['docId'] },
      { fields: ['docId', 'createdAt'] },
    ],
  }
);

module.exports = DocVersion;
