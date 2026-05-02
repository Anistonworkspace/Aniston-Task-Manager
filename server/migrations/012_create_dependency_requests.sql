-- Migration 012: Dependency Request system
--
-- Replaces the old behaviour where adding a "dependency" silently created a
-- normal Task on the assignee's board. New behaviour: dependency requests
-- live in their own table, have their own lifecycle (pending → accepted →
-- working_on_it → done | rejected | cancelled), and never materialise a Task
-- row. The parent task's blocked state is computed from the set of active
-- rows (status IN active states) for that parent.
--
-- This migration is purely additive and idempotent. It does NOT touch:
--   - existing `task_dependencies` rows (legacy task-to-task links — they
--     keep working; we just stop creating new placeholder Tasks)
--   - any existing Task rows
--   - any user/permission state
--
-- Backfill plan (deliberately NOT executed here):
--   Production may already contain placeholder Tasks created by the old
--   `assignDependency` flow. There is no flag distinguishing those from real
--   tasks, so an automated convert-to-request migration is unsafe. A guarded
--   admin tool can be authored later (Phase 13) using the heuristic:
--     a Task is a placeholder iff it appears as `dependsOnTaskId` in exactly
--     one task_dependencies row, has no subtasks/comments/worklogs/files,
--     and shares createdBy with that dependency's createdById.

CREATE TABLE IF NOT EXISTS dependency_requests (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "parentTaskId"           UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title                    VARCHAR(300) NOT NULL,
  "blockingReason"         TEXT,
  "requestedByUserId"      UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  "assignedToUserId"       UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  "originalAssignerUserId" UUID REFERENCES users(id) ON DELETE SET NULL,
  "boardId"                UUID REFERENCES boards(id) ON DELETE CASCADE,
  "workspaceId"            UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  status                   VARCHAR(20) NOT NULL DEFAULT 'pending',
  priority                 VARCHAR(20) NOT NULL DEFAULT 'medium',
  "dueDate"                DATE,
  "acceptedAt"             TIMESTAMP WITH TIME ZONE,
  "startedAt"              TIMESTAMP WITH TIME ZONE,
  "completedAt"            TIMESTAMP WITH TIME ZONE,
  "rejectedAt"             TIMESTAMP WITH TIME ZONE,
  "cancelledAt"            TIMESTAMP WITH TIME ZONE,
  "rejectionReason"        TEXT,
  "cancellationReason"     TEXT,
  "completedByUserId"      UUID REFERENCES users(id) ON DELETE SET NULL,
  "archivedAt"             TIMESTAMP WITH TIME ZONE,
  "archivedBy"             UUID REFERENCES users(id) ON DELETE SET NULL,
  "createdAt"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt"              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Defensive value constraints. DO block keeps it safe to re-run on a DB
-- where the table (and constraints) already exist.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dep_req_status_check') THEN
    ALTER TABLE dependency_requests ADD CONSTRAINT dep_req_status_check
      CHECK (status IN ('pending','accepted','working_on_it','done','rejected','cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dep_req_priority_check') THEN
    ALTER TABLE dependency_requests ADD CONSTRAINT dep_req_priority_check
      CHECK (priority IN ('low','medium','high','critical'));
  END IF;
END $$;

-- Hot-path lookups.
CREATE INDEX IF NOT EXISTS dep_req_parent_idx          ON dependency_requests ("parentTaskId");
CREATE INDEX IF NOT EXISTS dep_req_assigned_status_idx ON dependency_requests ("assignedToUserId", status);
CREATE INDEX IF NOT EXISTS dep_req_requested_status_idx ON dependency_requests ("requestedByUserId", status);
CREATE INDEX IF NOT EXISTS dep_req_board_idx           ON dependency_requests ("boardId");
CREATE INDEX IF NOT EXISTS dep_req_status_idx          ON dependency_requests (status);
CREATE INDEX IF NOT EXISTS dep_req_due_date_idx        ON dependency_requests ("dueDate");
CREATE INDEX IF NOT EXISTS dep_req_created_at_idx      ON dependency_requests ("createdAt");

-- "Blocked by N dependencies?" — fast partial index over only active rows.
CREATE INDEX IF NOT EXISTS dep_req_active_parent_idx
  ON dependency_requests ("parentTaskId")
  WHERE status IN ('pending','accepted','working_on_it') AND "archivedAt" IS NULL;

-- Duplicate-active guard — same parent + same assignee + same title (case-
-- and whitespace-insensitive) cannot have two active rows. Cancelled/done/
-- rejected rows are excluded so the assignee can be asked the same thing
-- again after a previous request is closed.
CREATE UNIQUE INDEX IF NOT EXISTS dep_req_active_unique_idx
  ON dependency_requests ("parentTaskId", "assignedToUserId", lower(btrim(title)))
  WHERE status IN ('pending','accepted','working_on_it') AND "archivedAt" IS NULL;

-- Extend notifications.type enum with the dependency lifecycle event values.
-- Each statement is independent so a duplicate-value error on one doesn't
-- poison the others. Wrapped to a no-op if the enum doesn't exist yet (fresh
-- installs that haven't created the notifications model). The runner treats
-- IF NOT EXISTS errors as [SKIP].
ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS 'dependency_requested';
ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS 'dependency_accepted';
ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS 'dependency_started';
ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS 'dependency_done';
ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS 'dependency_rejected';
ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS 'dependency_cancelled';
