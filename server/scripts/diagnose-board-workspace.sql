-- ──────────────────────────────────────────────────────────────────────────
-- Diagnose / repair script for the Rearrange-Boards bug investigation.
-- READ ME BEFORE RUNNING. Only the SELECTs run by default — UPDATEs are
-- commented out and require a manual review of the results first.
-- ──────────────────────────────────────────────────────────────────────────

-- 1. List every workspace with its id, name, isActive flag, and board count.
--    Confirms the workspaceId you see in the UI exists and is active.
SELECT
  w.id            AS workspace_id,
  w.name          AS workspace_name,
  w."isActive"    AS workspace_active,
  COUNT(b.id)     AS board_count_in_db
FROM workspaces w
LEFT JOIN boards b
       ON b."workspaceId" = w.id
      AND (b."isArchived" IS NULL OR b."isArchived" = false)
GROUP BY w.id, w.name, w."isActive"
ORDER BY w.name;

-- 2. Find ORPHAN boards — boards visible in the UI but with NULL workspaceId.
--    These appear under "OTHER BOARDS" in the sidebar, NOT inside any
--    workspace, so they are NOT shown in the Rearrange Boards modal and are
--    not the cause of a 4xx response when reordering. They are listed here
--    as a separate data-quality issue to clean up if desired.
SELECT
  b.id            AS board_id,
  b.name          AS board_name,
  b."createdBy"   AS created_by,
  b."createdAt"   AS created_at,
  b."isArchived"  AS archived
FROM boards b
WHERE b."workspaceId" IS NULL
  AND (b."isArchived" IS NULL OR b."isArchived" = false)
ORDER BY b."createdAt" DESC;

-- 3. Find boards that point to a workspace that no longer exists (FK
--    integrity check — should be zero rows under normal operation since
--    Board.workspaceId has ON DELETE SET NULL).
SELECT
  b.id            AS board_id,
  b.name          AS board_name,
  b."workspaceId" AS dangling_workspace_id
FROM boards b
WHERE b."workspaceId" IS NOT NULL
  AND b."workspaceId" NOT IN (SELECT id FROM workspaces);

-- 4. For a SPECIFIC workspace, list every non-archived board the controller
--    will accept on the Rearrange Boards save. Replace the literal below
--    with the workspaceId you see in the UI / network tab.
--
--    If the request payload contains a boardId NOT in this list, that's why
--    the controller returns "Some boards do not belong to this workspace…"
SELECT
  b.id, b.name, b.color, b."workspaceId", b."isArchived"
FROM boards b
WHERE b."workspaceId" = '00000000-0000-0000-0000-000000000000'  -- <-- replace
  AND (b."isArchived" IS NULL OR b."isArchived" = false)
ORDER BY b.name;

-- 5. List the existing per-user board-order rows for a specific user +
--    workspace. Sanity-check that previous saves persisted correctly.
SELECT *
FROM user_board_orders
WHERE "userId"      = '00000000-0000-0000-0000-000000000000'  -- <-- replace
  AND "workspaceId" = '00000000-0000-0000-0000-000000000000'  -- <-- replace
ORDER BY position;

-- ──────────────────────────────────────────────────────────────────────────
-- OPTIONAL REPAIR — DO NOT RUN BLINDLY. Uncomment ONLY after you have
-- confirmed in #2 that an orphan board really does belong inside the named
-- workspace. The script does not assume any heuristic for "which orphans
-- belong where" — that requires human judgement.
-- ──────────────────────────────────────────────────────────────────────────
-- UPDATE boards
--    SET "workspaceId" = '<target-workspace-uuid>'
--  WHERE id IN (
--          '<orphan-board-uuid-1>',
--          '<orphan-board-uuid-2>'
--        );
