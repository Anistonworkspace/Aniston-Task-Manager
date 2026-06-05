-- 024_file_backup_records.sql
-- Catalog for uploaded-FILES backups (gzipped tar archives of the uploads/
-- directory). A SEPARATE table from backup_records (database dumps) so the
-- files-backup subsystem never shares state with the database-dump subsystem:
-- independent concurrency lock, independent retention, independent UI list.
--
-- trigger / status are TEXT + CHECK (not native ENUMs) for the same stability
-- reason as backup_records — avoids Sequelize ENUM creation-order drift.
-- Idempotent: mirrored by a self-installing block in server.js start().

CREATE TABLE IF NOT EXISTS file_backup_records (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename          VARCHAR(255) NOT NULL UNIQUE,
  path              VARCHAR(1024) NOT NULL,
  "sizeBytes"       BIGINT,
  trigger           TEXT NOT NULL DEFAULT 'manual'
                    CHECK (trigger IN ('scheduled','manual','pre_restore','uploaded')),
  status            TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','completed','failed')),
  "errorMessage"    TEXT,
  "createdBy"       UUID REFERENCES users(id) ON DELETE SET NULL,
  "completedAt"     TIMESTAMP WITH TIME ZONE,
  "restoredAt"      TIMESTAMP WITH TIME ZONE,
  "progressPercent" INTEGER NOT NULL DEFAULT 0
                    CHECK ("progressPercent" >= 0 AND "progressPercent" <= 100),
  "createdAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_file_backup_records_created_at ON file_backup_records("createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_file_backup_records_trigger ON file_backup_records(trigger);
CREATE INDEX IF NOT EXISTS idx_file_backup_records_status ON file_backup_records(status);
