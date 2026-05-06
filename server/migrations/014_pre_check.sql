-- Pre-migration READ-ONLY distribution check for migration 014.
-- Run BEFORE 014_add_user_tier.sql:
--   psql -U postgres -d aniston_project_hub -f server/migrations/014_pre_check.sql
--
-- This file performs ZERO writes. It only reports what the migration WILL
-- compute, so an operator can sanity-check the row counts before committing
-- the additive change. If anything looks off (unknown role values, zero
-- super admins, etc.) abort and investigate before running the migration.

\echo
\echo === [1/5] Computed-tier distribution preview (what migration will set) ===
SELECT
  CASE
    WHEN "isSuperAdmin" = true        THEN 1
    WHEN role IN ('admin','manager')  THEN 2
    WHEN role = 'assistant_manager'   THEN 3
    ELSE                                   4
  END AS computed_tier,
  COUNT(*) AS user_count
FROM users
GROUP BY computed_tier
ORDER BY computed_tier;

\echo
\echo === [2/5] Per-role / per-isSuperAdmin distribution ===
SELECT role, "isSuperAdmin", COUNT(*)
FROM users
GROUP BY role, "isSuperAdmin"
ORDER BY "isSuperAdmin" DESC, role;

\echo
\echo === [3/5] Tier-1 successor count (MUST be >= 1 for last-T1 protection) ===
SELECT COUNT(*) AS tier_1_count
FROM users
WHERE "isSuperAdmin" = true;

\echo
\echo === [4/5] Sanity: any unknown role values (should return 0 rows) ===
SELECT id, email, role, "isSuperAdmin"
FROM users
WHERE role NOT IN ('admin','manager','assistant_manager','member');

\echo
\echo === [5/5] Tier column existence (should return 0 rows if migration not yet applied) ===
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'users' AND column_name = 'tier';
