-- Rollback for migration 014: Drops the additive tier column and its
-- supporting index/constraint. The legacy role + isSuperAdmin fields are
-- untouched, so the system is restored to the exact pre-migration shape.
--
-- Run with:
--   psql -U postgres -d aniston_project_hub -f server/migrations/014_add_user_tier_rollback.sql
--
-- DOES NOT delete or modify any other data. Idempotent.

BEGIN;

DROP INDEX IF EXISTS idx_users_tier;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_tier_check;

ALTER TABLE users DROP COLUMN IF EXISTS tier;

COMMIT;
