-- 025_timeblock_color_reminder.sql
-- Per-block color (user-chosen / auto-varied) + reminder dedupe timestamp.
--   * color          : a palette hex (e.g. '#8b5cf6'); NULL falls back to type colour.
--   * reminderSentAt : set once the N-minutes-before reminder has fired (dedupe).
-- Additive, no data loss. Mirrored by a self-installing block in server.js start().

ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "color"          VARCHAR(20);
ALTER TABLE time_blocks ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS time_blocks_reminder_due
  ON time_blocks ("reminderSentAt")
  WHERE "reminderMinutesBefore" IS NOT NULL AND "reminderSentAt" IS NULL;
