-- 021_recurring_reminders.sql
--
-- Adds recurring-reminder support to task_reminders.
--
-- Two new reminderType values become valid after this migration runs:
--   'interval'     — re-arms every intervalMinutes (15 ≤ N ≤ 10080)
--   'daily_times'  — re-arms at the next HH:MM slot in `timezone`
--
-- Both stop re-arming when the task is `done` or `isArchived`. The existing
-- partial unique index on
--   (taskId, reminderType, COALESCE(offsetMinutes,-1), COALESCE(customReminderAt,'1970-01-01'))
-- already gives us "one row per (taskId, reminderType)" for the new types
-- because they leave both COALESCE columns null. No index change needed.
--
-- This file is the audit-trail mirror of the ADD COLUMN IF NOT EXISTS block
-- in server/server.js. The boot block runs every restart; this file is for
-- humans + replay onto fresh DBs.

ALTER TABLE task_reminders
  ADD COLUMN IF NOT EXISTS "intervalMinutes" INTEGER DEFAULT NULL;

ALTER TABLE task_reminders
  ADD COLUMN IF NOT EXISTS "timesOfDay" JSONB DEFAULT NULL;

ALTER TABLE task_reminders
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) DEFAULT NULL;

ALTER TABLE task_reminders
  ADD COLUMN IF NOT EXISTS "lastFiredAt" TIMESTAMP WITH TIME ZONE DEFAULT NULL;
