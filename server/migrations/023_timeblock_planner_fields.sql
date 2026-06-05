-- 023_timeblock_planner_fields.sql
-- Time Planner upgrade — enrich time_blocks with planner metadata.
-- All columns are nullable or defaulted so existing rows remain valid and
-- render unchanged (missing title -> task title / "Untitled", type -> task_work,
-- status -> planned, priority -> normal, source -> manual).
-- Idempotent: mirrored by a self-installing block in server.js start().

ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "title"                 VARCHAR(300);
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "type"                  VARCHAR(30)  NOT NULL DEFAULT 'task_work';
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "status"                VARCHAR(20)  NOT NULL DEFAULT 'planned';
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "priority"              VARCHAR(20)  NOT NULL DEFAULT 'normal';
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "source"                VARCHAR(20)  NOT NULL DEFAULT 'manual';
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "reminderMinutesBefore" INTEGER;
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "createdById"           UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS time_blocks_created_by_id ON time_blocks ("createdById");

-- Backfill source for rows that already linked a task (best-effort, non-fatal).
UPDATE time_blocks SET "source" = 'task' WHERE "taskId" IS NOT NULL AND "source" = 'manual';
