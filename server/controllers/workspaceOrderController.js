// Per-user workspace ordering for the sidebar.
//
// The user can manually reorder their visible workspaces. The order is stored
// as (userId, workspaceId, position) rows in `user_workspace_orders` and
// applied at render time on the client. Mirrors the boardOrderController
// pattern, but scoped globally per user rather than per-workspace.
//
// Security model:
//   - The user must have visibility on every workspace id they submit. We
//     reuse the same visibility logic as `getMyWorkspaces` so the rule
//     matches the sidebar exactly. Cross-user / hidden-workspace ids are
//     rejected to prevent leaking the existence of inaccessible workspaces.
//   - Saved preferences are scoped to req.user.id only. Other users are
//     never affected.

const { UserWorkspaceOrder, Workspace, Board, User, sequelize } = require('../models');
const { Op } = require('sequelize');
const boardVisibility = require('../services/boardVisibilityService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the set of workspace ids visible to the calling user. Mirrors
// `workspaceController.getMyWorkspaces` so the rules stay in sync — admins
// and managers see every active workspace; everyone else sees workspaces
// they created, are a direct workspace member of, or have at least one
// accessible board inside.
async function getVisibleWorkspaceIds(user) {
  const isAdminOrManager = !!user.isSuperAdmin || user.role === 'admin' || user.role === 'manager';

  if (isAdminOrManager) {
    const rows = await Workspace.findAll({
      where: { isActive: true },
      attributes: ['id'],
      raw: true,
    });
    return new Set(rows.map(r => r.id));
  }

  // Members / assistant_managers — same path as getMyWorkspaces.
  const visibleBoardIds = await boardVisibility.getVisibleBoardIdsForUser(user, { includeArchived: false });
  let assignedWsIds = new Set();
  if (visibleBoardIds.size > 0) {
    const rows = await Board.findAll({
      where: { id: { [Op.in]: Array.from(visibleBoardIds) } },
      attributes: ['workspaceId'],
      raw: true,
    });
    for (const r of rows) if (r.workspaceId) assignedWsIds.add(r.workspaceId);
  }

  // Direct membership via Workspace.workspaceMembers (User.workspaceId join).
  let visibleUserIds = [user.id];
  try {
    const hierarchyService = require('../services/hierarchyService');
    const descendants = await hierarchyService.getDescendantIds(user.id);
    visibleUserIds = visibleUserIds.concat(descendants);
  } catch { /* hierarchy walk is best-effort */ }

  const userRecord = await User.findByPk(user.id, { attributes: ['id', 'workspaceId'] });

  const allWorkspaces = await Workspace.findAll({
    where: { isActive: true },
    include: [
      { model: User, as: 'workspaceMembers', attributes: ['id'] },
    ],
  });

  const out = new Set();
  for (const ws of allWorkspaces) {
    if (ws.createdBy === user.id) { out.add(ws.id); continue; }
    if (userRecord?.workspaceId && ws.id === userRecord.workspaceId) { out.add(ws.id); continue; }
    if (ws.workspaceMembers?.some(m => visibleUserIds.includes(m.id))) { out.add(ws.id); continue; }
    if (assignedWsIds.has(ws.id)) { out.add(ws.id); continue; }
  }
  return out;
}

// GET /api/workspaces/order
// Returns the calling user's saved workspaceId order. Empty array if no
// preference has been saved yet.
exports.getMine = async (req, res) => {
  try {
    const rows = await UserWorkspaceOrder.findAll({
      where: { userId: req.user.id },
      order: [['position', 'ASC']],
      attributes: ['workspaceId'],
      raw: true,
    });
    res.json({ success: true, data: { workspaceIds: rows.map(r => r.workspaceId) } });
  } catch (err) {
    console.error('[WorkspaceOrder] getMine error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load workspace order.' });
  }
};

// PUT /api/workspaces/order
// Body: { workspaceIds: [uuid, uuid, ...] }
// Replaces the calling user's workspace ordering preference.
exports.setOrder = async (req, res) => {
  const { workspaceIds } = req.body || {};

  // Diagnostic header — if this line is missing from the server logs but
  // the request was made, the request never reached this handler (likely a
  // route-mount issue). Mirrors the [BoardOrder] setOrder log convention.
  console.log(`[WorkspaceOrder] setOrder hit userId=${req.user?.id} workspaceCount=${Array.isArray(workspaceIds) ? workspaceIds.length : 'n/a'}`);

  if (!Array.isArray(workspaceIds)) {
    return res.status(400).json({ success: false, message: 'workspaceIds must be an array.' });
  }
  for (const id of workspaceIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return res.status(400).json({ success: false, message: 'workspaceIds must be UUIDs.' });
    }
  }
  if (new Set(workspaceIds).size !== workspaceIds.length) {
    return res.status(400).json({ success: false, message: 'workspaceIds must not contain duplicates.' });
  }

  try {
    // Resolve the set of workspaces visible to the caller using the same
    // rules as the sidebar fetch. Reject any submitted id that isn't in
    // that set — including ids that point to archived/inactive workspaces
    // or workspaces the caller cannot otherwise see. We do NOT echo the
    // offending ids back to avoid leaking the existence of hidden ones,
    // but we log them server-side for diagnosis.
    const visible = await getVisibleWorkspaceIds(req.user);
    const rejected = workspaceIds.filter(id => !visible.has(id));
    if (rejected.length > 0) {
      console.warn(`[WorkspaceOrder] setOrder: rejected workspaceIds=${JSON.stringify(rejected)} userId=${req.user.id} visibleCount=${visible.size}`);
      return res.status(400).json({
        success: false,
        message: 'Some workspaces are no longer accessible. Please refresh and try again.',
      });
    }

    // Persist atomically — drop the user's existing rows and re-insert
    // in the new order. If the insert fails, the destroy is rolled back
    // so the caller's previous preference is preserved intact.
    await sequelize.transaction(async (t) => {
      await UserWorkspaceOrder.destroy({
        where: { userId: req.user.id },
        transaction: t,
      });
      if (workspaceIds.length > 0) {
        const rows = workspaceIds.map((workspaceId, position) => ({
          userId: req.user.id,
          workspaceId,
          position,
        }));
        await UserWorkspaceOrder.bulkCreate(rows, { transaction: t });
      }
    });

    res.json({
      success: true,
      data: { workspaceIds },
      message: 'Workspace order saved successfully',
    });
  } catch (err) {
    console.error('[WorkspaceOrder] setOrder error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save workspace order.' });
  }
};
