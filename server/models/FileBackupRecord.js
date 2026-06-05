const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * Catalog of UPLOADED-FILES backup archives (the `uploads/` directory).
 *
 * Deliberately a SEPARATE table/model from BackupRecord (database dumps) so
 * the two backup subsystems never interfere:
 *   - A running files backup never blocks a database backup (independent
 *     concurrency locks, independent retention passes).
 *   - The Database-Backups UI list and the Files-Backups UI list are sourced
 *     from different tables — no kind/discriminator filtering to get wrong.
 *   - A bug in the files path can never corrupt the DB-backup catalog.
 *
 * Files live under <BACKUP_ROOT>/files. Filename format is
 * `files_<trigger>_YYYYMMDD_HHmmss_<random>.tar.gz` — never user-controlled.
 *
 * Field shape intentionally mirrors BackupRecord so the controller's
 * publicShape() and the frontend's row renderer work for both unchanged.
 */
const FileBackupRecord = sequelize.define('FileBackupRecord', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  filename: {
    type: DataTypes.STRING(255),
    allowNull: false,
    unique: true,
  },
  // Absolute path inside the backend container. Stored for audit/debug only;
  // download/restore/delete endpoints resolve this themselves via the
  // configured backup directory and reject any record whose path falls
  // outside it (path-traversal gate).
  path: {
    type: DataTypes.STRING(1024),
    allowNull: false,
  },
  sizeBytes: {
    type: DataTypes.BIGINT,
    allowNull: true,
  },
  trigger: {
    type: DataTypes.ENUM('scheduled', 'manual', 'pre_restore', 'uploaded'),
    allowNull: false,
    defaultValue: 'manual',
  },
  status: {
    type: DataTypes.ENUM('running', 'completed', 'failed'),
    allowNull: false,
    defaultValue: 'running',
  },
  // For failures: trimmed error text. For uploads: original filename.
  errorMessage: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  createdBy: {
    type: DataTypes.UUID,
    allowNull: true, // null for scheduled / system-initiated runs
  },
  completedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  restoredAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // Best-effort 0-100 progress indicator written by the service as the
  // archive is built. Blends staged checkpoints with a bytes-based estimate
  // anchored to the previous completed archive's size.
  progressPercent: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    validate: { min: 0, max: 100 },
  },
}, {
  tableName: 'file_backup_records',
  timestamps: true,
  indexes: [
    { fields: ['createdAt'] },
    { fields: ['trigger'] },
    { fields: ['status'] },
  ],
});

module.exports = FileBackupRecord;
