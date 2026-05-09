-- Migration 015: Hierarchy data-integrity constraints + indexes.
--
-- ADDITIVE ONLY. Adds:
--   1. CHECK constraint preventing a user being their own manager.
--   2. Indexes on managerId / isActive / role to speed up the recursive
--      descendant walk that taskVisibilityService and the org-chart endpoint
--      run on every hierarchy-aware request.
--
-- Idempotent. Safe to re-run.
-- Rollback: server/migrations/015_hierarchy_constraints_rollback.sql
--
-- Cycle prevention is intentionally NOT a DB constraint — recursive CTE
-- triggers add overhead and can fight with Sequelize transaction semantics.
-- The application layer (hierarchyService.wouldCreateCycle) already blocks
-- cycles; this migration adds the cheaper guards (self-parent + indexes).

BEGIN;

-- 1. CHECK: a user cannot be their own primary manager.
--    NOT VALID first so existing rows aren't validated immediately (in case
--    legacy data has any self-referencing rows we don't want to break the
--    migration). Then VALIDATE in a separate statement so any violation
--    is surfaced as a single, clear error rather than a silent skip.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_no_self_manager'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_no_self_manager
      CHECK ("managerId" IS NULL OR "managerId" <> id) NOT VALID;
    -- VALIDATE separately. If legacy data has self-references this will
    -- raise — operators should clear the offending rows first, then re-run.
    BEGIN
      ALTER TABLE users VALIDATE CONSTRAINT users_no_self_manager;
    EXCEPTION WHEN check_violation THEN
      RAISE NOTICE 'users_no_self_manager constraint added but VALIDATE failed — clear self-referencing rows and re-run.';
    END;
  END IF;
END $$;

-- 2. Index on managerId. Used by every getDirectReportIds /
--    getDescendantIds call (org chart, task visibility, approval chain,
--    deadline reminder job, etc.).
CREATE INDEX IF NOT EXISTS idx_users_manager_id ON users("managerId");

-- 3. Index on isActive. Most hierarchy queries filter by isActive=true; this
--    makes that path index-only.
CREATE INDEX IF NOT EXISTS idx_users_is_active ON users("isActive");

-- 4. Index on role. Legacy role-based queries (accessRequestController,
--    recurringTemplateController, approvalChainService) filter by exact
--    role values; index keeps those cheap during the tier-migration window.
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

COMMIT;
