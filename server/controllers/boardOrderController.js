// Per-user board ordering inside workspaces.
//
// The board lists in the sidebar can be rearranged by each user. The order
// is stored as a small set of (userId, workspaceId, boardId, position) rows
// in `user_board_orders` and applied at render time on the client.
//
// Security model:
//   - The user must have access to the workspace (existing visibility rules
//     in workspaceController.getMyWorkspaces) and to every boardId they
//     submit. Cross-workspace IDs and IDs the caller cannot see are rejected
//     to avoid leaking the existence of hidden boards.
//   - Saved preferences are scoped to req.user.id only. Other users are
//     never affected.

const { UserBoardOrder, Board, Workspace, sequelize } = require('../models');
const { Op } = require('sequelize');
const boardVisibility = require('../services/boardVisibilityService');
const { hasTierAtLeast, TIER_2 } = require('../config/tiers');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the set of board ids the calling user is allowed to see inside a
// given workspace. Delegates to boardVisibilityService so the rule matches
// the sidebar / search / direct-URL gate exactly.
//
// Phase 6 — replaced the legacy `isSuperAdmin || role === 'admin' || role === 'manager'`
// dual-gate with hasTierAtLeast(TIER_2). Functionally equivalent today
// (T1 = isSuperAdmin, T2 = admin/manager), but stays correct if the
// role-name strings ever change.
async function getVisibleBoardIds(user, workspaceId) {
  const isAdminOrManager = hasTierAtLeast(user, TIER_2);
  if (isAdminOrManager) {
    const rows = await Board.findAll({
      where: { workspaceId, isArchived: false },
      attributes: ['id'],
      raw: true,
    });
    return new Set(rows.map(r => r.id));
  }

  const allVisible = await boardVisibility.getVisibleBoardIdsForUser(user, { includeArchived: false });
  if (allVisible.size === 0) return new Set();
  // Filter by workspace.
  const rows = await Board.findAll({
    where: { id: { [Op.in]: Array.from(allVisible) }, workspaceId, isArchived: false },
    attributes: ['id'],
    raw: true,
  });
  return new Set(rows.map(r => r.id));
}

// GET /api/board-orders/mine
// Returns the calling user's full ordering map across all workspaces:
//   { orders: { [workspaceId]: [boardId, boardId, ...] } }
exports.getMine = async (req, res) => {
  try {
    const rows = await UserBoardOrder.findAll({
      where: { userId: req.user.id },
      order: [['workspaceId', 'ASC'], ['position', 'ASC']],
      attributes: ['workspaceId', 'boardId', 'position'],
      raw: true,
    });
    const orders = {};
    for (const r of rows) {
      if (!orders[r.workspaceId]) orders[r.workspaceId] = [];
      orders[r.workspaceId].push(r.boardId);
    }
    res.json({ success: true, data: { orders } });
  } catch (err) {
    console.error('[BoardOrder] getMine error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load board order preferences.' });
  }
};

// GET /api/workspaces/:id/board-order
// Returns the calling user's saved boardId order for a single workspace.
// Empty array if no preference has been saved yet.
exports.getForWorkspace = async (req, res) => {
  const workspaceId = req.params.workspaceId || req.params.id;
  if (!UUID_RE.test(workspaceId || '')) {
    return res.status(400).json({ success: false, message: 'Invalid workspaceId.' });
  }
  try {
    const ws = await Workspace.findByPk(workspaceId);
    if (!ws) return res.status(404).json({ success: false, message: 'Workspace not found.' });

    // Lightweight access check: if the user has zero visible boards in this
    // workspace AND isn't management, treat as forbidden. We don't try to
    // distinguish "exists but empty" vs "no access" — both yield an empty list.
    const isMgmt = hasTierAtLeast(req.user, TIER_2);
    if (!isMgmt) {
      const visible = await getVisibleBoardIds(req.user, workspaceId);
      if (visible.size === 0) {
        // No accessible boards — return empty preference rather than 403 to
        // keep the modal frictionless for newly-added members.
        return res.json({ success: true, data: { boardIds: [] } });
      }
    }

    const rows = await UserBoardOrder.findAll({
      where: { userId: req.user.id, workspaceId },
      order: [['position', 'ASC']],
      attributes: ['boardId'],
      raw: true,
    });
    res.json({ success: true, data: { boardIds: rows.map(r => r.boardId) } });
  } catch (err) {
    console.error('[BoardOrder] getForWorkspace error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load board order.' });
  }
};

