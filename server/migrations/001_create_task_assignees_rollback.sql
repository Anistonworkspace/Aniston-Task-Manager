-- Rollback: Remove task_assignees table
-- Run with: psql -U postgres -d aniston_project_hub -f migrations/001_create_task_assignees_rollback.sql

BEGIN;

-- Drop the table (this also drops its indexes)
DROP TABLE IF EXISTS task_assignees;

-- Drop the enum type
DROP TYPE IF EXISTS task_assignee_role;

COMMIT;
