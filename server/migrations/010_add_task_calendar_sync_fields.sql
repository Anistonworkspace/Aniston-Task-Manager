-- Phase 11: Task <-> Microsoft Graph calendar sync tracking
-- One-way sync: App task -> Teams/Outlook calendar
--
-- Adds columns used by calendarService.js to track per-task sync state.
-- All columns are nullable / defaulted so existing rows remain valid.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "teamsCalendarUserId" VARCHAR(255);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "syncStatus" VARCHAR(20) NOT NULL DEFAULT 'not_synced';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "lastSyncedAt" TIMESTAMP WITH TIME ZONE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "syncError" TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "syncAttempts" INTEGER NOT NULL DEFAULT 0;

-- Partial index for the retry job (fast lookup of only tasks that need work)
CREATE INDEX IF NOT EXISTS idx_tasks_sync_status_retry
  ON tasks ("syncStatus")
  WHERE "syncStatus" IN ('failed', 'pending');
