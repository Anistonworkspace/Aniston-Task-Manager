'use strict';

/**
 * Pin the contract for `getMyWorkspaces`:
 *   - admin/manager/super-admin → see every active workspace (unrestricted).
 *   - assistant_manager / member with NO accessible boards and NO direct
 *     workspace membership → 200 with an empty array (NOT a 500). This is
 *     the case the user originally reported as "Failed to fetch workspace"
 *     toast, and the regression we want pinned is that the controller
 *     never throws for empty-scope users.
 *   - assistant_manager / member with a creator/membership/board reason →
 *     see only the workspaces those reasons authorize.
 *
 * We mock the Sequelize models and the boardVisibilityService so the test
 * runs without a database. The shape of the controller's 200 response is
 * asserted precisely so the Sidebar's `wsRes.data.workspaces` extraction
 * keeps working.
 */

jest.mock('../../models', () => ({
  Workspace: { findAll: jest.fn() },
  Board:     { findAll: jest.fn() },
  User:      { findByPk: jest.fn() },
}));

jest.mock('../../services/boardVisibilityService', () => ({
  getVisibleBoardIdsForUser: jest.fn(),
}));

jest.mock('../../services/hierarchyService', () => ({
  getDescendantIds: jest.fn().mockResolvedValue([]),
}));

const { Workspace, Board, User } = require('../../models');
const boardVisibility = require('../../services/boardVisibilityService');
const { getMyWorkspaces } = require('../../controllers/workspaceController');

function buildReq(user) {
  return { user, params: {}, body: {}, query: {} };
}
function buildRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

describe('getMyWorkspaces', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── admins / managers ─────────────────────────────────────────────
  it('returns every active workspace for an admin', async () => {
    Workspace.findAll.mockResolvedValue([{ id: 'w1' }, { id: 'w2' }]);
    const req = buildReq({ id: 'admin-id', role: 'admin', isSuperAdmin: false });
    const res = buildRes();
    await getMyWorkspaces(req, res);
    expect(boardVisibility.getVisibleBoardIdsForUser).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: { workspaces: [{ id: 'w1' }, { id: 'w2' }] } })
    );
  });

  it('returns every active workspace for a manager', async () => {
    Workspace.findAll.mockResolvedValue([{ id: 'w1' }]);
    const req = buildReq({ id: 'mgr-id', role: 'manager', isSuperAdmin: false });
    const res = buildRes();
    await getMyWorkspaces(req, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: { workspaces: [{ id: 'w1' }] } })
    );
  });

  it('returns every active workspace for a super admin even if their role is "member"', async () => {
    Workspace.findAll.mockResolvedValue([{ id: 'w1' }]);
    const req = buildReq({ id: 'sa-id', role: 'member', isSuperAdmin: true });
    const res = buildRes();
    await getMyWorkspaces(req, res);
    expect(boardVisibility.getVisibleBoardIdsForUser).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
  });

  // ── restricted users ──────────────────────────────────────────────
  it('returns 200 with an empty array (not 500) for a member with no accessible boards', async () => {
    boardVisibility.getVisibleBoardIdsForUser.mockResolvedValue(new Set());
    User.findByPk.mockResolvedValue({ id: 'm', workspaceId: null });
    Workspace.findAll.mockResolvedValue([
      // toJSON is required because the controller calls ws.toJSON()
      { id: 'w1', createdBy: 'someone-else', workspaceMembers: [], boards: [], toJSON() { return { id: 'w1', createdBy: 'someone-else', workspaceMembers: [], boards: [] }; } },
    ]);
    const req = buildReq({ id: 'm', role: 'member', isSuperAdmin: false });
    const res = buildRes();
    await getMyWorkspaces(req, res);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: { workspaces: [] } })
    );
  });

  it('returns 200 with an empty array for an assistant_manager with no descendants and no boards', async () => {
    boardVisibility.getVisibleBoardIdsForUser.mockResolvedValue(new Set());
    User.findByPk.mockResolvedValue({ id: 'a', workspaceId: null });
    Workspace.findAll.mockResolvedValue([]);
    const req = buildReq({ id: 'a', role: 'assistant_manager', isSuperAdmin: false });
    const res = buildRes();
    await getMyWorkspaces(req, res);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: { workspaces: [] } })
    );
  });

  it('surfaces a workspace where the member is the creator', async () => {
    boardVisibility.getVisibleBoardIdsForUser.mockResolvedValue(new Set());
    User.findByPk.mockResolvedValue({ id: 'm', workspaceId: null });
    const ws = { id: 'w1', createdBy: 'm', workspaceMembers: [], boards: [], toJSON() { return { id: 'w1', createdBy: 'm', workspaceMembers: [], boards: [] }; } };
    Workspace.findAll.mockResolvedValue([ws]);
    const req = buildReq({ id: 'm', role: 'member', isSuperAdmin: false });
    const res = buildRes();
    await getMyWorkspaces(req, res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true })
    );
    const arg = res.json.mock.calls[0][0];
    expect(arg.data.workspaces).toHaveLength(1);
    expect(arg.data.workspaces[0].id).toBe('w1');
  });

  it('surfaces a workspace where the member has at least one accessible board', async () => {
    boardVisibility.getVisibleBoardIdsForUser.mockResolvedValue(new Set(['b1']));
    User.findByPk.mockResolvedValue({ id: 'm', workspaceId: null });
    Board.findAll.mockResolvedValue([{ id: 'b1', workspaceId: 'w1' }]);
    const ws = {
      id: 'w1',
      createdBy: 'someone-else',
      workspaceMembers: [],
      boards: [{ id: 'b1' }, { id: 'b2-not-visible' }],
      toJSON() { return { id: 'w1', createdBy: 'someone-else', workspaceMembers: [], boards: [{ id: 'b1' }, { id: 'b2-not-visible' }] }; },
    };
    Workspace.findAll.mockResolvedValue([ws]);
    const req = buildReq({ id: 'm', role: 'member', isSuperAdmin: false });
    const res = buildRes();
    await getMyWorkspaces(req, res);
    const arg = res.json.mock.calls[0][0];
    expect(arg.data.workspaces).toHaveLength(1);
    // Boards are filtered down to ones the user can actually open.
    expect(arg.data.workspaces[0].boards).toEqual([{ id: 'b1' }]);
  });

  it('hides a workspace where the member is only stale (no boards, not creator, not member)', async () => {
    boardVisibility.getVisibleBoardIdsForUser.mockResolvedValue(new Set());
    User.findByPk.mockResolvedValue({ id: 'm', workspaceId: null });
    Workspace.findAll.mockResolvedValue([
      { id: 'w-stale', createdBy: 'someone-else', workspaceMembers: [], boards: [{ id: 'b-not-visible' }], toJSON() { return { id: 'w-stale', createdBy: 'someone-else', workspaceMembers: [], boards: [{ id: 'b-not-visible' }] }; } },
    ]);
    const req = buildReq({ id: 'm', role: 'member', isSuperAdmin: false });
    const res = buildRes();
    await getMyWorkspaces(req, res);
    const arg = res.json.mock.calls[0][0];
    expect(arg.data.workspaces).toEqual([]);
  });
});
