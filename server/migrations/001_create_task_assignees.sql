-- Migration: Create task_assignees table and migrate data from assignedTo column
-- Safe to run multiple times (idempotent)
-- Run with: psql -U postgres -d aniston_project_hub -f migrations/001_create_task_assignees.sql

BEGIN;

-- 1. Create the task_assignee_role enum type
DO $$ BEGIN
  CREATE TYPE task_assignee_role AS ENUM ('assignee', 'supervisor');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 2. Create the task_assignees join table
CREATE TABLE IF NOT EXISTS task_assignees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "taskId" UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  "userId" UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role task_assignee_role NOT NULL DEFAULT 'assignee',
  "assignedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 3. Add indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_task_assignees_user_id ON task_assignees("userId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_assignees_task_user_role ON task_assignees("taskId", "userId", role);

-- 4. Data migration: move existing assignedTo values into task_assignees
-- Only inserts if the row doesn't already exist (idempotent)
INSERT INTO task_assignees ("taskId", "userId", role, "assignedAt", "createdAt", "updatedAt")
SELECT
  t.id AS "taskId",
  t."assignedTo" AS "userId",
  'assignee' AS role,
  COALESCE(t."createdAt", NOW()) AS "assignedAt",
  NOW() AS "createdAt",
  NOW() AS "updatedAt"
FROM tasks t
WHERE t."assignedTo" IS NOT NULL
ON CONFLICT ("taskId", "userId", role) DO NOTHING;

-- 5. Also migrate task_owners entries into task_assignees (if any exist beyond the assignedTo)
INSERT INTO task_assignees ("taskId", "userId", role, "assignedAt", "createdAt", "updatedAt")
SELECT
  o."taskId",
  o."userId",
  'assignee' AS role,
  COALESCE(o."createdAt", NOW()) AS "assignedAt",
  NOW() AS "createdAt",
  NOW() AS "updatedAt"
FROM task_owners o
WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = o."taskId")
ON CONFLICT ("taskId", "userId", role) DO NOTHING;

COMMIT;

-- NOTE: We keep the assignedTo column on tasks for backward compatibility during transition.
-- It can be dropped in a future migration after all code is updated:
--   ALTER TABLE tasks DROP COLUMN IF EXISTS "assignedTo";