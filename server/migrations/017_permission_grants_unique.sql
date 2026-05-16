-- Migration 017 — Permission Grants: ACTIVE override uniqueness
--
-- Phase A (May 2026 RBAC hardening). Adds a partial UNIQUE index on
-- permission_grants to prevent duplicate ACTIVE override rows for the same
-- (userId, resourceType, resourceId, action, effect) tuple. Without this,
-- concurrent POST /api/permissions calls can race past the controller's
-- findOne / findOrCreate gate and persist two ACTIVE rows. A subsequent
-- DELETE /api/permissions/:id only deactivates one, leaving an inconsistent
-- "active deny + active deny" or "active grant + active grant" state that
-- the engine surfaces as flapping effective permissions.
--
-- Why PARTIAL (WHERE "isActive" = true):
--   - Revoked rows (isActive=false) remain forever for audit history; we do
--     NOT want a future re-grant of the same permission to collide with an
--     old audit row. The partial predicate scopes uniqueness to live state.
--   - Expired rows are still ACTIVE (expiresAt only filters in the query);
--     the engine ignores them. They participate in uniqueness so a manual
--     re-issue at the same tuple updates instead of duplicating.
--
-- COALESCE handles NULL resourceId (global grants) and NULL action (legacy
-- permissionLevel-based rows): SQL treats NULL = NULL as UNKNOWN, so two
-- global grants would be considered distinct by a naive unique index.
-- Casting UUID → text for resourceId so both branches of COALESCE share
-- the same type.
--
-- SAFETY: this script ABORTS if duplicates already exist. Run the bundled
-- cleanup script first (idempotent, dry-run by default):
--
--   node server/scripts/dedupe-permission-grants.js          # report
--   node server/scripts/dedupe-permission-grants.js --apply  # deactivate
--                                                            # older dups
--
-- After cleanup, re-run this migration. The CREATE UNIQUE INDEX is
-- idempotent (IF NOT EXISTS) — re-running on a healthy DB is a no-op.

BEGIN;

DO $$
DECLARE
  duplicate_count INT;
  example_user TEXT;
BEGIN
  -- Count distinct tuples that have more than one active row.
  SELECT COUNT(*) INTO duplicate_count
  FROM (
    SELECT
      "userId",
      "resourceType",
      COALESCE("resourceId"::text, ''),
      COALESCE(action, ''),
      effect
    FROM permission_grants
    WHERE "isActive" = true
    GROUP BY 1, 2, 3, 4, 5
    HAVING COUNT(*) > 1
  ) dups;

  IF duplicate_count > 0 THEN
    -- Surface a sample userId so the operator can investigate quickly.
    SELECT pg."userId"::text INTO example_user
    FROM permission_grants pg
    WHERE pg."isActive" = true
    GROUP BY pg."userId", pg."resourceType", COALESCE(pg."resourceId"::text, ''),
             COALESCE(pg.action, ''), pg.effect
    HAVING COUNT(*) > 1
    LIMIT 1;

    RAISE EXCEPTION
      'Cannot create unique index: % duplicate ACTIVE permission_grants tuple(s) found (example userId %). '
      'Run `node server/scripts/dedupe-permission-grants.js --apply` to deactivate older duplicates, '
      'then re-run this migration.',
      duplicate_count, COALESCE(example_user, '<unknown>');
  END IF;
END $$;

-- Idempotent — re-running is a no-op once the index exists.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_permission_grants_active_override
  ON permission_grants (
    "userId",
    "resourceType",
    COALESCE("resourceId"::text, ''),
    COALESCE(action, ''),
    effect
  )
  WHERE "isActive" = true;

COMMIT;
