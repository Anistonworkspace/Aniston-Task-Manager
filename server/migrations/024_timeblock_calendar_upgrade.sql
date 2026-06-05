-- 024_timeblock_calendar_upgrade.sql
-- Google-Calendar-style Time Planner upgrade.
--   * description -> TEXT so it can hold a sanitized rich-HTML note (was VARCHAR 500).
--   * recurrenceRule    : 'daily' | 'weekdays' | 'weekly' | 'custom:<dows>' | NULL
--   * recurrenceGroupId : groups the instances generated from one repeat rule,
--                         so "delete series" can target the whole group.
-- All additive / widening — no data loss, old rows keep working.
-- Idempotent; mirrored by a self-installing block in server.js start().

ALTER TABLE time_blocks ALTER COLUMN "description" TYPE TEXT;
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "recurrenceRule"    VARCHAR(50);
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "recurrenceGroupId" UUID;

CREATE INDEX IF NOT EXISTS time_blocks_recurrence_group ON time_blocks ("recurrenceGroupId");
