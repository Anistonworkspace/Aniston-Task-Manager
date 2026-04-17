-- Add archivedGroups JSONB column to boards table
ALTER TABLE boards ADD COLUMN IF NOT EXISTS "archivedGroups" JSONB NOT NULL DEFAULT '[]';