// PUT /api/workspaces/:id/board-order
// Body: { boardIds: [uuid, uuid, ...] }
// Replaces the calling user's ordering preference for that workspace.
exports.setOrder = async (req, res) => {
  // Accept either `:id` (when mounted under /api/workspaces) or
  // `:workspaceId` (legacy mount point). Either path resolves to the same
  // workspace UUID.
  const workspaceId = req.params.workspaceId || req.params.id;
  const { boardIds } = req.body;

  // Diagnostic header — without this it's hard to tell from logs whether a
  // 404 came from this handler or the catch-all 404 in server.js.
  console.log(`[BoardOrder] setOrder workspaceId=${workspaceId} userId=${req.user?.id} boardCount=${Array.isArray(boardIds) ? boardIds.length : 'n/a'}`);

  if (!UUID_RE.test(workspaceId)) {
    return res.status(400).json({ success: false, message: 'Invalid workspaceId.' });
  }
  if (!Array.isArray(boardIds)) {
    return res.status(400).json({ success: false, message: 'boardIds must be an array.' });
  }
  for (const id of boardIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return res.status(400).json({ success: false, message: 'boardIds must be UUIDs.' });
    }
  }
  // Reject duplicate IDs in the same payload — keeps the order well-defined.
  if (new Set(boardIds).size !== boardIds.length) {
    return res.status(400).json({ success: false, message: 'boardIds must not contain duplicates.' });
  }

  try {
    // 1. Workspace must exist and the caller must be allowed to see it. We
    //    derive visible boards through the same path the sidebar uses.
    const ws = await Workspace.findByPk(workspaceId);
    if (!ws) {
      console.warn(`[BoardOrder] setOrder: workspace ${workspaceId} not found in DB`);
      return res.status(404).json({ success: false, message: 'Workspace not found.' });
    }

    const visibleBoardIds = await getVisibleBoardIds(req.user, workspaceId);
    if (visibleBoardIds.size === 0 && !hasTierAtLeast(req.user, TIER_2)) {
      // No accessible boards in this workspace — same as no access.
      return res.status(403).json({ success: false, message: 'You do not have access to this workspace.' });
    }

    // 2. Every submitted boardId must (a) belong to this workspace and
    //    (b) be visible to the caller. We deliberately do NOT echo back the
    //    offending IDs to avoid leaking the existence of hidden boards, but
    //    we log them server-side so a developer can diagnose. The server log
    //    will show e.g. "rejected boardIds=[abc,def] ws=xyz visible=[…]".
    const rejected = boardIds.filter(id => !visibleBoardIds.has(id));
    if (rejected.length > 0) {
      console.warn(`[BoardOrder] setOrder: rejected boardIds=${JSON.stringify(rejected)} workspaceId=${workspaceId} visibleCount=${visibleBoardIds.size}`);
      return res.status(400).json({
        success: false,
        message: 'Some boards do not belong to this workspace. Please refresh and try again.',
      });
    }

    // 3. Persist atomically — drop the user's existing rows for this
    //    workspace and re-insert in the new order.
    await sequelize.transaction(async (t) => {
      await UserBoardOrder.destroy({
        where: { userId: req.user.id, workspaceId },
        transaction: t,
      });
      if (boardIds.length > 0) {
        const rows = boardIds.map((boardId, position) => ({
          userId: req.user.id,
          workspaceId,
          boardId,
          position,
        }));
        await UserBoardOrder.bulkCreate(rows, { transaction: t });
      }
    });

    res.json({ success: true, data: { workspaceId, boardIds } });
  } catch (err) {
    console.error('[BoardOrder] setOrder error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save board order.' });
  }
};
