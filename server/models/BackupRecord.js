const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/db');

/**
 * Catalog of database backup files known to the application.
 *
 * Why a metadata table instead of just scanning the directory:
 *   - Lets us record `trigger` (scheduled / manual / pre_restore / uploaded),
 *     `status` (running / completed / failed), creator userId, errorMessage,
 *     etc. — none of which can be reconstructed from a filename.
 *   - Restore and delete endpoints look up the file *by id*, not by
 *     user-supplied path, which structurally blocks path-traversal attacks.
 *   - A directory scanner reconciles orphans on boot (so a manual file
 *     dropped into the backup dir still shows up), but the table is the
 *     source of truth for everything driven by the API/UI.
 *
 * Files live under DB_BACKUP_DIR (default `/app/backups/database`). Filename
 * format is `db_YYYYMMDD_HHmmss_<random>.sql.gz` — never user-controlled.
 */
const BackupRecord = sequelize.define('BackupRecord', {
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
  // download/restore/delete endpoints resolve this themselves via the configured
  // backup directory and reject any record whose path falls outside it.
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
  // Free-form notes. For failures: trimmed stderr from pg_dump. For uploads:
  // original filename submitted by the operator. Never echoed to non-Tier-1
  // users (all read endpoints are gated on superAdminOnly anyway).
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
  // Tracks "last restore performed against the database" — set only when a
  // restore operation uses this backup. Lets the UI surface "last restored
  // <date>" and lets ops trace which artefact a recovery used.
  restoredAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // Best-effort 0-100 progress indicator written by the service as the
  // dump pipeline advances. Not a hard guarantee — pg_dump itself doesn't
  // expose a stable percentage, so the value blends staged checkpoints
  // (10 = pg_dump started, 30-80 = streaming, 85 = pg_dump exited,
  // 95 = validation, 100 = done) with a bytes-based estimate when a
  // previous completed backup exists to anchor the size.
  progressPercent: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    validate: { min: 0, max: 100 },
  },
}, {
  tableName: 'backup_records',
  timestamps: true,
  indexes: [
    { fields: ['createdAt'] },
    { fields: ['trigger'] },
    { fields: ['status'] },
  ],
});

module.exports = BackupRecord;
