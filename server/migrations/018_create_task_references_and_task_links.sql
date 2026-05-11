-- Migration 018: task_references + task_links tables
--
-- These tables back the multi-value Reference and Link/URL columns on
-- the board. The same DDL is also created idempotently at server boot
-- in server.js (auto-migration block) — this file mirrors it so the
-- canonical migration history is complete for installs that drive
-- schema purely through `server/migrations/run_*.js`.
--
-- Idempotent: safe to run on a DB where server.js already created the
-- tables — `IF NOT EXISTS` makes both blocks no-op on existing schema.

CREATE TABLE IF NOT EXISTS task_references (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "taskId"   UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  text       VARCHAR(500) NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_references_task_pos
  ON task_references("taskId", position);

CREATE TABLE IF NOT EXISTS task_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "taskId"   UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  url        VARCHAR(2048) NOT NULL,
  title      VARCHAR(200),
  position   INTEGER NOT NULL DEFAULT 0,
  "createdBy" UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_links_task_pos
  ON task_links("taskId", position);
