-- 022_workflows.sql
--
-- Canonical migration for the Workflow Canvas tables (Phase W1 + W2 + W3 +
-- May-19 audit follow-up).
--
-- Why this file exists:
--   The five workflow tables (workflows, workflow_nodes, workflow_edges,
--   workflow_runs, workflow_waits) have shipped to production via the
--   self-installing `CREATE TABLE IF NOT EXISTS` block in server/server.js
--   (~line 1410). That block is intentionally kept — it protects fresh dev
--   DBs at boot. This file is the audit-trail companion: an idempotent,
--   replay-safe SQL artefact that mirrors the boot-time installer, lets ops
--   run it manually on a clean replica, and gives future audits a single
--   numbered place to look for "what did Phase W1 add to the schema."
--
-- Audit follow-ups (May-19) bundled in the same file:
--   - workflow_runs."finishedAt"      — pair with startedAt so duration is
--                                       not the only post-hoc signal.
--   - workflow_runs."actorId"         — who fired the trigger (or null for
--                                       system-fired events).
--   - workflow_runs."failedStepId"    — which action node failed, for the
--                                       run-history drilldown.
--   - workflow_runs."retryCount"      — bumped by future retry plumbing.
--   - workflow_runs."idempotencyKey"  — multi-replica dedup of trigger
--                                       fires. Partial unique index below
--                                       enforces "at most one run per key
--                                       within the active window."
--   - workflow_runs."workflowVersion" — best-effort version tag. NULL today,
--                                       reserved for the future
--                                       WorkflowVersion table.
--
-- Idempotency guarantees:
--   - Every CREATE / ALTER / INDEX uses IF NOT EXISTS.
--   - No DROP, no destructive ALTER, no data backfill.
--   - Re-running this file on a healthy production DB is a NO-OP.
--   - Re-running on a fresh DB produces the same end-state as the server.js
--     boot installer.
--
-- DO NOT modify or remove the server/server.js auto-install block in this
-- slice. Both paths must continue to produce identical schemas.

-- ─────────────────────────────────────────────────────────────────────
-- 1. workflows
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(200) NOT NULL,
  description TEXT,
  "boardId" UUID REFERENCES boards(id) ON DELETE CASCADE,
  "workspaceId" UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  "createdBy" UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "lastRunAt" TIMESTAMP WITH TIME ZONE,
  "lastRunStatus" VARCHAR(20),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflows_workspace
  ON workflows("workspaceId");
CREATE INDEX IF NOT EXISTS idx_workflows_board
  ON workflows("boardId");
CREATE INDEX IF NOT EXISTS idx_workflows_board_active
  ON workflows("boardId", "isActive");
-- Hot-path index for processWorkflows():
--   WHERE "isActive"=true AND ("boardId" IS NULL OR "boardId"=?)
-- The (isActive, boardId) column order lets Postgres jump straight to the
-- small isActive=true slice first.
CREATE INDEX IF NOT EXISTS idx_workflows_active_board
  ON workflows("isActive", "boardId");

-- ─────────────────────────────────────────────────────────────────────
-- 2. workflow_nodes
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflowId" UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  type VARCHAR(16) NOT NULL,
  kind VARCHAR(64) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  position JSONB NOT NULL DEFAULT '{"x":0,"y":0}'::jsonb,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workflow
  ON workflow_nodes("workflowId");
CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workflow_type
  ON workflow_nodes("workflowId", type);

-- ─────────────────────────────────────────────────────────────────────
-- 3. workflow_edges
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflowId" UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  "sourceNodeId" UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  "targetNodeId" UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  condition JSONB,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Phase W2 — branch column for condition-node outgoing edges.
-- 'true' | 'false' | NULL. Idempotent.
ALTER TABLE workflow_edges
  ADD COLUMN IF NOT EXISTS branch VARCHAR(8);

CREATE INDEX IF NOT EXISTS idx_workflow_edges_workflow
  ON workflow_edges("workflowId");
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_edges_source_target
  ON workflow_edges("sourceNodeId", "targetNodeId");
-- May-19 audit — explicit per-FK indexes for cascade performance on
-- node deletion (cascade resolves all incident edges).
CREATE INDEX IF NOT EXISTS idx_workflow_edges_source
  ON workflow_edges("sourceNodeId");
CREATE INDEX IF NOT EXISTS idx_workflow_edges_target
  ON workflow_edges("targetNodeId");

-- ─────────────────────────────────────────────────────────────────────
-- 4. workflow_runs
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflowId" UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  trigger VARCHAR(64) NOT NULL,
  context JSONB,
  status VARCHAR(16) NOT NULL,
  "nodesRun" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_time
  ON workflow_runs("workflowId", "startedAt" DESC);

-- May-19 audit — run-history enrichment. Every column is additive, NULL-
-- safe, and individually wrapped in IF NOT EXISTS so a partial replay or
-- a prior hot-patch leaves the table in the same final state.
ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS "finishedAt" TIMESTAMP WITH TIME ZONE;
ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS "actorId" UUID;
ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS "failedStepId" UUID;
ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS "idempotencyKey" VARCHAR(255);
ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS "workflowVersion" INTEGER;

-- Partial unique on idempotencyKey within the workflow scope. NULL keys are
-- allowed (legacy rows + tests that don't supply a key); only non-NULL keys
-- get the uniqueness guarantee. This matches the notifications
-- idx_notifications_idempotency pattern from migration 008-ish.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_idempotency
  ON workflow_runs("workflowId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;

-- Index startedAt globally to support cron-style "recent runs across all
-- workflows" admin queries without forcing a per-workflow scan.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_started
  ON workflow_runs("startedAt" DESC);

-- Index actorId for "show me runs that fired off my changes" admin views.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_actor
  ON workflow_runs("actorId");

-- ─────────────────────────────────────────────────────────────────────
-- 5. workflow_waits  (Phase W3 — paused-wait queue)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workflow_waits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workflowId" UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  "fromNodeId" UUID NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  "resumeAt" TIMESTAMP WITH TIME ZONE NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_waits_resume_at
  ON workflow_waits("resumeAt");
CREATE INDEX IF NOT EXISTS idx_workflow_waits_workflow
  ON workflow_waits("workflowId");
