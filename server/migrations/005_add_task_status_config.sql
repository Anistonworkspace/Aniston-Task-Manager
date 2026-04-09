-- Migration: Add statusConfig JSONB column to tasks for per-task custom status options
-- Each task can define its own allowed statuses, overriding board/global defaults.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "statusConfig" JSONB DEFAULT NULL;

COMMENT ON COLUMN tasks."statusConfig" IS 'Task-specific allowed statuses: [{ key, label, color }]. Overrides board/global defaults when set.';
