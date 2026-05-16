-- 020_status_templates.sql — Phase 2 of the Aniston Task Manager UX revamp.
--
-- Adds a `status_templates` table that lets Tier 1 / Tier 2 users define
-- reusable status tile groups for a board. A template carries a name, an
-- ordered list of statuses (key/label/color/position) as JSONB, the key
-- of the default status inside the group, and an `isDefault` flag that
-- marks one template per board as the board's default group.
--
-- This migration is BOARD-SCOPED by design (Phase 2 scope). Future phases
-- may introduce workspace / global scopes; the same table is intended to
-- carry those extra scopes via additional nullable columns.
--
-- Existing tasks are untouched. Tasks created without a `statusTemplateId`
-- continue to use the existing board.columns / DEFAULT_STATUSES resolution
-- chain. Tasks created with a template have its `statuses` array copied
-- into `tasks.statusConfig` so the template can later be edited/deleted
-- without retroactively breaking historical tasks.
--
-- Idempotent — safe to run multiple times. The matching self-installing
-- block lives in server/server.js start() so production deploys never
-- depend on running this script by hand.

CREATE TABLE IF NOT EXISTS status_templates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "boardId"           UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name                VARCHAR(100) NOT NULL,
  statuses            JSONB NOT NULL DEFAULT '[]'::jsonb,
  "defaultStatusKey"  VARCHAR(50) NOT NULL,
  "isDefault"         BOOLEAN NOT NULL DEFAULT false,
  "createdBy"         UUID NOT NULL REFERENCES users(id),
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup index — every list endpoint reads templates by board.
CREATE INDEX IF NOT EXISTS idx_status_templates_board
  ON status_templates("boardId");

-- Partial unique index — at most one default template per board. The
-- controller layer also enforces this transactionally (clears the prior
-- default before setting a new one), but the index is the authoritative
-- guard against a race condition that races two concurrent set-default
-- requests.
CREATE UNIQUE INDEX IF NOT EXISTS idx_status_templates_board_default_one
  ON status_templates("boardId")
  WHERE "isDefault" = true;
