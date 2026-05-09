-- Rollback for migration 015.
-- Drops the constraint and indexes added in 015_hierarchy_constraints.sql.

BEGIN;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_no_self_manager;

DROP INDEX IF EXISTS idx_users_manager_id;
DROP INDEX IF EXISTS idx_users_is_active;
DROP INDEX IF EXISTS idx_users_role;

COMMIT;
