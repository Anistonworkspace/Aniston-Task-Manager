-- Migration 014: Add tier-based RBAC column to users.
--
-- ADDITIVE ONLY. This migration does NOT touch:
--   - users.role              (legacy ENUM, kept for compatibility)
--   - users.isSuperAdmin      (legacy flag, kept for compatibility)
--   - permission_grants       (kept as-is)
--   - any other table
--
-- Idempotent. Safe to re-run.
-- Rollback: server/migrations/014_add_user_tier_rollback.sql
--
-- Mapping (re-run produces the same result):
--   isSuperAdmin = true              -> tier 1
--   role IN ('admin','manager')      -> tier 2
--   role = 'assistant_manager'       -> tier 3
--   role = 'member' (or anything else) -> tier 4
-- Tier 1 wins when isSuperAdmin = true regardless of legacy role.

BEGIN;

-- 1. Add the new tier column.
--    NOT NULL DEFAULT 4 means existing rows get tier=4 instantly (Postgres >=11
--    treats this as a metadata-only operation: no full table rewrite). The
--    backfill UPDATE below then promotes the rows that should be tiers 1-3.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tier INTEGER NOT NULL DEFAULT 4;

-- 2. CHECK constraint (defense in depth — backend also validates).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_tier_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_tier_check
      CHECK (tier BETWEEN 1 AND 4);
  END IF;
END $$;

-- 3. Backfill from the legacy fields. Idempotent: rerunning will simply
--    re-derive from the legacy fields and produce the same value. Safe even
--    if some rows have already been pre-populated manually.
UPDATE users SET tier = CASE
  WHEN "isSuperAdmin" = true        THEN 1
  WHEN role IN ('admin','manager')  THEN 2
  WHEN role = 'assistant_manager'   THEN 3
  ELSE                                   4
END;

-- 4. Index for tier-based queries: used by the upcoming tier middleware
--    (requireTier / hasTierAtLeast) and especially by the last-Tier-1
--    protection check that runs on every demotion/deactivation.
CREATE INDEX IF NOT EXISTS idx_users_tier ON users(tier);

COMMIT;
